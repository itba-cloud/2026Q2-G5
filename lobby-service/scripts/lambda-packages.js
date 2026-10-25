import { chmod, cp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const FUNCTION_NAMES = ['public', 'internal', 'lifecycle', 'maintenance', 'migrate'];
const packageName = specifier => specifier.startsWith('@')
  ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

export function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed (${result.status})`);
}

// Preserve normal Node resolution and package files (including conditional
// exports). Never bundle third-party modules or copy the full node_modules tree.
async function copyDependencies(names, installation, destination) {
  installation = path.resolve(installation);
  const copied = new Set();
  async function copy(name, parent, optional = false) {
    const lookup = createRequire(path.join(parent, 'package.json')).resolve.paths(name) || [];
    let directory;
    for (const base of lookup) {
      const candidate = path.join(base, name);
      if (!candidate.startsWith(`${installation}${path.sep}`)) continue;
      try { await stat(path.join(candidate, 'package.json')); directory = candidate; break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!directory) {
      if (optional) return;
      throw new Error(`Missing runtime dependency ${name} required by ${parent}`);
    }
    if (copied.has(directory)) return;
    copied.add(directory);
    const target = path.join(destination, path.relative(installation, directory));
    await mkdir(path.dirname(target), { recursive: true });
    await cp(directory, target, { recursive: true,
      filter: source => source === directory || path.basename(source) !== 'node_modules' });
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const name of Object.keys(dependencies).sort()) {
      const optional = name in (manifest.optionalDependencies || {})
        || (!(name in (manifest.dependencies || {})) && name in (manifest.peerDependencies || {}));
      await copy(name, directory, optional);
    }
  }
  for (const name of names) await copy(name, installation);
}

export async function packageFunction({ name, root, installation, staging, output, build, certificate }) {
  const directory = path.join(staging, name);
  const entry = `src/lambda/${name}/handler.js`;
  const { metafile } = await build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, packages: 'external',
    platform: 'node', format: 'esm', target: 'node22', write: false, metafile: true, logLevel: 'silent',
  });
  const sources = Object.keys(metafile.inputs).sort();
  const dependencies = [...new Set(Object.values(metafile.outputs)
    .flatMap(file => file.imports).filter(item => item.external && !isBuiltin(item.path))
    .map(item => packageName(item.path)))].sort();
  for (const source of sources) {
    if (!source.startsWith('src/') || source.includes('..')) throw new Error(`Unexpected source: ${source}`);
    const target = path.join(directory, source);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, source), target);
  }
  if (name === 'migrate') {
    await cp(path.join(root, 'src/store/migrations'), path.join(directory, 'src/store/migrations'), { recursive: true });
  }
  await copyDependencies(dependencies, installation, directory);
  const installed = JSON.parse(await readFile(path.join(installation, 'package-lock.json'), 'utf8'));
  const versions = Object.fromEntries(dependencies.map(name => [name, installed.packages[`node_modules/${name}`].version]));
  await writeFile(path.join(directory, 'package.json'), `${JSON.stringify({ name: `lobby-${name}`, private: true, type: 'module', dependencies: versions }, null, 2)}\n`);
  await mkdir(path.join(directory, 'certs'));
  await writeFile(path.join(directory, 'certs/rds-ca.pem'), certificate);
  await writeFile(path.join(directory, 'package-manifest.json'), `${JSON.stringify({ function: name, handler: `${entry.slice(0, -3)}.handler`, sources, dependencies: versions }, null, 2)}\n`);
  const files = [];
  const epoch = new Date('2000-01-01T00:00:00Z');
  async function walk(relative) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else {
        files.push(name);
        const file = path.join(directory, name);
        // ZIP stores Unix permissions: normalize umask-dependent npm/copy modes.
        const executable = (await stat(file)).mode & 0o111;
        await chmod(file, executable ? 0o755 : 0o644);
        await utimes(file, epoch, epoch);
      }
    }
  }
  await walk('');
  await mkdir(output, { recursive: true });
  const archive = path.join(output, `${name}.zip`);
  await rm(archive, { force: true });
  command('zip', ['-q', '-X', archive, '-@'], { cwd: directory, input: files.sort().join('\n') + '\n',
    stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, TZ: 'UTC' } });
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
  return { path: archive, sha256: hash, sources, dependencies: versions };
}
