"""Exercise Actions operations with fake CLIs, without a session or network."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

FAKE = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
tool=Path(sys.argv[0]).name
args=sys.argv[1:]
with open(os.environ['ACTIONS_TEST_LOG'],'a') as handle:
    handle.write(json.dumps([tool,*args])+'\n')
if tool=='aws':
    if args[:2]==['sts','get-caller-identity']:
        print(json.dumps({'Account':os.getenv('ACTIONS_TEST_ACCOUNT','123456789012')}))
    elif args[1] in ('head-bucket','head-object'):
        key='ACTIONS_TEST_BUCKET' if args[1]=='head-bucket' else 'ACTIONS_TEST_STATE'
        if os.getenv(key,'yes')=='no':
            print('An error occurred (404) when calling Head: Not Found',file=sys.stderr)
            sys.exit(1)
        print('{}')
    elif args[1]=='get-bucket-tagging':
        print(json.dumps({'TagSet':[{'Key':'ManagedBy','Value':'elastic-worlds-task-09'}]}))
    else: print('{}')
elif tool=='terraform':
    args=[a for a in args if not a.startswith('-chdir=')]
    if args[:2]==['state','pull']:
        project=os.getenv('ACTIONS_TEST_PROJECT','ewo-evaluacion')
        state={'outputs':{'snapshot_bucket_name':{'value':project+'-snapshots-123456789012'}}}
        if os.getenv('ACTIONS_TEST_PARTIAL'):
            state={'resources':[{'mode':'managed','type':'terraform_data','name':'lab_buckets',
                                'instances':[{'attributes':{'input':{'value':{'project':project},
                                    'type':['object',{'project':'string'}]}}}]}]}
        print(json.dumps(state))
    elif args[0]=='plan':
        Path(next(a[5:] for a in args if a.startswith('-out='))).write_text('saved-plan')
    elif args[0]=='show':
        plan={'planned_values':{'root_module':{'resources':[]}},'resource_changes':[
            {'mode':'managed','type':'aws_s3_bucket','address':'aws_s3_bucket.demo',
             'change':{'actions':['create']}}]}
        if os.getenv('ACTIONS_TEST_SECRET'):
            plan['planned_values']['root_module']['resources']=[
                {'mode':'managed','type':'aws_db_instance','address':'aws_db_instance.demo',
                 'values':{'password':'NEVER-PUBLISH-THIS'},'sensitive_values':{}}]
        print(json.dumps(plan))
    elif args[0]=='apply' and os.getenv('ACTIONS_TEST_FAIL_APPLY'):
        sys.exit(1)
    elif args[0]=='output':
        print(json.dumps({'client_website_url':{'value':'http://example.test'},
                          'alb_url':{'value':'http://api.example.test'},
                          'extra':{'value':'NEVER-PUBLISH-THIS'}}))
'''


class ActionsTests(unittest.TestCase):
    def operation(self, operation='deploy', project='ewo-evaluacion', **settings):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / 'bin'
            binary.mkdir()
            for tool in ('aws', 'terraform', 'npm'):
                path = binary / tool
                path.write_text(FAKE)
                path.chmod(0o755)
            log = root / 'commands.jsonl'
            summary = root / 'summary.md'
            env = {**os.environ, 'PATH': str(binary) + os.pathsep + os.environ['PATH'],
                   'AWS_ACCOUNT_ID': '123456789012', 'AWS_REGION': 'us-east-1',
                   'AWS_STATE_BUCKET': '', 'ACTIONS_TEST_LOG': str(log),
                   'GITHUB_STEP_SUMMARY': str(summary), 'GITHUB_REPOSITORY': 'example/worlds',
                   'RUNNER_TEMP': str(root), **settings}
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/terraform-actions.py'),
                                     operation, '--project', project], capture_output=True, text=True, env=env)
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            text = summary.read_text() if summary.exists() else ''
            self.assertFalse(list(root.glob('ewo-actions-*')), 'Temporary plans must be removed even on failure')
            return result, calls, text

    @staticmethod
    def terraform(calls, operation):
        return [call for call in calls if call[:3] == ['terraform', '-chdir=infra', operation]]

    def test_deploy_creates_backend_and_applies_exact_saved_plan(self):
        result, calls, text = self.operation(ACTIONS_TEST_BUCKET='no', ACTIONS_TEST_STATE='no')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(any(c[:3] == ['aws', 's3api', 'create-bucket'] for c in calls))
        plan = self.terraform(calls, 'plan')[0]
        saved = next(a[5:] for a in plan if a.startswith('-out='))
        self.assertEqual(self.terraform(calls, 'apply')[0][-1], saved)
        self.assertIn('http://example.test/dashboard.html', text)
        self.assertIn('https://github.com/example/worlds/blob/main/.docs/guia-usuario.md', text)
        self.assertIn('ewo-evaluacion-metrics-password', text)
        self.assertNotIn('NEVER-PUBLISH-THIS', text + result.stdout + result.stderr)

    def test_plan_reads_backend_without_mutating_it_or_applying(self):
        result, calls, text = self.operation('plan')
        self.assertEqual(result.returncode, 0, result.stderr)
        writes = [c for c in calls if c[:2] == ['aws', 's3api'] and c[2].startswith(('put-', 'create-', 'delete-'))]
        self.assertEqual(writes, [])
        self.assertFalse(self.terraform(calls, 'apply'))
        self.assertIn('No se ejecutó apply', text)

    def test_wrong_aws_account_stops_before_backend_or_terraform(self):
        result, calls, _ = self.operation(ACTIONS_TEST_ACCOUNT='999999999999')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 1)

    def test_wrong_project_stops_before_any_plan(self):
        result, calls, _ = self.operation(ACTIONS_TEST_PROJECT='another-world')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.terraform(calls, 'plan'))
        self.assertIn('project_name no coincide', result.stderr)

    def test_partial_deploy_can_resume_with_matching_bootstrap_identity(self):
        result, calls, _ = self.operation(ACTIONS_TEST_PARTIAL='yes')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.terraform(calls, 'apply'))

    def test_partial_deploy_cannot_change_project(self):
        result, calls, _ = self.operation(ACTIONS_TEST_PARTIAL='yes', ACTIONS_TEST_PROJECT='other')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.terraform(calls, 'plan'))

    def test_plan_cannot_create_a_missing_backend(self):
        result, calls, _ = self.operation('plan', ACTIONS_TEST_BUCKET='no')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c[:3] == ['aws', 's3api', 'create-bucket'] for c in calls))
        self.assertFalse(self.terraform(calls, 'init'))

    def test_destroy_requires_an_existing_state(self):
        result, calls, _ = self.operation('destroy', ACTIONS_TEST_STATE='no')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.terraform(calls, 'init'))

    def test_destroy_uses_saved_destroy_plan_and_preserves_backend(self):
        result, calls, text = self.operation('destroy')
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = self.terraform(calls, 'plan')[0]
        self.assertIn('-destroy', plan)
        self.assertEqual(self.terraform(calls, 'apply')[0][-1], next(a[5:] for a in plan if a.startswith('-out=')))
        self.assertFalse(any(c[:3] == ['aws', 's3api', 'delete-bucket'] for c in calls))
        self.assertIn('buckets de datos/artefactos se conservan', text)

    def test_secret_in_plan_blocks_apply_and_is_not_published(self):
        result, calls, text = self.operation(ACTIONS_TEST_SECRET='yes')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.terraform(calls, 'apply'))
        self.assertNotIn('NEVER-PUBLISH-THIS', text + result.stdout + result.stderr)

    def test_failed_apply_keeps_state_and_cleans_local_plan(self):
        result, calls, text = self.operation(ACTIONS_TEST_FAIL_APPLY='yes')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c[:3] == ['aws', 's3api', 'delete-bucket'] for c in calls))
        self.assertIn('Se conserva el backend', text)

    def test_invalid_project_is_rejected_before_running_commands(self):
        result, calls, _ = self.operation(project='unsafe; echo bad')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
