#!/usr/bin/env python3
"""Push a locally built image (world, NPC or metrics) to ECR for Fargate. Idempotent per immutable tag."""
import json
import os
import subprocess
import sys

region=os.environ.get('AWS_REGION','us-east-1')
expected=os.environ['EXPECTED_ACCOUNT_ID']
source=os.environ['SOURCE_IMAGE']
target=os.environ['TARGET_IMAGE']
registry,path=target.split('/',1)
repository,tag=path.rsplit(':',1)

def aws(*args,check=True):
    r=subprocess.run(['aws',*args,'--region',region,'--output','json'],capture_output=True,text=True)
    if check and r.returncode:raise RuntimeError(f'AWS operation failed: {args[0]} {args[1]}: {r.stderr}')
    return r

def run(args,**kwargs):
    subprocess.run(args,check=True,stdout=sys.stderr,**kwargs)

if json.loads(aws('sts','get-caller-identity').stdout)['Account']!=expected:raise RuntimeError('Account changed; refusing image push')
if not registry.startswith(f'{expected}.dkr.ecr.'):raise RuntimeError(f'Refusing to push outside this account: {registry}')
if aws('ecr','describe-images','--repository-name',repository,'--image-ids',f'imageTag={tag}',check=False).returncode==0:
    print(f'Image already in ECR: {target}');sys.exit(0)
if subprocess.run(['docker','info'],capture_output=True).returncode:
    raise RuntimeError('Docker is not running; start Docker Desktop and apply again')
if subprocess.run(['docker','image','inspect',source],capture_output=True).returncode:
    raise RuntimeError(f'Local image {source} is missing; delete .build/lab/*.json to rebuild it from source')
password=subprocess.run(['aws','ecr','get-login-password','--region',region],check=True,capture_output=True,text=True).stdout
run(['docker','login','--username','AWS','--password-stdin',registry],input=password,text=True)
run(['docker','tag',source,target])
run(['docker','push',target])
print(f'Pushed world image: {target}')
