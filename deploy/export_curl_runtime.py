"""Export curl and its non-system shared libraries from the pinned tool image."""
from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
import platform
import shutil
import subprocess
import sys


CURL = Path("/usr/bin/curl")
LOADER = "/lib64/ld-linux-x86-64.so.2"
# Both stages use Bookworm. Preserve the Node image's C runtime and loader.
SYSTEM_LIBRARIES = {
    "libc.so.6",
    "libdl.so.2",
    "libm.so.6",
    "libpthread.so.0",
    "libresolv.so.2",
    "librt.so.1",
    "libutil.so.1",
    "ld-linux-x86-64.so.2",
}


def linked_libraries(output: str) -> set[PurePosixPath]:
    libraries = set()
    for line in output.splitlines():
        if "not found" in line:
            raise RuntimeError("curl tool stage contains an unresolved shared library")
        fields = line.split()
        if len(fields) >= 3 and fields[1] == "=>":
            value = fields[2]
        elif fields and fields[0].startswith("/"):
            value = fields[0]
        else:
            continue
        path = PurePosixPath(value)
        if not path.is_absolute():
            raise RuntimeError("Unexpected curl shared library path")
        if path.name not in SYSTEM_LIBRARIES:
            libraries.add(path)
    return libraries


def export(destination: Path) -> None:
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("The pinned curl tool stage requires linux/amd64")
    result = subprocess.run([LOADER, "--list", str(CURL)], text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"curl library resolution failed: {result.stderr.strip()}")
    libraries = linked_libraries(result.stdout)
    for source in (CURL, *sorted(libraries)):
        source = Path(source)
        # Materialize SONAME files under /usr, preserving the base image's /lib symlink.
        installed_path = source.parent.resolve() / source.name
        if not installed_path.is_relative_to("/usr"):
            raise RuntimeError("curl runtime file is outside the Bookworm /usr tree")
        target = destination / installed_path.relative_to("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target, follow_symlinks=True)
    version = subprocess.run([str(CURL), "--version"], check=True, text=True, capture_output=True).stdout
    manifest = destination / "usr/share/doc/curl/prospector-runtime.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(
        json.dumps(
            {"version": version.splitlines()[0], "libraries": sorted(map(str, libraries))},
            indent=2,
        )
        + "\n"
    )
    print("Exported", version.splitlines()[0], "with", len(libraries), "shared libraries")


if __name__ == "__main__":
    export(Path(sys.argv[1]))
