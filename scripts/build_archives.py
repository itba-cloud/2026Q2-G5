"""Normalize build archives without changing their payloads."""
import os
from pathlib import Path
import zipfile


def normalize_context(directory):
    directory = Path(directory)
    for path in [directory, *directory.rglob('*')]:
        executable = path.stat().st_mode & 0o111
        path.chmod(0o755 if path.is_dir() or executable else 0o644)
        os.utime(path, (946684800, 946684800))


def normalize_jar(path):
    path = Path(path)
    temporary = path.with_suffix('.normalized.jar')
    with zipfile.ZipFile(path) as source, zipfile.ZipFile(
            temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
        for name in sorted(source.namelist()):
            original = source.getinfo(name)
            entry = zipfile.ZipInfo(name, (2000, 1, 1, 0, 0, 0))
            entry.create_system = 3
            mode = 0o40755 if original.is_dir() else 0o100644
            entry.external_attr = mode << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            target.writestr(entry, source.read(name))
    temporary.replace(path)

