"""Устанавливает закреплённые официальные CLI в .tools с обязательной проверкой SHA-256."""

import hashlib
import argparse
import json
import platform
import tarfile
import tempfile
import urllib.request
import zipfile
import shutil
from pathlib import Path


def main() -> None:
    """Читает --crypto-only, определяет ОС/CPU; возвращает None после установки CLI с проверкой SHA-256."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--crypto-only", action="store_true", help="Только age/rage; для нативной проверки Windows/macOS")
    options = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    system = {"Darwin": "darwin", "Linux": "linux", "Windows": "windows"}.get(platform.system())
    machine = platform.machine().lower()
    arm = machine in ("arm64", "aarch64")
    if system is None or machine not in ("arm64", "aarch64", "x86_64", "amd64"):
        raise SystemExit("Поддерживаются macOS/Linux arm64/x86_64 и Windows x64.")
    if system == "windows" and (arm or not options.crypto_only):
        raise SystemExit("Для Windows поддержан --crypto-only на x64. ARM64 rage требует отдельной нативной проверки.")
    lock = json.loads((root / "scripts/tools-lock.json").read_text())
    for project, record in lock.items():
        name = project.split("/")[-1]
        if options.crypto_only and name == "mailpit":
            continue
        arch = "arm64" if arm else "x86_64" if name == "rage" else "amd64"
        extension = "zip" if system == "windows" else "tar.gz"
        expected = f"rage-{record['tag']}-{arch}-{system}.{extension}" if name == "rage" else f"age-{record['tag']}-{system}-{arch}.{extension}" if name == "age" else f"mailpit-{system}-{arch}.{extension}"
        asset = next((item for item in record["assets"] if item["name"] == expected), None)
        if not asset or not asset["digest"] or not asset["digest"].startswith("sha256:"):
            raise SystemExit(f"Нет закреплённого SHA-256 для {expected}")
        target = root / ".tools" / name
        target.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="gault-tool-") as temporary:
            archive = Path(temporary) / f"release.{extension}"
            urllib.request.urlretrieve(asset["url"], archive)
            actual = hashlib.sha256(archive.read_bytes()).hexdigest()
            if actual != asset["digest"].split(":", 1)[1]:
                raise SystemExit(f"SHA-256 не совпал: {name}. Архив не исполнялся.")
            if extension == "zip":
                with zipfile.ZipFile(archive) as bundle:
                    executables = [item.filename for item in bundle.infolist() if not item.is_dir() and Path(item.filename).name == f"{name}.exe"]
                    if len(executables) != 1:
                        raise SystemExit(f"В проверенном ZIP нет единственного {name}.exe")
                    for item in bundle.infolist():
                        destination = (target / item.filename).resolve()
                        if not destination.is_relative_to(target.resolve()) or (item.external_attr >> 16) & 0o170000 == 0o120000:
                            raise SystemExit("Небезопасный путь/символическая ссылка в ZIP")
                    bundle.extractall(target)
                canonical = target / name / f"{name}.exe"
                source = target / executables[0]
                if source.resolve() != canonical.resolve():
                    canonical.parent.mkdir(exist_ok=True)
                    shutil.copyfile(source, canonical)
            else:
                with tarfile.open(archive) as bundle:
                    bundle.extractall(target, filter="data")
        print(f"{name} {record['tag']}: SHA-256 проверен")


if __name__ == "__main__":
    main()
