'use strict';

const TYPE_LABELS = { http: 'HTTP', https: 'HTTPS', socks: 'SOCKS5', socks4: 'SOCKS4' };

// Identity colors assignable to proxies; shown as the card's side bar, used
// by the background script to recolor the toolbar icon, and adopted by the
// popup theme while the proxy is active.
const PALETTE = ['#f5a524', '#f97316', '#ef4444', '#ec4899', '#8b5cf6',
                 '#3b82f6', '#06b6d4', '#14b8a6', '#22c55e', '#84cc16'];

// Theme for direct mode. Deliberately NOT one of the palette colors.
const DIRECT_THEME_COLOR = '#7f8ea6';

const TRASH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';

const EDIT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';

const GLOBE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14.5 14.5 0 0 1 0 18"/><path d="M12 3a14.5 14.5 0 0 0 0 18"/></svg>';

const ZAP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>';

const CHECK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

const $ = id => document.getElementById(id);

const listView = $('listView');
const formView = $('formView');
const formScroll = $('formScroll');
const settingsView = $('settingsView');
const proxyList = $('proxyList');
const statusLine = $('statusLine');
const statusText = $('statusText');
const statusDot = $('statusDot');
const addBtn = $('addBtn');
const settingsBtn = $('settingsBtn');
const settingsBackBtn = $('settingsBackBtn');
const backBtn = $('backBtn');
const cancelBtn = $('cancelBtn');
const proxyForm = $('proxyForm');
const formTitle = $('formTitle');
const saveBtn = $('saveBtn');
const connectBtn = $('connectBtn');
const cloneBtn = $('cloneBtn');
const typeSeg = $('typeSeg');
const colorRow = $('colorRow');
const dnsRow = $('dnsRow');
const authToggle = $('fAuth');
const authFields = $('authFields');
const formError = $('formError');
const testBtn = $('testBtn');
const testResult = $('testResult');
const exportBtn = $('exportBtn');
const importBtn = $('importBtn');
const importFile = $('importFile');
const dropZone = $('dropZone');
const settingsMsg = $('settingsMsg');
const themeSeg = $('themeSeg');

const fName = $('fName');
const fHost = $('fHost');
const fPort = $('fPort');
const fUser = $('fUser');
const fPass = $('fPass');
const fDns = $('fDns');
const fBypassLan = $('fBypassLan');
const fPersistent = $('fPersistent');

let state = { proxies: [], selectedId: 'direct' };
let currentType = 'http';
let selectedColor = PALETTE[0];
let editingId = null; // null = adding a new proxy, otherwise id being edited

// Color scheme preference: 'system' | 'light' | 'dark'. 'system' is
// resolved through the OS preference and followed live.
let themePreference = 'system';
const themeMedia = window.matchMedia('(prefers-color-scheme: light)');

function applyThemeMode() {
  const resolved = themePreference === 'system'
    ? (themeMedia.matches ? 'light' : 'dark')
    : themePreference;
  document.documentElement.dataset.theme = resolved;
  updateStatus(); // recompute accent colors against the new base theme
}

const uid = () => 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

// Parses a static, trusted SVG string into a node. Used instead of innerHTML
// so no markup is ever assigned from a string at runtime.
function svgNode(markup) {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  return document.importNode(doc.documentElement, true);
}

init();

async function init() {
  state = await browser.storage.local.get({ proxies: [], selectedId: 'direct', theme: 'system' });
  if (!Array.isArray(state.proxies)) state.proxies = [];

  // Restore the saved color scheme preference.
  themePreference = ['system', 'light', 'dark'].includes(state.theme) ? state.theme : 'system';
  themeSeg.querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === themePreference);
  });

  // One-time migration: assign identity colors to proxies saved before
  // colors existed.
  let migrated = false;
  state.proxies.forEach((p, i) => {
    if (!p.color) { p.color = PALETTE[i % PALETTE.length]; migrated = true; }
  });
  if (migrated) await browser.storage.local.set({ proxies: state.proxies });

  applyThemeMode();
  renderList();
  bindEvents();
}

