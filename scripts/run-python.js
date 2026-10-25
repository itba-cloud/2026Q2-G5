import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Candidates for Python in virtualenv across OSes
const candidates = [
  path.join(rootDir, 'npc-service', '.venv', 'Scripts', 'python.exe'), // Windows venv
  path.join(rootDir, 'npc-service', '.venv', 'bin', 'python3'),       // Unix venv
  path.join(rootDir, 'npc-service', '.venv', 'bin', 'python'),        // Unix venv
  path.join(rootDir, '.venv', 'Scripts', 'python.exe'),               // Root Windows venv
  path.join(rootDir, '.venv', 'bin', 'python3'),                      // Root Unix venv
  path.join(rootDir, '.venv', 'bin', 'python')                        // Root Unix venv
];

let pythonExec = null;
for (const cand of candidates) {
  if (fs.existsSync(cand)) {
    pythonExec = cand;
    break;
  }
}

if (!pythonExec) {
  pythonExec = process.platform === 'win32' ? 'python' : 'python3';
}

const args = process.argv.slice(2);
const child = spawn(pythonExec, args, {
  stdio: 'inherit',
  cwd: rootDir
});

child.on('error', (err) => {
  console.error(`Failed to start python process (${pythonExec}):`, err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (code !== null) {
    process.exit(code);
  } else if (signal) {
    process.kill(process.pid, signal);
  }
});
