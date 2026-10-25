import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FargateWorldLauncher } from '../src/orchestrator/FargateWorldLauncher.js';
import { DockerContainerLauncher } from '../src/orchestrator/DockerContainerLauncher.js';
import { createWorldLauncher } from '../src/orchestrator/createWorldLauncher.js';

const TASK = 'arn:aws:ecs:us-east-1:123456789012:task/ewo/abc';
const TOKEN = '11111111-1111-4111-8111-111111111111';
const options = { cluster: 'ewo', taskDefinition: 'ewo-world:3', subnets: ['subnet-a'], securityGroups: ['sg-w'] };

function fakeClient(handlers) {
  const calls = [];
  return { calls, async send(command) {
    const name = command.constructor.name;
    calls.push({ name, input: command.input });
    if (!handlers[name]) throw new Error(`unexpected ${name}`);
    return handlers[name](command.input);
  } };
}

function task(overrides = {}) {
  return { taskArn: TASK, lastStatus: 'RUNNING', desiredStatus: 'RUNNING',
    tags: [{ key: 'elastic-worlds.world-id', value: 'world-1' }, { key: 'elastic-worlds.reservation-token', value: TOKEN }],
    attachments: [{ type: 'ElasticNetworkInterface', details: [
      { name: 'networkInterfaceId', value: 'eni-1' }, { name: 'privateIPv4Address', value: '10.0.1.7' }] }],
    ...overrides };
}

test('RunTask is idempotent by reservation token and carries the world environment', async () => {
  const ecs = fakeClient({ RunTaskCommand: () => ({ tasks: [{ taskArn: TASK }] }) });
  const launcher = new FargateWorldLauncher(options, { ecs, ec2: fakeClient({}) });
  const result = await launcher.launchWorldContainer(null, { id: 'world-1', name: 'Uno', seed: 7, port: 8001, token: TOKEN, runtimeId: TOKEN });
  assert.deepEqual(result, { containerId: TASK, port: 8001, wsUrl: null, internalWsUrl: null });
  const { input } = ecs.calls[0];
  assert.equal(input.clientToken, TOKEN);
  assert.equal(input.startedBy, TOKEN);
  assert.equal(input.launchType, 'FARGATE');
  assert.equal(input.networkConfiguration.awsvpcConfiguration.assignPublicIp, 'ENABLED');
  const env = Object.fromEntries(input.overrides.containerOverrides[0].environment.map(e => [e.name, e.value]));
  assert.equal(input.overrides.containerOverrides[0].name, 'world');
  assert.equal(env.WORLD_ID, 'world-1');
  assert.equal(env.WORLD_RUNTIME_ID, TOKEN);
  assert.equal(env.PORT, '8001');
  assert.equal(env.SEED, '7');
  assert.equal(launcher.ec2Module, undefined, 'Launching does not load the EC2 client');

  const failing = new FargateWorldLauncher(options, { ecs: fakeClient({
    RunTaskCommand: () => ({ tasks: [], failures: [{ reason: 'RESOURCE:ENI' }] }) }), ec2: fakeClient({}) });
  await assert.rejects(failing.launchWorldContainer(null, { id: 'world-1', token: TOKEN }), /RESOURCE:ENI/);
});

test('Endpoint waits for the ENI, then reads the public IP from EC2', async () => {
  let current = task({ lastStatus: 'PROVISIONING', attachments: [] });
  const ecs = fakeClient({ DescribeTasksCommand: () => ({ tasks: [current] }) });
  const ec2 = fakeClient({ DescribeNetworkInterfacesCommand: ({ NetworkInterfaceIds }) => {
    assert.deepEqual(NetworkInterfaceIds, ['eni-1']);
    return { NetworkInterfaces: [{ Association: { PublicIp: '54.1.2.3' } }] };
  } });
  const launcher = new FargateWorldLauncher(options, { ecs, ec2 });
  assert.deepEqual(await launcher.resolveEndpoint(TASK), { ready: false });
  assert.equal(launcher.ec2Module, undefined, 'No EC2 client before the ENI exists');
  current = task({ lastStatus: 'PENDING' });
  assert.deepEqual(await launcher.resolveEndpoint(TASK), {
    ready: true, privateIp: '10.0.1.7', wsUrl: 'ws://54.1.2.3:8001', internalWsUrl: 'ws://10.0.1.7:8001',
  });
  current = task({ lastStatus: 'STOPPED', desiredStatus: 'STOPPED', stoppedReason: 'Essential container exited' });
  assert.equal((await launcher.resolveEndpoint(TASK)).stopped, true);

  const broken = new FargateWorldLauncher(options, { ecs: fakeClient({ DescribeTasksCommand: () => { throw new Error('throttled'); } }), ec2 });
  assert.deepEqual(await broken.resolveEndpoint(TASK), { ready: false });

  const privateOnly = new FargateWorldLauncher({ ...options, assignPublicIp: false }, { ecs, ec2: fakeClient({}) });
  current = task();
  assert.equal((await privateOnly.resolveEndpoint(TASK)).wsUrl, 'ws://10.0.1.7:8001');
});

