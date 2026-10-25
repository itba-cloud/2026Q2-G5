import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, cp, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { databaseFixture } from './helpers/database.js';
import { FUNCTION_NAMES, packageFunction } from '../scripts/lambda-packages.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const packages = path.resolve(process.env.TEST_LAMBDA_PACKAGE_DIR || path.join(root, 'dist/lambdas'));

test('Each deployment ZIP excludes other handlers, unused integrations, secrets and build tools', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ewo-package-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of FUNCTION_NAMES) {
    const { stdout } = await execute('unzip', ['-Z1', path.join(packages, `${name}.zip`)]);
    const files = stdout.trim().split('\n');
    assert.ok(files.includes(`src/lambda/${name}/handler.js`));
    for (const other of FUNCTION_NAMES.filter(other => other !== name)) {
      assert.equal(files.some(file => file.startsWith(`src/lambda/${other}/`)), false, `${name} contains ${other}`);
    }
    assert.equal(files.some(file => /(^|\/)(\.env[^/]*|esbuild|dotenv|tests|package-lock\.json)(\/|$)/.test(file)), false);
    assert.equal(files.includes('src/index.js'), false);
    assert.equal(files.includes('src/server.js'), false);
    assert.equal(files.some(file => file.startsWith('src/store/migrations/')), name === 'migrate');
    const destination = path.join(directory, name);
    await execute('unzip', ['-q', path.join(packages, `${name}.zip`), '-d', destination]);
    const manifest = JSON.parse(await readFile(path.join(destination, 'package-manifest.json'), 'utf8'));
    const dependencies = Object.keys(manifest.dependencies);
    assert.equal(dependencies.includes('ioredis'), name === 'internal');
    assert.equal(dependencies.includes('express'), ['public', 'internal'].includes(name));
    assert.equal(dependencies.includes('@aws-sdk/client-sfn'), ['public', 'internal', 'maintenance'].includes(name));
    assert.equal(files.includes('src/orchestrator/DockerContainerLauncher.js'), ['lifecycle', 'maintenance'].includes(name));
    if (name === 'public') {
      assert.equal(files.some(file => file.startsWith('src/modules/hosts/') || file.startsWith('src/modules/messaging/')), false);
    }
    if (name === 'migrate') {
      const migrations = await readdir(path.join(destination, 'src/store/migrations'));
      const sources = await readdir(path.join(root, 'src/store/migrations'));
      assert.equal(migrations.filter(file => file.endsWith('.sql')).length, sources.filter(file => file.endsWith('.sql')).length);
    }
  }
});