function bindEvents() {
  $('aboutVersion').textContent = browser.runtime.getManifest().version;

  addBtn.addEventListener('click', () => { resetForm(); showView(formView); fName.focus(); });
  settingsBtn.addEventListener('click', () => showView(settingsView));
  settingsBackBtn.addEventListener('click', () => showView(listView));
  backBtn.addEventListener('click', () => showView(listView));
  cancelBtn.addEventListener('click', () => showView(listView));
  proxyForm.addEventListener('submit', onSubmit);
  testBtn.addEventListener('click', onTest);
  cloneBtn.addEventListener('click', onClone);

  typeSeg.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => setType(btn.dataset.type));
  });

  themeSeg.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      themePreference = btn.dataset.theme;
      themeSeg.querySelectorAll('button').forEach(b => {
        b.classList.toggle('active', b === btn);
      });
      await browser.storage.local.set({ theme: themePreference });
      applyThemeMode();
    });
  });

  // Follow the OS color scheme while the preference is 'system'.
  themeMedia.addEventListener('change', () => {
    if (themePreference === 'system') applyThemeMode();
  });

  authToggle.addEventListener('change', () => {
    authFields.classList.toggle('open', authToggle.checked);
    updateScrollLanes();
  });

  exportBtn.addEventListener('click', onExport);
  importBtn.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', onImportFile);

  ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  }));
  dropZone.addEventListener('drop', e => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) importBackup(file);
  });
}

// --- Views ------------------------------------------------------------------

function showView(view) {
  [listView, formView, settingsView].forEach(v => {
    v.classList.toggle('hidden', v !== view);
  });
  updateScrollLanes();
}

// --- Scroll lanes & edge fades ------------------------------------------------
// Popup scrollbars float over content (overlay scrollbars), so regions that
// actually overflow get a padded right lane for the bar via .has-scroll.
// While a region is scrolled away from an edge, that edge gets a gradient
// fade (.fade-top / .fade-bottom) instead of a hard clip.

const scrollLaneEls = [proxyList, formScroll];

function updateScrollLanes() {
  scrollLaneEls.forEach(el => {
    const overflow = el.scrollHeight > el.clientHeight + 1;
    el.classList.toggle('has-scroll', overflow);
    el.classList.toggle('fade-top', overflow && el.scrollTop > 2);
    el.classList.toggle('fade-bottom', overflow && el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  });
}

scrollLaneEls.forEach(el => el.addEventListener('scroll', updateScrollLanes, { passive: true }));

if (typeof ResizeObserver !== 'undefined') {
  const laneObserver = new ResizeObserver(updateScrollLanes);
  scrollLaneEls.forEach(el => laneObserver.observe(el));
}

// --- Dynamic theme -------------------------------------------------------------
// The whole accent (gradient, glows, focus rings, button text) derives from
// the active proxy's identity color. Direct mode uses DIRECT_THEME_COLOR.

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let hue = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  return { h: hue, s: s * 100, l: l * 100 };
}

