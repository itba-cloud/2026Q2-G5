"""Exercise rollback paths with fake CLIs; never sends requests to AWS."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ProbeRollbackTests(unittest.TestCase):
    def workspace(self, base, script):
        root = base / "repo"
        (root / "scripts").mkdir(parents=True)
        shutil.copy2(ROOT / "scripts" / script, root / "scripts" / script)
        shutil.copytree(ROOT / "infra/probes", root / "infra/probes")
        shutil.copy2(ROOT / "infra/.terraform.lock.hcl", root / "infra/.terraform.lock.hcl")
        binary = base / "bin"
        binary.mkdir()
        log = base / "commands.jsonl"
        env = {**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"],
               "PROBE_TEST_COMMAND_LOG": str(log)}
        return root, binary, log, env

    def executable(self, binary, name, body):
        path = binary / name
        path.write_text("#!/usr/bin/env python3\n" + body)
        path.chmod(0o755)

    def test_failed_apply_still_destroys_and_returns_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, binary, log, env = self.workspace(Path(temporary), "check-aws-write-permissions.py")
            self.executable(binary, "terraform", '''import json,os,sys
from pathlib import Path
with open(os.environ["PROBE_TEST_COMMAND_LOG"],"a") as log: log.write(json.dumps(sys.argv[1:])+"\\n")
if sys.argv[1] == "apply":
    Path("terraform.tfstate").write_text("{}")
    sys.exit(1)
if sys.argv[1] == "show": print(json.dumps({"values":{"root_module":{"resources":[]}}}))
''')
            result = subprocess.run(["python3", str(root / "scripts/check-aws-write-permissions.py"), "--execute"],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            calls = [json.loads(line)[0] for line in log.read_text().splitlines()]
            self.assertIn("destroy", calls)
            report = json.loads((root / ".build/tarea-01-probe-result.json").read_text())
            self.assertEqual(report["apply_exit"], 1)
            self.assertEqual(report["destroy_exit"], 0)

    def test_bucket_setup_denial_still_removes_created_bucket(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, binary, log, env = self.workspace(Path(temporary), "check-state-backend.py")
            self.executable(binary, "aws", '''import json,os,sys
with open(os.environ["PROBE_TEST_COMMAND_LOG"],"a") as log: log.write(json.dumps(sys.argv[1:])+"\\n")
if sys.argv[2] == "put-public-access-block":
    print("An error occurred (AccessDenied) when calling PutPublicAccessBlock: test denial",file=sys.stderr)
    sys.exit(1)
print("{}")
''')
            result = subprocess.run(["python3", str(root / "scripts/check-state-backend.py"), "--execute"],
                                    env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            calls = [json.loads(line)[1] for line in log.read_text().splitlines()]
            self.assertIn("list-object-versions", calls)
            self.assertIn("delete-bucket", calls)
            report = json.loads((root / ".build/tarea-01-backend-result.json").read_text())
            self.assertTrue(report["cleaned_up"])
            self.assertTrue(any(item.get("error") == "AccessDenied" for item in report["operations"]))

    def test_unreadable_state_cannot_report_success_after_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, binary, log, env = self.workspace(Path(temporary), "check-aws-write-permissions.py")
            self.executable(binary, "terraform", '''import json,os,sys
from pathlib import Path
with open(os.environ["PROBE_TEST_COMMAND_LOG"],"a") as log: log.write(json.dumps(sys.argv[1:])+"\\n")
if sys.argv[1] == "apply": Path("terraform.tfstate").write_text("{}")
if sys.argv[1] == "show": sys.exit(1)
''')
            result = subprocess.run(["python3", str(root / "scripts/check-aws-write-permissions.py"), "--execute"],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("destroy", [json.loads(line)[0] for line in log.read_text().splitlines()])

    def test_success_requires_api_checks_and_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, binary, log, env = self.workspace(Path(temporary), "check-aws-write-permissions.py")
            self.executable(binary, "terraform", '''import json,os,sys
from pathlib import Path
with open(os.environ["PROBE_TEST_COMMAND_LOG"],"a") as log: log.write(json.dumps(sys.argv[1:])+"\\n")
if sys.argv[1] == "apply": Path("terraform.tfstate").write_text("{}")
if sys.argv[1] == "show":
    resources=[{"mode":"managed","type":kind,"address":kind+".probe","values":values} for kind,values in [
        ("aws_secretsmanager_secret",{"id":"test-secret"}),
        ("aws_cloudwatch_log_group",{"name":"test-logs"})]]
    print(json.dumps({"values":{"root_module":{"resources":resources}}}))
''')
            self.executable(binary, "aws", 'print("{}")\n')
            result = subprocess.run(["python3", str(root / "scripts/check-aws-write-permissions.py"), "--execute"],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((root / ".build/tarea-01-probe-result.json").read_text())
            self.assertEqual(len(report["api_checks"]), 4)
            self.assertTrue(all(check["pass"] for check in report["api_checks"]))
            self.assertEqual(report["destroy_exit"], 0)


if __name__ == "__main__":
    unittest.main()
