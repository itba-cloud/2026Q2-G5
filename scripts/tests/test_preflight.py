"""Regression tests for permission reporting; no AWS credentials or calls."""
import argparse
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("preflight", Path(__file__).resolve().parents[1] / "preflight-lobby-serverless.py")
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


def args(**overrides):
    values = dict(region="us-east-1", aws_only=True, local_only=False, json_out=None,
                  lab_role="LabRole", lambda_role="LabRole", workflow_role="LabRole",
                  scheduler_role="LabRole", instance_profile="LabInstanceProfile",
                  postgres_version="18.3", db_instance_class="db.t3.micro",
                  cache_engine_version="7.1", cache_node_type="cache.t3.micro",
                  no_npc_autoscaling=False, state_bucket=None)
    return argparse.Namespace(**(values | overrides))


def response(*argv):
    service, operation = argv[:2]
    if operation == "get-role":
        return {"Role": {"AssumeRolePolicyDocument": {"Statement": [{
            "Effect": "Allow", "Action": "sts:AssumeRole", "Principal": {"Service": [
                "lambda.amazonaws.com", "states.amazonaws.com", "scheduler.amazonaws.com",
                "ec2.amazonaws.com", "ecs-tasks.amazonaws.com", "kinesisanalytics.amazonaws.com"]}}]}}}
    if operation == "get-instance-profile":
        return {"InstanceProfile": {"Roles": [{"RoleName": "LabRole"}]}}
    if operation == "describe-availability-zones":
        return {"AvailabilityZones": [{}, {}]}
    if operation == "describe-orderable-db-instance-options":
        return {"OrderableDBInstanceOptions": [{"MultiAZCapable": True}]}
    if operation == "describe-cache-engine-versions":
        return {"CacheEngineVersions": [{}]}
    return {}


class PreflightTests(unittest.TestCase):
    def run_check(self, options=None, probe=response):
        check = preflight.Preflight(options or args())
        with patch.object(check, "aws", side_effect=probe) as aws, redirect_stdout(io.StringIO()):
            status = check.execute()
        return check, status, aws

    def test_reads_never_certify_writes(self):
        check, status, aws = self.run_check()
        self.assertEqual(status, 2)
        self.assertFalse(any(item["status"] == "BLOCKED" for item in check.results))
        self.assertTrue(any(item["operation"] == "AWS/permisos efectivos" and item["status"] == "PENDING" for item in check.results))
        for call in aws.call_args_list:
            self.assertTrue(call.args[1].startswith(("get-", "describe-", "list-")))

    def test_expired_session_stops_remote_probes_and_saves_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "report.json"
            def expired(*argv):
                raise preflight.CheckError("ExpiredToken")
            check, status, aws = self.run_check(args(json_out=str(output)), expired)
            self.assertEqual(status, 1)
            self.assertEqual(aws.call_count, 1)
            report = json.loads(output.read_text())
            self.assertFalse(report["writes_verified"])
            self.assertEqual(report["results"][0]["evidence"], "ExpiredToken")
            self.assertIn("checked_at", report)

    def test_denial_does_not_hide_other_service_results(self):
        def denied(*argv):
            if argv[0] == "secretsmanager":
                raise preflight.CheckError("AccessDeniedException")
            return response(*argv)
        check, status, aws = self.run_check(probe=denied)
        self.assertEqual(status, 1)
        self.assertTrue(any(item["operation"] == "ecs:ListClusters" and item["status"] == "PASS" for item in check.results))

    def test_empty_catalog_and_missing_multiaz_block(self):
        def empty(*argv):
            if argv[0] == "rds":
                return {"OrderableDBInstanceOptions": []}
            return response(*argv)
        check, status, aws = self.run_check(probe=empty)
        self.assertEqual(status, 1)
        self.assertTrue(any(item["operation"] == "RDS/catálogo Multi-AZ" and item["status"] == "BLOCKED" for item in check.results))

    def test_principal_without_assume_role_is_not_trusted(self):
        check = preflight.Preflight(args())
        policy = {"Role": {"AssumeRolePolicyDocument": {"Statement": [{
            "Effect": "Allow", "Action": "sts:TagSession", "Principal": {"Service": "lambda.amazonaws.com"}}]}}}
        with patch.object(check, "aws", return_value=policy), redirect_stdout(io.StringIO()):
            check.trust("LabRole", ["lambda.amazonaws.com"])
        self.assertEqual(check.results[-1]["status"], "BLOCKED")

    def test_backend_reads_without_versioning_are_blocked(self):
        check, status, aws = self.run_check(args(state_bucket="test-state"))
        self.assertEqual(status, 1)
        self.assertTrue(any(item["operation"] == "backend/s3:GetBucketVersioning" and item["status"] == "BLOCKED" for item in check.results))

    def test_fixed_npc_does_not_query_autoscaling(self):
        check, status, aws = self.run_check(args(no_npc_autoscaling=True))
        self.assertEqual(status, 2)
        self.assertFalse(any(call.args[0] == "application-autoscaling" for call in aws.call_args_list))

    def test_aws_error_does_not_print_credentials_or_stderr(self):
        result = subprocess.CompletedProcess([], 1, "", "An error occurred (AccessDenied) when calling SecretOperation: private-secret-value")
        with patch.object(preflight.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(preflight.CheckError, "^AccessDenied$"):
                preflight.command(["aws", "secretsmanager", "list-secrets"])


if __name__ == "__main__":
    unittest.main()