function hslToHex(hue, sat, light) {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.max(0, Math.min(100, sat)) / 100;
  const l = Math.max(0, Math.min(100, light)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const toHex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + toHex(rgb[0]) + toHex(rgb[1]) + toHex(rgb[2]);
}

function applyTheme(hex) {
  const [r, g, b] = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);

  const a1 = hslToHex(h, s, Math.min(l + 6, 74));
  const a2 = hslToHex(h - 12, s, Math.max(l - 9, 28));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

  const root = document.documentElement.style;
  root.setProperty('--accent1', a1);
  root.setProperty('--accent2', a2);
  root.setProperty('--grad', 'linear-gradient(135deg, ' + a1 + ', ' + a2 + ')');
  root.setProperty('--accent-glow', 'rgba(' + r + ',' + g + ',' + b + ',0.25)');
  root.setProperty('--accent-glow-strong', 'rgba(' + r + ',' + g + ',' + b + ',0.38)');
  root.setProperty('--accent-faint', 'rgba(' + r + ',' + g + ',' + b + ',0.14)');
  root.setProperty('--accent-soft', 'rgba(' + r + ',' + g + ',' + b + ',0.13)');
  root.setProperty('--accent-softer', 'rgba(' + r + ',' + g + ',' + b + ',0.07)');
  root.setProperty('--accent-border', 'rgba(' + r + ',' + g + ',' + b + ',0.32)');
  root.setProperty('--accent-ring', 'rgba(' + r + ',' + g + ',' + b + ',0.16)');
  // Accent-colored text must stay readable on the base theme: bright on
  // dark surfaces, deep on light ones.
  const lightMode = document.documentElement.dataset.theme === 'light';
  root.setProperty('--accent-text', hslToHex(h, Math.min(s, 85), lightMode ? 38 : 74));
  root.setProperty('--on-accent', luminance > 150 ? '#221d10' : '#ffffff');
}

// --- Rendering --------------------------------------------------------------

function renderList() {
  proxyList.replaceChildren();
  proxyList.appendChild(makeDirectCard());

  if (state.proxies.length === 0) {
    const empty = h('div', 'empty');
    empty.appendChild(svgNode(GLOBE_SVG));
    empty.appendChild(h('p', null, 'No proxies yet'));
    empty.appendChild(h('p', 'empty-hint', 'Add your first proxy to route traffic through it.'));
    proxyList.appendChild(empty);
  }

  state.proxies.forEach((p, i) => proxyList.appendChild(makeCard(p, i)));
  updateStatus();
  updateScrollLanes();
}

function makeDirectCard() {
  const card = h('div', 'proxy-card');
  card.tabIndex = 0;
  card.style.setProperty('--pc', DIRECT_THEME_COLOR);
  if (state.selectedId === 'direct') card.classList.add('selected');
  card.appendChild(h('div', 'radio'));

  const info = h('div', 'proxy-info');
  info.appendChild(h('div', 'proxy-name', 'Direct Connection'));
  const meta = h('div', 'proxy-meta');
  meta.appendChild(h('span', 'type-badge direct', 'DIRECT'));
  meta.appendChild(h('span', 'proxy-addr', 'No proxy — use your real IP'));
  info.appendChild(meta);
  card.appendChild(info);

  card.addEventListener('click', () => selectProxy('direct'));
  card.addEventListener('keydown', e => {
    if (e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectProxy('direct'); }
  });
  return card;
}

function makeCard(p, index) {
  const card = h('div', 'proxy-card');
  card.tabIndex = 0;
  card.style.animationDelay = (index * 30) + 'ms';
  card.style.setProperty('--pc', p.color || PALETTE[0]);
  if (p.id === state.selectedId) card.classList.add('selected');
  card.appendChild(h('div', 'radio'));

  const info = h('div', 'proxy-info');
  info.appendChild(h('div', 'proxy-name', p.name));
  const meta = h('div', 'proxy-meta');
  meta.appendChild(h('span', 'type-badge ' + p.type, TYPE_LABELS[p.type] || String(p.type).toUpperCase()));
  meta.appendChild(h('span', 'proxy-addr', p.host + ':' + p.port));
  info.appendChild(meta);
  card.appendChild(info);

  const actions = h('div', 'card-actions');

  const edit = h('button', 'edit-btn');
  edit.type = 'button';
  edit.title = 'Edit proxy';
  edit.appendChild(svgNode(EDIT_SVG));
  edit.addEventListener('click', e => { e.stopPropagation(); startEdit(p.id); });
  actions.appendChild(edit);

  const del = h('button', 'delete-btn');
  del.type = 'button';
  del.title = 'Remove proxy';
  del.appendChild(svgNode(TRASH_SVG));
  del.addEventListener('click', e => { e.stopPropagation(); removeProxy(p.id); });
  actions.appendChild(del);

  card.appendChild(actions);

  card.addEventListener('click', () => selectProxy(p.id));
  card.addEventListener('keydown', e => {
    if (e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectProxy(p.id); }
  });
  return card;
}

