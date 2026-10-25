import { createOperationsRuntime } from './operations.js';
import { OperationService } from '../../lifecycle/OperationService.js';
import { OperationDispatcher } from '../../worker/OperationDispatcher.js';

export async function createHttpRuntime(overrides = {}) {
  const runtime = await createOperationsRuntime(overrides);
  const dispatcher = new OperationDispatcher(runtime.operations);
  const service = new OperationService(runtime.worlds, runtime.operations, { dispatcher });
  return { ...runtime, dispatcher, service,
    async close() { dispatcher.client.destroy(); await runtime.close(); } };
}
