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
 *   proxies: [{ id, name, type, host, port, color?, username?, password?, proxyDNS,
 *              bypassLan?, bypass?, persistent?, showCountry?, country? }],
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

// While the popup verifies a proxy (connection test or country lookup), the
// running probe registers its exact request URLs here; only those URLs are
// routed through the candidate proxy — everything else keeps the current
// routing. Each probe's URLs carry a unique token, so concurrent probes for
// different proxies cannot collide.
let probeSessions = []; // [{ urls: Set<url>, proxy }]

function probeSessionFor(url) {
  return probeSessions.find(s => s.urls.has(url)) || null;
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
    const probe = probeSessionFor(details.url);
    if (probe) return buildProxyInfo(probe.proxy);

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

// --- Proxy probing ----------------------------------------------------------
// The popup asks us to verify a proxy configuration (connection test) or to
// determine its exit country. Either way, one request per service races
// through the candidate proxy: the first usable reply wins and aborts the
// rest, and only when every service fails within the deadline does the probe
// report failure. Multiple services means one being down — or sitting on a
// network filter's blocklist, as IP-lookup domains often do — cannot fail a
// probe on its own.

const PROBE_TIMEOUT_MS = 10000;

// Accepts an IPv4/IPv6 literal (surrounding whitespace tolerated) and
// returns it trimmed; anything else — HTML, an error page — yields null.
function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s;
  if (s.includes(':') && /^[0-9a-fA-F:.]{2,45}$/.test(s)) return s;
  return null;
}

// Accepts an ISO 3166-1 alpha-2 country code. Cloudflare's placeholder XX
// (location unknown) is rejected so another service can win with a real
// answer instead.
function normalizeCountry(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) && s !== 'XX' ? s : null;
}

// One `key=value` line out of a Cloudflare /cdn-cgi/trace body.
function traceField(body, key, normalize) {
  const m = new RegExp('^' + key + '=(.+)$', 'm').exec(body);
  return m ? normalize(m[1]) : null;
}

// Each service answers with the caller's public IP; parse() extracts it from
// the body, returning null for anything unexpected (a filter's block page,
// say) so the attempt fails rather than reporting a bogus success.
const TEST_ENDPOINTS = [
  { url: 'https://api.ipify.org/?format=json', // ipify — {"ip":"…"}
    parse: body => { try { return normalizeIp(JSON.parse(body).ip); } catch (err) { return null; } } },
  { url: 'https://www.cloudflare.com/cdn-cgi/trace', // Cloudflare — key=value lines
    parse: body => traceField(body, 'ip', normalizeIp) },
  { url: 'https://ifconfig.me/ip', // ifconfig.me — bare address
    parse: body => normalizeIp(body) },
  { url: 'https://checkip.amazonaws.com/', // Amazon — bare address
    parse: body => normalizeIp(body) },
];

// Exit-country services. /cdn-cgi/trace is served by Cloudflare under both
// of its domains — distinct names, so a blocklist rarely catches both —
// which keeps the lookup alive on networks that blackhole the dedicated
// geo-IP providers.
const COUNTRY_ENDPOINTS = [
  { url: 'https://www.cloudflare.com/cdn-cgi/trace', // Cloudflare — loc=XX line
    parse: body => traceField(body, 'loc', normalizeCountry) },
  { url: 'https://one.one.one.one/cdn-cgi/trace', // Cloudflare again, other domain
    parse: body => traceField(body, 'loc', normalizeCountry) },
  { url: 'https://get.geojs.io/v1/ip/country.json', // GeoJS — {"country":"XX",…}
    parse: body => { try { return normalizeCountry(JSON.parse(body).country); } catch (err) { return null; } } },
  { url: 'https://ipapi.co/country/', // ipapi.co — bare code
    parse: body => normalizeCountry(body) },
];

const PROXY_TYPES = new Set(['http', 'https', 'socks', 'socks4']);

function validProxyConfig(p) {
  const port = Number(p.port);
  return PROXY_TYPES.has(p.type) && typeof p.host === 'string' && Boolean(p.host) &&
    Number.isInteger(port) && port >= 1 && port <= 65535;
}

// One attempt against one service. Throws on transport errors, redirects
// (a redirected URL would escape the probe route), bad status, and bodies
// that don't parse; `probeKind` marks the failures where the proxy answered.
async function fetchProbe(url, parse, signal) {
  const res = await fetch(url, { cache: 'no-store', redirect: 'error', signal });
  if (!res.ok) throw probeFailure('HTTP ' + res.status);
  const value = parse(await res.text());
  if (!value) throw probeFailure('unusable reply');
  return value;
}