function updateStatus() {
  const p = state.proxies.find(x => x.id === state.selectedId);
  const active = Boolean(p);
  statusDot.classList.toggle('on', active);
  statusText.textContent = active ? 'Active' : 'Direct';
  statusText.classList.toggle('on', active);
  statusLine.textContent = p ? p.name + ' · ' + p.host + ':' + p.port : 'Direct connection';
  applyTheme(active ? (p.color || PALETTE[0]) : DIRECT_THEME_COLOR);
}

// --- Actions ----------------------------------------------------------------

async function selectProxy(id) {
  state.selectedId = id;
  await browser.storage.local.set({ selectedId: id });
  renderList();
}

async function removeProxy(id) {
  state.proxies = state.proxies.filter(p => p.id !== id);
  const update = { proxies: state.proxies };
  if (state.selectedId === id) {
    state.selectedId = 'direct';
    update.selectedId = 'direct';
  }
  await browser.storage.local.set(update);
  renderList();
}

// --- Form -------------------------------------------------------------------

function setType(type) {
  currentType = type in TYPE_LABELS ? type : 'http';
  typeSeg.querySelectorAll('button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === currentType);
  });
  dnsRow.hidden = !(currentType === 'socks' || currentType === 'socks4');
  updateScrollLanes();
}

function renderSwatches() {
  colorRow.replaceChildren();
  PALETTE.forEach(color => {
    const sw = h('button', 'swatch' + (color === selectedColor ? ' active' : ''));
    sw.type = 'button';
    sw.style.background = color;
    sw.title = color;
    sw.addEventListener('click', () => {
      selectedColor = color;
      colorRow.querySelectorAll('.swatch').forEach(x => {
        x.classList.toggle('active', x === sw);
      });
    });
    colorRow.appendChild(sw);
  });
}

function resetForm() {
  editingId = null;
  proxyForm.reset();
  formScroll.scrollTop = 0;
  formError.textContent = '';
  resetTestState();
  formTitle.textContent = 'Add Proxy';
  saveBtn.textContent = 'Save';
  saveBtn.className = 'btn-ghost';
  connectBtn.hidden = false;
  cloneBtn.hidden = true;
  setType('http');
  selectedColor = PALETTE[state.proxies.length % PALETTE.length];
  renderSwatches();
  authFields.classList.remove('open');
  fDns.checked = true;
}

function startEdit(id) {
  const p = state.proxies.find(x => x.id === id);
  if (!p) return;
  editingId = id;

  proxyForm.reset();
  formScroll.scrollTop = 0;
  formError.textContent = '';
  resetTestState();
  formTitle.textContent = 'Edit Proxy';
  saveBtn.textContent = 'Save';
  saveBtn.className = 'btn-primary';
  connectBtn.hidden = true;
  cloneBtn.hidden = false;

  fName.value = p.name;
  setType(p.type);
  selectedColor = p.color || PALETTE[0];
  renderSwatches();
  fHost.value = p.host;
  fPort.value = p.port;
  authToggle.checked = Boolean(p.username);
  authFields.classList.toggle('open', authToggle.checked);
  fUser.value = p.username || '';
  fPass.value = p.password || '';
  fDns.checked = Boolean(p.proxyDNS);
  fBypassLan.checked = Boolean(p.bypassLan);
  fPersistent.checked = Boolean(p.persistent);

  showView(formView);
  fName.focus();
}

