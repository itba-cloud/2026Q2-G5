import { createMaintenanceRuntime as createRuntime } from './runtime.js';
import { ReconciliationWorker } from '../../worker/ReconciliationWorker.js';
import { Ec2HostRetirement } from '../../orchestrator/Ec2HostRetirement.js';

export function createMaintenanceHandler(initialize = createRuntime) {
  let ready;
  return async (event, context = {}) => {
    context.callbackWaitsForEmptyEventLoop = false;
    if (!ready) ready = initialize().then(runtime => ({ runtime,
      reconciler: new ReconciliationWorker(runtime.worlds, runtime.operations, runtime.tasks, runtime.dispatcher,
        { retirement: new Ec2HostRetirement() }),
    })).catch(err => { ready = undefined; throw err; });
    const { reconciler } = await ready;
    return reconciler.tick({ remainingMs: () => context.getRemainingTimeInMillis?.() ?? 30000 });
  };
}

export const handler = createMaintenanceHandler();
