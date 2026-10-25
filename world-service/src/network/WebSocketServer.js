import http from 'http';
import { WebSocketServer as WSServer, WebSocket } from 'ws';
import crypto from 'crypto';
import { MessageTypes, parseIncomingMessage, createMessage } from './protocol.js';

export class WebSocketServer {
  /**
   * @param {object} options
   * @param {number} options.port
   * @param {object} options.world Instance of World
   * @param {Function} [options.onPlayerCountChange] Callback when player count changes
   * @param {Function} [options.getMetrics] Supplies the payload served on GET /metrics
   * @param {Function} [options.onChatMessage] Receives validated chat lines for the cross-world bus
   * @param {number} [options.chatMaxLength] Hard cap on a chat line, in characters
   * @param {number} [options.chatCooldownMs] Minimum gap between messages from one player
   */
  constructor({
    port = 8001,
    world,
    onPlayerCountChange = null,
    getMetrics = null,
    onChatMessage = null,
    chatMaxLength = 120,
    chatCooldownMs = 1000,
  }) {
    this.port = port;
    this.world = world;
    this.onPlayerCountChange = onPlayerCountChange;
    this.getMetrics = getMetrics;
    this.onChatMessage = onChatMessage;
    this.chatMaxLength = chatMaxLength;
    this.chatCooldownMs = chatCooldownMs;

    this.httpServer = null;
    this.wss = null;
    this.clients = new Map(); // playerId -> { ws, playerId, playerName }
    this.pingInterval = null;
  }

  /**
   * Starts the HTTP & WebSocket server.
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      try {
        this.httpServer = http.createServer((req, res) => {
          const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
          if (url.pathname === '/health' || url.pathname === '/') {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify({
              status: 'ok',
              isReady: true,
              worldId: this.world.worldId,
              worldName: this.world.name,
              playersCount: this.clients.size,
              humanPlayers: this.getHumanPlayerCount(),
              botPlayers: this.clients.size - this.getHumanPlayerCount(),
              uptime: process.uptime(),
            }));
          } else if (url.pathname === '/metrics') {
            // Telemetry scraped by the Lobby's MetricsCollector. Kept separate from
            // /health so the readiness-probe contract stays exactly as it was.
            let payload;
            try {
              payload = typeof this.getMetrics === 'function' ? this.getMetrics() : null;
            } catch (err) {
              console.warn('[WebSocketServer] Failed to build metrics payload:', err.message);
              payload = null;
            }

            if (!payload) {
              res.writeHead(503, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              });
              res.end(JSON.stringify({ error: 'Metrics not available' }));
              return;
            }

            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify(payload));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found' }));
          }
        });

        this.wss = new WSServer({ server: this.httpServer });

        this.wss.on('connection', (ws, req) => {
          this._handleConnection(ws, req);
        });

        this.wss.on('error', (err) => {
          console.error('[WebSocketServer] WSS error:', err);
        });

        this.httpServer.on('error', (err) => {
          console.error('[WebSocketServer] HTTP Server error:', err);
          reject(err);
        });

        this.httpServer.listen(this.port, '0.0.0.0', () => {
          console.log(`[WebSocketServer] HTTP & WebSocket Server listening on 0.0.0.0:${this.port}`);
          this._startHeartbeat();
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  _handleConnection(ws, req) {
    const ip = req.socket.remoteAddress;
    console.log(`[WebSocketServer] New connection from ${ip}`);

    ws.isAlive = true;
    ws.playerId = null;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (rawData) => {
      this._handleMessage(ws, rawData);
    });

    ws.on('close', () => {
      this._handleDisconnect(ws);
    });

    ws.on('error', (err) => {
      console.warn(`[WebSocketServer] Socket error on player ${ws.playerId || 'anonymous'}:`, err.message);
    });
  }

  _handleMessage(ws, rawData) {
    const parsed = parseIncomingMessage(rawData);
    if (!parsed) {
      this._send(ws, createMessage(MessageTypes.ERROR, { message: 'Invalid message format' }));
      return;
    }

    const { type, payload } = parsed;

    switch (type) {
      case MessageTypes.JOIN:
        this._handleJoin(ws, payload);
        break;

      case MessageTypes.MOVE:
        this._handleMove(ws, payload);
        break;

      case MessageTypes.SHOOT:
        this._handleShoot(ws, payload);
        break;

      case MessageTypes.HARVEST:
        this._handleHarvest(ws, payload);
        break;

      case MessageTypes.BUILD:
        this._handleBuild(ws, payload);
        break;

      case MessageTypes.USE_ITEM:
        this._handleUseItem(ws, payload);
        break;

      case MessageTypes.CHAT_SEND:
        this._handleChat(ws, payload);
        break;

      default:
        console.warn(`[WebSocketServer] Unhandled message type: ${type}`);
        break;
    }
  }

  _handleJoin(ws, payload) {
    if (ws.playerId) {
      return;
    }

    const playerName = (payload.playerName || 'Explorer').toString().trim().slice(0, 24);
    const isBot = Boolean(payload.isBot);
    const playerId = `p_${crypto.randomUUID().slice(0, 8)}`;

    ws.playerId = playerId;
    this.clients.set(playerId, { ws, playerId, playerName, isBot });

    // Add to simulation state
    const player = this.world.addPlayer(playerId, playerName);

    console.log(`[WebSocketServer] ${isBot ? 'Bot' : 'Human player'} joined: "${playerName}" (ID: ${playerId}). Total: ${this.clients.size} (Humans: ${this.getHumanPlayerCount()})`);

    // Send INIT state to the joining player
    const initData = this.world.getInitData(playerId);
    this._send(ws, createMessage(MessageTypes.INIT, initData));

    // Notify other players
    const joinNotice = createMessage(MessageTypes.PLAYER_JOINED, {
      player: {
        id: player.id,
        name: player.name,
        x: player.x,
        y: player.y,
        hp: player.hp,
        maxHp: player.maxHp,
      },
    });
    this._broadcastExcept(playerId, joinNotice);

    if (typeof this.onPlayerCountChange === 'function') {
      this.onPlayerCountChange(this.getHumanPlayerCount(), this.clients.size);
    }
  }

  _handleMove(ws, payload) {
    if (!ws.playerId) {
      this._send(ws, createMessage(MessageTypes.ERROR, { message: 'Must JOIN before sending actions' }));
      return;
    }

    const direction = payload.direction || { x: 0, y: 0 };
    this.world.setPlayerMovement(ws.playerId, direction.x, direction.y);
  }

  _handleShoot(ws, payload) {
    if (!ws.playerId) return;
    const angle = Number(payload.angle);
    if (!isNaN(angle)) {
      this.world.shoot(ws.playerId, angle);
    }
  }

  _handleHarvest(ws, payload) {
    if (!ws.playerId) return;
    const result = this.world.harvest(ws.playerId, payload.targetId);
    if (!result.success) {
      this._send(ws, createMessage(MessageTypes.TOAST, { message: result.reason, type: 'warning' }));
    }
  }

  _handleBuild(ws, payload) {
    if (!ws.playerId) return;
    const { type, x, y } = payload;
    const result = this.world.buildStructure(ws.playerId, type, Number(x), Number(y));
    if (!result.success) {
      this._send(ws, createMessage(MessageTypes.TOAST, { message: result.reason, type: 'error' }));
    }
  }

  _handleUseItem(ws, payload) {
    if (!ws.playerId) return;
    const item = payload.item || 'food';
    if (item === 'food') {
      const result = this.world.consumeFood(ws.playerId);
      if (!result.success) {
        this._send(ws, createMessage(MessageTypes.TOAST, { message: result.reason, type: 'warning' }));
      }
    }
  }

  /**
   * Validates a player-authored chat line and hands it to the cross-world bus.
   *
   * This is the one place where user input leaves the world and reaches every
   * other instance, so it is rate limited and length capped before it travels.
   */
  _handleChat(ws, payload) {
    if (!ws.playerId) return;

    const client = this.clients.get(ws.playerId);
    if (!client) return;

    const text = (payload.text || '').toString().replace(/\s+/g, ' ').trim();
    if (!text) return;

    const now = Date.now();
    if (client.lastChatAt && now - client.lastChatAt < this.chatCooldownMs) {
      this._send(ws, createMessage(MessageTypes.TOAST, {
        message: 'Esperá un momento antes de enviar otro mensaje',
        type: 'warning',
      }));
      return;
    }
    client.lastChatAt = now;

    const chat = {
      playerName: client.playerName,
      text: text.slice(0, this.chatMaxLength),
      worldName: this.world.name,
      timestamp: new Date().toISOString(),
    };

    // Show it locally right away — players in this world should not wait for
    // the round trip through Redis, and the bus discards our own echo anyway.
    this.broadcast(createMessage(MessageTypes.CHAT_MESSAGE, { ...chat, isRemote: false }));

    if (typeof this.onChatMessage === 'function') {
      this.onChatMessage(chat);
    }
  }

