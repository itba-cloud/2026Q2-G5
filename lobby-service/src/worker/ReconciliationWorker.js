import { randomUUID } from 'node:crypto';
import { DescribeExecutionCommand, StopExecutionCommand } from '@aws-sdk/client-sfn';
import { executionArnFor } from './OperationDispatcher.js';
import { TERMINAL } from '../lifecycle/errors.js';

/** One sweep at a time, with short DB leases and no DB transaction across network I/O. */
export class ReconciliationWorker {
  constructor(worlds, operations, tasks, dispatcher, { now = Date.now, retirement = null } = {}) {
    Object.assign(this, { worlds, operations, tasks, dispatcher, retirement });
    this.now = now;
    this.token = randomUUID();
    this.running = false;
  }

  async tick({ budgetMs = 20000, remainingMs = () => Infinity } = {}) {
    if (this.running) return { skipped: true };
    this.running = true;
    const started = this.now();
    const canContinue = () => this.now() - started < budgetMs && remainingMs() > 12000;
    const summary = { processed: 0, errors: 0, skipped: false };
    try {
      if (!await this.operations.lease('reconciliation', this.token)) return { ...summary, skipped: true };
      try {
        const stages = ['dispatch', 'hosts', 'operations', 'worlds'];
        let stage = Number(await this.operations.checkpoint('stage')) || 0;
        let empty = 0;
        while (canContinue() && empty < stages.length) {
          await this.stillLeader();
          const name = stages[stage % stages.length];
          stage = (stage + 1) % stages.length;
          await this.operations.saveCheckpoint('stage', String(stage), this.token);
          const processed = await this.sweepOne(name, canContinue, summary);
          empty = processed ? 0 : empty + 1;
          if (processed) summary.processed++;
          if (summary.processed >= 40) break;
        }
        const stats = (await this.operations.pool.query(`SELECT count(*)::int AS pending,
          COALESCE(EXTRACT(EPOCH FROM now()-min(created_at)),0)::int AS oldest_seconds
          FROM lobby_operations WHERE status IN ('ACCEPTED','RUNNING','RECOVERY_PENDING')`)).rows[0];
        Object.assign(summary, stats, { durationMs: this.now() - started });
        console.log(JSON.stringify({ event: 'maintenance.completed', ...summary }));
        return summary;
      } finally {
        await this.operations.releaseLease('reconciliation', this.token);
      }
    } finally { this.running = false; }
  }

  async sweepOne(stage, canContinue, summary) {
    if (stage === 'dispatch') return (await this.dispatcher.tick({ limit: 1 })) > 0;
    const cursor = await this.operations.checkpoint(stage);
    const query = stage === 'hosts' ? ['hosts', 'host_id', 'true']
      : stage === 'worlds' ? ['worlds', 'world_id', "status='ACTIVE'"]
        : ['lobby_operations', 'operation_id', "status IN ('RUNNING','RECOVERY_PENDING')"];
    const [table, key, where] = query;
    // Identifiers are constants; user data is always bound as a parameter.
    const row = (await this.operations.pool.query(`SELECT * FROM ${table}
      WHERE ${where} AND ${key}>$1${stage === 'operations' ? '::uuid' : ''}
      ORDER BY ${key} LIMIT 1`, [cursor || (stage === 'operations' ? '00000000-0000-0000-0000-000000000000' : '')])).rows[0];
    if (!row) {
      await this.operations.saveCheckpoint(stage, '', this.token);
      return false;
    }
    try {
      if (stage === 'hosts') await this.checkHost(await this.worlds.getHost(row.host_id));
      if (stage === 'operations') await this.recover(row, { canContinue });
      if (stage === 'worlds') await this.checkWorld(await this.worlds.getWorld(row.world_id));
    } catch (err) {
      summary.errors++;
      console.warn(JSON.stringify({ event: 'maintenance.item_retry', stage, id: row[key], error: err.name }));
    }
    await this.operations.saveCheckpoint(stage, String(row[key]), this.token);
    return true;
  }

