"""Rebuilt archives must not change when checkout metadata changes."""
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_archives import normalize_context, normalize_jar


class BuildArchivesTests(unittest.TestCase):
    def test_docker_context_includes_the_root_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root/'source.js';file.write_text('same source')
            program = root/'entrypoint.sh';program.write_text('#!/bin/sh\n')
            root.chmod(0o700);file.chmod(0o600);program.chmod(0o700)
            normalize_context(root)
            self.assertEqual(root.stat().st_mode & 0o777, 0o755)
            self.assertEqual(file.stat().st_mode & 0o777, 0o644)
            self.assertEqual(program.stat().st_mode & 0o777, 0o755)
            self.assertEqual(file.stat().st_mtime, 946684800)

    def test_jar_is_independent_of_order_timestamps_and_umask(self):
        with tempfile.TemporaryDirectory() as directory:
            outputs = []
            for index, order in enumerate([['Main.class', 'META-INF/MANIFEST.MF'], ['META-INF/MANIFEST.MF', 'Main.class']]):
                path = Path(directory) / f'{index}.jar'
                with zipfile.ZipFile(path, 'w') as archive:
                    for name in order:
                        info = zipfile.ZipInfo(name, (2020 + index, 2, 3, 0, 0, 0))
                        info.external_attr = (0o100600 if index else 0o100664) << 16
                        archive.writestr(info, name.encode())
                normalize_jar(path)
                outputs.append(path.read_bytes())
                with zipfile.ZipFile(path) as archive:
                    self.assertEqual(archive.read('Main.class'), b'Main.class')
            self.assertEqual(outputs[0], outputs[1])


if __name__ == '__main__':
    unittest.main()