  _handleDisconnect(ws) {
    const playerId = ws.playerId;
    if (playerId && this.clients.has(playerId)) {
      const clientInfo = this.clients.get(playerId);
      this.clients.delete(playerId);
      const removedPlayer = this.world.removePlayer(playerId);
      const name = removedPlayer ? removedPlayer.name : playerId;

      console.log(`[WebSocketServer] ${clientInfo?.isBot ? 'Bot' : 'Player'} disconnected: "${name}" (ID: ${playerId}). Remaining: ${this.clients.size} (Humans: ${this.getHumanPlayerCount()})`);

      // Broadcast disconnection to remaining clients
      const leaveNotice = createMessage(MessageTypes.PLAYER_LEFT, { playerId });
      this.broadcast(leaveNotice);

      if (typeof this.onPlayerCountChange === 'function') {
        this.onPlayerCountChange(this.getHumanPlayerCount(), this.clients.size);
      }
    }
  }

  getHumanPlayerCount() {
    let count = 0;
    for (const client of this.clients.values()) {
      if (!client.isBot) {
        count++;
      }
    }
    return count;
  }

  _send(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }

  /**
   * Broadcasts a message to all connected and authenticated players.
   * @param {string} message Formatted JSON string
   */
  broadcast(message) {
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
  }

  _broadcastExcept(excludePlayerId, message) {
    for (const [id, client] of this.clients.entries()) {
      if (id !== excludePlayerId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
  }

  _startHeartbeat() {
    this.pingInterval = setInterval(() => {
      if (!this.wss) return;
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          console.log('[WebSocketServer] Terminating unresponsive socket');
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);
  }

  /**
   * Stops the WebSocket server.
   * @returns {Promise<void>}
   */
  close() {
    return new Promise((resolve) => {
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }

      if (!this.wss) {
        resolve();
        return;
      }

      // Disconnect all clients
      for (const client of this.clients.values()) {
        try {
          client.ws.close(1000, 'Server shutting down');
        } catch {
          // ignore
        }
      }
      this.clients.clear();

      if (this.wss) {
        this.wss.close();
        this.wss = null;
      }

      if (this.httpServer) {
        this.httpServer.close(() => {
          console.log('[WebSocketServer] HTTP & WebSocket Server closed.');
          this.httpServer = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  getConnectedCount() {
    return this.clients.size;
  }
}
