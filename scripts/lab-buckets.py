#!/usr/bin/env python3
"""Bootstrap only this project's buckets, retaining existing/unowned buckets."""
import json
import os
import subprocess
import sys

region=os.environ.get('AWS_REGION','us-east-1')
project=os.environ['PROJECT_NAME']
expected=os.environ['EXPECTED_ACCOUNT_ID']

def aws(*args):
    r=subprocess.run(['aws',*args,'--region',region,'--output','json'],capture_output=True,text=True)
    if r.returncode:raise RuntimeError(f'AWS operation failed: {args[0]} {args[1]}: {r.stderr}')
    return json.loads(r.stdout) if r.stdout.strip() else {}

if aws('sts','get-caller-identity')['Account']!=expected:raise RuntimeError('Account changed; refusing bucket mutation')
for kind in ['snapshots','client','artifacts']:
    bucket=f'{project}-{kind}-{expected}'
    exists=subprocess.run(['aws','s3api','head-bucket','--bucket',bucket,'--region',region],capture_output=True).returncode==0
    if sys.argv[1]=='create':
        if exists:
            print(f'Reusing existing bucket: {bucket}');continue
        args=['s3api','create-bucket','--bucket',bucket]
        if region!='us-east-1':args+=['--create-bucket-configuration',f'LocationConstraint={region}']
        aws(*args)
        aws('s3api','put-bucket-tagging','--bucket',bucket,'--tagging',json.dumps({'TagSet':[
            {'Key':'Project','Value':project},{'Key':'ManagedBy','Value':'terraform-bootstrap'}]}))
        print(f'Created bucket: {bucket}')
    elif sys.argv[1]=='destroy' and os.environ.get('CLEANUP_BUCKETS')=='true' and exists:
        tags=aws('s3api','get-bucket-tagging','--bucket',bucket).get('TagSet',[])
        if {'Key':'ManagedBy','Value':'terraform-bootstrap'} not in tags:
            print(f'Retaining unowned bucket: {bucket}');continue
        while True:
            versions=aws('s3api','list-object-versions','--bucket',bucket)
            objects=[{'Key':v['Key'],'VersionId':v['VersionId']} for key in ['Versions','DeleteMarkers'] for v in versions.get(key,[])]
            if not objects:break
            for start in range(0,len(objects),1000):
                result=aws('s3api','delete-objects','--bucket',bucket,'--delete',json.dumps({'Objects':objects[start:start+1000],'Quiet':True}))
                if result.get('Errors'):raise RuntimeError('Could not delete owned bucket versions')
        aws('s3api','delete-bucket','--bucket',bucket)
        print(f'Deleted owned bucket: {bucket}')
