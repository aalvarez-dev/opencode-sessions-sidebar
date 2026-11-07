#!/usr/bin/env python3
"""Inspect official native symbols without executing any inspected executable."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import struct
import subprocess
import tempfile
import zipfile

EXPECTED_ARCHIVE_SHA256 = "b21afebccec77970cfad82f1736d984d19ef60f7a3f82f1bc3c20b140d992c47"
EXPECTED_MEMBER = "bun-linux-x64-baseline-profile/bun-profile"
EXPECTED_NATIVE = {
    "buildId": "c30f169b1bef81fa57467cd091ba53aab5235468",
    "text": {
        "virtualAddress": "0x24c8400",
        "bytes": 57556330,
        "sha256": "b92183090fa644136cc3346548467e80fb4e5cb4bbf11de60ec58f76de7e134c",
    },
}


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def extract_expected(archive, destination):
    actual = sha256(archive)
    if actual != EXPECTED_ARCHIVE_SHA256:
        raise ValueError("The official archive digest does not match")
    with zipfile.ZipFile(archive) as zipped:
        entries = zipped.infolist()
        names = set()
        for entry in entries:
            path = PurePosixPath(entry.filename)
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if (path.is_absolute() or ".." in path.parts or "\\" in entry.filename
                    or (path.parts and ":" in path.parts[0])
                    or entry.filename in names or kind not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError("Unsafe or duplicate archive member")
            names.add(entry.filename)
        if sum(entry.file_size for entry in entries) > 350_000_000:
            raise ValueError("Archive exceeds the predeclared extraction size")
        entry = zipped.getinfo(EXPECTED_MEMBER)
        if entry.is_dir() or entry.file_size != 266714456:
            raise ValueError("Unexpected profile binary entry")
        # Never honor archived executable permissions. The extracted file is data
        # for ELF inspection and potential symbol lookup, not a replacement runtime.
        descriptor, temporary = tempfile.mkstemp(prefix="symbol-data-", dir=destination.parent)
        try:
            with os.fdopen(descriptor, "wb") as output, zipped.open(entry) as source:
                shutil.copyfileobj(source, output, 1024 * 1024)
            os.chmod(temporary, 0o644)
            if destination.exists():
                if sha256(destination) != sha256(temporary):
                    raise ValueError("Refusing to replace a different existing symbol file")
                os.unlink(temporary)
            else:
                os.replace(temporary, destination)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return {"sha256": actual, "bytes": archive.stat().st_size,
            "member": EXPECTED_MEMBER, "extractedBytes": destination.stat().st_size,
            "extractedMode": oct(stat.S_IMODE(destination.stat().st_mode))}


def elf_details(path):
    with open(path, "rb") as stream:
        header = stream.read(64)
        if header[:6] != b"\x7fELF\x02\x01":
            raise ValueError("Expected a little-endian 64-bit ELF")
        program_offset = struct.unpack_from("<Q", header, 32)[0]
        program_size, program_count = struct.unpack_from("<HH", header, 54)
        if program_size != 56 or not 0 < program_count < 128:
            raise ValueError("Unsupported ELF program table")
        stream.seek(program_offset)
        programs = [struct.unpack("<IIQQQQQQ", stream.read(program_size))
                    for _ in range(program_count)]
        offset = struct.unpack_from("<Q", header, 40)[0]
        size, count, strings_index = struct.unpack_from("<HHH", header, 58)
        if size != 64 or not count or strings_index >= count:
            raise ValueError("Unsupported ELF section table")
        stream.seek(offset)
        sections = [struct.unpack("<IIQQQQIIQQ", stream.read(size)) for _ in range(count)]
        strings_section = sections[strings_index]
        stream.seek(strings_section[4])
        strings = stream.read(strings_section[5])
        by_name = {}
        for section in sections:
            name = strings[section[0]:].split(b"\0", 1)[0].decode("ascii")
            by_name[name] = section
        text = by_name[".text"]
        stream.seek(text[4])
        digest = hashlib.sha256()
        remaining = text[5] if text[1] != 8 else 0  # SHT_NOBITS in debug-only data.
        while remaining:
            block = stream.read(min(remaining, 1024 * 1024))
            if not block:
                raise ValueError("Truncated text section")
            digest.update(block)
            remaining -= len(block)
        note = by_name[".note.gnu.build-id"]
        stream.seek(note[4])
        raw = stream.read(note[5])
        name_size, desc_size, note_type = struct.unpack_from("<III", raw)
        desc_offset = 12 + ((name_size + 3) & ~3)
        if note_type != 3 or raw[12:12 + name_size] != b"GNU\0":
            raise ValueError("Unexpected GNU build ID note")
        build_id = raw[desc_offset:desc_offset + desc_size].hex()
        return {"path": str(path), "buildId": build_id,
                "text": {"virtualAddress": hex(text[3]), "bytes": text[5],
                         "sha256": digest.hexdigest() if text[1] != 8 else None},
                "textFileOffset": hex(text[4]), "textSectionType": text[1],
                "loadSegments": [{"offset": hex(item[2]), "virtualAddress": hex(item[3]),
                                  "fileBytes": item[5], "memoryBytes": item[6],
                                  "flags": item[1], "alignment": item[7]}
                                 for item in programs if item[0] == 1],
                "sectionTypes": {name: by_name[name][1] for name in
                                 (".text", ".dynsym", ".symtab", ".eh_frame", ".debug_frame")
                                 if name in by_name},
                "unwindSections": {name: by_name[name][5] for name in (".eh_frame", ".eh_frame_hdr", ".debug_frame") if name in by_name},
                "debugSections": {name: section[5] for name, section in by_name.items() if name.startswith(".debug")},
                "symbolTableBytes": by_name.get(".symtab", (0,) * 10)[5]}


def function_inventory(path):
    """Bind native names and address ranges without retaining a huge symbol list."""
    digest = hashlib.sha256()
    count = 0
    anchors = []
    wanted = {"JSC::Heap::isMarked(void const*)",
              "JSC::MarkedBlock::isMarked(unsigned int, void const*)",
              "WTF::Dependency WTF::Dependency::loadAndFence<unsigned int>(unsigned int const*, unsigned int&)"}
    with tempfile.TemporaryFile(mode="w+t") as output:
        process = subprocess.run(["nm", "-n", "-S", "-C", "--defined-only", str(path)],
                                 stdout=output, stderr=subprocess.PIPE,
                                 text=True, timeout=45, check=False)
        if process.returncode:
            raise RuntimeError("nm function inventory failed: " + process.stderr)
        output.seek(0)
        for line in output:
            match = re.match(r"^([0-9a-f]+)\s+([0-9a-f]+)\s+([tTwW])\s+(.*)$", line.strip())
            if not match:
                continue
            start, size, kind, name = match.groups()
            digest.update(f"{start} {size} {kind} {name}\n".encode())
            count += 1
            if name in wanted:
                anchors.append({"start": hex(int(start, 16)), "bytes": int(size, 16), "name": name})
    if len(anchors) != len(wanted):
        raise ValueError("Pinned native address anchors are unavailable")
    return {"sha256": digest.hexdigest(), "count": count, "anchors": anchors}


def prepare_symbol_files(runtime, profile, output):
    """Use a real runtime ELF plus conventional separate debug information.

    OpenCode's stripped ELF has different executable file offsets from Bun's
    profile ELF. Substituting the full profile in perf's ELF cache silently
    mislabels addresses. A NOBITS debug file makes perf use the runtime's layout.
    """
    symfs = profile.parent / "native-symbol-symfs"
    if symfs.is_symlink() or symfs.resolve().is_relative_to(output):
        raise ValueError("The private symbol filesystem must stay outside artifacts")
    symfs.mkdir(parents=True, exist_ok=True)
    symfs = symfs.resolve()

    def target(relative):
        destination = symfs / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.parent.resolve().is_relative_to(symfs) or destination.is_symlink():
            raise ValueError("Unsafe private symbol filesystem destination")
        return destination

    def install(destination, produce):
        descriptor, temporary = tempfile.mkstemp(prefix="debug-data-", dir=destination.parent)
        os.close(descriptor)
        temporary = Path(temporary)
        try:
            produce(temporary)
            os.chmod(temporary, 0o644)
            if destination.exists():
                if sha256(destination) != sha256(temporary):
                    raise ValueError("Refusing to replace different existing symbol data")
            else:
                os.replace(temporary, destination)
            if not destination.is_file() or stat.S_IMODE(destination.stat().st_mode) != 0o644:
                raise ValueError("Symbol filesystem files must be regular, non-executable data")
        finally:
            temporary.unlink(missing_ok=True)

    mirror = target(runtime.as_posix().lstrip("/"))
    # Copy instead of hardlink: making the mirror non-executable must never
    # change the measured runtime's permissions or bytes.
    install(mirror, lambda path: shutil.copyfile(runtime, path))
    runtime_hash = sha256(runtime)
    if sha256(mirror) != runtime_hash:
        raise ValueError("The runtime mirror must exactly match the measured ELF")
    build_id = EXPECTED_NATIVE["buildId"]
    debug = target(Path("usr/lib/debug/.build-id") / build_id[:2] / (build_id[2:] + ".debug"))

    def derive(path):
        subprocess.run(["objcopy", "--only-keep-debug", str(profile), str(path)],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=45, check=True)

    install(debug, derive)
    details = elf_details(debug)
    if (details["buildId"] != build_id or details["textSectionType"] != 8
            or details["sectionTypes"].get(".dynsym") != 8
            or details["sectionTypes"].get(".symtab") != 2
            or details["text"]["virtualAddress"] != EXPECTED_NATIVE["text"]["virtualAddress"]
            or details["text"]["bytes"] != EXPECTED_NATIVE["text"]["bytes"]):
        raise ValueError("Derived debug data must retain symbols without a runtime text/dynsym image")
    original_inventory = function_inventory(profile)
    if function_inventory(debug) != original_inventory:
        raise ValueError("Derived debug function addresses differ from the verified profile")
    return {"symbolizationMode": "separate-debug-with-original-runtime",
            "fullProfileAsRuntimeElfAllowed": False,
            "symbolFilesystemPath": str(symfs),
            "runtimeMirrorPath": str(mirror), "runtimeMirrorSha256": runtime_hash,
            "runtimeMirrorMode": oct(stat.S_IMODE(mirror.stat().st_mode)),
            "debugFilePath": str(debug), "debugFileSha256": sha256(debug),
            "debugFileMode": oct(stat.S_IMODE(debug.stat().st_mode)),
            "derivedDebugElf": details, "functionInventory": original_inventory,
            "debugDerivation": ["objcopy", "--only-keep-debug", str(profile), str(debug)],
            "requiredPerfOptions": ["--symfs", str(symfs), "--no-inline"],
            "buildIdCachePolicy": "Use a separate empty cache; never add the full profile ELF."}


def symbols(path, retained):
    counts = {"defined": 0, "jsc": 0, "heap": 0, "gcRelated": 0}
    examples = {"heap": [], "gcRelated": []}
    gc_pattern = re.compile(r"JSC::(?:Heap::|SlotVisitor::|AbstractSlotVisitor::|MarkedSpace::|MarkedBlock::|GCThread|GCActivityCallback::|GCDeferralContext::|HeapCell::)")
    # Full symbol output stays in a temporary file, not in the uploaded report.
    with tempfile.TemporaryFile(mode="w+t") as native_symbols, open(retained, "w") as output:
        process = subprocess.run(["nm", "-C", "--defined-only", str(path)],
                                 stdout=native_symbols, stderr=subprocess.PIPE,
                                 text=True, timeout=45, check=False)
        if process.returncode:
            raise RuntimeError("nm failed: " + process.stderr)
        native_symbols.seek(0)
        for line in native_symbols:
            counts["defined"] += 1
            if "JSC::" in line:
                counts["jsc"] += 1
            if "JSC::Heap::" in line:
                counts["heap"] += 1
                if len(examples["heap"]) < 40:
                    examples["heap"].append(line.strip())
            if gc_pattern.search(line):
                counts["gcRelated"] += 1
                output.write(line)
                if len(examples["gcRelated"]) < 60:
                    examples["gcRelated"].append(line.strip())
    return {"counts": counts, "examples": examples, "retainedSymbolList": retained.name,
            "retainedSymbolListSha256": sha256(retained)}


parser = argparse.ArgumentParser()
parser.add_argument("--symbols-archive", type=Path, required=True)
parser.add_argument("--opencode", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--symbol-file", type=Path, required=True,
                    help="Non-executable symbol data outside the report/artifact directory")
args = parser.parse_args()
args.output = args.output.resolve()
args.output.mkdir(parents=True, exist_ok=True)
destination = args.symbol_file.resolve()
report_path = args.output / "native-symbol-preflight.json"
report = {"kind": "official-native-symbol-preflight", "acceptanceEvaluated": False,
          "inspectedExecutableRun": False, "perfRun": False, "completed": False}
try:
    if args.symbol_file.is_symlink():
        raise ValueError("The symbol data destination must not be a symbolic link")
    if destination.is_relative_to(args.output):
        raise ValueError("Large symbol data must stay outside the report/artifact directory")
    if args.symbols_archive.resolve().is_relative_to(args.output):
        raise ValueError("The large symbols archive must stay outside the report/artifact directory")
    destination.parent.mkdir(parents=True, exist_ok=True)
    report["archive"] = extract_expected(args.symbols_archive, destination)
    report["executables"] = {
        "opencode": elf_details(args.opencode.resolve()), "profile": elf_details(destination)}
    # Flat bindings let the capture driver verify /proc/<owned-pid>/exe and
    # symbol data again immediately before recording, without trusting a path.
    report["runtimeExecutablePath"] = str(args.opencode.resolve())
    report["runtimeExecutableSha256"] = sha256(args.opencode.resolve())
    report["symbolFilePath"] = str(destination)
    report["symbolFileSha256"] = sha256(destination)
    report["profileBuildId"] = report["executables"]["profile"]["buildId"]
    report["profileTextSha256"] = report["executables"]["profile"]["text"]["sha256"]
    values = list(report["executables"].values())
    report["expectedNativeImage"] = EXPECTED_NATIVE
    report["matches"] = {
        "buildId": len({item["buildId"] for item in values}) == 1,
        "textVirtualAddress": len({item["text"]["virtualAddress"] for item in values}) == 1,
        "textBytes": len({item["text"]["bytes"] for item in values}) == 1,
        "textSha256": len({item["text"]["sha256"] for item in values}) == 1,
        "pinnedNativeImage": all(item["buildId"] == EXPECTED_NATIVE["buildId"]
                                 and item["text"] == EXPECTED_NATIVE["text"] for item in values),
    }
    if not all(report["matches"].values()):
        raise ValueError("Host and symbols must match the pinned native image; refusing symbol substitution")
    report["runtimeAndProfileFileOffsetsMatch"] = (
        report["executables"]["opencode"]["textFileOffset"]
        == report["executables"]["profile"]["textFileOffset"])
    report.update(prepare_symbol_files(args.opencode.resolve(), destination, args.output))
    report["symbols"] = symbols(destination, args.output / "gc-native-symbols.txt")
    report["canResolveMatchingNativeTextSymbols"] = (
        all(report["matches"].values()) and report["symbols"]["counts"]["heap"] > 0
        and report["symbols"]["counts"]["gcRelated"] > 0)
    if not report["canResolveMatchingNativeTextSymbols"]:
        raise ValueError("Matching native GC symbols are unavailable")
    report["limitations"] = [
        "Matching native text and symbols support native instruction-address symbolization only.",
        "The full profile ELF must never substitute for the runtime ELF: file offsets can differ despite matching native text and Build ID.",
        "Separate debug data supports native leaf symbols; caller unwinding, inline-source resolution and JIT names are not established. The retained pilot capture resolved only leaf frames.",
        "The profile file is symbol data only; the measured OpenCode runtime must remain unchanged.",
        "These symbols apply to this exact baseline native image, not automatically to another architecture or nonbaseline build.",
    ]
    report["completed"] = True
except Exception as error:
    report["error"] = f"{type(error).__name__}: {error}"
    raise
finally:
    report["scriptSha256"] = sha256(Path(__file__))
    report_path.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"completed": report["completed"], "matches": report["matches"],
                  "symbolCounts": report["symbols"]["counts"],
                  "unwindSections": report["executables"]["profile"]["unwindSections"],
                  "canResolveMatchingNativeTextSymbols": report["canResolveMatchingNativeTextSymbols"],
                  "report": str(report_path)}, indent=2))
