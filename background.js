'use strict';

/**
 * Proxy Manager — background service.
 *
 * Owns the routing decision for every request the browser makes.
 * The popup is a dumb view over browser.storage.local; this script
 * watches that storage and applies the selected proxy.
 *
 * Storage schema (browser.storage.local):
 * {
 *   schemaVersion: 1,
 *   proxies: [{ id, name, type, host, port, color?, username?, password?, proxyDNS, persistent? }],
 *   selectedId: 'direct' | <proxy id>
 * }
 */

const DEFAULT_STATE = {
  schemaVersion: 1,
  proxies: [],
  selectedId: 'direct',
};

let state = { ...DEFAULT_STATE };

// Resolved once the persisted state has been read at startup.
const stateReady = (async () => {
  try {
    const stored = await browser.storage.local.get(null);
    state = { ...DEFAULT_STATE, ...stored };
    if (!Array.isArray(state.proxies)) state.proxies = [];

    // Startup selection rule: a proxy marked persistent takes over the
    // selection (at most one can be — the popup enforces that). Otherwise
    // the last used selection, already stored in selectedId, applies.
    const persistent = state.proxies.find(p => p.persistent);
    if (persistent && state.selectedId !== persistent.id) {
      state.selectedId = persistent.id;
      await browser.storage.local.set({ selectedId: persistent.id });
    }
  } catch (err) {
    console.error('[Proxy Manager] Failed to load state:', err);
  }
})();

function getSelectedProxy() {
  if (state.selectedId === 'direct') return null;
  return state.proxies.find(p => p.id === state.selectedId) || null;
}

// --- Routing ---------------------------------------------------------------

// When the popup tests a proxy configuration, only the test URL is routed
// through the candidate proxy; everything else keeps the current routing.
let testRoute = null; // { urlPrefix, proxy }

function buildProxyInfo(proxy) {
  const info = {
    type: proxy.type,
    host: proxy.host,
    port: Number(proxy.port),
  };
  if (proxy.type === 'socks' || proxy.type === 'socks4') {
    info.proxyDNS = Boolean(proxy.proxyDNS);
  }
  if (proxy.username) {
    info.username = proxy.username;
    info.password = proxy.password || '';
  }
  return info;
}

browser.proxy.onRequest.addListener(
  async details => {
    // Wait for startup state so the very first requests after browser
    // launch already go through the last selected proxy.
    await stateReady;
    if (testRoute && details.url.startsWith(testRoute.urlPrefix)) {
      return buildProxyInfo(testRoute.proxy);
    }

    // Future expansion point: per-domain routing rules / failover chains
    // can be decided here using `details.url`.
    const proxy = getSelectedProxy();
    return proxy ? buildProxyInfo(proxy) : { type: 'direct' };
  },
  { urls: ['<all_urls>'] }
);

browser.proxy.onError.addListener(err => {
  console.error('[Proxy Manager] Proxy error:', err.message);
});

// --- Proxy testing ----------------------------------------------------------
// The popup asks us to verify a proxy configuration. We route a single
// request to a lightweight IP echo service through the candidate proxy and
// report back latency and the exit IP.

const TEST_URL_PREFIX = 'https://api.ipify.org/';
const TEST_URL = TEST_URL_PREFIX + '?format=json';
const PROXY_TYPES = new Set(['http', 'https', 'socks', 'socks4']);

browser.runtime.onMessage.addListener(async msg => {
  if (!msg || msg.type !== 'testProxy' || !msg.proxy) return undefined;
  const p = msg.proxy;
  const port = Number(p.port);
  if (!PROXY_TYPES.has(p.type) || typeof p.host !== 'string' || !p.host ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'Invalid proxy configuration' };
  }

  const started = Date.now();
  testRoute = { urlPrefix: TEST_URL_PREFIX, proxy: p };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(TEST_URL + '&_=' + Date.now(), {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: 'Unexpected response (HTTP ' + res.status + ')' };
    const data = await res.json();
    return { ok: true, ip: data.ip || 'unknown', ms: Date.now() - started };
  } catch (err) {
    const reason = err && err.name === 'AbortError'
      ? 'Timed out after 9 s'
      : 'Could not connect through this proxy';
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
    testRoute = null;
  }
});