// Reads and validates the form. Returns { proxy } or { error }.
// The proxy object has no id; callers attach one as needed.
function readForm() {
  const name = fName.value.trim();
  const host = fHost.value.trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/:?#].*$/, '');
  const port = Number(fPort.value.trim());

  if (!host) return { error: 'Host is required.' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: 'Port must be a number between 1 and 65535.' };
  }

  const proxy = {
    name: name || host,
    type: currentType,
    host,
    port,
    color: selectedColor,
    proxyDNS: (currentType === 'socks' || currentType === 'socks4') ? fDns.checked : false,
    bypassLan: fBypassLan.checked,
    persistent: fPersistent.checked,
  };

  if (authToggle.checked && fUser.value.trim()) {
    proxy.username = fUser.value.trim();
    proxy.password = fPass.value;
  }

  return { proxy };
}

function showError(msg) {
  formError.textContent = msg;
  formError.classList.remove('shake');
  void formError.offsetWidth; // restart animation
  formError.classList.add('shake');
  updateScrollLanes();
}

async function onSubmit(e) {
  e.preventDefault();

  // Connect = save + make it the active proxy. Enter-key submission
  // (no submitter) defaults to the primary action: save when editing,
  // connect when adding.
  const connect = e.submitter === connectBtn || (!e.submitter && !editingId);

  const { proxy, error } = readForm();
  if (error) return showError(error);

  // Only one proxy may be persistent; enabling it here clears the rest.
  if (proxy.persistent) {
    state.proxies.forEach(p => { if (p.id !== editingId) p.persistent = false; });
  }

  if (editingId) {
    const idx = state.proxies.findIndex(x => x.id === editingId);
    if (idx === -1) return showError('This proxy no longer exists.');
    state.proxies[idx] = { ...state.proxies[idx], ...proxy, id: editingId };
    await browser.storage.local.set({ proxies: state.proxies });
  } else {
    const entry = { ...proxy, id: uid() };
    state.proxies.push(entry);
    const update = { proxies: state.proxies };
    if (connect) {
      state.selectedId = entry.id;
      update.selectedId = entry.id;
    }
    await browser.storage.local.set(update);
  }

  showView(listView);
  renderList();
}

// Duplicates the proxy being edited as a new entry. The clone never
// inherits the persistent flag — it always starts disabled.
// Stays in the form; the button flashes a checkmark as confirmation.
async function onClone() {
  const { proxy, error } = readForm();
  if (error) return showError(error);

  const entry = { ...proxy, id: uid(), name: proxy.name + ' (copy)', persistent: false };
  state.proxies.push(entry);
  await browser.storage.local.set({ proxies: state.proxies });
  renderList();

  cloneBtn.disabled = true;
  cloneBtn.classList.add('cloned');
  cloneBtn.replaceChildren(svgNode(CHECK_SVG));
  setTimeout(() => {
    cloneBtn.disabled = false;
    cloneBtn.classList.remove('cloned');
    cloneBtn.textContent = 'Clone';
  }, 1200);
}

// --- Connection test --------------------------------------------------------

async function onTest() {
  const { proxy, error } = readForm();
  if (error) return showError(error);
  formError.textContent = '';

  setTestState('testing');
  try {
    const res = await browser.runtime.sendMessage({ type: 'testProxy', proxy });
    setTestState(res && res.ok ? 'ok' : 'fail', res);
  } catch (err) {
    setTestState('fail', { error: 'No response from background script' });
  }
}

function setTestState(phase, res) {
  testBtn.disabled = phase === 'testing';
  if (phase === 'testing') {
    testBtn.replaceChildren(h('span', 'spinner'), document.createTextNode(' Testing…'));
  } else {
    testBtn.replaceChildren(svgNode(ZAP_SVG), document.createTextNode(' Test Connection'));
  }

  testResult.className = 'test-result' + (phase === 'testing' || phase === 'ok' || phase === 'fail' ? ' ' + phase : '');
  if (phase === 'testing') {
    testResult.textContent = 'Sending a request through this proxy…';
  } else if (phase === 'ok') {
    testResult.textContent = 'Working — exit IP ' + res.ip + ' · ' + res.ms + ' ms';
  } else if (phase === 'fail') {
    testResult.textContent = 'Failed — ' + ((res && res.error) || 'could not connect');
  } else {
    testResult.textContent = '';
  }
  updateScrollLanes();
}

