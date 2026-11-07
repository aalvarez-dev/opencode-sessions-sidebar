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
        remaining = text[5]
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
                "text": {"virtualAddress": hex(text[3]), "bytes": text[5], "sha256": digest.hexdigest()},
                "unwindSections": {name: by_name[name][5] for name in (".eh_frame", ".eh_frame_hdr", ".debug_frame") if name in by_name},
                "debugSections": {name: section[5] for name, section in by_name.items() if name.startswith(".debug")},
                "symbolTableBytes": by_name.get(".symtab", (0,) * 10)[5]}


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
    report["symbols"] = symbols(destination, args.output / "gc-native-symbols.txt")
    report["canResolveMatchingNativeTextSymbols"] = (
        all(report["matches"].values()) and report["symbols"]["counts"]["heap"] > 0
        and report["symbols"]["counts"]["gcRelated"] > 0)
    if not report["canResolveMatchingNativeTextSymbols"]:
        raise ValueError("Matching native GC symbols are unavailable")
    report["limitations"] = [
        "Matching native text and symbols support native instruction-address symbolization only.",
        "No perf permission, sampling support, call-stack unwinding, inline-source resolution, or JIT name mapping has been tested.",
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