function probeFailure(detail) {
  const err = new Error('Probe attempt failed: ' + detail);
  err.probeKind = detail;
  return err;
}

// Runs one request per service through `proxy`; the first usable reply wins
// and the rest abort. Resolves { value, ms }; rejects with the AggregateError
// from Promise.any, its `deadlineHit` flag set when the shared deadline
// expired before any service succeeded.
let probeSeq = 0;
async function raceThroughProxy(endpoints, proxy) {
  const token = 'pm' + (++probeSeq).toString(36) + Math.random().toString(36).slice(2, 8);
  const urls = endpoints.map(e => e.url + (e.url.includes('?') ? '&' : '?') + 'probe=' + token);
  const session = { urls: new Set(urls), proxy };
  probeSessions.push(session);
  const started = Date.now();
  const ctrl = new AbortController();
  let deadlineHit = false;
  const timer = setTimeout(() => { deadlineHit = true; ctrl.abort(); }, PROBE_TIMEOUT_MS);
  try {
    const value = await Promise.any(endpoints.map((e, i) => fetchProbe(urls[i], e.parse, ctrl.signal)));
    return { value, ms: Date.now() - started };
  } catch (err) {
    if (err) err.deadlineHit = deadlineHit;
    throw err;
  } finally {
    clearTimeout(timer);
    ctrl.abort(); // a win cancels the slower attempts still in flight
    probeSessions = probeSessions.filter(s => s !== session);
  }
}

// Every service failed — condense the per-service errors into one line.
function describeProbeFailure(err) {
  if (err && err.deadlineHit) return 'Timed out after ' + (PROBE_TIMEOUT_MS / 1000) + ' s';
  const errors = err instanceof AggregateError ? err.errors : [err];
  return errors.some(e => e && e.probeKind)
    ? 'Proxy connected, but no test service gave a usable reply'
    : 'Could not connect through this proxy';
}

browser.runtime.onMessage.addListener(async msg => {
  if (!msg || !msg.proxy || (msg.type !== 'testProxy' && msg.type !== 'fetchCountry')) {
    return undefined;
  }
  if (!validProxyConfig(msg.proxy)) {
    return { ok: false, error: 'Invalid proxy configuration' };
  }

  if (msg.type === 'testProxy') {
    try {
      const { value, ms } = await raceThroughProxy(TEST_ENDPOINTS, msg.proxy);
      return { ok: true, ip: value, ms };
    } catch (err) {
      return { ok: false, error: describeProbeFailure(err) };
    }
  }

  // fetchCountry — resolve the exit country and cache it on the stored
  // proxy, so the lookup happens once per proxy until a manual refresh.
  try {
    const { value } = await raceThroughProxy(COUNTRY_ENDPOINTS, msg.proxy);
    await stateReady;
    const entry = state.proxies.find(x => x.id === msg.proxy.id);
    if (entry && entry.showCountry) {
      entry.country = value;
      await browser.storage.local.set({ proxies: state.proxies });
    }
    return { ok: true, country: value };
  } catch (err) {
    return { ok: false, error: describeProbeFailure(err) };
  }
});

// --- Authentication fallback ------------------------------------------------
// Credentials are normally passed inline via ProxyInfo above; some proxies
// still issue a 407 challenge, which we answer here.

const answeredRequests = new Set();

browser.webRequest.onAuthRequired.addListener(
  details => {
    if (!details.isProxy) return {};
    const session = probeSessionFor(details.url);
    const proxy = session ? session.proxy : getSelectedProxy();
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
// identity color; gray means direct connection. No text badge. When the
// selected proxy has Show Proxy Country enabled and its exit country has
// been resolved, the country's flag is composited over the tile's top-right
// corner — the same spot, and about the same footprint, as the counter
// badge other toolbar buttons carry — and the tooltip names the country.

const DIRECT_ICON_COLOR = '#7f8ea6';
const DEFAULT_PROXY_COLOR = '#f5a524';
const ICON_SIZES = [16, 32, 64];

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

// 'PL' → 🇵🇱 (regional indicator pair) — the same glyph the popup list shows.
const flagEmoji = cc => String.fromCodePoint(...[...cc].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65));

let regionNames = null;
try {
  regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
} catch (err) { /* older engine — the bare code is shown instead */ }

function countryLabel(cc) {
  try {
    const name = regionNames && regionNames.of(cc);
    return name && name !== cc ? name + ' (' + cc + ')' : cc;
  } catch (err) {
    return cc;
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Icon image failed to decode'));
    img.src = url;
  });
}

