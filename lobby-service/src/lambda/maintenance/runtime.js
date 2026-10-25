import { createTasksRuntime } from '../../shared/runtime/tasks.js';
import { OperationDispatcher } from '../../worker/OperationDispatcher.js';

export async function createMaintenanceRuntime(overrides = {}) {
  const runtime = await createTasksRuntime(overrides);
  const dispatcher = new OperationDispatcher(runtime.operations);
  return { ...runtime, dispatcher,
    async close() { dispatcher.client.destroy(); await runtime.close(); } };
}