// --- Authentication fallback ------------------------------------------------
// Credentials are normally passed inline via ProxyInfo above; some proxies
// still issue a 407 challenge, which we answer here.

const answeredRequests = new Set();

browser.webRequest.onAuthRequired.addListener(
  details => {
    if (!details.isProxy) return {};
    const proxy = testRoute && details.url.startsWith(testRoute.urlPrefix)
      ? testRoute.proxy
      : getSelectedProxy();
    if (!proxy || !proxy.username) return {};
    if (answeredRequests.has(details.requestId)) {
      // Credentials were already tried for this request and rejected.
      return {};
    }
    answeredRequests.add(details.requestId);
    return {
      authCredentials: {
        username: proxy.username,
        password: proxy.password || '',
      },
    };
  },
  { urls: ['<all_urls>'] },
  ['blocking']
);

const forgetRequest = id => answeredRequests.delete(id);
browser.webRequest.onCompleted.addListener(d => forgetRequest(d.requestId), { urls: ['<all_urls>'] });
browser.webRequest.onErrorOccurred.addListener(d => forgetRequest(d.requestId), { urls: ['<all_urls>'] });

// --- State sync -------------------------------------------------------------

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.proxies) state.proxies = changes.proxies.newValue || [];
  if (changes.selectedId) state.selectedId = changes.selectedId.newValue || 'direct';
  updateAction();
});

// --- Toolbar icon -----------------------------------------------------------
// The toolbar icon is a full-tile glyph redrawn in the active proxy's
// identity color; gray means direct connection. No text badge.

const DIRECT_ICON_COLOR = '#7f8ea6';
const DEFAULT_PROXY_COLOR = '#f5a524';

function iconDataUrl(color) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<rect width="32" height="32" rx="7" fill="' + color + '"/>' +
    '<circle cx="16" cy="16" r="7.2" fill="none" stroke="#10131a" stroke-width="3"/>' +
    '<g fill="#10131a">' +
    '<circle cx="16" cy="16" r="2.7"/>' +
    '<circle cx="16" cy="8.8" r="1.8"/>' +
    '<circle cx="22.24" cy="19.6" r="1.8"/>' +
    '<circle cx="9.76" cy="19.6" r="1.8"/>' +
    '</g>' +
    '</svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

async function updateAction() {
  await stateReady;
  const proxy = getSelectedProxy();
  browser.browserAction.setIcon({
    path: iconDataUrl(proxy ? proxy.color || DEFAULT_PROXY_COLOR : DIRECT_ICON_COLOR),
  });
  // text badge from older versions is no longer used — clear it
  browser.browserAction.setBadgeText({ text: '' });
  browser.browserAction.setTitle({
    title: proxy
      ? 'Proxy Manager — ' + proxy.name + ' (' + proxy.host + ':' + proxy.port + ')'
      : 'Proxy Manager — direct connection',
  });
}

// --- Lifecycle --------------------------------------------------------------

browser.runtime.onInstalled.addListener(async () => {
  const stored = await browser.storage.local.get(null);
  const init = {};
  if (!Array.isArray(stored.proxies)) init.proxies = [];
  if (typeof stored.selectedId !== 'string') init.selectedId = 'direct';
  if (typeof stored.schemaVersion !== 'number') init.schemaVersion = 1;
  if (Object.keys(init).length) await browser.storage.local.set(init);
});

// On browser start the stored selection is applied automatically by the
// proxy.onRequest listener above; refresh the icon to match.
browser.runtime.onStartup.addListener(updateAction);

updateAction();