test('Status maps ECS tasks to the Docker contract and finds unrecorded tasks by token', async () => {
  let current = task();
  const ecs = fakeClient({
    DescribeTasksCommand: ({ tasks, include }) => {
      assert.deepEqual(include, ['TAGS']);
      return { tasks: tasks[0] === TASK ? [current] : [] };
    },
    ListTasksCommand: ({ startedBy }) => ({ taskArns: startedBy === TOKEN ? [TASK] : [] }),
  });
  const launcher = new FargateWorldLauncher(options, { ecs, ec2: fakeClient({}) });
  const status = await launcher.getContainerStatus(null, TASK);
  assert.equal(status.exists, true);
  assert.equal(status.running, true);
  assert.equal(status.privateIp, '10.0.1.7');
  assert.equal(status.labels['elastic-worlds.reservation-token'], TOKEN);
  assert.equal((await launcher.getContainerStatus(null, launcher.containerRef('world-1', TOKEN))).containerId, TASK);
  assert.equal((await launcher.getContainerStatus(null, 'another-token')).exists, false);
  current = task({ lastStatus: 'STOPPED' });
  assert.equal((await launcher.getContainerStatus(null, TASK)).exists, false);

  const down = new FargateWorldLauncher(options, { ecs: fakeClient({ DescribeTasksCommand: () => { throw new Error('timeout'); } }), ec2: fakeClient({}) });
  assert.equal((await down.getContainerStatus(null, TASK)).hostUnreachable, true);
});

test('Stop requests StopTask once and reports removal only when STOPPED', async () => {
  let current = task();
  const ecs = fakeClient({
    DescribeTasksCommand: () => ({ tasks: [current] }),
    StopTaskCommand: () => { current = task({ desiredStatus: 'STOPPED', lastStatus: 'DEACTIVATING' }); return {}; },
  });
  const launcher = new FargateWorldLauncher(options, { ecs, ec2: fakeClient({}) });
  assert.equal(await launcher.stopWorldContainer(null, TASK), false);
  assert.equal(await launcher.stopWorldContainer(null, TASK), false);
  assert.equal(ecs.calls.filter(c => c.name === 'StopTaskCommand').length, 1);
  assert.equal(await launcher.removeWorldContainer(null, TASK), false);
  current = task({ desiredStatus: 'STOPPED', lastStatus: 'STOPPED' });
  assert.equal(await launcher.stopWorldContainer(null, TASK), true);
  assert.equal(await launcher.removeWorldContainer(null, TASK), true);
  assert.equal(ecs.calls.filter(c => c.name === 'StopTaskCommand').length, 1);
});

test('WORLD_LAUNCHER selects the launcher and Fargate requires its settings', () => {
  assert.ok(createWorldLauncher({ worldLauncher: 'docker', useDockerMock: true }) instanceof DockerContainerLauncher);
  assert.ok(createWorldLauncher({ worldLauncher: 'fargate', fargate: options }) instanceof FargateWorldLauncher);
  assert.throws(() => createWorldLauncher({ worldLauncher: 'ecs' }), /docker o fargate/);
  assert.throws(() => createWorldLauncher({ worldLauncher: 'fargate', fargate: { ...options, subnets: [] } }), /subnets/);
  assert.throws(() => createWorldLauncher({ worldLauncher: 'fargate', fargate: { ...options, cluster: '' } }), /cluster/);
});

test('HEALTH_TIMEOUT_MS and Fargate settings come from the environment', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const read = env => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { config } from './src/shared/config.js'; console.log(JSON.stringify({ health: config.healthTimeoutMs, launcher: config.worldLauncher, fargate: config.fargate }))"],
  { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(read({}).health, 30000);
  assert.equal(read({}).launcher, 'docker');
  const fargate = read({ HEALTH_TIMEOUT_MS: '120000', WORLD_LAUNCHER: 'Fargate', WORLD_TASK_SUBNETS: 'subnet-a, subnet-b', WORLD_TASK_PUBLIC_IP: 'false' });
  assert.equal(fargate.health, 120000);
  assert.equal(fargate.launcher, 'fargate');
  assert.deepEqual(fargate.fargate.subnets, ['subnet-a', 'subnet-b']);
  assert.equal(fargate.fargate.assignPublicIp, false);
  assert.throws(() => read({ HEALTH_TIMEOUT_MS: '-5' }));
});
