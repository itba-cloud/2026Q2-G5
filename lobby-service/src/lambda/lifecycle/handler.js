import { createTasksRuntime as createRuntime } from '../../shared/runtime/tasks.js';

export function createLifecycleHandler(initialize = createRuntime) {
  let ready;
  return async (event, context = {}) => {
    context.callbackWaitsForEmptyEventLoop = false;
    if (!ready) ready = initialize().catch(err => { ready = undefined; throw err; });
    try {
      const runtime = await ready;
      return await runtime.tasks.invoke(event.action, event.operationId, { executionArn: event.executionArn });
    } catch (err) {
      if (err.code === 'TASK_BUSY') err.name = 'TaskBusy';
      if (['40001', '40P01', '57P01', 'ECONNRESET', 'ECONNREFUSED'].includes(err.code)) err.name = 'TransientDatabaseError';
      throw err;
    }
  };
}

export const handler = createLifecycleHandler();
