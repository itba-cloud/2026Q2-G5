import { config } from '../config.js';
import { RdsWorldRepository } from './RdsWorldRepository.js';

if (config.storageMode !== 'rds') throw new Error('Migration requires STORAGE_MODE=rds');
const repository = new RdsWorldRepository(config);
try {
  await repository.init({ migrate: true });
} finally {
  await repository.close();
}
