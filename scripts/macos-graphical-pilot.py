#!/usr/bin/env python3
"""Bounded Terminal.app feasibility probe on an ephemeral GitHub macOS runner.

This is a graphics pilot, not the complete sidebar acceptance suite. It never
edits TCC, accesses a keychain, grants accessibility permissions, or connects to
an external model. A missing graphical session/permission produces a blocked
receipt, rather than a claimed successful screenshot test.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
import shutil
import signal
import struct
import subprocess
import tempfile
import time
import zlib


class Blocked(Exception):
    pass


MACOS_OBSERVER = r'''
import Foundation
import AppKit
import CoreText
import CoreGraphics
import Vision
import Darwin

func emit(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}

var ownedFontRegistration: URL?
do {
    if CommandLine.arguments.count == 5 && CommandLine.arguments[1] == "profile" {
        let input = URL(fileURLWithPath: CommandLine.arguments[2])
        let command = CommandLine.arguments[3]
        let output = URL(fileURLWithPath: CommandLine.arguments[4])
        guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(input as CFURL) as? [CTFontDescriptor],
              let descriptor = descriptors.first,
              let requestedName = CTFontDescriptorCopyAttribute(descriptor, kCTFontNameAttribute) as? String else {
            throw NSError(domain: "SidebarPilot", code: 1, userInfo: [NSLocalizedDescriptionKey: "The pinned font has no CoreText PostScript descriptor."])
        }
        var sessionRegistrationCreated = false
        if NSFont(name: requestedName, size: 12) == nil {
            var registrationError: Unmanaged<CFError>?
            sessionRegistrationCreated = CTFontManagerRegisterFontsForURL(input as CFURL, .session, &registrationError)
            if sessionRegistrationCreated { ownedFontRegistration = input }
            if let registrationError { _ = registrationError.takeRetainedValue() }
        }
        guard let font = NSFont(name: requestedName, size: 12), font.fontName == requestedName else {
            throw NSError(domain: "SidebarPilot", code: 1, userInfo: [NSLocalizedDescriptionKey: "The installed pinned font did not resolve through AppKit."])
        }
        let resolved = CTFontCreateWithName(font.fontName as CFString, font.pointSize, nil)
        guard let resolvedURL = CTFontCopyAttribute(resolved, kCTFontURLAttribute) as? URL else {
            throw NSError(domain: "SidebarPilot", code: 2, userInfo: [NSLocalizedDescriptionKey: "CoreText did not identify the selected font file."])
        }
        let archive = try NSKeyedArchiver.archivedData(withRootObject: font, requiringSecureCoding: true)
        guard let decoded = try NSKeyedUnarchiver.unarchivedObject(ofClass: NSFont.self, from: archive),
              decoded.fontName == requestedName, decoded.pointSize == font.pointSize else {
            throw NSError(domain: "SidebarPilot", code: 3, userInfo: [NSLocalizedDescriptionKey: "The Terminal profile font archive did not round-trip."])
        }
        func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) throws -> Data {
            try NSKeyedArchiver.archivedData(withRootObject: NSColor(srgbRed: red, green: green, blue: blue, alpha: 1), requiringSecureCoding: true)
        }
        let profile: [String: Any] = [
            "name": output.deletingPathExtension().lastPathComponent,
            "type": "Window Settings", "ProfileCurrentVersion": 2.07,
            "Font": archive, "FontAntialias": true,
            "columnCount": 140, "rowCount": 48,
            "CommandString": command, "RunCommandAsShell": false,
            "BackgroundColor": try color(0.035, 0.035, 0.035),
            "TextColor": try color(0.92, 0.92, 0.92),
            "CursorColor": try color(0.92, 0.92, 0.92),
            "SelectionColor": try color(0.20, 0.30, 0.45),
            "ShowWindowSettingsNameInTitle": true,
            "ShowDimensionsInTitle": true,
            "shellExitAction": 1,
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: profile, format: .xml, options: 0)
        try data.write(to: output, options: .atomic)
        try emit(["postScriptName": requestedName, "family": font.familyName ?? "",
                  "pointSize": font.pointSize, "resolvedFontFile": resolvedURL.path,
                  "fontArchiveRoundTrip": true, "requestedColumns": 140, "requestedRows": 48,
                  "sessionRegistrationCreated": sessionRegistrationCreated,
                  "profile": output.lastPathComponent])
        // Successful setup hands cleanup responsibility back to the Python owner.
        ownedFontRegistration = nil
    } else if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "unregister-font" {
        let input = URL(fileURLWithPath: CommandLine.arguments[2])
        var registrationError: Unmanaged<CFError>?
        let removed = CTFontManagerUnregisterFontsForURL(input as CFURL, .session, &registrationError)
        if let registrationError { _ = registrationError.takeRetainedValue() }
        try emit(["sessionRegistrationRemoved": removed])
    } else if CommandLine.arguments.count > 2 && CommandLine.arguments[1] == "ocr" {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["en-US"]
        request.usesLanguageCorrection = false
        let handler = VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[2]), options: [:])
        try handler.perform([request])
        try emit(["lines": (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }])
    } else {
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let terminal = windows.filter { ($0[kCGWindowOwnerName as String] as? String) == "Terminal" }
        try emit(terminal.map { entry -> [String: Any] in
            ["id": entry[kCGWindowNumber as String] ?? 0,
             "pid": entry[kCGWindowOwnerPID as String] ?? 0,
             "title": entry[kCGWindowName as String] ?? "",
             "bounds": entry[kCGWindowBounds as String] ?? [:]]
        })
    }
} catch {
    if let ownedFontRegistration {
        CTFontManagerUnregisterFontsForURL(ownedFontRegistration as CFURL, .session, nil)
    }
    fputs("Public window/OCR observation failed: \(error)\n", stderr)
    exit(1)
}
'''


def run(arguments, timeout=15, *, cwd=None, env=None, required=True):
    result = subprocess.run(
        arguments,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if required and result.returncode:
        raise RuntimeError(
            f"{Path(arguments[0]).name} exited {result.returncode}: "
            f"{result.stderr[-2000:]} {result.stdout[-1000:]}"
        )
    return result


def apple_string(value):
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def prepare_observer(directory, output):
    """Compile once, outside the two bounded graphical scenarios."""
    receipt = {
        "status": "blocked",
        "sourceSha256": hashlib.sha256(MACOS_OBSERVER.encode()).hexdigest(),
        "timeoutSeconds": 120,
        "platform": platform.platform(),
    }
    try:
        if not (
            platform.system() == "Darwin"
            and os.environ.get("GITHUB_ACTIONS") == "true"
            and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
        ):
            raise Blocked("Compile only on an ephemeral GitHub-hosted macOS runner.")
        directory = directory.resolve()
        directory.mkdir(parents=True, exist_ok=True)
        source, binary = directory / "macos-observer.swift", directory / "macos-observer"
        source.write_text(MACOS_OBSERVER)
        started = time.monotonic()
        compiled = run(["/usr/bin/swiftc", str(source), "-o", str(binary)], timeout=120, required=False)
        receipt["compileMs"] = (time.monotonic() - started) * 1000
        if compiled.returncode:
            raise RuntimeError("Public macOS observer compilation failed: " + compiled.stderr[-2000:])
        receipt.update(status="prepared", binarySha256=hashlib.sha256(binary.read_bytes()).hexdigest())
        (directory / "macos-observer-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    except (Blocked, subprocess.TimeoutExpired) as error:
        receipt["reason"] = str(error)
    except Exception as error:
        receipt.update(status="failed", reason=str(error))
    (output / "macos-observer-preparation.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))
    return 0 if receipt["status"] == "prepared" else 1


def verified_observer(binary):
    if not binary:
        raise Blocked("Prepare the macOS observer once and pass its executable with --observer.")
    binary = binary.resolve()
    receipt = json.loads((binary.parent / "macos-observer-receipt.json").read_text())
    if receipt.get("status") != "prepared" or receipt.get("sourceSha256") != hashlib.sha256(MACOS_OBSERVER.encode()).hexdigest():
        raise RuntimeError("The prepared macOS observer does not match this script's source.")
    if hashlib.sha256(binary.read_bytes()).hexdigest() != receipt.get("binarySha256"):
        raise RuntimeError("The prepared macOS observer binary failed its hash receipt.")
    return binary, receipt


def frame_text(snapshot):
    return "\n".join(
        "".join(span["text"] for span in line) for line in snapshot["frame"]["lines"]
    )


def terminal_pids():
    """Inventory executable identities, without reading command-line arguments."""
    listing = run(["/bin/ps", "-axo", "pid=,comm="], required=False).stdout
    result = set()
    for line in listing.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and fields[1].endswith("/Terminal.app/Contents/MacOS/Terminal"):
            result.add(int(fields[0]))
    return result


def process_ancestors(pid):
    rows = run(["/bin/ps", "-axo", "pid=,ppid="], required=False).stdout.splitlines()
    parents = dict(tuple(map(int, row.split())) for row in rows if len(row.split()) == 2)
    result = set()
    while pid > 1 and pid not in result:
        result.add(pid)
        pid = parents.get(pid, 0)
    return result


def png_stats(path):
    """Check actual screenshot pixels with only Python's standard library."""
    raw = path.read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise Blocked("The screenshot command did not produce a PNG.")
    offset, compressed, palette = 8, bytearray(), b""
    width = height = depth = color = interlace = None
    while offset + 12 <= len(raw):
        size = struct.unpack(">I", raw[offset : offset + 4])[0]
        kind = raw[offset + 4 : offset + 8]
        data = raw[offset + 8 : offset + 8 + size]
        if kind == b"IHDR":
            width, height, depth, color, _, _, interlace = struct.unpack(
                ">IIBBBBB", data
            )
        elif kind == b"IDAT":
            compressed.extend(data)
        elif kind == b"PLTE":
            palette = data
        elif kind == b"IEND":
            break
        offset += size + 12
    if not width or not height or not (200 <= width <= 10000 and 200 <= height <= 10000):
        raise Blocked("No usable terminal window dimensions in the screenshot.")
    if depth != 8 or interlace != 0 or color not in (0, 2, 3, 4, 6):
        raise Blocked("Screenshot pixel format needs independent review; not marked passed.")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    stride = width * channels
    packed = zlib.decompress(compressed)
    if len(packed) != height * (stride + 1):
        raise Blocked("Screenshot pixel data has unexpected dimensions.")
    previous = bytearray(stride)
    unique, sampled, opaque = set(), 0, 0
    for y in range(height):
        start = y * (stride + 1)
        method = packed[start]
        row = bytearray(packed[start + 1 : start + 1 + stride])
        for i in range(stride):
            left = row[i - channels] if i >= channels else 0
            up = previous[i]
            corner = previous[i - channels] if i >= channels else 0
            if method == 1:
                predictor = left
            elif method == 2:
                predictor = up
            elif method == 3:
                predictor = (left + up) // 2
            elif method == 4:
                p = left + up - corner
                a, b, c = abs(p - left), abs(p - up), abs(p - corner)
                predictor = left if a <= b and a <= c else up if b <= c else corner
            elif method == 0:
                predictor = 0
            else:
                raise Blocked("Unsupported PNG scanline filter.")
            row[i] = (row[i] + predictor) & 255
        if y % 3 == 0:
            for x in range(0, width, 3):
                index = x * channels
                pixel = row[index : index + channels]
                sampled += 1
                if color in (4, 6) and pixel[-1] == 0:
                    continue
                opaque += 1
                if color == 3:
                    pixel = palette[pixel[0] * 3 : pixel[0] * 3 + 3]
                elif color in (4, 6):
                    pixel = pixel[:-1]
                unique.add(bytes(value // 16 for value in pixel))
        previous = row
    if len(unique) < 8 or opaque < sampled // 2:
        raise Blocked("The terminal screenshot is blank, transparent, or too uniform.")
    return {
        "width": width,
        "height": height,
        "sampledQuantizedColors": len(unique),
        "sampledPixels": sampled,
        "opaquePixels": opaque,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "bytes": len(raw),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=".sidebar-lab/macos-graphical")
    parser.add_argument("--font-profile", type=Path, help="Pinned TTF for a uniquely named, non-default Terminal profile on the disposable runner.")
    parser.add_argument("--prepare-observer", type=Path, help="Compile the public macOS helper once into this temporary directory.")
    parser.add_argument("--observer", type=Path, help="Prepared macOS helper executable with a matching source/binary receipt.")
    parser.add_argument("--design", action="store_true", help="Capture the explicit synthetic approved-design fixture with the unchanged product renderer.")
    arguments = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    output = Path(arguments.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if arguments.prepare_observer:
        return prepare_observer(arguments.prepare_observer, output)
    report = {
        "schemaVersion": 2,
        "status": "blocked",
        "platform": platform.platform(),
        "scope": "macOS Terminal.app graphical pilot; " + ("pinned Nerd font profile" if arguments.font_profile else "ASCII/default font configuration"),
        "deadlineSeconds": 240,
        "checks": [],
        "captures": [],
        "transportAcceptanceEvaluated": False,
        "nativeExecutionValidated": False,
        "observedHealthWarnings": [],
        "limitations": [
            "Not a Ghostty acceptance run or a complete macOS interaction suite.",
            "Profile/font receipts plus real pixels require visual review; they do not automatically recognize every displayed glyph.",
            "Synthetic sessions and public plugin commands; no model inference.",
        ],
    }
    fixture = None
    window_id = None
    pid_file = None
    mac_observer = None
    registered_font = None
    terminal_before = set()
    phase = "environment"
    request_id = 0
    hosted_mac = (
        platform.system() == "Darwin"
        and os.environ.get("GITHUB_ACTIONS") == "true"
        and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
    )
    try:
        if not hosted_mac:
            raise Blocked("Run only on an ephemeral GitHub-hosted macOS runner.")
        def deadline(_signal, _frame):
            raise Blocked("The bounded graphical pilot exceeded 240 seconds.")
        signal.signal(signal.SIGALRM, deadline)
        signal.alarm(240)
        terminal_before = terminal_pids()
        console = run(["/usr/bin/stat", "-f", "%Su", "/dev/console"]).stdout.strip()
        report["consoleUser"] = console
        if console in ("root", "loginwindow", "_mbsetupuser", ""):
            raise Blocked("The runner has no usable logged-in desktop session.")
        for path in (
            Path("/Library/Managed Preferences/ai.opencode.managed.plist"),
            Path("/Library/Managed Preferences") / console / "ai.opencode.managed.plist",
        ):
            if path.exists():
                raise Blocked("Managed OpenCode configuration prevents an isolated pilot.")
        executable = (
            os.environ.get("SIDEBAR_OPENCODE")
            or os.environ.get("OPENCODE_BIN")
            or shutil.which("opencode")
        )
        bun = os.environ.get("SIDEBAR_BUN") or os.environ.get("BUN_BIN") or shutil.which("bun")
        if not executable or not bun:
            raise Blocked("Pinned OpenCode and Bun executables must be prepared first.")
        executable, bun = str(Path(executable).resolve()), str(Path(bun).resolve())
        if run([executable, "--version"]).stdout.strip() != "1.18.30":
            raise RuntimeError("The pilot requires stock OpenCode 1.18.30.")
        if run([bun, "--version"]).stdout.strip() != "1.3.14":
            raise RuntimeError("The pilot requires Bun 1.3.14.")
        report["opencodeVersion"], report["bunVersion"] = "1.18.30", "1.3.14"
        mac_observer, report["observerPreparation"] = verified_observer(arguments.observer)
        report["revision"] = run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()
        plugin = repo / "dist/tui.js"
        product = plugin
        design_config = None
        if arguments.design:
            if not arguments.font_profile:
                raise Blocked("The approved-design graphical scenario requires the pinned-font profile.")
            design_config = json.loads(run([bun, "scripts/sidebar-design-fixture.ts"], cwd=repo).stdout)
            report["limitations"].extend(design_config["limitations"])
            report["scope"] = "Stock Terminal.app renderer with the shared synthetic approved-design public-read fixture"
        report["sourceHashes"] = {
            str(path.relative_to(repo)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (plugin, repo / "scripts/sidebar-probe.ts", Path(__file__).resolve(), *(
                (repo / "scripts/sidebar-design-fixture.ts", repo / "scripts/sidebar-design-wrapper.ts", repo / "scripts/check-sidebar-design.ts", repo / "scripts/lib/macos-design-relay.ts", repo / "scripts/lib/terminal-design-input.ts", repo / "src/ui/end-label.tsx") if arguments.design else ()
            ))
        }
        fixture = Path(tempfile.mkdtemp(prefix="sidebar-macos-pilot-"))
        project, config = fixture / ("opencode-sessions-sidebar" if arguments.design else "project"), fixture / "config"
        storage, exchange = fixture / "sidebar-state", fixture / "exchange"
        for directory in (project, config / "opencode", fixture / "home", fixture / "managed"):
            directory.mkdir(parents=True)
        run(["git", "init", "--initial-branch", "feat/continuista-sidebar" if arguments.design else "synthetic-macos", str(project)])
        observer = fixture / "observer.mjs"
        run(
            [bun, "build", "scripts/sidebar-probe.ts", "--target", "bun", "--outfile", str(observer)],
            cwd=repo,
            timeout=30,
        )
        if arguments.design:
            plugin = fixture / "design-wrapper.mjs"
            run([bun, "build", "scripts/sidebar-design-wrapper.ts", "--target", "bun", "--outfile", str(plugin)], cwd=repo, timeout=30)
            report["wrapperSha256"] = hashlib.sha256(plugin.read_bytes()).hexdigest()
        (config / "opencode/opencode.json").write_text(json.dumps({"agent": design_config["agent"]} if design_config else {}))
        (config / "opencode/tui.json").write_text(json.dumps({
            "plugin": [
                [plugin.as_uri(), {
                    "hostId": "synthetic-sidebar-runtime",
                    "storageDirectory": str(storage),
                    "icons": "nerd" if arguments.font_profile else "ascii",
                    "density": "balanced",
                }],
                observer.as_uri(),
            ]
        }))
        environment = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "TERM": "xterm-256color",
            "LANG": "en_US.UTF-8",
            "OPENCODE_TEST_HOME": str(fixture / "home"),
            "OPENCODE_TEST_MANAGED_CONFIG_DIR": str(fixture / "managed"),
            "XDG_CONFIG_HOME": str(config),
            "XDG_DATA_HOME": str(fixture / "data"),
            "XDG_CACHE_HOME": str(fixture / "cache"),
            "XDG_STATE_HOME": str(fixture / "state"),
            "OPENCODE_DISABLE_MODELS_FETCH": "true",
            "OPENCODE_DISABLE_AUTOUPDATE": "true",
            "OPENCODE_DISABLE_PROJECT_CONFIG": "true",
            "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true",
            "SIDEBAR_SMOKE_EXCHANGE": str(exchange),
            "SIDEBAR_SMOKE_DIRECTORY": str(project),
            "SIDEBAR_SMOKE_STORAGE": str(storage),
            **({
                "SIDEBAR_DESIGN": "true", "SIDEBAR_DESIGN_PRODUCT": str(product),
                "SIDEBAR_DESIGN_OPENCODE": executable,
                "SIDEBAR_DESIGN_RELAY_EXCHANGE": str(fixture / "relay"),
                "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
            } if arguments.design else {}),
        }
        launcher, pid_file = fixture / (fixture.name + ".command"), fixture / "pid"
        launcher.write_text(
            "#!/bin/bash\nset -eu\n"
            + "printf '%s\\n' \"$$\" > " + shlex.quote(str(pid_file)) + "\n"
            + "cd " + shlex.quote(str(project)) + "\n"
            # Public terminal control sequences: a unique title and optional
            # window-size request. Actual geometry is read back from the TUI.
            + "printf '\\033]2;" + fixture.name + "\\007\\033[8;" + ("48" if arguments.font_profile else "40") + ";140t'\n"
            + "exec /usr/bin/env -i "
            + " ".join(shlex.quote(key + "=" + value) for key, value in environment.items())
            + " " + (shlex.quote(bun) + " " + shlex.quote(str(repo / "scripts/lib/macos-design-relay.ts")) if arguments.design else shlex.quote(executable)) + "\n"
        )
        launcher.chmod(0o700)
        phase = "terminal-automation"
        launch_script = (
            'tell application "Terminal"\nactivate\n'
            + "do script " + apple_string("/bin/bash " + shlex.quote(str(launcher)))
            + "\nreturn id of front window\nend tell"
        )
        try:
            if arguments.font_profile:
                # The selected-font case uses a named document/profile directly.
                # It must not accidentally inherit an existing/default window.
                raise Blocked("Use LaunchServices with the owned .terminal profile.")
            result = run(["/usr/bin/osascript", "-e", launch_script], timeout=20, required=False)
            if result.returncode or not result.stdout.strip().isdigit():
                report["appleEvents"] = {"status": "unavailable", "reason": result.stderr[-1500:]}
            else:
                window_id = int(result.stdout.strip())
                report["launchMethod"] = "Apple Events: Terminal do script"
                geometry = run([
                    "/usr/bin/osascript", "-e",
                    'tell application "Terminal"\n'
                    f"set number of columns of window id {window_id} to 140\n"
                    f"set number of rows of window id {window_id} to 40\nend tell",
                ], timeout=10, required=False)
                report["geometryRequested"] = {"columns": 140, "rows": 40, "accepted": geometry.returncode == 0}
        except subprocess.TimeoutExpired:
            report["appleEvents"] = {"status": "unavailable", "reason": "The normal Apple Events request timed out; no permission was granted or modified."}
        except Blocked:
            report["appleEvents"] = {"status": "not-used", "reason": "Pinned font scenario opens its own .terminal profile through LaunchServices."}

        # Standard LaunchServices document opening does not require scripting
        # Terminal.app. It is a separate supported launch route, not a change to
        # any privacy/accessibility policy. CoreGraphics still respects capture
        # permissions; absent window metadata/capture stays explicitly blocked.
        if not window_id:
            phase = "launchservices-fallback"
            def visible_windows():
                observed = run([str(mac_observer)], timeout=10, required=False)
                if observed.returncode:
                    raise Blocked("Public CoreGraphics window discovery unavailable: " + observed.stderr[-1500:])
                return json.loads(observed.stdout)

            before = {window["id"] for window in visible_windows()}
            launch_document = launcher
            if arguments.font_profile:
                phase = "pinned-terminal-profile"
                font_file = arguments.font_profile.resolve()
                manifest = json.loads((repo / "assets/fonts/manifest.json").read_text())
                candidates = [entry for entry in manifest["files"] if entry["name"] == font_file.name]
                if len(candidates) != 1:
                    raise RuntimeError("The requested profile font is not the package's pinned font.")
                expected_hash = candidates[0]["sha256"]
                if hashlib.sha256(font_file.read_bytes()).hexdigest() != expected_hash:
                    raise RuntimeError("The requested profile font failed its pinned hash check.")
                launch_document = fixture / (fixture.name + ".terminal")
                profile = run([str(mac_observer), "profile", str(font_file), "/bin/bash " + shlex.quote(str(launcher)), str(launch_document)], timeout=20, required=False)
                if profile.returncode:
                    raise Blocked("The selected Terminal font profile could not be prepared: " + profile.stderr[-1500:])
                font_receipt = json.loads(profile.stdout)
                if font_receipt.get("sessionRegistrationCreated"):
                    registered_font = font_file
                resolved_file = Path(font_receipt["resolvedFontFile"])
                if hashlib.sha256(resolved_file.read_bytes()).hexdigest() != expected_hash:
                    raise RuntimeError("AppKit/CoreText selected a different font file than the pinned bundle.")
                report["fontProfile"] = {
                    **font_receipt, "sha256": expected_hash,
                    "profileSha256": hashlib.sha256(launch_document.read_bytes()).hexdigest(),
                    "source": "Uniquely named .terminal document opened through LaunchServices",
                    "defaultProfileChanged": False,
                    "pixelReviewRequired": True,
                    "selectionEvidence": "The owned native process starts from this profile's unique CommandString; the NSFont archive resolves to the hash-verified installed file.",
                }
                # Preserve exact generated bytes for the hash receipt. The .plist
                # extension avoids treating this evidence file as a launchable document.
                shutil.copy2(launch_document, output / "terminal-profile.plist")
            # Do not launch a duplicate native client if the first route managed
            # to start the owned command before its Apple Event response hung.
            if not pid_file.exists():
                opened = run(["/usr/bin/open", "-a", "Terminal", str(launch_document)], timeout=10, required=False)
                if opened.returncode:
                    raise Blocked("LaunchServices could not open the owned command: " + opened.stderr[-1500:])
                report["launchMethod"] = "LaunchServices: open owned .terminal profile" if arguments.font_profile else "LaunchServices: open owned .command"
            else:
                report["launchMethod"] = "Apple Events started command; CoreGraphics observation"
            started = time.monotonic()
            while time.monotonic() - started < 25:
                if pid_file.exists():
                    launch_pid = int(pid_file.read_text().strip())
                    ancestors = process_ancestors(launch_pid)
                    owned = [window for window in visible_windows() if window["pid"] in ancestors]
                    # Opening Terminal can also create its ordinary startup
                    # window. Prefer the unique fixture/profile title before
                    # considering newly created windows from the same app PID.
                    candidates = [window for window in owned if fixture.name in window["title"]]
                    if len(candidates) != 1:
                        candidates = [window for window in owned if window["id"] not in before]
                    if not candidates and len(owned) == 1:
                        candidates = owned
                    if len(candidates) == 1:
                        selected = candidates[0]
                        window_id = int(selected["id"])
                        report["windowIdentity"] = {
                            "method": "public CoreGraphics window list plus owned process ancestry",
                            "windowId": window_id,
                            "ownerPid": selected["pid"],
                            "launchPid": launch_pid,
                            "newWindow": window_id not in before,
                            "uniqueTitleMatch": fixture.name in selected["title"],
                            "soleOwnedTerminalWindow": len(owned) == 1,
                        }
                        break
                time.sleep(0.2)
            if not window_id:
                raise Blocked("LaunchServices did not expose an unambiguously owned Terminal window through public CoreGraphics.")

        phase = "native-startup"
        started = time.monotonic()
        while not Path(str(exchange) + ".ready.json").exists():
            if time.monotonic() - started > 45:
                raise Blocked("The launch route returned, but the native TUI observer did not become ready.")
            time.sleep(0.1)

        def request(kind, **fields):
            nonlocal request_id
            request_id += 1
            temporary = Path(str(exchange) + ".request.tmp")
            temporary.write_text(json.dumps({"id": request_id, "type": kind, **fields}))
            temporary.replace(Path(str(exchange) + ".request.json"))
            started = time.monotonic()
            while time.monotonic() - started < 15:
                response_path = Path(str(exchange) + ".response.json")
                if response_path.exists():
                    response = json.loads(response_path.read_text())
                    if response.get("id") == request_id:
                        if not response.get("ok"):
                            raise RuntimeError(response.get("error", "Observer request failed."))
                        return response["result"]
                time.sleep(0.025)
            raise RuntimeError("Native observer request timed out: " + kind)

        def until(predicate):
            started = time.monotonic()
            while time.monotonic() - started < 20:
                snapshot = request("snapshot")
                if predicate(snapshot):
                    return snapshot
                time.sleep(0.1)
            raise RuntimeError("Expected native sidebar frame did not appear.")

        def close_design_onboarding(snapshot):
            # The frame identifies the stock close button. Input travels through
            # the actual owned PTY; no host callback or private state is changed.
            if "Getting started" not in frame_text(snapshot):
                return snapshot
            lines = frame_text(snapshot).splitlines()
            candidates = [(line.index("✕") + 1, row + 1) for row, line in enumerate(lines) if "Getting started" in line and "✕" in line]
            if len(candidates) != 1:
                raise RuntimeError("The native onboarding close button is not unambiguously visible.")
            column, row = candidates[0]
            relay = fixture / "relay"
            temporary = Path(str(relay) + ".request.tmp")
            temporary.write_text(json.dumps({"id": 1, "type": "close-native-onboarding", "column": column, "row": row}))
            temporary.replace(Path(str(relay) + ".request.json"))
            started = time.monotonic()
            response = Path(str(relay) + ".response.json")
            while not response.exists():
                if time.monotonic() - started > 10:
                    raise RuntimeError("The owned native PTY did not acknowledge the onboarding close click.")
                time.sleep(0.025)
            receipt = json.loads(response.read_text())
            if receipt.get("id") != 1 or not receipt.get("ok"):
                raise RuntimeError("Unexpected design input acknowledgement.")
            closed = until(lambda current: "Getting started" not in frame_text(current))
            report["designOnboardingInput"] = receipt
            report["checks"].append("Native onboarding closes through its observed button and the owned PTY input relay.")
            return closed

        def capture(name, snapshot, expected_text):
            path = output / (name + ".png")
            # The TUI frame assertion can precede Terminal.app's final window paint.
            time.sleep(0.2)
            result = run([
                "/usr/sbin/screencapture", "-x", "-o", "-l", str(window_id), str(path)
            ], timeout=15, required=False)
            if result.returncode or not path.exists():
                raise Blocked("Window capture unavailable: " + result.stderr[-1500:])
            stats = png_stats(path)
            recognition = run([str(mac_observer), "ocr", str(path)], timeout=20, required=False)
            if recognition.returncode:
                raise Blocked("Screenshot exists but native offline OCR could not correlate its pixels: " + recognition.stderr[-1500:])
            recognized = json.loads(recognition.stdout)
            normalized = "".join(character.lower() for character in " ".join(recognized["lines"]) if character.isalnum())
            expected = "".join(character.lower() for character in expected_text if character.isalnum())
            (output / (name + "-ocr.json")).write_text(json.dumps(recognized, indent=2) + "\n")
            if expected not in normalized:
                raise Blocked("Screenshot needs visual review: native offline OCR did not find expected text: " + expected_text)
            warnings = [line.strip() for line in frame_text(snapshot).splitlines() if "Session data incomplete" in line]
            report["observedHealthWarnings"].extend({"capture": name, "text": warning, "snapshotTiming": snapshot.get("timing")} for warning in warnings)
            report["captures"].append({
                "file": path.name, **stats,
                "snapshotTiming": snapshot.get("timing"),
                "visibleHealthWarnings": warnings,
                "pixelCorrelation": {"method": "macOS Vision offline OCR", "expectedText": expected_text, "matched": True},
            })
            # Raw frame is supporting evidence, never the source of the PNG.
            clean = json.loads(json.dumps(snapshot).replace(str(fixture), "/synthetic"))
            (output / (name + "-frame.json")).write_text(json.dumps(clean, indent=2) + "\n")

        phase = "native-sidebar"
        until(lambda snapshot: any(
            entry["id"] == "opencode-sessions-sidebar" and entry["active"]
            for entry in snapshot["plugins"]
        ))
        request("seed")
        snapshot = until(lambda current: current["route"].get("params", {}).get("sessionID") == current["initialIds"][0])
        report["actualGeometry"] = {"columns": snapshot["frame"]["width"], "rows": snapshot["frame"]["height"]}
        if arguments.font_profile:
            report["checks"].append("The owned .terminal profile launches the native process with a round-tripped NSFont archive resolving to the pinned file hash.")
        report["checks"].extend([
            "Stock OpenCode loaded the actual sidebar plugin in Terminal.app.",
            "Synthetic sessions rendered in the native session route.",
        ])
        expected_title = "Preparar la próxima versión" if arguments.design else "Synthetic Alpha"
        if arguments.design and snapshot["frame"]["width"] < 140:
            raise Blocked("The approved-design fixture requires the wide native sidebar; Browse is not substitute evidence.")
        if snapshot["frame"]["width"] >= 140:
            snapshot = until(lambda current:
                "Active session:" in frame_text(current) and expected_title in frame_text(current)
            )
            active_id = snapshot["initialIds"][0]
            identifiers = {node["id"] for node in snapshot["geometry"]}
            if "sidebar-session-" + active_id + "-menu" in identifiers:
                raise RuntimeError("The active row unexpectedly contains its ellipsis menu.")
            if "sidebar-session-" + active_id + "-completion" not in identifiers:
                raise RuntimeError("The active row's direct completion control is absent.")
            report["checks"].append("The active row omits its ellipsis and retains the completion control.")
            initial_capture = "macos-approved-design" if arguments.design else "macos-terminal-sidebar"
        else:
            request("command", command="sessions-sidebar.browse")
            snapshot = until(lambda current: current["dialogDepth"] > 0 and "Synthetic Alpha" in frame_text(current))
            report["checks"].append("The public Browse command presents synthetic sessions in the runner's actual narrow terminal.")
            report["limitations"].append("Terminal resize was not established at 140 columns; this macOS pilot covers Browse and icons, not wide-sidebar row geometry.")
            initial_capture = "macos-terminal-browse"
        phase = "window-capture"
        if arguments.design:
            snapshot = close_design_onboarding(snapshot)
        report["nativeOnboardingVisible"] = "Getting started" in frame_text(snapshot)
        report["visibleGroupLabels"] = [name for name in ("Later", "Pinned sessions", "Other sessions") if name in frame_text(snapshot)]
        if report["nativeOnboardingVisible"]:
            report["limitations"].append("Native Getting started remains visible; its panel can reduce the sidebar viewport. No host onboarding state was edited.")
        if arguments.design:
            snapshot = until(lambda current: any(node["id"] == "sidebar-child-" + current["design"]["ids"]["backend"] and node["height"] == 1 for node in current["geometry"]))
            design_frame = output / "approved-design-frame.json"
            design_frame.write_text(json.dumps(snapshot, indent=2) + "\n")
            result = run([bun, "scripts/check-sidebar-design.ts", str(design_frame)], cwd=repo, timeout=20, required=False)
            if result.returncode:
                # Keep the actual pixels even when semantic/layout assertions fail.
                capture("macos-approved-design-failed", snapshot, expected_title)
                raise RuntimeError("Approved-design geometry/color checks failed: " + result.stderr[-3000:])
            report["designAcceptance"] = json.loads(result.stdout)
            report["checks"].extend(report["designAcceptance"]["checks"])
            if snapshot["design"]["productSha256"] != report["sourceHashes"]["dist/tui.js"]:
                raise RuntimeError("Design wrapper did not render the measured product binary.")
        capture(initial_capture, snapshot, expected_title)
        if not arguments.design:
            phase = "icon-dialog"
            request("command", command="sessions-sidebar.check-icons")
            snapshot = until(lambda current: "Check sidebar icons" in frame_text(current))
            phase = "window-capture"
            capture("macos-terminal-icon-dialog", snapshot, "Check sidebar icons")
            report["checks"].append("The actual icon comparison dialog opened through its public command.")
        for source_path, expected_hash in report["sourceHashes"].items():
            if hashlib.sha256((repo / source_path).read_bytes()).hexdigest() != expected_hash:
                raise RuntimeError("A measured source or plugin changed while the pilot was running.")
        verified_observer(mac_observer)
        if report["observedHealthWarnings"]:
            report["limitations"].append("Session-data health warnings appeared without an intentional transport cut. They are retained for investigation; this font/graphics pilot does not pass transport acceptance.")
        report["status"] = "passed"
    except (Blocked, subprocess.TimeoutExpired) as error:
        report["status"], report["reason"] = "blocked", str(error)
    except Exception as error:
        report["status"], report["reason"] = "failed", str(error)
    finally:
        signal.alarm(0)
        report["lastPhase"] = phase
        # Stop only descendants of this fixture's recorded process. Never kill by
        # executable name, close other windows, or change system permissions.
        if pid_file and pid_file.exists():
            try:
                parent = int(pid_file.read_text().strip())
                rows = run(["/bin/ps", "-axo", "pid=,ppid="], required=False).stdout.splitlines()
                pairs = [tuple(map(int, row.split())) for row in rows if len(row.split()) == 2]
                owned = {parent}
                while True:
                    more = {pid for pid, ppid in pairs if ppid in owned} - owned
                    if not more:
                        break
                    owned.update(more)
                for pid in sorted(owned, reverse=True):
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            except Exception as error:
                report.setdefault("cleanupWarnings", []).append(str(error))
        if window_id:
            try:
                if not report.get("appleEvents"):
                    run([
                        "/usr/bin/osascript", "-e",
                        f'tell application "Terminal" to close window id {window_id} saving no',
                    ], timeout=5, required=False)
            except Exception as error:
                report.setdefault("cleanupWarnings", []).append(str(error))
        if hosted_mac:
            try:
                # This single-job ephemeral desktop had no user Terminal window
                # to preserve for these newly created app processes. Existing
                # Terminal PIDs, if any, are never terminated.
                for pid in terminal_pids() - terminal_before:
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            except Exception as error:
                report.setdefault("cleanupWarnings", []).append(str(error))
        if mac_observer and registered_font:
            try:
                removed = run([str(mac_observer), "unregister-font", str(registered_font)], timeout=10, required=False)
                report["fontRegistrationCleanup"] = json.loads(removed.stdout) if removed.returncode == 0 else {"error": removed.stderr[-1000:]}
            except Exception as error:
                report.setdefault("cleanupWarnings", []).append(str(error))
        if fixture:
            shutil.rmtree(fixture, ignore_errors=True)
        (output / "macos-graphical-result.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
    return 1 if report["status"] == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