  async checkHost(host) {
    if (!host) return;
    const age = this.now() - new Date(host.lastHeartbeat || this.now()).getTime();
    if (age > 90000 && host.status !== 'DOWN') await this.operations.pool.query(`UPDATE hosts SET status='DOWN',updated_at=now()
      WHERE host_id=$1 AND last_heartbeat < now()-interval '90 seconds'`, [host.id]);
    // Worlds stay on a silent host until EC2 confirms it was terminated.
    if (age > 90000 && this.retirement && await this.operations.hasPlacedWorlds(host.id)
      && await this.retirement.isRetired(host.id)) {
      const { released, stopping } = await this.operations.releaseWorldsOnRetiredHost(host.id);
      if (released.length || stopping.length) {
        console.log(JSON.stringify({ event: 'maintenance.host_retired', hostId: host.id, released, stopping }));
      }
    }
    if (age > 300000) await this.operations.pool.query(`DELETE FROM hosts h WHERE host_id=$1
      AND last_heartbeat < now()-interval '300 seconds'
      AND NOT EXISTS (SELECT 1 FROM worlds w WHERE w.host_id=h.host_id)`, [host.id]);
  }

  async checkWorld(world) {
    if (!world) return;
    const host = await this.tasks.placement(world.hostId);
    if (!host) return;
    const status = await this.tasks.launcher.getContainerStatus(host, world.containerId);
    if (status.hostUnreachable) {
      if (world.hostId) await this.worlds.updateHostStatus(host.id, 'DOWN');
      return;
    }
    if (!status.exists || (!status.running && status.status !== 'unknown')) {
      try {
        const op = await this.operations.accept({ kind: 'SELF_SHUTDOWN', worldId: world.id,
          key: `reconcile:${world.runtimeId || world.id}`, visibility: 'internal', payload: { runtimeId: world.runtimeId } });
        await this.dispatcher.dispatchOne(op.operation_id);
      } catch (err) { if (!['OPERATION_PENDING', 'STALE_RUNTIME'].includes(err.code)) throw err; }
    }
  }

  async stillLeader() {
    if (!await this.operations.lease('reconciliation', this.token)) throw new Error('Sweep lease lost');
  }

  async recover(op, { canContinue = () => true } = {}) {
    const executionArn = op.execution_arn || executionArnFor(op);
    const execution = await this.dispatcher.send(new DescribeExecutionCommand({ executionArn }));
    if (execution.status === 'RUNNING') {
      if (new Date(op.deadline_at) < new Date()) {
        await this.dispatcher.send(new StopExecutionCommand({ executionArn, error: 'OperationDeadlineExceeded' }));
      }
      return;
    }
    // StopExecution does not kill an already executing Lambda. Its 45s lease is
    // longer than the configured 30s Lambda timeout; wait before taking ownership.
    if (op.task_expires_at && new Date(op.task_expires_at) > new Date()) return;
    const reloaded = await this.operations.get(op.operation_id);
    if (!reloaded || TERMINAL.has(reloaded.status)) return;
    await this.operations.pool.query(`UPDATE lobby_operations SET status='RECOVERY_PENDING',updated_at=now()
      WHERE operation_id=$1 AND status IN ('RUNNING','RECOVERY_PENDING')`, [op.operation_id]);
    const invoke = async action => canContinue() ? this.tasks.invoke(action, op.operation_id, { recovery: true }) : null;
    if (op.kind === 'START') {
      const result = await invoke('cleanup');
      if (result && !result.recoveryPending && !result.done) await invoke('recordFailure');
    } else {
      const claim = await invoke('claimStop');
      if (!claim || claim.waiting) return;
      if (!claim.released) {
        const removed = await invoke('remove');
        if (!removed?.removed) return;
        if (!await invoke('release')) return;
      }
      if (!await invoke('delete')) return;
      await invoke('finish');
    }
  }

}
