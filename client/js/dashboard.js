/**
 * Monitoring and cost dashboard.
 *
 * Consumes the metrics service API (/api/metrics and /api/metrics/history) and
 * renders it without external dependencies. The metrics service does the heavy
 * lifting (world scraping, aggregation and costing); this module only presents.
 */

import { ClientConfig } from './config.js';

const REFRESH_MS = 5000;
const HISTORY_POINTS = 120;
const FETCH_TIMEOUT_MS = 4000;

const el = {
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  errorBanner: document.getElementById('error-banner'),
  kpiGrid: document.getElementById('kpi-grid'),
  chartGrid: document.getElementById('chart-grid'),
  historyWindow: document.getElementById('history-window'),
  worldsBody: document.getElementById('worlds-tbody'),
  hostsBody: document.getElementById('hosts-tbody'),
  recList: document.getElementById('rec-list'),
  footerInfo: document.getElementById('footer-info'),
  refreshBtn: document.getElementById('btn-refresh'),
  logoutBtn: document.getElementById('btn-logout'),
  authModal: document.getElementById('auth-modal'),
  authForm: document.getElementById('auth-form'),
  authUser: document.getElementById('auth-user'),
  authPass: document.getElementById('auth-pass'),
  authError: document.getElementById('auth-error'),
};


/**
 * Base URL of the metrics API. Locally it is the metrics service itself (:3100). In AWS
 * the panel is opened with ?api=http://<ALB>, whose listener rule sends /api/metrics*
 * straight to the metrics service.
 */
const apiBase = new URLSearchParams(window.location.search).get('api')
  || ClientConfig.metricsApiUrl;

let timer = null;
let consecutiveFailures = 0;
let isRefreshing = false;
/** Collector cadence reported by the server; the chart window is labelled from it. */
let collectorIntervalMs = REFRESH_MS;

// --------------------------------------------------------------------------
// Formatting
// --------------------------------------------------------------------------

/**
 * Escapes any value coming from the Lobby. The registry accepts unvalidated fields
 * (POST /worlds/:id/status still writes `name`, `biome` and the counters as-is),
 * so nothing in the snapshot can be treated as trusted.
 */
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const num = (value, decimals = 0, fallback = '—') => (
  typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(decimals)
    : fallback
);

const usd = (value, decimals = 4) => (
  typeof value === 'number' && Number.isFinite(value)
    ? `$${value.toFixed(decimals)}`
    : '—'
);

function duration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// --------------------------------------------------------------------------
// KPIs
// --------------------------------------------------------------------------

function tickClass(effectiveHz, targetHz = 20) {
  if (typeof effectiveHz !== 'number') return '';
  const ratio = effectiveHz / targetHz;
  if (ratio >= 0.95) return 'good';
  if (ratio >= 0.85) return 'warn';
  return 'bad';
}

function renderKpis(snapshot) {
  const { fleet, cost } = snapshot;

  const cards = [
    {
      label: 'Partidas activas',
      value: fleet.activeWorlds,
      unit: `/ ${fleet.totalWorlds}`,
      sub: `${num(fleet.idleWorlds, 0)} inactiva(s) · sin costo de cómputo`,
      cls: '',
    },
    {
      label: 'Jugadores conectados',
      value: fleet.totalPlayers,
      sub: `${num(fleet.humanPlayers, 0)} humano(s) · ${num(fleet.botPlayers, 0)} bot(s)`,
      cls: '',
    },
    {
      label: 'Memoria en uso',
      value: num(fleet.totalMemoryMb, 0),
      unit: 'MB',
      sub: `Suma del RSS de ${fleet.activeWorlds - fleet.unreachableWorlds} contenedor(es)`,
      cls: '',
    },
    {
      label: 'Rendimiento game loop',
      value: num(fleet.avgTickHz, 1),
      unit: 'Hz',
      sub: 'Objetivo: 20 Hz (50 ms por tick)',
      cls: tickClass(fleet.avgTickHz),
    },
    {
      label: 'Latencia IA (NPCs)',
      value: num(fleet.avgAiLatencyMs, 2),
      unit: 'ms',
      sub: `${num(fleet.totalBots, 0)} bot(s) decidiendo`,
      cls: 'ai',
    },
    {
      label: 'Costo atribuido',
      value: usd(cost.attributedHourlyUsd, 4),
      unit: '/h',
      sub: `≈ ${usd(cost.attributedMonthlyUsd, 2)}/mes si se sostiene`,
      cls: 'cost',
    },
    {
      label: 'Costo fijo de flota',
      value: usd(cost.fleetFixedHourlyUsd, 4),
      unit: '/h',
      sub: `${usd(cost.idleCapacityHourlyUsd, 4)}/h en capacidad ociosa`,
      cls: '',
    },
    {
      label: 'Ahorro por elasticidad',
      value: `${num(cost.savedByElasticityPct, 1)}%`,
      sub: `${usd(cost.savedByElasticityUsd, 4)} no gastados en ${duration(cost.observationSeconds)}`,
      cls: 'good',
    },
  ];

  el.kpiGrid.innerHTML = cards.map((c) => `
    <div class="kpi-card">
      <div class="kpi-label">${esc(c.label)}</div>
      <div class="kpi-value ${c.cls}">${esc(c.value)}${c.unit ? `<span class="kpi-unit">${esc(c.unit)}</span>` : ''}</div>
      <div class="kpi-sub">${esc(c.sub)}</div>
    </div>
  `).join('');
}

