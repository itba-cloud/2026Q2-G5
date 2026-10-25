import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env reliably regardless of execution working directory
try {
  const dotenv = await import('dotenv');
  if (dotenv && dotenv.default && typeof dotenv.default.config === 'function') {
    // 1. Root .env
    const rootEnv = path.resolve(__dirname, '../../.env');
    if (fs.existsSync(rootEnv)) {
      dotenv.default.config({ path: rootEnv });
    }
    // 2. Module specific lobby-service/.env (overrides root)
    const moduleEnv = path.resolve(__dirname, '../.env');
    if (fs.existsSync(moduleEnv)) {
      dotenv.default.config({ path: moduleEnv, override: true });
    }
    // 3. Fallback to cwd
    dotenv.default.config();
  }
} catch {
  // Runs seamlessly if dotenv is not installed
}

// Load configuration after the legacy/local .env initialization above.
export const { config } = await import('./shared/config.js');