// Draws the flag emoji large on a scratch canvas and crops it to its inked
// pixels. Emoji fonts disagree about glyph bearings, so measuring the pixels
// that actually landed is the only reliable way to know where the flag is.
// Throws when nothing renders, in which case the caller keeps the plain tile.
function renderFlagGlyph(country) {
  const W = 192, H = 128;
  const scratch = document.createElement('canvas');
  scratch.width = W;
  scratch.height = H;
  const ctx = scratch.getContext('2d');
  ctx.font = '96px "Twemoji Mozilla", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(flagEmoji(country), W / 2, H / 2);
  const alpha = ctx.getImageData(0, 0, W, H).data;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (alpha[(y * W + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('Flag glyph did not render');
  const cropped = document.createElement('canvas');
  cropped.width = maxX - minX + 1;
  cropped.height = maxY - minY + 1;
  cropped.getContext('2d')
    .drawImage(scratch, minX, minY, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
  return cropped;
}

// Scales a canvas down in halving steps until one more halving would drop
// below the target box; a single 10:1 drawImage downscale aliases the flag's
// stripes away at 16 px, stepped halving keeps them crisp.
function shrinkToward(canvas, w, h) {
  let cur = canvas;
  while (cur.width / 2 > w && cur.height / 2 > h) {
    const next = document.createElement('canvas');
    next.width = Math.round(cur.width / 2);
    next.height = Math.round(cur.height / 2);
    next.getContext('2d').drawImage(cur, 0, 0, cur.width, cur.height, 0, 0, next.width, next.height);
    cur = next;
  }
  return cur;
}

// One icon size: the colored tile at full size, the flag in a badge-shaped
// box laid over its top-right corner — 10×8 px with 2 px corners on the
// 16 px icon, the visible footprint of a native counter badge. The badge
// overlaps the artwork instead of overhanging it, so the tile keeps the
// same size whether or not a flag is showing.
function composeIcon(baseImg, flag, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(baseImg, 0, 0, size, size);

  const bw = Math.round(size * 0.625);
  const bh = Math.round(size * 0.5);
  const bx = size - bw;
  const by = 0;
  const radius = size * 0.125;

  const scaled = shrinkToward(flag, bw, bh);
  // cover the box, centring the sliver the aspect difference crops away
  const scale = Math.max(bw / scaled.width, bh / scaled.height);
  const dw = scaled.width * scale;
  const dh = scaled.height * scale;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, radius);
  ctx.clip();
  ctx.drawImage(scaled, bx + (bw - dw) / 2, by + (bh - dh) / 2, dw, dh);
  ctx.restore();

  // keyline in the glyph color, so pale flags keep an edge on pale tiles
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, radius);
  ctx.strokeStyle = '#10131a';
  ctx.lineWidth = Math.max(1, size / 32);
  ctx.stroke();

  return ctx.getImageData(0, 0, size, size);
}

// Only the latest render may apply its icon, so a slow flag composite can
// never overwrite the icon of a selection made after it.
let iconRenderSeq = 0;

async function updateAction() {
  await stateReady;
  const proxy = getSelectedProxy();
  const color = proxy ? proxy.color || DEFAULT_PROXY_COLOR : DIRECT_ICON_COLOR;
  // The flag rides the toolbar only for a proxy that shows its country in
  // the list, and only once a real code has been resolved and cached.
  const country = proxy && proxy.showCountry &&
    typeof proxy.country === 'string' && /^[A-Z]{2}$/.test(proxy.country)
    ? proxy.country : null;

  // text badge from older versions is no longer used — clear it
  browser.browserAction.setBadgeText({ text: '' });
  browser.browserAction.setTitle({
    title: proxy
      ? 'Proxy Manager — ' + proxy.name + ' (' + proxy.host + ':' + proxy.port + ')' +
        (country ? ' — exit country: ' + countryLabel(country) : '')
      : 'Proxy Manager — direct connection',
  });

  const seq = ++iconRenderSeq;
  let icon = { path: iconDataUrl(color) };
  if (country) {
    try {
      const base = await loadImage(iconDataUrl(color));
      const flag = renderFlagGlyph(country);
      const imageData = {};
      for (const size of ICON_SIZES) imageData[size] = composeIcon(base, flag, size);
      icon = { imageData };
    } catch (err) {
      // no color-emoji rendering here — the plain tile still tells the story
    }
  }
  if (seq === iconRenderSeq) browser.browserAction.setIcon(icon);
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