// --------------------------------------------------------------------------
// Sparklines (plain SVG, no libraries)
// --------------------------------------------------------------------------

/**
 * Draws a series as an area + line inside a normalised viewBox.
 * @param {number[]} values
 * @param {string} color
 * @returns {string} Markup SVG
 */
function sparkline(values, color) {
  const points = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (points.length < 2) {
    return '<div class="empty-state" style="padding:14px;font-size:0.78rem">Recolectando datos…</div>';
  }

  const width = 100;
  const height = 30;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const isFlat = max === min;

  const coords = points.map((value, i) => {
    const x = (i / (points.length - 1)) * width;
    // A constant series is drawn at mid height: resting it on the floor would imply
    // a minimum that does not exist, and would divide by zero.
    const y = isFlat
      ? height / 2
      : height - ((value - min) / (max - min)) * (height - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const gradientId = `grad-${color.replace('#', '')}`;

  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-hidden="true">
      <defs>
        <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <polygon points="0,${height} ${coords.join(' ')} ${width},${height}" fill="url(#${gradientId})"/>
      <polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5"
                stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    </svg>
  `;
}

function renderCharts(history) {
  const series = [
    { name: 'Jugadores', key: 'totalPlayers', color: '#3b82f6', decimals: 0, unit: '' },
    { name: 'Memoria total', key: 'totalMemoryMb', color: '#10b981', decimals: 0, unit: ' MB' },
    { name: 'Game loop', key: 'avgTickHz', color: '#f59e0b', decimals: 1, unit: ' Hz' },
    { name: 'Latencia IA', key: 'avgAiLatencyMs', color: '#a78bfa', decimals: 2, unit: ' ms' },
    { name: 'Mundos activos', key: 'activeWorlds', color: '#60a5fa', decimals: 0, unit: '' },
    { name: 'Costo', key: 'hourlyUsd', color: '#fbbf24', decimals: 4, unit: ' USD/h' },
  ];

  el.chartGrid.innerHTML = series.map((s) => {
    const values = history.map((p) => p[s.key]);
    const latest = [...values].reverse().find((v) => typeof v === 'number' && Number.isFinite(v));
    const current = typeof latest === 'number' ? `${latest.toFixed(s.decimals)}${s.unit}` : '—';

    return `
      <div class="chart-box">
        <div class="chart-head">
          <span class="chart-name">${esc(s.name)}</span>
          <span class="chart-current" style="color:${s.color}">${esc(current)}</span>
        </div>
        ${sparkline(values, s.color)}
      </div>
    `;
  }).join('');

  el.historyWindow.textContent = history.length
    ? `${history.length} muestras · ${duration((history.length * collectorIntervalMs) / 1000)}`
    : 'Sin muestras aún';
}

// --------------------------------------------------------------------------
// Tables
// --------------------------------------------------------------------------

function statusBadge(world) {
  if (world.status !== 'ACTIVE') return '<span class="badge badge-inactive">INACTIVO</span>';
  if (!world.reachable) return '<span class="badge badge-unreachable">SIN RESPUESTA</span>';
  return '<span class="badge badge-active">ACTIVO</span>';
}

/**
 * Age note for a reading that is no longer current. A world that stopped answering
 * keeps its last measurement, but it must never be presented as the present state.
 */
function staleNote(world) {
  if (world.reachable || !world.memory) return '';
  return `<span class="world-id-cell stale">último dato hace ${num(world.sampleAgeSeconds, 0)}s</span>`;
}

const VERDICT_BADGES = {
  OVERSIZED: ['badge-oversized', 'SOBREDIMENSIONADO'],
  UNDERSIZED: ['badge-undersized', 'SATURADO'],
  RIGHT_SIZED: ['badge-rightsized', 'CORRECTO'],
  NOT_RUNNING: ['badge-neutral', '—'],
  UNKNOWN: ['badge-neutral', 'SIN DATOS'],
};

function verdictBadge(verdict) {
  const [cls, label] = VERDICT_BADGES[verdict] || VERDICT_BADGES.UNKNOWN;
  return `<span class="badge ${cls}">${label}</span>`;
}

function utilBar(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '';
  const pct = Math.min(100, Math.max(0, ratio * 100));
  const cls = ratio < 0.25 ? 'low' : ratio > 0.85 ? 'high' : 'ok';
  return `<div class="util-bar"><div class="util-fill ${cls}" style="width:${pct.toFixed(1)}%"></div></div>`;
}

function renderWorlds(worlds) {
  if (!worlds.length) {
    el.worldsBody.innerHTML = '<tr><td colspan="11" class="empty-state">No hay mundos registrados.</td></tr>';
    return;
  }

  // Active worlds first: they are the only ones that cost money and can fail.
  const ordered = [...worlds].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'ACTIVE' ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });

  el.worldsBody.innerHTML = ordered.map((w) => {
    const loop = w.gameLoop;
    const isActive = w.status === 'ACTIVE' && Boolean(w.memory);
    const staleCls = w.reachable ? '' : ' stale';

    const loopCell = isActive && loop
      ? `<span class="num ${tickClass(loop.recentHz ?? loop.effectiveHz, loop.targetHz)}${staleCls}">${num(loop.recentHz ?? loop.effectiveHz, 1)} Hz</span>
         <span class="world-id-cell">p95 ${num(loop.p95DurationMs, 2)} ms · ${num(loop.budgetUtilizationPct, 1)}% del budget</span>`
      : '<span class="dim">—</span>';

    const memCell = isActive && w.memory
      ? `<span class="num${staleCls}">${num(w.memory.rssMb, 1)} MB</span>
         <span class="world-id-cell">heap ${num(w.memory.heapUsedMb, 1)}/${num(w.memory.heapTotalMb, 1)} MB</span>
         ${utilBar(w.cost.memoryUtilization)}`
      : '<span class="dim">—</span>';

    const aiCell = w.ai && typeof w.ai.avgMs === 'number'
      ? `<span class="num" style="color:#a78bfa">${num(w.ai.avgMs, 2)} ms</span>
         <span class="world-id-cell">p95 ${num(w.ai.p95Ms, 2)} ms · ${num(w.ai.decisions, 0)} decisiones</span>`
      : '<span class="dim">—</span>';

    const entitiesCell = isActive && w.entities
      ? `<span class="num">${num(w.entities.players, 0)}👤 ${num(w.entities.structures, 0)}🏗 ${num(w.entities.projectiles, 0)}➶</span>
         <span class="world-id-cell">${num(w.entities.resources, 0)} recursos</span>`
      : '<span class="dim">—</span>';

    return `
      <tr>
        <td class="world-name-cell">
          ${esc(w.name)}
          <span class="world-id-cell">${esc(w.id)}</span>
        </td>
        <td>
          ${statusBadge(w)}
          ${w.reachable ? `<span class="world-id-cell">${duration(w.process?.uptimeSeconds)}</span>` : staleNote(w)}
        </td>
        <td>
          <span class="dim">${esc(w.hostId || '—')}</span>
          ${w.port ? `<span class="world-id-cell">:${num(w.port, 0)}</span>` : ''}
        </td>
        <td>
          <span class="num">${num(w.players.total, 0)}${w.players.max ? ` / ${num(w.players.max, 0)}` : ''}</span>
          <span class="world-id-cell">${num(w.players.humans, 0)}👤 ${num(w.players.bots, 0)}🤖</span>
        </td>
        <td>${memCell}</td>
        <td>${loopCell}</td>
        <td>${aiCell}</td>
        <td>${entitiesCell}</td>
        <td><span class="num">${w.status === 'ACTIVE' ? usd(w.cost.slotHourlyUsd, 5) : '<span class="dim">$0</span>'}</span></td>
        <td>
          <span class="num">${usd(w.cost.accruedCostUsd, 5)}</span>
          <span class="world-id-cell">${duration(w.cost.cumulativeActiveSeconds)} facturados</span>
        </td>
        <td>${verdictBadge(w.rightSizing.verdict)}</td>
      </tr>
    `;
  }).join('');
}

function renderHosts(hosts) {
  if (!hosts.length) {
    el.hostsBody.innerHTML = '<tr><td colspan="9" class="empty-state">No hay hosts registrados.</td></tr>';
    return;
  }

  el.hostsBody.innerHTML = hosts.map((h) => `
    <tr>
      <td class="world-name-cell">
        ${esc(h.name)}
        <span class="world-id-cell">${esc(h.id)}${h.isPermanent ? ' · permanente' : ''}</span>
      </td>
      <td><span class="badge ${h.status === 'HEALTHY' ? 'badge-active' : 'badge-inactive'}">${esc(h.status)}</span></td>
      <td class="num dim">${esc(h.hostIp || '—')}</td>
      <td class="num">${esc(h.instanceType)}</td>
      <td class="num dim">${num(h.vcpu, 0)} vCPU · ${num(h.memoryMb / 1024, 0)} GB</td>
      <td>
        <span class="num">${num(h.activeWorlds, 0)} / ${num(h.maxWorlds, 0)}</span>
        ${utilBar(h.activeWorlds / h.maxWorlds)}
      </td>
      <td class="num">${num(h.usedMemoryMb, 1)} MB</td>
      <td class="num">${usd(h.hourlyUsd, 4)}</td>
      <td class="num">${usd(h.monthlyUsd, 2)}</td>
    </tr>
  `).join('');
}

function renderRecommendations(recommendations) {
  if (!recommendations.length) {
    el.recList.innerHTML = '<div class="empty-state">✅ Sin recomendaciones: todos los mundos activos están correctamente dimensionados.</div>';
    return;
  }

  el.recList.innerHTML = recommendations.map((r) => `
    <div class="rec-item ${esc(r.severity)}">
      <div class="rec-head">
        <span class="rec-world">${esc(r.worldName)}</span>
        ${verdictBadge(r.verdict)}
      </div>
      <div class="rec-msg">${esc(r.message)}</div>
      ${r.action ? `<div class="rec-action">→ ${esc(r.action)}</div>` : ''}
    </div>
  `).join('');
}

// --------------------------------------------------------------------------
// Refresh cycle
// --------------------------------------------------------------------------

function setStatus(state, text) {
  el.statusDot.className = `status-dot ${state}`;
  el.statusText.textContent = text;
}

function showError(message) {
  el.errorBanner.hidden = false;
  el.errorBanner.textContent = message;
}

const STORAGE_KEY_AUTH = 'metrics_basic_auth';

function toBase64(str) {
  try {
    return btoa(unescape(encodeURIComponent(str)));
  } catch {
    return btoa(str);
  }
}

function getStoredAuth() {
  // 1. Check URL parameters (?user=admin&pass=cloud2026 or ?auth=<base64>)
  const urlParams = new URLSearchParams(window.location.search);
  const authParam = urlParams.get('auth');
  if (authParam) {
    sessionStorage.setItem(STORAGE_KEY_AUTH, authParam);
    return authParam;
  }
  const userParam = urlParams.get('user');
  const passParam = urlParams.get('pass');
  if (userParam && passParam) {
    const token = toBase64(`${userParam}:${passParam}`);
    sessionStorage.setItem(STORAGE_KEY_AUTH, token);
    return token;
  }

  // 2. Check sessionStorage
  return sessionStorage.getItem(STORAGE_KEY_AUTH);
}

function setStoredAuth(username, password) {
  const token = toBase64(`${username}:${password}`);
  sessionStorage.setItem(STORAGE_KEY_AUTH, token);
  return token;
}

function clearStoredAuth() {
  sessionStorage.removeItem(STORAGE_KEY_AUTH);
}

function showAuthModal(errorMessage = null) {
  if (el.authError) {
    if (errorMessage) {
      el.authError.textContent = errorMessage;
      el.authError.hidden = false;
    } else {
      el.authError.hidden = true;
    }
  }
  if (el.authModal) {
    el.authModal.hidden = false;
    if (el.authUser && !el.authUser.value) {
      el.authUser.focus();
    } else if (el.authPass) {
      el.authPass.focus();
    }
  }
}

function hideAuthModal() {
  if (el.authModal) el.authModal.hidden = true;
  if (el.authError) el.authError.hidden = true;
}

async function fetchJson(path) {
  const token = getStoredAuth();
  const headers = { Accept: 'application/json' };
  if (token) {
    headers['Authorization'] = `Basic ${token}`;
  }

  const res = await fetch(`${apiBase}${path}`, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (res.status === 401) {
    const err = new Error(`HTTP 401 en ${path}: Autenticación requerida`);
    err.status = 401;
    throw err;
  }

  if (!res.ok) throw new Error(`HTTP ${res.status} en ${path}`);
  return res.json();
}

async function refresh() {
  // A hung metrics service would otherwise stack requests, and a slow response could
  // paint over a fresher one that already arrived.
  if (isRefreshing) return;
  isRefreshing = true;

  try {
    const [snapshot, history] = await Promise.all([
      fetchJson('/api/metrics'),
      fetchJson(`/api/metrics/history?limit=${HISTORY_POINTS}`),
    ]);

    hideAuthModal();
    collectorIntervalMs = snapshot.collector?.intervalMs || REFRESH_MS;

    renderKpis(snapshot);
    renderCharts(history.points || []);
    renderWorlds(snapshot.worlds || []);
    renderHosts(snapshot.hosts || []);
    renderRecommendations(snapshot.recommendations || []);

    const collector = snapshot.collector || {};
    // The source of the numbers differs per deployment: scraped in-process locally,
    // or pushed through Kinesis and Flink into DynamoDB in AWS.
    const sourceInfo = collector.mode === 'dynamodb'
      ? `pipeline Kinesis → Flink → DynamoDB · ${num(collector.reportingWorlds, 0)} mundo(s) reportando · `
        + `lectura ${num(collector.lastReadDurationMs, 0)} ms`
      : `${num(collector.scrapeCount, 0)} ciclos de scrapeo · `
        + `último ciclo ${num(collector.lastScrapeDurationMs, 0)} ms`;
    el.footerInfo.textContent =
      `Última actualización: ${new Date(snapshot.timestamp).toLocaleTimeString('es-AR')} · `
      + `${sourceInfo} · `
      + `NPC Service: ${collector.npcServiceReachable ? 'alcanzable' : 'no alcanzable'} · `
      + `API: ${apiBase}`;

    el.errorBanner.hidden = true;
    consecutiveFailures = 0;
    setStatus('live', `En vivo · cada ${REFRESH_MS / 1000}s`);
  } catch (err) {
    consecutiveFailures++;
    setStatus('error', 'Sin conexión');

    if (err.status === 401) {
      clearStoredAuth();
      if (timer) { clearInterval(timer); timer = null; }
      showAuthModal('Acceso denegado (401). Credenciales incorrectas o requeridas.');
      showError('Autenticación requerida. Ingresá usuario y contraseña para acceder a las métricas.');
      return;
    }

    showError(
      `No se pudo obtener métricas del servicio de métricas en ${apiBase} (${err.message}). `
      + `Intento fallido n.° ${consecutiveFailures}. Verificá que el metrics-service esté `
      + `corriendo, o abrí el panel con ?api=<URL del ALB>.`
    );
  } finally {
    isRefreshing = false;
  }
}

el.refreshBtn.addEventListener('click', () => {
  if (!timer && getStoredAuth()) {
    timer = setInterval(refresh, REFRESH_MS);
  }
  refresh();
});

if (el.authForm) {
  el.authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const user = el.authUser.value.trim();
    const pass = el.authPass.value;
    if (!user || !pass) return;

    setStoredAuth(user, pass);
    hideAuthModal();
    el.errorBanner.hidden = true;
    setStatus('live', 'Autenticando…');

    await refresh();
    if (!timer && getStoredAuth()) {
      timer = setInterval(refresh, REFRESH_MS);
    }
  });
}

if (el.logoutBtn) {
  el.logoutBtn.addEventListener('click', () => {
    clearStoredAuth();
    if (timer) { clearInterval(timer); timer = null; }
    setStatus('error', 'Sesión cerrada');
    showAuthModal('Sesión cerrada. Ingresá credenciales de administrador para continuar.');
  });
}

// Pause polling while the tab is hidden: a panel nobody is looking at should not
// keep querying the control plane.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (timer) { clearInterval(timer); timer = null; }
  } else if (!timer && getStoredAuth()) {
    refresh();
    timer = setInterval(refresh, REFRESH_MS);
  }
});

// Bootstrapping: if no credentials found, request login; otherwise refresh and start timer.
if (!getStoredAuth()) {
  showAuthModal();
} else {
  refresh();
  timer = setInterval(refresh, REFRESH_MS);
}

