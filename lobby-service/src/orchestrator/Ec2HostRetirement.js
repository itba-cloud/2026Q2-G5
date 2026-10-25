const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;
const RETIRED_STATES = new Set(['shutting-down', 'terminated']);

/**
 * Ec2HostRetirement: tells whether a World Host's EC2 instance was terminated.
 * Hosts register with their instance-id; missing heartbeats alone may only be a
 * network partition, and releasing those worlds could run them twice.
 */
export class Ec2HostRetirement {
  constructor({ ec2, timeoutMs = 3000 } = {}) {
    Object.assign(this, { ec2, timeoutMs });
  }

  async client() {
    this.ec2Module ??= await import('@aws-sdk/client-ec2');
    this.ec2 ??= new this.ec2Module.EC2Client({ maxAttempts: 2 });
    return this.ec2;
  }

  async isRetired(hostId) {
    if (!INSTANCE_ID.test(hostId || '')) return false;
    const client = await this.client();
    try {
      const { Reservations = [] } = await client.send(
        new this.ec2Module.DescribeInstancesCommand({ InstanceIds: [hostId] }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) }
      );
      const instance = Reservations.flatMap(r => r.Instances || []).find(i => i.InstanceId === hostId);
      return RETIRED_STATES.has(instance?.State?.Name);
    } catch (err) {
      // Terminated instances stay visible for about an hour, then EC2 forgets them.
      if (err?.name === 'InvalidInstanceID.NotFound') return true;
      throw err;
    }
  }
}
