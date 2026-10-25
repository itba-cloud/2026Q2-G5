import { ECSClient, RunTaskCommand, DescribeTasksCommand, ListTasksCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { worldEnvironment } from './worldEnvironment.js';

const WORLD_TAG = 'elastic-worlds.world-id';
const TOKEN_TAG = 'elastic-worlds.reservation-token';

function eniOf(task) {
  const attachment = task.attachments?.find(a => a.type === 'ElasticNetworkInterface');
  const details = Object.fromEntries((attachment?.details || []).map(d => [d.name, d.value]));
  return { id: details.networkInterfaceId, privateIp: details.privateIPv4Address };
}

/**
 * FargateWorldLauncher: runs each world as its own ECS task on Fargate.
 * Same contract as DockerContainerLauncher, but there is no host: every task
 * gets its own ENI, so all worlds listen on the same port. The `host` argument
 * the lifecycle passes is ignored. Its public IP only exists once the ENI is
 * attached, so wsUrl is resolved after launch (see resolveEndpoint).
 */
export class FargateWorldLauncher {
  constructor(options = {}, { ecs = new ECSClient({ maxAttempts: 2 }), ec2, timeoutMs = 3000 } = {}) {
    for (const key of ['cluster', 'taskDefinition']) {
      if (!options[key]) throw new Error(`El launcher Fargate requiere ${key}`);
    }
    if (!options.subnets?.length || !options.securityGroups?.length) {
      throw new Error('El launcher Fargate requiere subnets y security groups');
    }
    this.options = { containerName: 'world', assignPublicIp: true, port: 8001, publicWsProtocol: 'ws', ...options };
    Object.assign(this, { ecs, ec2, timeoutMs });
    this.port = this.options.port;
    this.requiresHost = false;
    // StopTask only starts the shutdown: callers poll until the task is STOPPED.
    this.stopsAsynchronously = true;
  }

  isMockMode() {
    return false;
  }

  /** Tasks are found by startedBy, which carries the reservation token. */
  containerRef(worldId, token) {
    return token || null;
  }

  // The EC2 client is large (all of EC2's API). Only the public IP lookup needs
  // it, so it is loaded on first use instead of on every Lambda cold start.
  async ec2Client() {
    this.ec2Module ??= await import('@aws-sdk/client-ec2');
    this.ec2 ??= new this.ec2Module.EC2Client({ maxAttempts: 2 });
    return this.ec2;
  }

  send(client, command) {
    return client.send(command, { abortSignal: AbortSignal.timeout(this.timeoutMs) });
  }

  async launchWorldContainer(host, worldConfig) {
    const token = worldConfig.token || worldConfig.runtimeId;
    if (!token) throw new Error('El launcher Fargate requiere el token de la reserva');
    const port = worldConfig.port || this.port;
    const environment = worldEnvironment(worldConfig, {
      port, lobbyUrl: process.env.LOBBY_LOAD_BALANCER_URL || '', redisUrl: process.env.REDIS_URL || '',
    }).map(([name, value]) => ({ name, value }));
    // clientToken makes a retried launch return the same task instead of a second one.
    const { tasks = [], failures = [] } = await this.send(this.ecs, new RunTaskCommand({
      cluster: this.options.cluster,
      taskDefinition: this.options.taskDefinition,
      launchType: 'FARGATE',
      count: 1,
      clientToken: token,
      startedBy: token,
      networkConfiguration: { awsvpcConfiguration: {
        subnets: this.options.subnets,
        securityGroups: this.options.securityGroups,
        assignPublicIp: this.options.assignPublicIp ? 'ENABLED' : 'DISABLED',
      } },
      overrides: { containerOverrides: [{ name: this.options.containerName, environment }] },
      tags: [{ key: WORLD_TAG, value: worldConfig.id }, { key: TOKEN_TAG, value: token }],
    }));
    if (!tasks[0]?.taskArn) {
      throw new Error(`RunTask no inició la task: ${failures.map(f => f.reason).join(', ') || 'sin detalle'}`);
    }
    console.log(JSON.stringify({ event: 'fargate.task_started', worldId: worldConfig.id, taskArn: tasks[0].taskArn }));
    return { containerId: tasks[0].taskArn, port, wsUrl: null, internalWsUrl: null };
  }

  async describe(ref) {
    let arn = ref;
    if (!ref.startsWith('arn:')) {
      const { taskArns = [] } = await this.send(this.ecs, new ListTasksCommand({ cluster: this.options.cluster, startedBy: ref }));
      if (!taskArns.length) return null;
      arn = taskArns[0];
    }
    const { tasks = [] } = await this.send(this.ecs, new DescribeTasksCommand({
      cluster: this.options.cluster, tasks: [arn], include: ['TAGS'],
    }));
    return tasks[0] || null;
  }

  /**
   * Address of a launched task, once Fargate attached its ENI.
   * @returns {Promise<{ ready: boolean, stopped?: boolean, privateIp?: string, wsUrl?: string, internalWsUrl?: string }>}
   */
  async resolveEndpoint(ref) {
    try {
      const task = ref && await this.describe(ref);
      if (!task || task.lastStatus === 'STOPPED' || task.desiredStatus === 'STOPPED') {
        return { ready: false, stopped: true, reason: task?.stoppedReason };
      }
      const eni = eniOf(task);
      if (!eni.id || !eni.privateIp) return { ready: false };
      let publicIp = null;
      if (this.options.assignPublicIp) {
        // DescribeTasks only reports the private address; the public one lives on the ENI.
        const ec2 = await this.ec2Client();
        const { NetworkInterfaces = [] } = await this.send(ec2, new this.ec2Module.DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eni.id] }));
        publicIp = NetworkInterfaces[0]?.Association?.PublicIp;
        if (!publicIp) return { ready: false };
      }
      return {
        ready: true,
        privateIp: eni.privateIp,
        wsUrl: `${this.options.publicWsProtocol}://${publicIp || eni.privateIp}:${this.port}`,
        internalWsUrl: `ws://${eni.privateIp}:${this.port}`,
      };
    } catch (err) {
      // A transient AWS error is retried by the next health poll, until its deadline.
      console.warn(JSON.stringify({ event: 'fargate.endpoint_retry', ref, error: err.name }));
      return { ready: false };
    }
  }

  /**
   * Same shape as the Docker launcher. A STOPPED task needs no removal, so it
   * reports exists: false; tags are exposed as labels for identity checks.
   */
  async getContainerStatus(host, ref) {
    if (!ref) return { exists: false, running: false, status: 'not_found' };
    try {
      const task = await this.describe(ref);
      if (!task || task.lastStatus === 'STOPPED') {
        return { exists: false, running: false, status: task ? 'stopped' : 'not_found' };
      }
      return {
        exists: true,
        containerId: task.taskArn,
        labels: Object.fromEntries((task.tags || []).map(t => [t.key, t.value])),
        running: task.lastStatus === 'RUNNING',
        status: (task.lastStatus || 'unknown').toLowerCase(),
        privateIp: eniOf(task).privateIp,
      };
    } catch (err) {
      console.warn(JSON.stringify({ event: 'fargate.describe_failed', ref, error: err.name }));
      return { exists: false, running: false, status: 'unreachable', hostUnreachable: true };
    }
  }

  /** Asks ECS to stop the task. True only once it is STOPPED (or gone). */
  async stopWorldContainer(host, ref) {
    if (!ref) return true;
    try {
      const task = await this.describe(ref);
      if (!task || task.lastStatus === 'STOPPED') return true;
      if (task.desiredStatus !== 'STOPPED') {
        await this.send(this.ecs, new StopTaskCommand({
          cluster: this.options.cluster, task: task.taskArn, reason: 'Elastic Worlds: parada del mundo',
        }));
      }
      return false;
    } catch (err) {
      console.warn(JSON.stringify({ event: 'fargate.stop_failed', ref, error: err.name }));
      return false;
    }
  }

  /**
   * The world is shutting itself down: its essential container exits and
   * Fargate stops the task on its own. Never cut that short.
   */
  async removeWorldContainer(host, ref) {
    if (!ref) return true;
    const status = await this.getContainerStatus(host, ref);
    return !status.hostUnreachable && !status.exists;
  }
}
