import { SFNClient, StartExecutionCommand, DescribeExecutionCommand } from '@aws-sdk/client-sfn';

export function executionArnFor(op) {
  const match = /^(arn:[^:]+:states:[^:]+:[^:]+):stateMachine:([^:]+):\d+$/.exec(op.workflow_version_arn);
  if (!match) throw new Error('Workflow must use an immutable version ARN');
  return `${match[1]}:execution:${match[2]}:${op.operation_id}`;
}

export class OperationDispatcher {
  constructor(operations, client = new SFNClient({ maxAttempts: 1 })) {
    this.operations = operations;
    this.client = client;
  }

  send(command, timeoutMs = 3000) {
    return this.client.send(command, { abortSignal: AbortSignal.timeout(timeoutMs) });
  }

  async tick({ limit = 10 } = {}) {
    const pending = await this.operations.claimDispatch(limit);
    await Promise.all(pending.map(op => this.dispatch(op)));
    return pending.length;
  }

  async dispatchOne(operationId, options) {
    const [op] = await this.operations.claimDispatch(1, operationId);
    return op ? this.dispatch(op, options) : false;
  }

  async dispatch(op, { timeoutMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const send = command => this.send(command, Math.max(1, deadline - Date.now()));
    try {
      let arn;
      const input = JSON.stringify({ operationId: op.operation_id, contractVersion: 1 });
      try {
        const result = await send(new StartExecutionCommand({
          stateMachineArn: op.workflow_version_arn, name: op.operation_id, input,
        }));
        arn = result.executionArn;
      } catch (err) {
        if (err.name !== 'ExecutionAlreadyExists') throw err;
        // A closed execution rejects StartExecution even with identical input.
        const result = await send(new DescribeExecutionCommand({ executionArn: executionArnFor(op) }));
        if (result.input !== input || (result.stateMachineVersionArn && result.stateMachineVersionArn !== op.workflow_version_arn)) {
          throw new Error('Execution identity mismatch');
        }
        arn = result.executionArn;
      }
      await this.operations.dispatched(op, arn);
      console.log(JSON.stringify({ event: 'operation.dispatched', operationId: op.operation_id }));
      return true;
    } catch (err) {
      console.warn(JSON.stringify({ event: 'operation.dispatch_retry', operationId: op.operation_id, error: err.name }));
      await this.operations.dispatchFailed(op);
      return false;
    }
  }
}
