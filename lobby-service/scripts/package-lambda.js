import { mkdtemp, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash, X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { command, FUNCTION_NAMES, packageFunction } from './lambda-packages.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.argv[2] || path.join(root, 'dist/lambdas'));
if (output.endsWith('.zip')) throw new Error('Pass an output directory: each Lambda now has its own ZIP.');
const temporary = await mkdtemp(path.join(tmpdir(), 'ewo-lambda-package-'));
const expectedCaHash = '90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b';
try {
  const installation = path.join(temporary, 'dependencies');
  await mkdir(installation);
  for (const name of ['package.json', 'package-lock.json']) await cp(path.join(root, name), path.join(installation, name));
  // The build tool stays in this temporary installation and never enters a ZIP.
  command('npm', ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: installation });
  const { build } = await import(pathToFileURL(path.join(installation, 'node_modules/esbuild/lib/main.js')));
  const response = await fetch('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem', { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Could not download the RDS CA bundle');
  const certificate = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(certificate).digest('hex') !== expectedCaHash) throw new Error('RDS CA bundle changed: review and update its pinned SHA-256');
  const certificates = certificate.toString().match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!certificates?.length) throw new Error('RDS bundle contains no certificates');
  for (const pem of certificates) new X509Certificate(pem);
  const manifest = {};
  for (const name of FUNCTION_NAMES) {
    const result = await packageFunction({ name, root, installation, staging: path.join(temporary, 'functions'), output, build, certificate });
    manifest[name] = result;
    console.log(`${name}: ${result.path}\nSHA-256: ${result.sha256}`);
  }
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
