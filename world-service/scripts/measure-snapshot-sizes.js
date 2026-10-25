// Measures world snapshot sizes with the real engine, serialized exactly as
// S3Adapter uploads them (compact JSON). Results back .docs/decision-snapshots.md.
// Usage: node world-service/scripts/measure-snapshot-sizes.js
import { gzipSync } from 'node:zlib';
import { World } from '../src/engine/World.js';

const KIB = 1024; 
const GLACIER_IR_MIN_BYTES = 128 * KIB;
const BIG_INVENTORY = () => ({ wood: 1e6, stone: 1e6, food: 1e6 });

function measure(world) { 
  const json = JSON.stringify(world.getSnapshot());
  return { bytes: Buffer.byteLength(json), gzip: gzipSync(json).length };
}

// Rocks are the only resources persisted once harvested (trees and bushes regrow).
function harvestAllRocks(world, builder) {
  for (const res of [...world.resources.values()]) {
    if (res.type !== 'rock') continue;
    builder.x = res.x;
    builder.y = res.y;
    while (world.resources.has(res.id)) {
      if (!world.harvest(builder.id, res.id)?.success) break;
    }
  }
}

// Builds on a hexagonal grid through the real placement rules; returns how many fit.
function buildMany(world, builder, limit, types = ['wall', 'campfire', 'turret']) {
  const step = 36;
  let built = 0;
  for (let row = 0; row * step * 0.866 < world.worldHeight && built < limit; row++) {
    const y = 20 + row * step * 0.866;
    const offset = row % 2 ? step / 2 : 0;
    for (let x = 20 + offset; x < world.worldWidth && built < limit; x += step) {
      builder.x = x;
      builder.y = y;
      builder.inventory = BIG_INVENTORY();
      if (world.buildStructure(builder.id, types[built % types.length], x, y).success) built++;
    }
  }
  return built;
}

// Players that left stay in players_data forever, so they count toward the size.
function addPlayers(world, count, online) {
  for (let n = 0; n < count; n++) {
    const id = `p-${n}-${'x'.repeat(24)}`;
    const player = world.addPlayer(id, `Jugador_${n}`);
    player.inventory = { wood: 37, stone: 12, food: 4 };
    player.kills = n % 7;
    player.deaths = n % 5;
    if (n >= online) world.removePlayer(id);
  }
}

function scenario(name, { players = 0, online = 0, structures = 0, rocks = false }) {
  const world = new World({ worldId: '9f1c2e4a-1b2c-4d5e-8f90-123456789abc', name });
  const builder = world.addPlayer('builder-0000000000000000000000', 'Constructor');
  if (rocks) harvestAllRocks(world, builder);
  const built = structures ? buildMany(world, builder, structures) : 0;
  addPlayers(world, players, online);
  return { name, players: players + 1, structures: built, ...measure(world) };
}

const rows = [
  scenario('Recién creado', {}),
  scenario('Casual', { players: 4, online: 2, structures: 20 }),
  scenario('Activo, rocas agotadas', { players: 19, online: 8, structures: 100, rocks: true }),
  scenario('Muy activo', { players: 99, online: 20, structures: 300, rocks: true }),
  scenario('Mapa lleno de estructuras', { players: 99, online: 20, structures: Infinity, rocks: true }),
  scenario('Mapa lleno + 1.000 jugadores históricos', { players: 999, online: 20, structures: Infinity, rocks: true }),
];

const kib = (bytes) => (bytes / KIB).toFixed(1);
console.log('| Escenario | Jugadores | Estructuras | JSON (KiB) | gzip (KiB) | > 128 KiB |');
console.log('| --- | ---: | ---: | ---: | ---: | :---: |');
for (const r of rows) {
  const archived = r.bytes > GLACIER_IR_MIN_BYTES ? 'sí' : 'no';
  console.log(`| ${r.name} | ${r.players} | ${r.structures} | ${kib(r.bytes)} | ${kib(r.gzip)} | ${archived} |`);
}

// Marginal size of each entity, measured against a world with a single player.
const emptyWorld = new World({ worldId: 'w' });
emptyWorld.addPlayer('b', 'B');
const baseBytes = measure(emptyWorld).bytes;

const turretWorld = new World({ worldId: 'w' });
buildMany(turretWorld, turretWorld.addPlayer('b', 'B'), 30, ['turret']);
console.log(`\nBytes por estructura ≈ ${((measure(turretWorld).bytes - baseBytes) / 30).toFixed(0)}`);

const historyWorld = new World({ worldId: 'w' });
historyWorld.addPlayer('b', 'B');
addPlayers(historyWorld, 100, 0);
console.log(`Bytes por jugador histórico ≈ ${((measure(historyWorld).bytes - baseBytes) / 100).toFixed(0)}`);
