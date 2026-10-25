#!/usr/bin/env python3
"""Create default-retention Kinesis without the action denied by Learner Lab."""
import json
import os
import subprocess
import sys
import time

region = os.environ.get('AWS_REGION', 'us-east-1')
project = os.environ['PROJECT_NAME']
expected = os.environ['EXPECTED_ACCOUNT_ID']
name = f'{project}-telemetry'

def aws(*args, missing=False):
    result = subprocess.run(['aws', *args, '--region', region, '--output', 'json'], capture_output=True, text=True)
    if result.returncode:
        if missing and 'ResourceNotFoundException' in result.stderr:
            return None
        raise RuntimeError(f'AWS operation failed: {args[0]} {args[1]}: {result.stderr}')
    return json.loads(result.stdout) if result.stdout.strip() else {}

if aws('sts', 'get-caller-identity')['Account'] != expected:
    raise RuntimeError('Account changed; refusing stream mutation')
exists = aws('kinesis', 'describe-stream-summary', '--stream-name', name, missing=True)
if sys.argv[1] == 'create':
    if not exists:
        aws('kinesis', 'create-stream', '--stream-name', name, '--shard-count', '1', '--tags',
            json.dumps({'Name': name, 'Project': project, 'ManagedBy': 'terraform-bootstrap'}))
        for _ in range(90):
            stream = aws('kinesis', 'describe-stream-summary', '--stream-name', name, missing=True)
            if stream and stream['StreamDescriptionSummary']['StreamStatus'] == 'ACTIVE':
                break
            time.sleep(2)
        else:
            raise RuntimeError('Kinesis stream did not become ACTIVE')
        print(f'Created stream with default 24h retention: {name}')
    else:
        print(f'Reusing existing stream: {name}')
elif sys.argv[1] == 'destroy' and exists:
    tags = aws('kinesis', 'list-tags-for-stream', '--stream-name', name)['Tags']
    if {'Key': 'ManagedBy', 'Value': 'terraform-bootstrap'} not in tags:
        print(f'Retaining unowned stream: {name}')
    else:
        aws('kinesis', 'delete-stream', '--stream-name', name)
        for _ in range(90):
            if not aws('kinesis', 'describe-stream-summary', '--stream-name', name, missing=True):
                break
            time.sleep(2)
        else:
            raise RuntimeError('Kinesis stream deletion did not complete')
        print(f'Deleted owned stream: {name}')