function resetTestState() {
  setTestState('idle');
}

// --- Backup & restore ---------------------------------------------------------

function showSettingsMsg(kind, text) {
  settingsMsg.textContent = text;
  settingsMsg.className = 'settings-message ' + kind;
}

async function onExport() {
  try {
    const payload = {
      app: 'proxy-manager',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      data: { proxies: state.proxies, selectedId: state.selectedId },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const filename = 'proxy-manager-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    await browser.downloads.download({ url, filename, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showSettingsMsg('ok', 'Exported ' + plural(state.proxies.length, 'proxy') + ' to your downloads folder.');
  } catch (err) {
    showSettingsMsg('fail', 'Export failed — ' + ((err && err.message) || 'unknown error'));
  }
}

function onImportFile() {
  const file = importFile.files && importFile.files[0];
  importFile.value = ''; // allow re-importing the same file
  if (file) importBackup(file);
}

async function importBackup(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (err) {
    showSettingsMsg('fail', 'Import failed — the file is not valid JSON.');
    return;
  }

  const result = validateBackup(parsed);
  if (result.error) {
    showSettingsMsg('fail', result.error);
    return;
  }

  state.proxies = result.proxies;
  state.selectedId = result.selectedId;
  await browser.storage.local.set({ proxies: state.proxies, selectedId: state.selectedId });
  renderList();

  let msg = 'Imported ' + plural(result.proxies.length, 'proxy') + '.';
  if (result.skipped) msg += ' Skipped ' + result.skipped + ' invalid.';
  showSettingsMsg('ok', msg);
}

// Accepts our own export format ({ data: {...} }) or a bare
// { proxies, selectedId } object. Returns { proxies, selectedId, skipped }
// or { error }.
function validateBackup(parsed) {
  const data = parsed && typeof parsed === 'object'
    ? (parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed)
    : null;
  if (!data || !Array.isArray(data.proxies)) {
    return { error: 'Import failed — not a Proxy Manager backup file.' };
  }

  const proxies = [];
  const seenIds = new Set();
  let skipped = 0;

  data.proxies.forEach(raw => {
    const p = sanitizeProxy(raw);
    if (!p) { skipped++; return; }
    if (seenIds.has(p.id)) p.id = uid();
    seenIds.add(p.id);
    p.color = p.color || PALETTE[proxies.length % PALETTE.length];
    proxies.push(p);
  });

  // At most one proxy may be persistent; first one wins.
  let persistentSeen = false;
  proxies.forEach(p => {
    if (p.persistent) {
      if (persistentSeen) p.persistent = false;
      persistentSeen = true;
    }
  });

  const selectedId = typeof data.selectedId === 'string' &&
    (data.selectedId === 'direct' || seenIds.has(data.selectedId))
    ? data.selectedId
    : 'direct';

  return { proxies, selectedId, skipped };
}

// Normalizes one raw proxy entry; returns null when mandatory fields are bad.
function sanitizeProxy(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const host = typeof raw.host === 'string' ? raw.host.trim() : '';
  const port = Number(raw.port);
  if (!(raw.type in TYPE_LABELS) || !host ||
      !Number.isInteger(port) || port < 1 || port > 65535) return null;

  const p = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : host,
    type: raw.type,
    host,
    port,
    color: typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : null,
    proxyDNS: Boolean(raw.proxyDNS),
    bypassLan: Boolean(raw.bypassLan),
    persistent: Boolean(raw.persistent),
  };
  if (typeof raw.username === 'string' && raw.username) {
    p.username = raw.username;
    p.password = typeof raw.password === 'string' ? raw.password : '';
  }
  return p;
}
