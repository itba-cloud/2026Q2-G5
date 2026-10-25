import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetworkClient } from '../js/network.js';

test('A reused port cannot connect the player to a different world', async t => {
  const original = globalThis.WebSocket;
  let worldId = 'another-world';
  let created = 0;
  class Socket {
    static OPEN = 1;
    constructor() { created++; this.readyState = 1; queueMicrotask(() => this.onopen?.()); }
    send() { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'INIT', payload: { worldId, playerId: 'p_test' } }) })); }
    close() { this.readyState = 3; this.onclose?.({}); }
  }
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = original; });
  const client = new NetworkClient();
  let initEvents = 0;
  client.on('INIT', () => initEvents++);
  await assert.rejects(client.connect('ws://reused-port', 'Player', 4, 1, 'selected-world'), { code: 'WORLD_MISMATCH' });
  assert.equal(created, 1, 'Do not retry an endpoint that identifies a different world');
  assert.equal(initEvents, 0, 'The game never consumes the wrong INIT');
  assert.equal(client.isConnected, false);
  worldId = 'selected-world';
  const result = await client.connect('ws://current-port', 'Player', 4, 1, 'selected-world');
  assert.equal(result.worldId, 'selected-world');
  assert.equal(initEvents, 1);
  client.disconnect();
});
