"""check-plan-no-secrets.py on fixture plans and purge-legacy-secrets.py with a fake AWS CLI."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
CHECK = ROOT / "scripts" / "check-plan-no-secrets.py"
PURGE = ROOT / "scripts" / "purge-legacy-secrets.py"


def plan(resources, variables=None, declared=None, **extra):
    return {
        "planned_values": {"root_module": {"child_modules": [{"resources": resources}]}},
        "variables": variables or {},
        "configuration": {"root_module": {"variables": declared or {}}},
        "resource_changes": [], "complete": True, **extra,
    }


def resource(address, values, sensitive=None):
    return {"address": address, "values": values, "sensitive_values": sensitive or {}}


class CheckPlanNoSecretsTests(unittest.TestCase):
    def run_check(self, document):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(document, handle)
        try:
            return subprocess.run([sys.executable, str(CHECK), handle.name], capture_output=True, text=True)
        finally:
            os.unlink(handle.name)

    def test_write_only_and_managed_passwords_pass(self):
        result = self.run_check(plan([
            resource("module.data.aws_db_instance.this[0]", {"password": None, "password_wo": None, "manage_master_user_password": True},
                     {"password": True, "password_wo": True}),
            resource("aws_secretsmanager_secret_version.metrics", {"secret_string": "", "secret_string_wo": None, "secret_string_wo_version": 1}),
        ], variables={"metrics_password_version": {"value": 1}}))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_boolean_flags_named_like_secrets_pass(self):
        result = self.run_check(plan([
            resource("aws_secretsmanager_secret.metrics_password", {"name": "ewo-metrics", "force_overwrite_replica_secret": False}),
        ], variables={"rotate_secret": {"value": True}}))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_stored_passwords_fail_without_printing_them(self):
        result = self.run_check(plan([
            resource("aws_db_instance.main", {"password": "hunter2-db"}),
            resource("aws_s3_object.metrics_password", {"key": "metrics_password.txt", "content": "hunter2-metrics"}, {"content": True}),
        ], variables={"metrics_pass": {"value": "hunter2-var"}, "db_username": {"value": "dbadmin"}},
           declared={"metrics_pass": {"sensitive": True}}))
        self.assertEqual(result.returncode, 1)
        for path in ["aws_db_instance.main.password", "aws_s3_object.metrics_password.content", "var.metrics_pass"]:
            self.assertIn(path, result.stdout)
        self.assertNotIn("db_username", result.stdout)
        self.assertNotIn("hunter2", result.stdout + result.stderr)

    def test_state_files_are_checked_too(self):
        state = {"values": {"root_module": {"resources": [resource("aws_db_instance.main", {"password": "hunter2"})]}}}
        result = self.run_check(state)
        self.assertEqual(result.returncode, 1)
        self.assertIn("aws_db_instance.main.password", result.stdout)

    def test_public_ami_and_replica_flag_are_not_secrets(self):
        ami = resource("data.aws_ssm_parameter.ami", {
            "name": "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
            "type": "String", "value": "ami-0123456789abcdef0",
        }, {"value": True})
        ami.update(mode="data", type="aws_ssm_parameter")
        result = self.run_check(plan([
            ami, resource("aws_secretsmanager_secret.metrics", {"force_overwrite_replica_secret": False}),
        ]))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for field, value in [("name", "/app/password"), ("type", "SecureString"), ("value", "hunter2")]:
            private = {**ami, "values": {**ami["values"], field: value}}
            result = self.run_check(plan([private]))
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertNotIn("hunter2", result.stdout + result.stderr)

    def test_password_in_prior_state_still_fails(self):
        previous = {"values": {"root_module": {"resources": [
            resource("aws_db_instance.main", {"password": "hunter2"}),
        ]}}}
        result = self.run_check(plan([], prior_state=previous))
        self.assertEqual(result.returncode, 1)
        self.assertIn("aws_db_instance.main.password", result.stdout)
        self.assertNotIn("hunter2", result.stdout + result.stderr)

    def test_incomplete_or_foreign_documents_are_rejected(self):
        self.assertIn("incomplete", self.run_check(plan([], complete=False)).stderr)
        self.assertIn("Not a plan or state", self.run_check({"format_version": "1.0"}).stderr)


FAKE_AWS = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_AWS_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")
state = json.loads(os.environ["FAKE_AWS_STATE"])
command = args[:2]
if command == ["sts", "get-caller-identity"]:
    print(json.dumps({"Account": state["account"]}))
elif command == ["s3api", "head-bucket"]:
    sys.exit(0 if state["exists"] else 254)
elif command == ["s3api", "get-bucket-tagging"]:
    print(json.dumps({"TagSet": [{"Key": k, "Value": v} for k, v in state["tags"].items()]}))
elif command == ["s3api", "list-object-versions"]:
    print(json.dumps({"Versions": [{"Key": "db_password.txt", "VersionId": "v1"}, {"Key": "db_password.txt", "VersionId": "v2"}],
                      "DeleteMarkers": [{"Key": "metrics_password.txt", "VersionId": "m1"}]}))
elif command in (["s3api", "delete-objects"], ["s3api", "delete-bucket"]):
    print("{}")
else:
    sys.exit(f"unexpected command {args}")
'''


class PurgeLegacySecretsTests(unittest.TestCase):
    def purge(self, *extra, account="123456789012", exists=True, tags=None):
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "aws"
            fake.write_text(FAKE_AWS)
            fake.chmod(0o755)
            log = Path(directory) / "log.jsonl"
            state = {"account": account, "exists": exists,
                     "tags": tags if tags is not None else {"Project": "ewo", "ManagedBy": "bootstrap-buckets.sh"}}
            env = {**os.environ, "PATH": f"{directory}{os.pathsep}{os.environ['PATH']}",
                   "FAKE_AWS_LOG": str(log), "FAKE_AWS_STATE": json.dumps(state)}
            result = subprocess.run([sys.executable, str(PURGE), "--project", "ewo", "--account", "123456789012", *extra],
                                    capture_output=True, text=True, env=env)
            commands = [json.loads(line)[:2] for line in log.read_text().splitlines()] if log.exists() else []
            return result, commands

    def test_dry_run_reports_without_deleting(self):
        result, commands = self.purge()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("3 object versions", result.stdout)
        self.assertNotIn(["s3api", "delete-objects"], commands)
        self.assertNotIn(["s3api", "delete-bucket"], commands)

    def test_confirm_deletes_every_version_then_the_bucket(self):
        result, commands = self.purge("--confirm")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(commands.index(["s3api", "delete-objects"]), commands.index(["s3api", "delete-bucket"]))
        self.assertIn("Deleted ewo-secrets-123456789012", result.stdout)

    def test_refuses_another_account_or_an_unowned_bucket(self):
        result, commands = self.purge("--confirm", account="999999999999")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(commands, [["sts", "get-caller-identity"]])
        result, commands = self.purge("--confirm", tags={"Project": "other"})
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(["s3api", "delete-bucket"], commands)

    def test_missing_bucket_is_nothing_to_do(self):
        result, commands = self.purge("--confirm", exists=False)
        self.assertEqual(result.returncode, 0)
        self.assertIn("Nothing to purge", result.stdout)


if __name__ == "__main__":
    unittest.main()
