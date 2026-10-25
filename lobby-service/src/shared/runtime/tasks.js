import { createOperationsRuntime } from './operations.js';
import { LifecycleTasks } from '../../lifecycle/LifecycleTasks.js';
import { createWorldLauncher } from '../../orchestrator/createWorldLauncher.js';

export async function createTasksRuntime(overrides = {}) {
  const runtime = await createOperationsRuntime(overrides);
  const launcher = createWorldLauncher(runtime.config);
  const tasks = new LifecycleTasks(runtime.worlds, runtime.operations, launcher, { config: runtime.config });
  return { ...runtime, launcher, tasks };
}
