#!/usr/bin/env python3
"""Build and verify the single-root OpenHome Ability upload archive."""

from pathlib import Path
from hashlib import sha256
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


PROJECT_DIR = Path(__file__).resolve().parents[1]
ABILITY_NAME = "openhome-gpt-live"
ABILITY_DIR = PROJECT_DIR / "openhome-ability" / ABILITY_NAME
OUTPUT_FILE = PROJECT_DIR / "dist" / "openhome-gpt-live-ability.zip"
CHECKSUM_FILE = PROJECT_DIR / "dist" / "openhome-gpt-live-ability.zip.sha256"
ABILITY_FILES = (
    "__init__.py",
    "main.py",
    "background.py",
    "devkit_functions.py",
    "requirements.txt",
    "README.md",
)


def main():
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(OUTPUT_FILE, "w", compression=ZIP_DEFLATED) as archive:
        for filename in ABILITY_FILES:
            source = ABILITY_DIR / filename
            if not source.is_file():
                raise FileNotFoundError(f"Missing Ability file: {source}")
            data = source.read_bytes()
            info = ZipInfo(f"{ABILITY_NAME}/{filename}", date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)

    with ZipFile(OUTPUT_FILE) as archive:
        names = archive.namelist()
        roots = {name.split("/", 1)[0] for name in names}
        if roots != {ABILITY_NAME} or any("/" not in name for name in names):
            raise RuntimeError(f"Ability archive must have one top-level directory: {names}")
        if set(names) != {f"{ABILITY_NAME}/{name}" for name in ABILITY_FILES}:
            raise RuntimeError(f"Ability archive contains unexpected files: {names}")

    digest = sha256(OUTPUT_FILE.read_bytes()).hexdigest()
    CHECKSUM_FILE.write_text(f"{digest}  {OUTPUT_FILE.name}\n", encoding="utf-8")

    print(OUTPUT_FILE)
    print(CHECKSUM_FILE)


if __name__ == "__main__":
    main()