test('Extracted ZIPs initialize and execute their real handlers with local PostgreSQL', { timeout: 30000 }, async t => {
  const fixture = await databaseFixture();
  t.after(() => fixture.close());
  const directory = await mkdtemp(path.join(tmpdir(), 'ewo-package-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of FUNCTION_NAMES) {
    await execute('unzip', ['-q', path.join(packages, `${name}.zip`), '-d', path.join(directory, name)]);
  }
  const connection = new URL(process.env.TEST_DATABASE_URL);
  const env = { ...process.env,
    EWO_ARTIFACT_ROOT: directory, STORAGE_MODE: 'rds',
    DB_HOST: connection.hostname, DB_PORT: connection.port || '5432', DB_NAME: connection.pathname.slice(1),
    DB_USER: decodeURIComponent(connection.username), DB_PASSWORD: decodeURIComponent(connection.password),
    PGOPTIONS: fixture.config.db.options, USE_DOCKER_MOCK: 'true',
    DB_POOL_MAX: '1', REDIS_URL: '', AWS_REGION: 'us-east-1', AWS_EC2_METADATA_DISABLED: 'true',
  };
  delete env.DB_CA_FILE;
  delete env.DB_SECRET_ARN;
  // No source-tree imports: Node must resolve every dependency inside each ZIP.
  const code = `
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    const load = name => import(pathToFileURL(process.env.EWO_ARTIFACT_ROOT + '/' + name + '/src/lambda/' + name + '/handler.js'));
    const event = (path, method = 'GET', body) => ({
      requestContext: { elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/test/123' } },
      httpMethod: method, path, headers: { host: 'lobby.test', 'content-type': 'application/json' },
      queryStringParameters: {}, isBase64Encoded: false, body: body ? JSON.stringify(body) : '',
    });
    assert.deepEqual(await (await load('migrate')).handler(), { success: true });
    const publicApi = (await load('public')).handler;
    assert.equal((await publicApi(event('/health'), {})).statusCode, 200);
    const created = await publicApi(event('/worlds', 'POST', { name: 'Packaged world', autoStart: false }), {});
    assert.equal(created.statusCode, 201);
    const worldId = JSON.parse(created.body).worldId;
    assert.equal((await publicApi(event('/hosts'), {})).statusCode, 404);
    assert.equal((await publicApi(event('/worlds/' + worldId + '/stop', 'POST'), {})).statusCode, 404);
    const internalApi = (await load('internal')).handler;
    assert.equal((await internalApi(event('/hosts/heartbeat', 'POST', { id: 'packaged-host', hostIp: '127.0.0.1', maxWorlds: 1 }), {})).statusCode, 200);
    const reported = await internalApi(event('/worlds/' + worldId + '/status', 'POST', { playersCount: 3 }), {});
    assert.equal(reported.statusCode, 200);
    assert.equal(JSON.parse(reported.body).world.playersCount, 3);
    const lifecycle = (await load('lifecycle')).handler;
    await assert.rejects(lifecycle({ action: 'invalid' }, {}), error => error.code === 'INVALID_ACTION');
    const maintenance = await (await load('maintenance')).handler({}, { getRemainingTimeInMillis: () => 30000 });
    assert.equal(maintenance.errors, 0);
    assert.equal(maintenance.skipped, false);
    console.log('All five packaged handlers executed successfully');
    process.exit(0);
  `;
  const result = await execute(process.execPath, ['--input-type=module', '-e', code], { cwd: directory, env, timeout: 25000 });
  assert.match(result.stdout, /All five packaged handlers executed successfully/);
});

test('Changing public-only code changes its ZIP while maintenance stays byte-identical', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ewo-package-hashes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  await cp(path.join(root, 'src'), path.join(source, 'src'), { recursive: true });
  const { stdout: certificate } = await execute('unzip', ['-p', path.join(packages, 'public.zip'), 'certs/rds-ca.pem']);
  const make = (name, iteration) => packageFunction({ name, root: source, installation: root,
    staging: path.join(directory, `staging-${iteration}`), output: path.join(directory, `output-${iteration}`), build, certificate });
  const before = {};
  for (const name of ['public', 'maintenance']) before[name] = await make(name, 'before');
  await appendFile(path.join(source, 'src/lambda/public/app.js'), '\n// Public-only deployment change.\n');
  assert.notEqual((await make('public', 'after')).sha256, before.public.sha256);
  assert.equal((await make('maintenance', 'after')).sha256, before.maintenance.sha256);
});

test('ZIP is reproducible across checkout paths and umasks', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ewo-portable-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certificate = 'test certificate: packaging must preserve its bytes';
  const originalMask = process.umask();
  const hashes = [];
  try {
    for (const [index, mask] of [0o077, 0o002].entries()) {
      process.umask(mask);
      const checkout = path.join(directory, `checkout-${index}`);
      await cp(path.join(root, 'src'), path.join(checkout, 'src'), { recursive: true });
      const result = await packageFunction({ name: 'public', root: checkout,
        installation: root, staging: path.join(checkout, 'staging'),
        output: path.join(checkout, 'output'), build, certificate });
      hashes.push(result.sha256);
    }
  } finally {
    process.umask(originalMask);
  }
  assert.equal(hashes[0], hashes[1]);
});
