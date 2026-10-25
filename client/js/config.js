const isBrowser = typeof window !== 'undefined';
const isSecure = isBrowser && window.location.protocol === 'https:';
const defaultHost = isBrowser ? (window.location.hostname || 'localhost') : 'localhost';
const defaultProtocol = isBrowser ? window.location.protocol : 'http:';
const runtimeConfig = isBrowser ? window.ELASTIC_WORLDS_RUNTIME_CONFIG || {} : {};

export const ClientConfig = Object.freeze({
  // Default WebSocket server endpoint for fallback game instance
  defaultWorldWsUrl: `${isSecure ? 'wss:' : 'ws:'}//${defaultHost}:8001`,

  // Default REST API for Lobby Service (Control Plane)
  lobbyApiUrl: runtimeConfig.lobbyApiUrl || `${defaultProtocol}//${defaultHost}:3000`,
  fallbackLobbyApiUrl: runtimeConfig.fallbackLobbyApiUrl || (runtimeConfig.lobbyApiUrl ? null : `${defaultProtocol}//${defaultHost}:3001`),

  // Default REST API for the metrics service (monitoring & cost dashboard). In AWS the
  // ALB routes /api/metrics* to it, so the dashboard is opened with ?api=<ALB> instead.
  metricsApiUrl: runtimeConfig.metricsApiUrl || `${defaultProtocol}//${defaultHost}:3100`,

  // Local storage keys
  storageKeys: {
    playerName: 'ewo_player_name',
    lastWorldUrl: 'ewo_last_world_url',
  },
});
