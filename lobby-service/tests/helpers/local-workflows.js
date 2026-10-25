import { definition, runWorkflow } from './workflow.js';
import { executionArnFor } from '../../src/worker/OperationDispatcher.js';

// An in-process AWS client double. It executes the repo's actual ASL against the
// lifecycle handler, while retaining execution names/input for dispatcher retries.
export class LocalWorkflowClient {
  constructor(operations, handler) {
    Object.assign(this, { operations, handler });
    this.executions = new Map();
    this.pending = new Set();
  }

  async send(command) {
    const { input } = command;
    if (command.constructor.name === 'StartExecutionCommand') {
      const op = await this.operations.get(JSON.parse(input.input).operationId);
      const executionArn = executionArnFor(op);
      if (this.executions.has(executionArn)) throw Object.assign(new Error('Already exists'), { name: 'ExecutionAlreadyExists' });
      const execution = { executionArn, input: input.input, stateMachineVersionArn: input.stateMachineArn, status: 'RUNNING' };
      this.executions.set(executionArn, execution);
      const pending = definition(op.kind === 'START' ? 'start' : 'stop').then(asl =>
        runWorkflow(asl, this.handler, { operationId: op.operation_id }, {
          executionArn, wait: seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)),
        })).then(result => { execution.status = result.status; }).catch(error => { execution.status = 'FAILED'; execution.error = error; });
      this.pending.add(pending);
      pending.finally(() => this.pending.delete(pending));
      return { executionArn };
    }
    const execution = this.executions.get(input.executionArn);
    if (!execution) throw Object.assign(new Error('No execution'), { name: 'ExecutionDoesNotExist' });
    if (command.constructor.name === 'StopExecutionCommand') execution.status = 'ABORTED';
    return execution;
  }

  async drain() { await Promise.allSettled([...this.pending]); }
  destroy() {}
}
