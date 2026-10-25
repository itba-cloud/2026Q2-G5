#!/usr/bin/env python3
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime,timezone
import argparse
parser=argparse.ArgumentParser(description="Create a disposable S3 backend, verify state/lock, then delete it.")
parser.add_argument("--execute", action="store_true", help="Run real AWS creation and cleanup")
parser.add_argument("--region", default="us-east-1")
options=parser.parse_args()
if not options.execute:
    parser.error("Pass --execute to run real bucket creation and cleanup")
root=Path(__file__).resolve().parents[1]
(root/'.build').mkdir(exist_ok=True)
folder=Path(tempfile.mkdtemp(prefix='tarea-01-backend-',dir=root/'.build'))
name='ewo-permisos-state-'+uuid.uuid4().hex[:16]
env={key:value for key,value in os.environ.items() if not key.startswith(('TF_VAR_','TF_CLI_ARGS')) and key not in {'TF_DATA_DIR','TF_WORKSPACE'}}
env.update(AWS_MAX_ATTEMPTS='1',AWS_PAGER='',TF_IN_AUTOMATION='true')
report={'bucket':name,'directory':str(folder),'region':options.region,'checked_at':datetime.now(timezone.utc).isoformat(),'operations':[],'cleaned_up':False}
reportfile=root/'.build/tarea-01-backend-result.json'
created=False

def aws(*args, expected_error=None):
    p=subprocess.run(['aws',*args,'--region',options.region,'--no-cli-pager','--output','json','--cli-connect-timeout','5','--cli-read-timeout','15'],env=env,capture_output=True,text=True)
    operation=' '.join(args[:2])
    error=re.search(r'\((\w+)\) when calling',p.stderr)
    code=error.group(1) if error else 'CommandFailed'
    success=(p.returncode==0 if expected_error is None else p.returncode!=0 and code==expected_error)
    report['operations'].append({'operation':operation,'pass':success,'error':None if p.returncode==0 else code})
    reportfile.write_text(json.dumps(report,indent=2))
    print(operation,'PASS' if success else code,flush=True)
    if not success: raise RuntimeError(operation+': '+code)
    return json.loads(p.stdout) if p.stdout.strip() else {}

def tf(*args):
    with (folder/(args[0]+'.log')).open('a') as log:
        p=subprocess.run(['terraform',*args,'-no-color'],cwd=folder,env=env,stdout=log,stderr=subprocess.STDOUT)
    report['operations'].append({'operation':'terraform '+' '.join(args[:1]),'pass':p.returncode==0})
    reportfile.write_text(json.dumps(report,indent=2))
    print('terraform',args[0],p.returncode,flush=True)
    if p.returncode: raise RuntimeError('terraform '+args[0])

try:
    aws('s3api','create-bucket','--bucket',name,*(() if options.region == 'us-east-1' else ('--create-bucket-configuration','LocationConstraint='+options.region)))
    created=True
    aws('s3api','put-bucket-tagging','--bucket',name,'--tagging',json.dumps({'TagSet':[{'Key':'ManagedBy','Value':'codex-permission-probe'},{'Key':'Disposable','Value':'true'}]}))
    aws('s3api','put-public-access-block','--bucket',name,'--public-access-block-configuration','BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true')
    aws('s3api','put-bucket-encryption','--bucket',name,'--server-side-encryption-configuration',json.dumps({'Rules':[{'ApplyServerSideEncryptionByDefault':{'SSEAlgorithm':'AES256'}}]}))
    aws('s3api','put-bucket-versioning','--bucket',name,'--versioning-configuration','Status=Enabled')
    shutil.copy2(root/'infra/probes/state-backend/main.tf',folder/'main.tf')
    tf('init','-input=false','-backend-config=bucket='+name,'-backend-config=key=probe/terraform.tfstate','-backend-config=region='+options.region,'-backend-config=encrypt=true','-backend-config=use_lockfile=true')
    tf('apply','-input=false','-auto-approve')
    tf('apply','-input=false','-auto-approve')
    body=folder/'lock.json'
    body.write_text(json.dumps({'ID':'probe-contention-lock','Operation':'permission-probe'}))
    aws('s3api','put-object','--bucket',name,'--key','probe/terraform.tfstate.tflock','--body',str(body),'--if-none-match','*')
    aws('s3api','put-object','--bucket',name,'--key','probe/terraform.tfstate.tflock','--body',str(body),'--if-none-match','*',expected_error='PreconditionFailed')
    aws('s3api','get-object','--bucket',name,'--key','probe/terraform.tfstate.tflock',str(folder/'read-lock.json'))
    aws('s3api','delete-object','--bucket',name,'--key','probe/terraform.tfstate.tflock')
    tf('destroy','-input=false','-auto-approve')
finally:
    if created:
        versions=aws('s3api','list-object-versions','--bucket',name)
        objects=[{'Key':v['Key'],'VersionId':v['VersionId']} for key in ('Versions','DeleteMarkers') for v in versions.get(key,[])]
        if objects:
            aws('s3api','delete-objects','--bucket',name,'--delete',json.dumps({'Objects':objects}))
        aws('s3api','delete-bucket','--bucket',name)
        report['cleaned_up']=True
    reportfile.write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2),flush=True)
