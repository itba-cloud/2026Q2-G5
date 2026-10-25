import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databaseFixture } from './helpers/database.js';
import { Ec2HostRetirement } from '../src/orchestrator/Ec2HostRetirement.js';
import { ReconciliationWorker } from '../src/worker/ReconciliationWorker.js';

const INSTANCE = 'i-0123456789abcdef0';

function ec2Answering(answer) {
  const calls = [];
  return { calls, async send(command) {
    calls.push(command.input);
    if (answer instanceof Error) throw answer;
    return { Reservations: [{ Instances: [{ InstanceId: INSTANCE, State: { Name: answer } }] }] };
  } };
}

function ec2Error(name) {
  const err = new Error(name);
  err.name = name;
  return err;
}

test('EC2 retirement is confirmed only for terminated or forgotten instances', async () => {
  for (const [answer, retired] of [
    ['terminated', true], ['shutting-down', true], ['running', false], ['stopped', false], ['pending', false],
    [ec2Error('InvalidInstanceID.NotFound'), true],
  ]) {
    const ec2 = ec2Answering(answer);
    assert.equal(await new Ec2HostRetirement({ ec2 }).isRetired(INSTANCE), retired, String(answer));
    assert.deepEqual(ec2.calls, [{ InstanceIds: [INSTANCE] }]);
  }
});

test('EC2 retirement never guesses: hand-registered hosts are skipped and API errors propagate', async () => {
  const ec2 = ec2Answering('terminated');
  assert.equal(await new Ec2HostRetirement({ ec2 }).isRetired('host-worker-01'), false);
  assert.equal(ec2.calls.length, 0);
  await assert.rejects(new Ec2HostRetirement({ ec2: ec2Answering(ec2Error('UnauthorizedOperation')) }).isRetired(INSTANCE),
    { name: 'UnauthorizedOperation' });
});

async function silentHostWithWorlds(fixture, worldIds) {
  const { worlds } = fixture;
  await worlds.registerHost({ id: INSTANCE, hostIp: '10.0.0.10', maxWorlds: 4 });
  for (const [index, id] of worldIds.entries()) {
    await worlds.createWorld({ id, name: id, seed: index + 1 });
    await worlds.pool.query(`UPDATE worlds SET status='ACTIVE',host_id=$2,port=$3,port_scope=$2,
      ws_url='ws://10.0.0.10', container_id='c', players_count=3, runtime_id=gen_random_uuid()
      WHERE world_id=$1`, [id, INSTANCE, 18001 + index]);
  }
  await worlds.pool.query(`UPDATE hosts SET last_heartbeat=now()-interval '120 seconds' WHERE host_id=$1`, [INSTANCE]);
  return worlds.getHost(INSTANCE);
}

function workerWith(fixture, retired) {
  const asked = [];
  const retirement = { async isRetired(hostId) { asked.push(hostId); return retired; } };
  return { asked, worker: new ReconciliationWorker(fixture.worlds, fixture.operations, null, null, { retirement }) };
}

test('Worlds on a terminated World Host return to INACTIVE and free the host', async t => {
  const fixture = await databaseFixture();
  t.after(() => fixture.close());
  const host = await silentHostWithWorlds(fixture, ['lost-a', 'lost-b']);
  const { asked, worker } = workerWith(fixture, true);

  await worker.checkHost(host);

  assert.deepEqual(asked, [INSTANCE]);
  for (const id of ['lost-a', 'lost-b']) {
    const world = await fixture.worlds.getWorld(id);
    assert.equal(world.status, 'INACTIVE');
    assert.equal(world.hostId, null);
    assert.equal(world.port, null);
    assert.equal(world.wsUrl, null);
    assert.equal(world.playersCount, 0);
  }
  assert.equal((await fixture.worlds.getHost(INSTANCE)).status, 'DOWN');

  // Without placed worlds the existing prune deletes the host after 300s.
  await fixture.worlds.pool.query(`UPDATE hosts SET last_heartbeat=now()-interval '400 seconds' WHERE host_id=$1`, [INSTANCE]);
  await worker.checkHost(await fixture.worlds.getHost(INSTANCE));
  assert.equal(await fixture.worlds.getHost(INSTANCE), null);
});

test('A silent host that EC2 still reports alive keeps its worlds', async t => {
  const fixture = await databaseFixture();
  t.after(() => fixture.close());
  const host = await silentHostWithWorlds(fixture, ['partitioned']);
  const { worker } = workerWith(fixture, false);

  await worker.checkHost(host);

  const world = await fixture.worlds.getWorld('partitioned');
  assert.equal(world.status, 'ACTIVE');
  assert.equal(world.hostId, INSTANCE);
  assert.equal((await fixture.worlds.getHost(INSTANCE)).status, 'DOWN');
});

test('EC2 is not asked about fresh hosts or silent hosts without worlds', async t => {
  const fixture = await databaseFixture();
  t.after(() => fixture.close());
  await fixture.worlds.registerHost({ id: INSTANCE, hostIp: '10.0.0.10', maxWorlds: 4 });
  const { asked, worker } = workerWith(fixture, true);

  await worker.checkHost(await fixture.worlds.getHost(INSTANCE));
  await fixture.worlds.pool.query(`UPDATE hosts SET last_heartbeat=now()-interval '120 seconds' WHERE host_id=$1`, [INSTANCE]);
  await worker.checkHost(await fixture.worlds.getHost(INSTANCE));

  assert.deepEqual(asked, []);
});

test('A world with a live operation is left to its workflow', async t => {
  const fixture = await databaseFixture();
  t.after(() => fixture.close());
  const host = await silentHostWithWorlds(fixture, ['stopping', 'idle']);
  const op = await fixture.operations.accept({ kind: 'STOP', worldId: 'stopping', key: 'stop-on-lost-host' });
  const { worker } = workerWith(fixture, true);

  await worker.checkHost(host);

  assert.equal((await fixture.worlds.getWorld('stopping')).status, 'ACTIVE');
  assert.equal((await fixture.worlds.getWorld('idle')).status, 'INACTIVE');
  assert.equal((await fixture.operations.get(op.operation_id)).status, 'ACCEPTED');
});

test('A stop that already claimed a world on a terminated host learns the container is gone', async t => {
  const fixture = await databaseFixture();
  t.after(() => fixture.close());
  const host = await silentHostWithWorlds(fixture, ['claimed']);
  const op = await fixture.operations.accept({ kind: 'SELF_SHUTDOWN', worldId: 'claimed', key: 'graceful-host-shutdown',
    visibility: 'internal', payload: { runtimeId: (await fixture.worlds.getWorld('claimed')).runtimeId } });
  // What claimStop leaves behind before Remove fails against the unreachable host.
  await fixture.worlds.pool.query(`UPDATE lobby_operations SET status='RECOVERY_PENDING',
    context=jsonb_build_object('phase','CLAIMED','token',operation_id::text,'hostId',$2::text) WHERE operation_id=$1`,
  [op.operation_id, INSTANCE]);
  await fixture.worlds.pool.query(`UPDATE worlds SET status='STOPPING',reservation_token=$1 WHERE world_id='claimed'`,
    [op.operation_id]);
  const { worker } = workerWith(fixture, true);

  await worker.checkHost(host);

  assert.equal((await fixture.operations.get(op.operation_id)).context.phase, 'REMOVED');
  assert.equal((await fixture.worlds.getWorld('claimed')).status, 'STOPPING');
});
