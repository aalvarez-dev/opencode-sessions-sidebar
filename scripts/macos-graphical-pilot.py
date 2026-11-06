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


def frame_text(snapshot):
    return "\n".join(
        "".join(span["text"] for span in line) for line in snapshot["frame"]["lines"]
    )


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
    arguments = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    output = Path(arguments.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {
        "schemaVersion": 1,
        "status": "blocked",
        "platform": platform.platform(),
        "scope": "macOS Terminal.app graphical feasibility pilot; ASCII configuration",
        "deadlineSeconds": 180,
        "checks": [],
        "captures": [],
        "limitations": [
            "Not a Ghostty acceptance run or a complete macOS interaction suite.",
            "Default Terminal.app font; pinned Nerd Font rendering is not certified by this pilot.",
            "Synthetic sessions and public plugin commands; no model inference.",
        ],
    }
    fixture = None
    window_id = None
    pid_file = None
    phase = "environment"
    request_id = 0
    try:
        if platform.system() != "Darwin" or os.environ.get("GITHUB_ACTIONS") != "true":
            raise Blocked("Run only on an ephemeral GitHub-hosted macOS runner.")
        def deadline(_signal, _frame):
            raise Blocked("The bounded graphical pilot exceeded 180 seconds.")
        signal.signal(signal.SIGALRM, deadline)
        signal.alarm(180)
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
        report["revision"] = run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()
        plugin = repo / "dist/tui.js"
        report["sourceHashes"] = {
            str(path.relative_to(repo)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (plugin, repo / "scripts/sidebar-probe.ts", Path(__file__).resolve())
        }
        fixture = Path(tempfile.mkdtemp(prefix="sidebar-macos-pilot-"))
        project, config = fixture / "project", fixture / "config"
        storage, exchange = fixture / "sidebar-state", fixture / "exchange"
        for directory in (project, config / "opencode", fixture / "home", fixture / "managed"):
            directory.mkdir(parents=True)
        run(["git", "init", "--initial-branch", "synthetic-macos", str(project)])
        observer = fixture / "observer.mjs"
        run(
            [bun, "build", "scripts/sidebar-probe.ts", "--target", "bun", "--outfile", str(observer)],
            cwd=repo,
            timeout=30,
        )
        (config / "opencode/opencode.json").write_text("{}")
        (config / "opencode/tui.json").write_text(json.dumps({
            "plugin": [
                [plugin.as_uri(), {
                    "hostId": "synthetic-sidebar-runtime",
                    "storageDirectory": str(storage),
                    "icons": "ascii",
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
        }
        launcher, pid_file = fixture / "launch.sh", fixture / "pid"
        launcher.write_text(
            "#!/bin/bash\nset -eu\n"
            + "printf '%s\\n' \"$$\" > " + shlex.quote(str(pid_file)) + "\n"
            + "cd " + shlex.quote(str(project)) + "\n"
            + "exec /usr/bin/env -i "
            + " ".join(shlex.quote(key + "=" + value) for key, value in environment.items())
            + " " + shlex.quote(executable) + "\n"
        )
        launcher.chmod(0o700)
        phase = "terminal-automation"
        launch_script = (
            'tell application "Terminal"\nactivate\n'
            + "do script " + apple_string("/bin/bash " + shlex.quote(str(launcher)))
            + "\nreturn id of front window\nend tell"
        )
        result = run(["/usr/bin/osascript", "-e", launch_script], timeout=20, required=False)
        if result.returncode or not result.stdout.strip().isdigit():
            raise Blocked("Terminal automation unavailable: " + result.stderr[-1500:])
        window_id = int(result.stdout.strip())
        geometry = run([
            "/usr/bin/osascript", "-e",
            'tell application "Terminal"\n'
            f"set number of columns of window id {window_id} to 140\n"
            f"set number of rows of window id {window_id} to 40\nend tell",
        ], timeout=10, required=False)
        report["geometryRequested"] = {"columns": 140, "rows": 40, "accepted": geometry.returncode == 0}
        if geometry.returncode:
            raise Blocked("The pilot could not establish its terminal dimensions: " + geometry.stderr[-1500:])

        phase = "native-startup"
        started = time.monotonic()
        while not Path(str(exchange) + ".ready.json").exists():
            if time.monotonic() - started > 45:
                raise Blocked("Terminal automation returned, but the native TUI observer did not become ready.")
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

        def capture(name, snapshot):
            path = output / (name + ".png")
            # The TUI frame assertion can precede Terminal.app's final window paint.
            time.sleep(0.2)
            result = run([
                "/usr/sbin/screencapture", "-x", "-o", "-l", str(window_id), str(path)
            ], timeout=15, required=False)
            if result.returncode or not path.exists():
                raise Blocked("Window capture unavailable: " + result.stderr[-1500:])
            stats = png_stats(path)
            report["captures"].append({"file": path.name, **stats})
            # Raw frame is supporting evidence, never the source of the PNG.
            clean = json.loads(json.dumps(snapshot).replace(str(fixture), "/synthetic"))
            (output / (name + "-frame.json")).write_text(json.dumps(clean, indent=2) + "\n")

        phase = "native-sidebar"
        until(lambda snapshot: any(
            entry["id"] == "opencode-sessions-sidebar" and entry["active"]
            for entry in snapshot["plugins"]
        ))
        request("seed")
        snapshot = until(lambda current:
            "Active session:" in frame_text(current) and "Synthetic Alpha" in frame_text(current)
        )
        active_id = snapshot["initialIds"][0]
        identifiers = {node["id"] for node in snapshot["geometry"]}
        if "sidebar-session-" + active_id + "-menu" in identifiers:
            raise RuntimeError("The active row unexpectedly contains its ellipsis menu.")
        if "sidebar-session-" + active_id + "-completion" not in identifiers:
            raise RuntimeError("The active row's direct completion control is absent.")
        report["checks"].extend([
            "Stock OpenCode loaded the actual sidebar plugin in Terminal.app.",
            "Synthetic sessions rendered in the native session route.",
            "The active row omits its ellipsis and retains the completion control.",
        ])
        phase = "window-capture"
        capture("macos-terminal-sidebar", snapshot)
        phase = "icon-dialog"
        request("command", command="sessions-sidebar.check-icons")
        snapshot = until(lambda current: "Check sidebar icons" in frame_text(current))
        phase = "window-capture"
        capture("macos-terminal-icon-dialog", snapshot)
        report["checks"].append("The actual icon comparison dialog opened through its public command.")
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
                run([
                    "/usr/bin/osascript", "-e",
                    f'tell application "Terminal" to close window id {window_id} saving no',
                ], timeout=5, required=False)
            except Exception as error:
                report.setdefault("cleanupWarnings", []).append(str(error))
        if fixture:
            shutil.rmtree(fixture, ignore_errors=True)
        (output / "macos-graphical-result.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
    return 1 if report["status"] == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
