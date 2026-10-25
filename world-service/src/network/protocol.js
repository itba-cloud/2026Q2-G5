/**
 * Protocol Definitions and Message Schemas for World Service.
 * Follows the specifications in world-service.md.
 */

export const MessageTypes = Object.freeze({
  // Client -> Server
  JOIN: 'JOIN',
  MOVE: 'MOVE',
  SHOOT: 'SHOOT',
  HARVEST: 'HARVEST',
  BUILD: 'BUILD',
  USE_ITEM: 'USE_ITEM',
  CHAT_SEND: 'CHAT_SEND', // Player writes a line for the cross-world channel
  CHAT_NPC: 'CHAT_NPC', // Reserved for future

  // Server -> Client
  INIT: 'INIT',
  STATE_SYNC: 'STATE_SYNC',
  PLAYER_JOINED: 'PLAYER_JOINED',
  PLAYER_LEFT: 'PLAYER_LEFT',
  RESOURCE_HARVESTED: 'RESOURCE_HARVESTED',
  RESOURCE_DAMAGED: 'RESOURCE_DAMAGED',
  RESOURCE_REGENERATED: 'RESOURCE_REGENERATED',
  STRUCTURE_BUILT: 'STRUCTURE_BUILT',
  STRUCTURE_DESTROYED: 'STRUCTURE_DESTROYED',
  PLAYER_HIT: 'PLAYER_HIT',
  PLAYER_DIED: 'PLAYER_DIED',
  PLAYER_RESPAWNED: 'PLAYER_RESPAWNED',
  NPC_RESPONSE: 'NPC_RESPONSE', // Reserved for future
  CHAT_MESSAGE: 'CHAT_MESSAGE', // A chat line, from this world or any other
  WORLD_NOTICE: 'WORLD_NOTICE', // Another world came online / went to sleep
  ERROR: 'ERROR',
  TOAST: 'TOAST',
});

/**
 * Validates and normalizes incoming raw JSON WebSocket message.
 * @param {string|Buffer} rawData
 * @returns {{ type: string, payload: any } | null}
 */
export function parseIncomingMessage(rawData) {
  try {
    const text = typeof rawData === 'string' ? rawData : rawData.toString('utf-8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      return null;
    }
    return {
      type: parsed.type,
      payload: parsed.payload || {},
    };
  } catch {
    return null;
  }
}

/**
 * Creates formatted JSON string to be sent over WebSocket.
 * @param {string} type
 * @param {object} payload
 * @returns {string}
 */
export function createMessage(type, payload = {}) {
  return JSON.stringify({
    type,
    payload,
  });
}
