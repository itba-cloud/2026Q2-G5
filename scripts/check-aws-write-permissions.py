#!/usr/bin/env python3
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone

import argparse
parser=argparse.ArgumentParser(description="Create and remove disposable AWS resources to verify write permissions.")
parser.add_argument("--execute", action="store_true", help="Run real AWS creation and cleanup; requires a live session")
parser.add_argument("--region", default="us-east-1")
args=parser.parse_args()
if not args.execute:
    parser.error("Pass --execute to run real resource creation and cleanup")
root=Path(__file__).resolve().parents[1]
(root/'.build').mkdir(exist_ok=True)
(root/'.build/terraform-provider-cache').mkdir(exist_ok=True)
folder=Path(tempfile.mkdtemp(prefix='tarea-01-probe-',dir=root/'.build'))
name='ewo-permisos-'+datetime.now(timezone.utc).strftime('%m%d')+'-'+secrets.token_hex(3)
shutil.copy2(root/'infra/probes/permissions/main.tf',folder/'main.tf')
lock=(root/'infra/.terraform.lock.hcl').read_text().split('\nprovider "registry.terraform.io/hashicorp/external"')[0]
(folder/'.terraform.lock.hcl').write_text(lock)
env={key:value for key,value in os.environ.items() if not key.startswith(('TF_VAR_','TF_CLI_ARGS')) and key not in {'TF_WORKSPACE','TF_DATA_DIR'}}
env.update(TF_VAR_aws_region=args.region,TF_VAR_probe_name=name,TF_VAR_db_password=secrets.token_urlsafe(28),TF_PLUGIN_CACHE_DIR=str(root/'.build/terraform-provider-cache'),TF_IN_AUTOMATION='true')
report={'name':name,'directory':str(folder),'region':args.region,'checked_at':datetime.now(timezone.utc).isoformat()}
(root/'.build/tarea-01-probe-location.json').write_text(json.dumps(report,indent=2))

def run(*args):
    stage=args[0]
    print('RUN',stage,flush=True)
    with (folder/(stage+'.log')).open('w') as log:
        code=subprocess.run(['terraform',*args,'-no-color'],cwd=folder,env=env,stdout=log,stderr=subprocess.STDOUT).returncode
    report[stage+'_exit']=code
    (root/'.build/tarea-01-probe-result.json').write_text(json.dumps(report,indent=2))
    print('RESULT',stage,code,flush=True)
    return code

try:
    if run('init','-input=false') == 0 and run('validate') == 0:
        if run('plan','-input=false','-out=probe.plan') == 0:
            run('apply','-input=false','probe.plan')
            state=subprocess.run(['terraform','show','-json'],cwd=folder,env=env,capture_output=True,text=True)
            if state.returncode == 0:
                resources=json.loads(state.stdout).get('values',{}).get('root_module',{}).get('resources',[])
                report['resources_created']=[item['address'] for item in resources if item['mode']=='managed']
                (root/'.build/tarea-01-probe-result.json').write_text(json.dumps(report,indent=2))
                if report.get('apply_exit') == 0:
                    attributes={item['type']:item['values'] for item in resources if item['mode']=='managed'}
                    checks=[
                        ('SecretsManager/GetSecretValue',['secretsmanager','get-secret-value','--secret-id',attributes['aws_secretsmanager_secret']['id'],'--query','VersionId']),
                        ('Logs/CreateLogStream',['logs','create-log-stream','--log-group-name',attributes['aws_cloudwatch_log_group']['name'],'--log-stream-name','probe']),
                        ('Logs/PutLogEvents',['logs','put-log-events','--log-group-name',attributes['aws_cloudwatch_log_group']['name'],'--log-stream-name','probe','--log-events',json.dumps([{'timestamp':int(datetime.now(timezone.utc).timestamp()*1000),'message':'permission-probe'}])]),
                        ('ECR/GetAuthorizationToken',['ecr','get-authorization-token','--query','length(authorizationData)']),
                    ]
                    report['api_checks']=[]
                    for operation,command in checks:
                        with (folder/'api-checks.log').open('a') as log:
                            code=subprocess.run(['aws',*command,'--region',args.region,'--output','json','--no-cli-pager'],env={**env,'AWS_PAGER':'','AWS_MAX_ATTEMPTS':'1'},stdout=log,stderr=subprocess.STDOUT,timeout=30).returncode
                        report['api_checks'].append({'operation':operation,'pass':code==0})
                        print('CHECK',operation,code,flush=True)
                    (root/'.build/tarea-01-probe-result.json').write_text(json.dumps(report,indent=2))
finally:
    if (folder/'terraform.tfstate').exists():
        run('destroy','-input=false','-auto-approve')
print(json.dumps(report,indent=2),flush=True)
raise SystemExit(0 if report.get('apply_exit') == 0 and report.get('destroy_exit') == 0 and len(report.get('api_checks', [])) == 4 and all(check['pass'] for check in report.get('api_checks', [])) else 1)
