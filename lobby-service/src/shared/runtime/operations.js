import { createDatabaseRuntime } from './database.js';
import { RdsOperationRepository } from '../../store/RdsOperationRepository.js';

export async function createOperationsRuntime(overrides = {}) {
  const runtime = await createDatabaseRuntime(overrides);
  return { ...runtime, operations: new RdsOperationRepository(runtime.worlds, runtime.config) };
}
