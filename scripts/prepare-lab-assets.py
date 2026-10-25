#!/usr/bin/env python3
"""Local build step for Terraform external data. Never reads deployment secrets."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from build_archives import normalize_context, normalize_jar

root = Path(__file__).resolve().parents[1]
query = json.load(sys.stdin)
project = query['project']
cache = root / '.build' / 'lab'
cache.mkdir(parents=True, exist_ok=True)

def run(args, **kwargs):
    subprocess.run(args, check=True, stdout=sys.stderr, **kwargs)

def digest(paths):
    h = hashlib.sha256()
    for p in sorted(paths):
        h.update(str(p.relative_to(root)).encode())
        h.update(p.read_bytes())
    return h.hexdigest()

files = []
for service in ['world-service','lobby-service','npc-service','metrics-service']:
    directory = root / service
    files += [p for p in directory.iterdir() if p.name in ['Dockerfile','package.json','package-lock.json','requirements.txt']]
    files += [p for p in (directory/'src').rglob('*') if p.is_file() and '__pycache__' not in p.parts]
files += [root/'flink-metrics-job/pom.xml']
files += [p for p in (root/'flink-metrics-job/src').rglob('*') if p.is_file()]
files += [Path(__file__).resolve()]
files += [Path(__file__).with_name('build_archives.py').resolve()]
files += sorted((root/'lobby-service/scripts').glob('*.js'))
source = hashlib.sha256((project+digest(files)).encode()).hexdigest()
manifest = cache / f'{source}.json'
with (cache/'build.lock').open('w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    if manifest.exists():
        data = json.loads(manifest.read_text())
        artifacts = ['flink_jar'] + [f'lambda_{name}_zip' for name in ['public','internal','lifecycle','maintenance','migrate']]
        if all(k in data and (root / 'infra' / data[k]).is_file() for k in artifacts):
            print(json.dumps(data));sys.exit(0)
    data = {}
    # Docker Snap can mount this directory, unlike its separate /tmp namespace.
    with tempfile.TemporaryDirectory(prefix='source-build-', dir=cache) as temporary:
        temporary = Path(temporary)
        for service in ['world','npc','metrics']:
            src = root/f'{service}-service'
            context = temporary/service
            context.mkdir()
            for p in src.iterdir():
                if p.name in ['Dockerfile','package.json','package-lock.json','requirements.txt']:
                    shutil.copy2(p,context/p.name)
            shutil.copytree(src/'src',context/'src',ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
            normalize_context(context)
            image = f'{project}-{service}:{source[:16]}'
            run(['docker','build','--platform','linux/amd64','-t',image,str(context)])
            data[f'{service}_image'] = image
        maven = temporary/'flink'
        maven.mkdir()
        shutil.copy2(root/'flink-metrics-job/pom.xml',maven/'pom.xml')
        shutil.copytree(root/'flink-metrics-job/src',maven/'src')
        repository = cache/'maven-repository'
        repository.mkdir(exist_ok=True)
        run(['docker','run','--rm','--user',f'{os.getuid()}:{os.getgid()}',
             '-v',f'{maven}:/workspace','-v',f'{repository}:/cache','-w','/workspace',
             'maven:3.9-eclipse-temurin-17','mvn','-q','-Dmaven.repo.local=/cache','-DskipTests','package'])
        jar = cache/f'{source}.jar'
        shutil.copy2(maven/'target/flink-metrics-job.jar',jar)
        normalize_jar(jar)
    # Immutable cached copy prevents a later build from changing an in-flight plan.
    packages = cache/f'{source}-lambdas'
    run(['npm','--prefix',str(root/'lobby-service'),'run','package:lambda','--',str(packages)])
    # Content-address each Lambda independently: an unrelated source change must
    # not change filename and trigger deployment of otherwise identical code.
    immutable = cache/'lambdas'
    immutable.mkdir(exist_ok=True)
    for name in ['public','internal','lifecycle','maintenance','migrate']:
        package = packages/f'{name}.zip'
        checksum = hashlib.sha256(package.read_bytes()).hexdigest()
        artifact = immutable/f'{name}-{checksum}.zip'
        if artifact.exists():
            if hashlib.sha256(artifact.read_bytes()).hexdigest() != checksum:
                raise RuntimeError(f'Corrupt immutable Lambda artifact: {artifact.name}')
        else:
            shutil.copy2(package,artifact)
        data[f'lambda_{name}_zip'] = str(artifact)
    data.update(flink_jar=str(jar),source_digest=source)
    # Terraform runs from infra/. These values must survive moving the checkout.
    for key in ['flink_jar'] + [f'lambda_{name}_zip' for name in ['public','internal','lifecycle','maintenance','migrate']]:
        data[key] = os.path.relpath(data[key], root/'infra')
    manifest.write_text(json.dumps(data))
    print(json.dumps(data))
