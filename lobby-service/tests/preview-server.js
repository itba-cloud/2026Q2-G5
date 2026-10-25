// Local integration harness. AWS orchestration is replaced by the ASL contract
// runner; PostgreSQL, the HTTP handlers, Docker and WebSockets are real.
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { databaseFixture } from './helpers/database.js';
import { LocalWorkflowClient } from './helpers/local-workflows.js';
import { OperationDispatcher } from '../src/worker/OperationDispatcher.js';
import { createMaintenanceHandler } from '../src/lambda/maintenance.js';
import { OperationService } from '../src/lifecycle/OperationService.js';
import { LifecycleTasks } from '../src/lifecycle/LifecycleTasks.js';
import { DockerContainerLauncher } from '../src/orchestrator/DockerContainerLauncher.js';
import { createLobbyHttpApp } from '../src/server.js';
import { createLifecycleHandler } from '../src/lambda/lifecycle.js';

const fixture = await databaseFixture();
const { worlds, operations } = fixture;
const service = new OperationService(worlds, operations);
const launcher = new DockerContainerLauncher({ useMock: false, defaultImage: process.env.TEST_WORLD_IMAGE || 'ewo-world-migration-test:local' });
const tasks = new LifecycleTasks(worlds, operations, launcher);
const handler = createLifecycleHandler(async () => ({ tasks }));
const workflows = new LocalWorkflowClient(operations, handler);
const dispatcher = new OperationDispatcher(operations, workflows);
service.dispatcher = dispatcher;
const maintenance = createMaintenanceHandler(async () => ({ worlds, operations, tasks, dispatcher }));
const proxy = http.createServer((req, res) => {
  const upstream = http.request({ socketPath: process.env.TEST_DOCKER_SOCKET || '/var/run/docker.sock', path: req.url, method: req.method, headers: req.headers }, response => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on('error', () => res.writeHead(502).end());
  req.pipe(upstream);
}).listen(0, '127.0.0.1');
await once(proxy, 'listening');
const host = await worlds.registerHost({ id: 'preview-host', hostIp: '127.0.0.1', publicHost: '127.0.0.1',
  dockerApiUrl: `http://127.0.0.1:${proxy.address().port}`, maxWorlds: 4, portRange: { min: 18601, max: 18604 } });
process.env.WORLD_STORAGE_MODE = 'local';
process.env.REDIS_URL = '';
process.env.LOBBY_LOAD_BALANCER_URL = 'http://host.docker.internal:18701';
const config = { corsOrigins: ['*'] };
const internal = createLobbyHttpApp(config, worlds, null, { announce: async () => false }, { profile: 'internal', operationService: service }).listen(18701, '0.0.0.0');
const app = express();
app.get('/runtime-config.js', (req, res) => res.type('js').send('window.ELASTIC_WORLDS_RUNTIME_CONFIG={lobbyApiUrl:location.origin};'));
app.get('/arquitectura-lobby-lambda.html', (req, res) => res.sendFile(fileURLToPath(new URL('../../arquitectura-lobby-lambda.html', import.meta.url))));
app.post('/__local/maintenance', async (req, res) => {
  try { res.json(await maintenance({}, { getRemainingTimeInMillis: () => 30000 })); }
  catch (err) { res.status(500).json({ error: err.name }); }
});
app.use(express.static(fileURLToPath(new URL('../../client/', import.meta.url))));
app.use(createLobbyHttpApp(config, worlds, null, null, { profile: 'public', operationService: service }));
const server = app.listen(18700, '0.0.0.0');
// Mimic a World Host heartbeat. This does not dispatch or reconcile operations.
const timer = setInterval(() => {
  worlds.updateHostLoad(host.id, 0, { lastHeartbeat: new Date().toISOString() }).catch(console.error);
}, 60000);

let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  service.dispatcher = null; // Shutdown callbacks need not start new test workflows while cleaning up.
  await workflows.drain();
  for (const world of await worlds.listWorlds()) if (world.containerId) await launcher.stopWorldContainer(host, world.containerId);
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => internal.close(resolve));
  await new Promise(resolve => proxy.close(resolve));
  await fixture.close();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => close().catch(console.error));
console.log('Local serverless integration preview: http://localhost:18700 (isolated test database; local ASL runner, not AWS)');
