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
 *   proxies: [{ id, name, type, host, port, color?, username?, password?, proxyDNS, bypassLan?, bypass?, persistent? }],
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

// When the popup tests a proxy configuration, only the test probe URLs are
// routed through the candidate proxy; everything else keeps the current
// routing.
let testRoute = null; // { prefixes: [url, ...], proxy }

// True while a proxy test is running and `url` is one of its probes.
function isTestUrl(url) {
  return Boolean(testRoute) && testRoute.prefixes.some(prefix => url.startsWith(prefix));
}

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

// --- LAN bypass ---------------------------------------------------------------
// A proxy flagged `bypassLan` only handles public traffic; requests to LAN
// destinations go direct regardless of scheme (http and https alike).

function isPrivateIPv4(h) {
  const parts = h.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map(p => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (nums.some(n => n < 0 || n > 255)) return false;
  const a = nums[0];
  const b = nums[1];
  return a === 10 || a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254);
}

function isLanHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true; // mDNS
  if (h.startsWith('[') && h.endsWith(']')) {
    // IPv6 literal: loopback, unique-local (fc00::/7), link-local (fe80::/10)
    const v6 = h.slice(1, -1);
    return v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
  }
  if (!h.includes('.')) return true; // dotless intranet name
  return isPrivateIPv4(h);
}

function isLanUrl(url) {
  try {
    return isLanHost(new URL(url).hostname);
  } catch (err) {
    return false;
  }
}

// --- Bypass rules -----------------------------------------------------------
// A proxy may carry a list of URL patterns (grammar in bypass.js) whose
// requests connect directly. Patterns are compiled once per version of the
// proxies array and cached, so the per-request listener only runs regexes.

let bypassCache = { proxies: null, map: new Map() };

function getBypassRules(proxy) {
  if (bypassCache.proxies !== state.proxies) {
    const map = new Map();
    state.proxies.forEach(p => {
      const rules = Bypass.compileRules(p.bypass);
      if (rules.length) map.set(p.id, rules);
    });
    bypassCache = { proxies: state.proxies, map };
  }
  return bypassCache.map.get(proxy.id) || null;
}

browser.proxy.onRequest.addListener(
  async details => {
    // Wait for startup state so the very first requests after browser
    // launch already go through the last selected proxy.
    await stateReady;
    if (isTestUrl(details.url)) {
      return buildProxyInfo(testRoute.proxy);
    }

    const proxy = getSelectedProxy();
    if (proxy) {
      if (proxy.bypassLan && isLanUrl(details.url)) return { type: 'direct' };
      const rules = getBypassRules(proxy);
      if (rules && Bypass.matchUrl(rules, details.url)) return { type: 'direct' };
    }
    return proxy ? buildProxyInfo(proxy) : { type: 'direct' };
  },
  { urls: ['<all_urls>'] }
);

browser.proxy.onError.addListener(err => {
  console.error('[Proxy Manager] Proxy error:', err.message);
});

// --- Proxy testing ----------------------------------------------------------
// The popup asks us to verify a proxy configuration. One request per IP echo
// service races through the candidate proxy: the first usable reply wins and
// aborts the rest, and only when every service fails within the deadline is
// the proxy reported as broken. The services are run by distinct operators,
// so one being down — or sitting on a network filter's blocklist, as IP-echo
// domains often do — cannot fail the test on its own.

const TEST_TIMEOUT_MS = 10000;

// Accepts an IPv4/IPv6 literal (surrounding whitespace tolerated) and
// returns it trimmed; anything else — HTML, an error page — yields null.
function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s;
  if (s.includes(':') && /^[0-9a-fA-F:.]{2,45}$/.test(s)) return s;
  return null;
}

// Each service answers with the caller's public IP; parse() extracts it from
// the body, returning null for anything unexpected (a filter's block page,
// say) so the attempt fails rather than reporting a bogus success.
const TEST_ENDPOINTS = [
  { url: 'https://api.ipify.org/?format=json', // ipify — {"ip":"…"}
    parse: body => { try { return normalizeIp(JSON.parse(body).ip); } catch (err) { return null; } } },
  { url: 'https://www.cloudflare.com/cdn-cgi/trace', // Cloudflare — key=value lines
    parse: body => { const m = /^ip=(.+)$/m.exec(body); return m ? normalizeIp(m[1]) : null; } },
  { url: 'https://ifconfig.me/ip', // ifconfig.me — bare address
    parse: body => normalizeIp(body) },
  { url: 'https://checkip.amazonaws.com/', // Amazon — bare address
    parse: body => normalizeIp(body) },
];

const PROXY_TYPES = new Set(['http', 'https', 'socks', 'socks4']);

// One attempt against one service. Throws on transport errors, redirects
// (a redirected URL would escape the test route), bad status, and bodies
// without an IP; `testKind` marks the failures where the proxy answered.
async function fetchExitIp(endpoint, signal) {
  const res = await fetch(endpoint.url, { cache: 'no-store', redirect: 'error', signal });
  if (!res.ok) throw testFailure('HTTP ' + res.status);
  const ip = endpoint.parse(await res.text());
  if (!ip) throw testFailure('unusable reply');
  return ip;
}

function testFailure(detail) {
  const err = new Error('Test attempt failed: ' + detail);
  err.testKind = detail;
  return err;
}

// Every service failed — condense the per-service errors into one line.
function describeTestFailure(err, deadlineHit) {
  if (deadlineHit) return 'Timed out after ' + (TEST_TIMEOUT_MS / 1000) + ' s';
  const errors = err instanceof AggregateError ? err.errors : [err];
  return errors.some(e => e && e.testKind)
    ? 'Proxy connected, but no test service gave a usable reply'
    : 'Could not connect through this proxy';
}

browser.runtime.onMessage.addListener(async msg => {
  if (!msg || msg.type !== 'testProxy' || !msg.proxy) return undefined;
  const p = msg.proxy;
  const port = Number(p.port);
  if (!PROXY_TYPES.has(p.type) || typeof p.host !== 'string' || !p.host ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'Invalid proxy configuration' };
  }

  const started = Date.now();
  testRoute = { prefixes: TEST_ENDPOINTS.map(e => e.url), proxy: p };
  const ctrl = new AbortController();
  let deadlineHit = false;
  const timer = setTimeout(() => { deadlineHit = true; ctrl.abort(); }, TEST_TIMEOUT_MS);
  try {
    const ip = await Promise.any(TEST_ENDPOINTS.map(e => fetchExitIp(e, ctrl.signal)));
    return { ok: true, ip, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: describeTestFailure(err, deadlineHit) };
  } finally {
    clearTimeout(timer);
    ctrl.abort(); // a win cancels the slower attempts still in flight
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
    const proxy = isTestUrl(details.url) ? testRoute.proxy : getSelectedProxy();
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
