const APP_VERSION = '1.2.4';
const STATE_KEY = 'dm-drawing-board-state';
const IDB_NAME = 'dm-drawing-board';
const IDB_STORE = 'campaigns';
const IDB_ACTIVE_ID = 'active';
const savedState = loadStoredState();
const defaults = {
  theme: 'light',
  campaignName: '',
  campaignPremise: '',
  scratchpad: '',
  regions: [],
  tasks: { hooks: [], scenes: [], loose: [] },
  history: [],
  tables: { rumors: [], twists: [] },
  encounters: [],
  characters: [],
  map: { ink: '', background: '', stamps: [], paths: [], waterAreas: [], layers: { background: true, grid: true, ink: true, water: true, paths: true, stamps: true }, tool: 'draw', brushColor: '#000000', brushSize: 6, brushStyle: 'marker', pathStyle: 'path', exportScale: 2, exportTransparent: false, gridType: 'square', gridSize: 40 }
};
let appState = mergeState(defaults, savedState);
let regionImageDraft = '';
let characterImageDraft = '';
let activeMapTool = appState.map.tool || 'draw';
let drawing = false;
let lastPoint = null;
let lastDrawStrokePoints = [];
let currentOverlay = null;
let selectedStampId = '';
let selectedPathId = '';
let selectedWaterAreaId = '';
let pendingPathPoint = null;
let pathPreviewPoint = null;
let pendingPathConnection = null;
let pendingWaterPoints = [];
let waterPreviewPoint = null;
let lastWaterClosePointerTime = 0;
let waterDrawing = false;
let lastWaterDrawPoint = null;
let waterPointerId = null;
let waterDragStarted = false;
let saveTimer = null;
let mapHydrated = false;
let overlayReturnFocus = null;
const undoStack = [];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const APP_ZOOM_KEY = 'dmDrawingBoardAppZoom';
const APP_ZOOM_STEP = 0.1;
const APP_ZOOM_MIN = 0.7;
const APP_ZOOM_MAX = 1.3;

function clampAppZoom(value) {
  return Math.min(APP_ZOOM_MAX, Math.max(APP_ZOOM_MIN, Number(value) || 1));
}

function applyAppZoom(value) {
  const zoom = clampAppZoom(value);
  document.documentElement.style.setProperty('--app-zoom', zoom.toFixed(2));
  localStorage.setItem(APP_ZOOM_KEY, zoom.toFixed(2));
  return zoom;
}

function adjustAppZoom(direction) {
  const current = clampAppZoom(localStorage.getItem(APP_ZOOM_KEY) || 1);
  const next = direction === 0 ? 1 : current + (direction * APP_ZOOM_STEP);
  return applyAppZoom(next);
}

window.appZoomControl = adjustAppZoom;
applyAppZoom(localStorage.getItem(APP_ZOOM_KEY) || 1);

function snapshotMap() {
  undoStack.push(JSON.stringify(appState.map));
  if (undoStack.length > 40) undoStack.shift();
}

function undoMap() {
  const previous = undoStack.pop();
  if (!previous) return;
  appState.map = JSON.parse(previous);
  activeMapTool = appState.map.tool || activeMapTool;
  pendingPathPoint = null;
  pathPreviewPoint = null;
  pendingPathConnection = null;
  pendingWaterPoints = [];
  waterPreviewPoint = null;
  lastDrawStrokePoints = [];
  waterDrawing = false;
  lastWaterDrawPoint = null;
  waterPointerId = null;
  waterDragStarted = false;
  selectedPathId = '';
  selectedWaterAreaId = '';
  syncMapBackground();
  redrawMapInk();
  renderWaterAreas();
  renderMapStamps();
  setMapTool(activeMapTool, false);
  saveState();
}

function syncMapBackground(root = document) {
  const images = $$('#map-bg-image, #overlay-map-bg-image', root);
  images.forEach(image => {
    image.src = appState.map.background || '';
    image.hidden = !appState.map.background || appState.map.layers?.background === false;
  });
}

const uid = () => crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];


function loadStoredState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return {};
    DMDashSecurity.assertImportSize(raw);
    const parsed = JSON.parse(raw);
    return parsed && parsed.storagePointer ? {} : DMDashSecurity.normalizeState(parsed);
  } catch (_error) {
    localStorage.removeItem(STATE_KEY);
    return {};
  }
}

function mergeState(_base, incoming) {
  return DMDashSecurity.normalizeState(incoming || {});
}

function openStateDb() {
  if (!window.indexedDB) return Promise.resolve(null);
  return new Promise(resolve => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(IDB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function saveStateLarge(usePointer = false) {
  const db = await openStateDb();
  if (!db) return false;
  const normalized = DMDashSecurity.normalizeState(appState);
  return new Promise(resolve => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(normalized, IDB_ACTIVE_ID);
    tx.oncomplete = () => {
      if (usePointer) {
        try { localStorage.setItem(STATE_KEY, JSON.stringify({ storagePointer: 'indexeddb', savedAt: new Date().toISOString() })); } catch (_error) {}
      }
      resolve(true);
    };
    tx.onerror = () => resolve(false);
  });
}

async function loadStateLarge() {
  const db = await openStateDb();
  if (!db) return null;
  return new Promise(resolve => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const request = tx.objectStore(IDB_STORE).get(IDB_ACTIVE_ID);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateNow, 120);
}

async function saveStateNow() {
  clearTimeout(saveTimer);
  try {
    appState = DMDashSecurity.normalizeState(appState);
    const serialized = JSON.stringify(appState);
    localStorage.setItem(STATE_KEY, serialized);
    return true;
  } catch (_error) {
    try {
      const ok = await saveStateLarge(true);
      if (ok) return true;
    } catch (_storageError) {}
    showToast('Campaign is too large for local storage. Save a campaign file.', 'warn');
    return false;
  }
}

async function hydrateLargeState() {
  const raw = localStorage.getItem(STATE_KEY);
  const shouldHydrate = !raw || raw.includes('storagePointer');
  if (!shouldHydrate) return;
  const stored = await loadStateLarge();
  if (!stored) return;
  appState = DMDashSecurity.normalizeState(stored);
  activeMapTool = appState.map.tool || 'draw';
  refreshApp();
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

function parseTags(value) {
  const found = String(value || '').toLowerCase().match(/#[a-z0-9_-]+/g) || [];
  return [...new Set(found)];
}

function setThemeText() {
  $('#theme-btn').textContent = appState.theme === 'dark' ? 'Light Mode' : 'Dark Mode';
  $('#theme-btn').setAttribute('aria-pressed', appState.theme === 'dark' ? 'true' : 'false');
}

function readImageFile(input, callback, maxSize = 1400) {
  const file = input.files && input.files[0];
  const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  if (!file || !allowedTypes.includes(file.type)) {
    showToast('Choose a PNG, JPEG, GIF, or WebP image.', 'warn');
    input.value = '';
    return;
  }
  if (file.size > DMDashSecurity.MAX_IMAGE_BYTES) {
    showToast('Choose an image under 6 MB.', 'warn');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => compressImage(reader.result, maxSize).then(callback).catch(() => showToast('That image could not be opened.', 'warn'));
  reader.onerror = () => showToast('That image could not be opened.', 'warn');
  reader.readAsDataURL(file);
}

function compressImage(src, maxSize) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas unavailable.');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const result = canvas.toDataURL('image/jpeg', 0.82);
        if (!DMDashSecurity.safeImageData(result)) throw new Error('Unsafe image data.');
        resolve(result);
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => reject(new Error('Image decoding failed.'));
    image.src = src;
  });
}

async function downloadFile(filename, content, type) {
  return DMDashPlatform.saveTextFile(filename, content, type);
}

function safeFilename(name, fallback) {
  return DMDashSecurity.sanitizeFilename(name, fallback);
}

function getDialogRoot() {
  return $('#dialog-root');
}

function getFocusableElements(root) {
  return Array.from(root.querySelectorAll('button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'))
    .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}

function showToast(message, kind = 'info') {
  const stack = $('#toast-stack');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 220);
  }, 3200);
}

function openDialog({ title = 'Notice', body = '', fields = [], actions = [{ label: 'OK', value: true, tone: 'primary' }] } = {}) {
  const root = getDialogRoot();
  if (!root) return Promise.resolve(null);
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return new Promise(resolve => {
    root.hidden = false;
    const fieldMarkup = fields.map(field => {
      const value = escapeHtml(field.value || '');
      if (field.type === 'textarea') return `<label for="${field.id}">${escapeHtml(field.label)}</label><textarea id="${field.id}">${value}</textarea>`;
      return `<label for="${field.id}">${escapeHtml(field.label)}</label><input id="${field.id}" type="text" value="${value}">`;
    }).join('');
    root.innerHTML = `<section class="dialog-card" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><h2 id="dialog-title">${escapeHtml(title)}</h2><div class="dialog-body">${body}</div>${fieldMarkup ? `<form class="dialog-fields">${fieldMarkup}</form>` : ''}<div class="dialog-actions">${actions.map((action, index) => `<button type="button" data-dialog-action="${index}" class="${action.tone ? `dialog-${action.tone}` : ''}">${escapeHtml(action.label)}</button>`).join('')}</div></section>`;
    const dialog = $('.dialog-card', root);
    const firstField = fields.length ? $(`#${fields[0].id}`, root) : null;
    const firstButton = $('[data-dialog-action]', root);
    const close = value => {
      const values = {};
      fields.forEach(field => { values[field.name || field.id] = $(`#${field.id}`, root)?.value || ''; });
      root.hidden = true;
      root.innerHTML = '';
      root.removeEventListener('click', clickHandler);
      document.removeEventListener('keydown', keyHandler);
      if (returnFocus?.isConnected) returnFocus.focus();
      resolve({ value, values });
    };
    const keyHandler = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
        return;
      }
      if (event.key === 'Tab') {
        const focusable = getFocusableElements(dialog);
        if (!focusable.length) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key === 'Enter' && fields.length && event.target.tagName !== 'TEXTAREA') {
        event.preventDefault();
        close(actions[0]?.value ?? true);
      }
    };
    const clickHandler = event => {
      if (event.target === root) close(null);
      const button = event.target.closest('[data-dialog-action]');
      if (!button) return;
      const action = actions[Number(button.dataset.dialogAction)];
      close(action?.value ?? true);
    };
    root.addEventListener('click', clickHandler);
    document.addEventListener('keydown', keyHandler);
    setTimeout(() => (firstField || firstButton || dialog)?.focus(), 0);
  });
}

async function appAlert(message, title = 'Notice') {
  await openDialog({ title, body: `<p>${escapeHtml(message)}</p>`, actions: [{ label: 'OK', value: true, tone: 'primary' }] });
}

async function showPrivacyPolicy() {
  await openDialog({
    title: 'Privacy Policy',
    body: `<div class="privacy-policy"><p>DM Dash does not collect, sell, or share personal information. Campaign data stays on your device unless you choose to save or export a file.</p><h3>GitHub Pages</h3><p>The web version is hosted by GitHub Pages. The app does not add analytics, tracking cookies, or outbound network requests. GitHub may process basic connection and request data as the hosting provider under its own privacy terms.</p><h3>Electron App</h3><p>The desktop version runs locally and does not send campaign data to a server. It reads or writes campaign files only when you choose to open or save them.</p><p class="privacy-meta">Version ${APP_VERSION} · Effective August 11, 2026</p></div>`,
    actions: [{ label: 'Close', value: true, tone: 'primary' }]
  });
}

async function appConfirm(message, title = 'Confirm') {
  const result = await openDialog({ title, body: `<p>${escapeHtml(message)}</p>`, actions: [{ label: 'Yes', value: true, tone: 'primary' }, { label: 'No', value: false, tone: 'quiet' }] });
  return Boolean(result?.value);
}

async function appPrompt(label, fallback = '', title = 'Add Detail') {
  const id = `dialog-field-${Date.now()}`;
  const result = await openDialog({ title, body: '', fields: [{ id, label, value: fallback, name: 'text' }], actions: [{ label: 'Add', value: true, tone: 'primary' }, { label: 'Cancel', value: false, tone: 'quiet' }] });
  if (!result?.value) return null;
  return result.values.text;
}

async function showInfoCard(title, rows = []) {
  await openDialog({ title, body: `<div class="dialog-info-list">${rows.filter(Boolean).map(row => `<p>${escapeHtml(row)}</p>`).join('')}</div>`, actions: [{ label: 'Close', value: true, tone: 'primary' }] });
}

function showView(name) {
  $$('.nav-btn').forEach(btn => {
    const active = btn.dataset.view === name;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `${name}-view`));
  if (name === 'map') requestAnimationFrame(hydrateMapView);
}

function addRegion() {
  addRegionFromValues({
    name: $('#region-name').value.trim(),
    type: $('#region-type').value,
    tone: $('#region-tone').value.trim(),
    sceneTags: $('#region-scenes').value,
    secrets: $('#region-secrets').value.trim(),
    image: regionImageDraft
  });
  regionImageDraft = '';
  $('#region-form').reset();
}

function addRegionFromValues(values = {}) {
  const region = {
    id: uid(),
    name: values.name || 'Unnamed Place',
    type: values.type || 'Location',
    tone: values.tone || '',
    sceneTags: Array.isArray(values.sceneTags) ? values.sceneTags : parseTags(values.sceneTags || ''),
    secrets: values.secrets || '',
    image: values.image || '',
    x: 6 + (appState.regions.length % 3) * 30,
    y: 8 + Math.floor(appState.regions.length / 3) * 24
  };
  appState.regions.push(region);
  renderRegions();
  if (currentOverlay === 'world') renderRegions($('#overlay-board'));
  saveState();
}

function renderRegions(root = document) {
  const list = $('#region-list', root);
  const board = $('#map-board', root) || $('#overlay-world-board', root) || $('#overlay-board .map-board', root);
  const tagButtons = (region) => (region.sceneTags || []).map(tag => `<button class="tag-chip" data-scene-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join('');
  if (list) {
    list.innerHTML = appState.regions.map(region => `
      <article class="card region-card" data-id="${region.id}" tabindex="0">
        ${region.image ? `<img class="node-img" src="${region.image}" alt="">` : ''}
        <h3>${escapeHtml(region.name)}</h3>
        <div class="meta">${escapeHtml(region.type)}${region.tone ? ` • ${escapeHtml(region.tone)}` : ''}</div>
        ${(region.sceneTags || []).length ? `<div class="tag-row">${tagButtons(region)}</div>` : ''}
        <p>${escapeHtml(region.secrets)}</p>
        <button data-delete-region="${region.id}" aria-label="Delete ${escapeHtml(region.name)}">Delete</button>
      </article>
    `).join('');
  }
  if (board) {
    board.innerHTML = appState.regions.map(region => `
      <div class="region-pin" style="left:${region.x}%; top:${region.y}%;" data-pin="${region.id}">
        ${region.image ? `<img class="node-img" src="${region.image}" alt="">` : ''}
        ${escapeHtml(region.name)}<div class="meta">${escapeHtml(region.type)}</div>
        ${(region.sceneTags || []).length ? `<div class="tag-row">${tagButtons(region)}</div>` : ''}
      </div>
    `).join('');
  }
}

function rollDie(sides) {
  return Math.floor(Math.random() * sides) + 1;
}

function rollFormula(formula) {
  const cleaned = String(formula || '').slice(0, 200).toLowerCase().replace(/\s+/g, '');
  const parts = cleaned.match(/[+-]?[^+-]+/g) || [];
  let total = 0;
  const detail = [];
  for (const part of parts) {
    const sign = part.startsWith('-') ? -1 : 1;
    const token = part.replace(/^[+-]/, '');
    const dice = token.match(/^(\d*)d(\d+)(kh1|kl1)?$/);
    if (dice) {
      const count = Math.min(Number(dice[1] || 1), 100);
      const sides = Math.min(Number(dice[2]), 1000000);
      const rolls = Array.from({ length: count }, () => rollDie(sides));
      let used = rolls;
      if (dice[3] === 'kh1') used = [Math.max(...rolls)];
      if (dice[3] === 'kl1') used = [Math.min(...rolls)];
      const subtotal = used.reduce((sum, value) => sum + value, 0) * sign;
      total += subtotal;
      detail.push(`${sign < 0 ? '-' : '+'}${token} [${rolls.join(', ')}]`);
    } else if (/^\d+$/.test(token)) {
      total += Number(token) * sign;
      detail.push(`${sign < 0 ? '-' : '+'}${token}`);
    }
  }
  return { total, detail: detail.join(' ') || 'No valid dice found.' };
}

function renderDice() {
  const dice = [4, 6, 8, 10, 12, 20, 100];
  $('#dice-grid').innerHTML = dice.map(sides => `
    <article class="card die-card">
      <strong>d${sides}</strong>
      <div class="dice-total" id="d${sides}-total">—</div>
      <button data-roll="${sides}">Roll d${sides}</button>
    </article>
  `).join('');
}

function showRoll(label, result) {
  $('#dice-result').innerHTML = `<strong>${escapeHtml(label)} = ${result.total}</strong><br>${escapeHtml(result.detail)}`;
  appState.history.unshift(`${label}: ${result.total} (${result.detail})`);
  appState.history = appState.history.slice(0, 16);
  renderHistory();
  saveState();
}

function renderHistory() {
  $('#dice-history').innerHTML = appState.history.map(item => `<div>${escapeHtml(item)}</div>`).join('');
}

function getSymbolData(kind) {
  const data = {
    mountain: { mark: '▲', label: 'Mountain' },
    water: { mark: '≈', label: 'Water' },
    forest: { mark: '♣', label: 'Forest' },
    city: { mark: '■', label: 'City' },
    dungeon: { mark: '▣', label: 'Dungeon' },
    path: { mark: '━', label: 'Path' },
    ruin: { mark: '✕', label: 'Ruin' },
    camp: { mark: '⌂', label: 'Camp' },
    note: { mark: '•', label: 'Note' }
  };
  return data[kind] || data.note;
}

function syncMapControlUi() {
  const symbolValue = $('#symbol-kind')?.value || $('#overlay-symbol-kind')?.value || 'mountain';
  $$('.map-tool-btn').forEach(button => {
    const active = button.dataset.mapTool === activeMapTool;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  $$('.symbol-palette [data-symbol-pick]').forEach(button => {
    const active = button.dataset.symbolPick === symbolValue;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  $$('#brush-color, #overlay-brush-color').forEach(input => { input.value = appState.map.brushColor || '#000000'; });
  $$('#brush-size, #overlay-brush-size').forEach(input => { input.value = appState.map.brushSize || 6; });
  $$('#brush-size-output, #overlay-brush-size-output').forEach(output => { output.textContent = appState.map.brushSize || 6; });
  $$('#brush-style, #overlay-brush-style').forEach(select => { select.value = appState.map.brushStyle || 'marker'; });
  $$('#path-style, #overlay-path-style').forEach(select => { select.value = appState.map.pathStyle || 'path'; });
  $$('#map-export-scale, #overlay-map-export-scale').forEach(select => { select.value = String(appState.map.exportScale || 2); });
  $$('#export-transparent, #overlay-export-transparent').forEach(input => { input.checked = Boolean(appState.map.exportTransparent); });
  $$('#symbol-kind, #overlay-symbol-kind').forEach(select => { select.value = symbolValue; });
  $$('#grid-type, #overlay-grid-type').forEach(select => { select.value = appState.map.gridType || 'square'; });
  $$('#grid-size, #overlay-grid-size').forEach(input => { input.value = appState.map.gridSize || 40; });
  $$('#grid-size-output, #overlay-grid-size-output').forEach(output => { output.textContent = appState.map.gridSize || 40; });
}

function renderMapGrid(root = document) {
  const type = appState.map.gridType || 'none';
  const size = Number(appState.map.gridSize || 40);
  const layers = $$('#map-grid-layer, #overlay-map-grid-layer', root);
  layers.forEach(layer => {
    layer.className = `map-grid-layer ${type === 'hex' ? 'hex-grid' : type === 'square' ? 'square-grid' : ''}`;
    layer.style.setProperty('--grid-size', `${size}px`);
    layer.hidden = type === 'none' || appState.map.layers?.grid === false;
  });
}

function syncLayerUi() {
  const layers = appState.map.layers || {};
  [['background', 'layer-background'], ['grid', 'layer-grid'], ['ink', 'layer-ink'], ['water', 'layer-water'], ['paths', 'layer-paths'], ['stamps', 'layer-stamps']].forEach(([name, id]) => {
    const control = $(`#${id}`);
    if (control) control.checked = layers[name] !== false;
  });
}

function applyLayerVisibility(root = document) {
  const layers = appState.map.layers || {};
  $$('#map-bg-image, #overlay-map-bg-image', root).forEach(node => { node.hidden = layers.background === false || !appState.map.background; });
  $$('#map-canvas, #overlay-map-canvas', root).forEach(node => { node.hidden = layers.ink === false; });
  $$('#map-water-layer, #overlay-map-water-layer', root).forEach(node => { node.hidden = layers.water === false; });
  $$('#map-path-layer, #overlay-map-path-layer', root).forEach(node => { node.hidden = layers.paths === false; });
  $$('#map-stamp-layer, #overlay-board .stamp-layer', root).forEach(node => { node.hidden = layers.stamps === false; });
  syncLayerUi();
}

function setLayerVisibility(name, value) {
  appState.map.layers = { ...(appState.map.layers || {}), [name]: value };
  renderMapGrid();
  applyLayerVisibility();
  saveState();
}

function getToolHint() {
  const count = pendingWaterPoints.length;
  const names = {
    draw: `${brushLabel()} brush: drag to ink the map. Draw a closed shape, then press Water Fill to make custom water`,
    erase: 'Eraser: drag to erase ink',
    symbol: 'Symbol: click the board to stamp the selected icon',
    label: 'Label: click the board and type a map label',
    location: 'Location pin: click to create a linked campaign entry',
    quest: 'Quest pin: click to create a linked hook',
    waterarea: count ? `Water Area: ${count} shoreline point${count === 1 ? '' : 's'} placed. Click the start dot or press Enter to fill.` : 'Water Area: click shoreline points to lasso a lake, coast, swamp, or river mouth',
    pathline: pendingPathPoint ? 'Path Line: click the destination point to finish the route' : `Path Line: click a start point for a ${pathStyleLabel(appState.map.pathStyle)}`,
    connectpaths: pendingPathConnection ? 'Connect Paths: click another endpoint to snap both together' : 'Connect Paths: click two route endpoints to join them',
    move: 'Move: drag stamps, water, and green curve handles',
    delete: 'Delete: click any stamp, water, or path handle to remove it'
  };
  return names[activeMapTool] || 'Map Maker ready';
}

function updateMapHud() {
  $$('#map-hud, #overlay-map-hud').forEach(hud => {
    hud.textContent = getToolHint();
  });
}

function brushLabel() {
  return ({ marker: 'Marker', pixel: 'Pixel Pencil', dungeon: 'Dungeon Ink', highlighter: 'Highlighter' })[appState.map.brushStyle || 'marker'] || 'Marker';
}

function pathStyleLabel(value) {
  return ({ path: 'path', trail: 'trail', river: 'river', border: 'border', secret: 'secret route' })[value || 'path'] || 'path';
}


function setMapTool(tool, shouldSave = true) {
  if (tool !== 'pathline') {
    pendingPathPoint = null;
    pathPreviewPoint = null;
  }
  if (tool !== 'connectpaths') pendingPathConnection = null;
  if (tool !== 'waterarea') {
    pendingWaterPoints = [];
    waterPreviewPoint = null;
  }
  activeMapTool = tool;
  appState.map.tool = tool;
  document.body.classList.toggle('delete-map-mode', tool === 'delete');
  $$('.map-maker-board').forEach(board => {
    board.style.cursor = tool === 'delete' ? 'not-allowed' : tool === 'move' ? 'grab' : tool === 'label' || tool === 'location' || tool === 'quest' || tool === 'waterarea' || tool === 'pathline' ? 'copy' : tool === 'connectpaths' ? 'cell' : 'crosshair';
  });
  syncMapControlUi();
  renderMapPaths();
  renderWaterAreas();
  renderMapStamps();
  applyLayerVisibility();
  updateMapHud();
  if (shouldSave) saveState();
}

function getCanvasPoint(event, canvas = event.currentTarget || $('#map-canvas')) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height)
  };
}

function syncCanvasInk(sourceCanvas) {
  if (!sourceCanvas) return;
  const targetId = sourceCanvas.id === 'overlay-map-canvas' ? 'map-canvas' : 'overlay-map-canvas';
  const targetCanvas = $(`#${targetId}`);
  if (!targetCanvas) return;
  const ctx = targetCanvas.getContext('2d');
  ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
  ctx.drawImage(sourceCanvas, 0, 0);
}

function redrawMapInk() {
  syncMapBackground();
  const canvases = $$('#map-canvas, #overlay-map-canvas');
  canvases.forEach(canvas => canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height));
  if (!appState.map.ink) return;
  const image = new Image();
  image.onload = () => {
    canvases.forEach(canvas => canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height));
  };
  image.src = appState.map.ink;
}

function saveMapInk(canvas = $('#map-canvas')) {
  if (!canvas) return;
  appState.map.ink = canvas.toDataURL('image/png');
  syncCanvasInk(canvas);
  saveState();
}

function startDraw(event) {
  if ((activeMapTool === 'delete' || event.altKey || activeMapTool === 'move') && handlePathCanvasClick(event)) return;
  if (activeMapTool === 'delete') return;
  if (activeMapTool === 'waterarea') {
    startWaterDraw(event);
    return;
  }
  if (['symbol','label','location','quest','pathline','connectpaths'].includes(activeMapTool)) {
    handleMapObjectPlacement(event);
    return;
  }
  if (activeMapTool === 'delete') return;
  if (activeMapTool !== 'draw' && activeMapTool !== 'erase') return;
  snapshotMap();
  drawing = true;
  lastPoint = getCanvasPoint(event);
  if (activeMapTool === 'draw') lastDrawStrokePoints = [lastPoint];
  event.currentTarget.setPointerCapture(event.pointerId);
}

function moveDraw(event) {
  const canvas = event.currentTarget || $('#map-canvas');
  if (activeMapTool === 'pathline' && pendingPathPoint) {
    pathPreviewPoint = getCanvasPoint(event, canvas);
    renderMapPaths();
    return;
  }
  if (activeMapTool === 'waterarea' && waterDrawing) {
    const point = getCanvasPoint(event, canvas);
    waterPreviewPoint = point;
    if (!lastWaterDrawPoint || Math.hypot(point.x - lastWaterDrawPoint.x, point.y - lastWaterDrawPoint.y) >= 8) {
      appendWaterPoint(point);
      lastWaterDrawPoint = point;
      waterDragStarted = true;
    }
    renderWaterAreas();
    return;
  }
  if (activeMapTool === 'waterarea' && pendingWaterPoints.length) {
    waterPreviewPoint = getCanvasPoint(event, canvas);
    renderWaterAreas();
    return;
  }
  if (!drawing) return;
  const ctx = canvas.getContext('2d');
  const point = getCanvasPoint(event, canvas);
  if (activeMapTool === 'draw') captureWaterFillDraftPoint(point);
  ctx.save();
  const brushStyle = appState.map.brushStyle || 'marker';
  ctx.lineCap = brushStyle === 'pixel' ? 'butt' : 'round';
  ctx.lineJoin = brushStyle === 'pixel' ? 'miter' : 'round';
  ctx.lineWidth = Number(appState.map.brushSize || 6);
  if (activeMapTool === 'erase') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = Number(appState.map.brushSize || 6) * 2.1;
  } else {
    ctx.strokeStyle = appState.map.brushColor || '#000000';
    if (brushStyle === 'highlighter') ctx.globalAlpha = .42;
    if (brushStyle === 'dungeon') ctx.setLineDash([Math.max(4, ctx.lineWidth * 1.1), Math.max(3, ctx.lineWidth * .7)]);
  }
  ctx.beginPath();
  ctx.moveTo(lastPoint.x, lastPoint.y);
  const drawPoint = brushStyle === 'dungeon' && activeMapTool === 'draw' ? { x: point.x + (Math.random() - .5) * ctx.lineWidth * .55, y: point.y + (Math.random() - .5) * ctx.lineWidth * .55 } : point;
  ctx.lineTo(drawPoint.x, drawPoint.y);
  ctx.stroke();
  ctx.restore();
  lastPoint = point;
}

function endDraw(event) {
  if (waterDrawing) {
    const canvas = event.currentTarget || $('#map-canvas');
    const point = getCanvasPoint(event, canvas);
    if (waterDragStarted) appendWaterPoint(point, true);
    waterPreviewPoint = point;
    waterDrawing = false;
    lastWaterDrawPoint = null;
    waterPointerId = null;
    waterDragStarted = false;
    try { canvas.releasePointerCapture?.(event.pointerId); } catch (_) {}
    renderWaterAreas();
    return;
  }
  if (!drawing) return;
  moveDraw(event);
  if (activeMapTool === 'draw') captureWaterFillDraftPoint(getCanvasPoint(event, event.currentTarget || $('#map-canvas')), true);
  drawing = false;
  lastPoint = null;
  saveMapInk(event.currentTarget || $('#map-canvas'));
}

function placeSymbol(event) {
  const point = getCanvasPoint(event, event.currentTarget || $('#map-canvas'));
  const kind = (currentOverlay === 'map' && $('#overlay-symbol-kind')) ? $('#overlay-symbol-kind').value : ($('#symbol-kind')?.value || 'mountain');
  const symbol = getSymbolData(kind);
  snapshotMap();
  appState.map.stamps.push({ id: uid(), type: kind, label: symbol.label, x: point.x - 28, y: point.y - 28, size: 64, image: '' });
  renderMapStamps();
  saveState();
}

function getPlacementPoint(event) {
  const board = event.target.closest('.map-maker-board') || $('#map-maker-board') || $('#overlay-board .map-maker-board');
  const canvas = board?.querySelector('canvas') || event.currentTarget || $('#map-canvas');
  return getCanvasPoint(event, canvas);
}

function addMapStamp(stamp) {
  appState.map.stamps.push(stamp);
  selectedStampId = stamp.id;
  renderMapStamps();
}

async function handleMapObjectPlacement(event) {
  if (event._mapPlacementHandled) return;
  if (event.target.closest('.map-stamp,.path-curve-handle,.water-area')) return;
  event._mapPlacementHandled = true;
  event.preventDefault();
  event.stopPropagation();
  if (activeMapTool === 'symbol') return placeSymbol(event);
  const point = getPlacementPoint(event);
  if (activeMapTool === 'pathline') return placePathPoint(point);
  if (activeMapTool === 'connectpaths') return connectPathAtPoint(point);
  if (activeMapTool === 'waterarea') return placeWaterAreaPoint(point, event);
  const prompts = {
    label: ['Map label text:', 'New Label'],
    location: ['Location name:', 'New Location'],
    quest: ['Quest / beat title:', 'New Quest']
  };
  const promptData = prompts[activeMapTool];
  if (!promptData) return;
  const entered = await appPrompt(promptData[0], promptData[1], activeMapTool === 'quest' ? 'Quest Pin' : activeMapTool === 'location' ? 'Location Pin' : 'Map Label');
  const title = (entered || '').trim();
  if (!title) return;
  snapshotMap();
  if (activeMapTool === 'label') {
    addMapStamp({ id: uid(), type: 'label', label: title, x: point.x - 70, y: point.y - 18, size: 140, image: '' });
  }
  if (activeMapTool === 'location') {
    const region = { id: uid(), name: title, type: 'Location', tone: '', sceneTags: [], secrets: '', image: '', x: 6 + (appState.regions.length % 3) * 30, y: 8 + Math.floor(appState.regions.length / 3) * 24 };
    appState.regions.push(region);
    addMapStamp({ id: uid(), type: 'location', label: title, linkedRegionId: region.id, x: point.x - 42, y: point.y - 42, size: 84, image: '' });
    renderRegions();
  }
  if (activeMapTool === 'quest') {
    const task = { id: uid(), text: title, lane: 'hooks' };
    appState.tasks.hooks.push(task);
    addMapStamp({ id: uid(), type: 'quest', label: title, linkedTaskId: task.id, linkedLane: 'hooks', x: point.x - 42, y: point.y - 42, size: 84, image: '' });
    renderTasks();
  }
  saveState();
}


function captureWaterFillDraftPoint(point, force = false) {
  if (!point || activeMapTool !== 'draw') return;
  const cleanPoint = { x: Math.max(0, Math.min(1600, Number(point.x || 0))), y: Math.max(0, Math.min(1000, Number(point.y || 0))) };
  const last = lastDrawStrokePoints[lastDrawStrokePoints.length - 1];
  if (!force && last && Math.hypot(cleanPoint.x - last.x, cleanPoint.y - last.y) < 7) return;
  lastDrawStrokePoints.push(cleanPoint);
}

function activeMapCanvas() {
  if (currentOverlay === 'map') return $('#overlay-map-canvas') || $('#map-canvas');
  return $('#map-canvas') || $('#overlay-map-canvas');
}

function simplifyWaterFillPoints(points, maxPoints = 140) {
  const clean = (points || [])
    .filter(point => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)))
    .map(point => ({ x: Math.max(0, Math.min(1600, Number(point.x))), y: Math.max(0, Math.min(1000, Number(point.y))) }));
  if (clean.length < 3) return clean;
  const spaced = [];
  clean.forEach(point => {
    const last = spaced[spaced.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= 5) spaced.push(point);
  });
  if (spaced.length > 2 && Math.hypot(spaced[0].x - spaced[spaced.length - 1].x, spaced[0].y - spaced[spaced.length - 1].y) < 18) spaced.pop();
  if (spaced.length <= maxPoints) return spaced;
  const step = Math.ceil(spaced.length / maxPoints);
  const sampled = spaced.filter((_, index) => index % step === 0);
  if (sampled.length < 3) return spaced.slice(0, Math.min(spaced.length, maxPoints));
  return sampled.slice(0, maxPoints);
}

function pointsCoverEnoughArea(points) {
  if (!points || points.length < 3) return false;
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  return Math.max(...xs) - Math.min(...xs) >= 18 && Math.max(...ys) - Math.min(...ys) >= 18;
}

function createCustomWaterAreaFromDrawPoints(points, title = 'Water') {
  const usable = simplifyWaterFillPoints(points);
  if (!pointsCoverEnoughArea(usable)) return null;
  const xs = usable.map(point => point.x);
  const ys = usable.map(point => point.y);
  const pad = 12;
  const rawMinX = Math.max(0, Math.min(...xs) - pad);
  const rawMinY = Math.max(0, Math.min(...ys) - pad);
  const rawMaxX = Math.min(1600, Math.max(...xs) + pad);
  const rawMaxY = Math.min(1000, Math.max(...ys) + pad);
  const rawW = Math.max(1, rawMaxX - rawMinX);
  const rawH = Math.max(1, rawMaxY - rawMinY);
  const w = Math.max(60, rawW);
  const h = Math.max(60, rawH);
  const offsetX = rawW < w ? (w - rawW) / 2 : 0;
  const offsetY = rawH < h ? (h - rawH) / 2 : 0;
  const x = Math.max(0, Math.min(1600 - w, rawMinX - offsetX));
  const y = Math.max(0, Math.min(1000 - h, rawMinY - offsetY));
  return {
    id: uid(),
    type: 'water',
    label: title,
    x,
    y,
    w,
    h,
    customFill: true,
    points: usable.map(point => ({ x: point.x - x, y: point.y - y }))
  };
}

function eraseWaterFillDraftInk(points) {
  if (!points || points.length < 2) return;
  const canvases = $$('#map-canvas, #overlay-map-canvas');
  const width = Math.max(14, Number(appState.map.brushSize || 6) * 3);
  canvases.forEach(canvas => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach(point => ctx.lineTo(point.x, point.y));
    ctx.stroke();
    ctx.restore();
  });
}

function waterFillFromDraw() {
  const area = createCustomWaterAreaFromDrawPoints(lastDrawStrokePoints, 'Water');
  if (!area) {
    showToast('Draw a closed shape with Draw first, then press Water Fill.', 'warn');
    return;
  }
  snapshotMap();
  appState.map.waterAreas = appState.map.waterAreas || [];
  appState.map.waterAreas.push(area);
  selectedWaterAreaId = area.id;
  selectedStampId = '';
  selectedPathId = '';
  pendingWaterPoints = [];
  waterPreviewPoint = null;
  eraseWaterFillDraftInk(lastDrawStrokePoints);
  const canvas = activeMapCanvas();
  if (canvas) saveMapInk(canvas);
  lastDrawStrokePoints = [];
  renderWaterAreas();
  updateMapHud();
  saveState();
  showToast('Water Fill made your drawn shape into custom water.', 'info');
}


function finishWaterArea(options = {}) {
  if (pendingWaterPoints.length < 3) return;
  const title = (options.name || 'Water').trim() || 'Water';
  snapshotMap();
  const xs = pendingWaterPoints.map(point => point.x);
  const ys = pendingWaterPoints.map(point => point.y);
  const minX = Math.max(0, Math.min(...xs));
  const minY = Math.max(0, Math.min(...ys));
  const maxX = Math.min(1600, Math.max(...xs));
  const maxY = Math.min(1000, Math.max(...ys));
  const w = Math.max(60, maxX - minX);
  const h = Math.max(60, maxY - minY);
  const area = {
    id: uid(),
    type: 'water',
    label: title,
    x: minX,
    y: minY,
    w,
    h,
    points: pendingWaterPoints.map(point => ({ x: point.x - minX, y: point.y - minY }))
  };
  appState.map.waterAreas = appState.map.waterAreas || [];
  appState.map.waterAreas.push(area);
  selectedWaterAreaId = area.id;
  selectedStampId = '';
  selectedPathId = '';
  pendingWaterPoints = [];
  waterPreviewPoint = null;
  lastDrawStrokePoints = [];
  lastWaterClosePointerTime = 0;
  renderWaterAreas();
  updateMapHud();
  saveState();
}

function cancelWaterArea() {
  pendingWaterPoints = [];
  waterPreviewPoint = null;
  lastDrawStrokePoints = [];
  waterDrawing = false;
  lastWaterDrawPoint = null;
  waterPointerId = null;
  waterDragStarted = false;
  lastWaterClosePointerTime = 0;
  renderWaterAreas();
  updateMapHud();
}

function finishWaterAreaFromButton() {
  if (pendingWaterPoints.length >= 3) finishWaterArea({ promptForName: false });
}

function appendWaterPoint(point, force = false) {
  const last = pendingWaterPoints[pendingWaterPoints.length - 1];
  if (!force && last && Math.hypot(point.x - last.x, point.y - last.y) < 8) return;
  pendingWaterPoints.push(point);
}

function startWaterDraw(event) {
  if (event.button !== undefined && event.button !== 0) return;
  if (handleWaterCloseBeforePlacement(event)) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  event._mapPlacementHandled = true;
  const point = getCanvasPoint(event, event.currentTarget || $('#map-canvas'));
  if (!pendingWaterPoints.length) pendingWaterPoints = [point];
  else appendWaterPoint(point, true);
  waterPreviewPoint = point;
  waterDrawing = true;
  lastWaterDrawPoint = point;
  waterPointerId = event.pointerId;
  waterDragStarted = false;
  event.currentTarget?.setPointerCapture?.(event.pointerId);
  renderWaterAreas();
  updateMapHud();
}

function isNearWaterStart(point, radius = 56) {
  if (!pendingWaterPoints.length) return false;
  const first = pendingWaterPoints[0];
  return Math.hypot(point.x - first.x, point.y - first.y) <= radius;
}

function tryFinishWaterAreaAtPoint(point, event = {}, force = false) {
  if (activeMapTool !== 'waterarea' || pendingWaterPoints.length < 3) return false;
  const shouldClose = force || Number(event.detail || 0) >= 2 || event.type === 'dblclick' || isNearWaterStart(point, 32);
  if (!shouldClose || !isNearWaterStart(point, 42)) return false;
  event.preventDefault?.();
  event.stopPropagation?.();
  finishWaterArea({ promptForName: false });
  return true;
}

function handleWaterCloseBeforePlacement(event) {
  if (activeMapTool !== 'waterarea' || pendingWaterPoints.length < 3) return false;
  const point = getPlacementPoint(event);
  if (!isNearWaterStart(point, 42)) return false;
  event.preventDefault?.();
  event.stopPropagation?.();
  event._mapPlacementHandled = true;
  finishWaterArea({ promptForName: false });
  return true;
}

function finishWaterAreaFromCloseTarget(event) {
  if (activeMapTool !== 'waterarea' || pendingWaterPoints.length < 3) return false;
  event.preventDefault?.();
  event.stopPropagation?.();
  event._mapPlacementHandled = true;
  finishWaterArea({ promptForName: false });
  return true;
}

function placeWaterAreaPoint(point, event = {}) {
  if (!pendingWaterPoints.length) {
    pendingWaterPoints = [point];
    waterPreviewPoint = point;
    renderWaterAreas();
    return;
  }
  if (tryFinishWaterAreaAtPoint(point, event)) return;
  if (pendingWaterPoints.length >= 3 && isNearWaterStart(point, 64)) {
    waterPreviewPoint = pendingWaterPoints[0];
    renderWaterAreas();
    return;
  }
  pendingWaterPoints.push(point);
  waterPreviewPoint = point;
  renderWaterAreas();
  updateMapHud();
}

function waterAreaPoints(area) {
  const x = Number(area.x || 0);
  const y = Number(area.y || 0);
  const w = Number(area.w || 260);
  const h = Number(area.h || 160);
  const points = Array.isArray(area.points) && area.points.length >= 3
    ? area.points
    : [
        { x: w * .5, y: 0 }, { x: w * .92, y: h * .18 }, { x: w, y: h * .58 },
        { x: w * .68, y: h }, { x: w * .2, y: h * .86 }, { x: 0, y: h * .44 }
      ];
  return points.map(point => ({ x: x + Number(point.x || 0), y: y + Number(point.y || 0) }));
}

function waterClipPath(area) {
  const w = Number(area.w || 260);
  const h = Number(area.h || 160);
  const points = Array.isArray(area.points) && area.points.length >= 3
    ? area.points
    : [
        { x: w * .5, y: 0 }, { x: w * .92, y: h * .18 }, { x: w, y: h * .58 },
        { x: w * .68, y: h }, { x: w * .2, y: h * .86 }, { x: 0, y: h * .44 }
      ];
  return `polygon(${points.map(point => `${(Number(point.x || 0) / w) * 100}% ${(Number(point.y || 0) / h) * 100}%`).join(', ')})`;
}

function deleteWaterArea(id) {
  if (!id) return false;
  snapshotMap();
  appState.map.waterAreas = (appState.map.waterAreas || []).filter(area => area.id !== id);
  if (selectedWaterAreaId === id) selectedWaterAreaId = '';
  renderWaterAreas();
  saveState();
  return true;
}

function renderWaterAreas(root = document) {
  const layers = $$('#map-water-layer, #overlay-map-water-layer', root);
  const waterMarkup = (appState.map.waterAreas || []).map(area => {
    const clipPath = waterClipPath(area);
    return `
      <button class="water-area ${selectedWaterAreaId === area.id ? 'selected-water-area' : ''} ${activeMapTool === 'delete' ? 'delete-ready' : ''}" data-water-area="${area.id}" style="left:${Number(area.x)}px; top:${Number(area.y)}px; width:${Number(area.w || 260)}px; height:${Number(area.h || 160)}px; --water-clip:${clipPath};" title="${activeMapTool === 'delete' ? 'Click to delete water area' : 'Water area. Use Move to drag.'}" aria-label="${escapeHtml(area.label || 'Water area')}">
        <span>${escapeHtml(area.label || 'Water')}</span>
      </button>`;
  }).join('');
  const previewPoints = pendingWaterPoints.length
    ? [...pendingWaterPoints, ...(waterPreviewPoint ? [waterPreviewPoint] : [])]
    : [];
  const previewMarkup = previewPoints.length
    ? `<svg class="water-preview-svg" viewBox="0 0 1600 1000" aria-hidden="true"><polyline points="${previewPoints.map(point => `${point.x},${point.y}`).join(' ')}"/>${pendingWaterPoints.length >= 3 ? `<polygon class="water-preview-fill" points="${previewPoints.map(point => `${point.x},${point.y}`).join(' ')}"/>` : ''}<circle class="water-start-dot" cx="${pendingWaterPoints[0].x}" cy="${pendingWaterPoints[0].y}" r="5"/>${pendingWaterPoints.length >= 3 ? `<circle class="water-close-ring" cx="${pendingWaterPoints[0].x}" cy="${pendingWaterPoints[0].y}" r="20"/><text x="${pendingWaterPoints[0].x + 28}" y="${pendingWaterPoints[0].y - 18}">click start dot to fill</text>` : ''}</svg>${pendingWaterPoints.length >= 3 ? `<button class="water-start-close" type="button" style="left:${pendingWaterPoints[0].x - 28}px; top:${pendingWaterPoints[0].y - 28}px;" title="Click to close and fill water area" aria-label="Click to close and fill water area"><span class="sr-only">Click to close and fill water area</span></button>` : ''}`
    : '';
  layers.forEach(layer => { layer.innerHTML = previewMarkup + waterMarkup; });
  updateMapHud();
}


function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (!dx && !dy) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

function distanceToPath(point, path) {
  const control = pathControlPoint(path);
  let previous = { x: Number(path.x1), y: Number(path.y1) };
  let best = Infinity;
  for (let i = 1; i <= 28; i += 1) {
    const t = i / 28;
    const mt = 1 - t;
    const current = {
      x: (mt * mt * Number(path.x1)) + (2 * mt * t * control.cx) + (t * t * Number(path.x2)),
      y: (mt * mt * Number(path.y1)) + (2 * mt * t * control.cy) + (t * t * Number(path.y2))
    };
    best = Math.min(best, distanceToSegment(point, previous, current));
    previous = current;
  }
  return best;
}

function findPathNearPoint(point, tolerance = 22) {
  let match = null;
  let best = tolerance;
  for (const path of appState.map.paths || []) {
    const distance = distanceToPath(point, path);
    if (distance <= best) {
      best = distance;
      match = path;
    }
  }
  return match;
}

function getPathEndpoint(path, end) {
  return end === 'start'
    ? { x: Number(path.x1), y: Number(path.y1) }
    : { x: Number(path.x2), y: Number(path.y2) };
}

function setPathEndpoint(path, end, point) {
  if (end === 'start') {
    path.x1 = point.x;
    path.y1 = point.y;
  } else {
    path.x2 = point.x;
    path.y2 = point.y;
  }
}

function findPathEndpointNearPoint(point, tolerance = 32) {
  let match = null;
  let best = tolerance;
  for (const path of appState.map.paths || []) {
    for (const end of ['start', 'end']) {
      const pathPoint = getPathEndpoint(path, end);
      const distance = Math.hypot(point.x - pathPoint.x, point.y - pathPoint.y);
      if (distance <= best) {
        best = distance;
        match = { path, end, point: pathPoint };
      }
    }
  }
  return match;
}

function connectPathAtPoint(point) {
  const endpoint = findPathEndpointNearPoint(point, 38);
  if (!endpoint) {
    showToast('Click near the end of a path to choose a connection point.', 'warn');
    return;
  }
  selectedStampId = '';
  selectedPathId = endpoint.path.id;
  if (!pendingPathConnection) {
    pendingPathConnection = { pathId: endpoint.path.id, end: endpoint.end };
    renderMapPaths();
    renderMapStamps();
    return;
  }
  if (pendingPathConnection.pathId === endpoint.path.id && pendingPathConnection.end === endpoint.end) {
    pendingPathConnection = null;
    renderMapPaths();
    renderMapStamps();
    return;
  }
  const firstPath = (appState.map.paths || []).find(path => path.id === pendingPathConnection.pathId);
  if (!firstPath) {
    pendingPathConnection = null;
    renderMapPaths();
    renderMapStamps();
    return;
  }
  const firstPoint = getPathEndpoint(firstPath, pendingPathConnection.end);
  const secondPoint = getPathEndpoint(endpoint.path, endpoint.end);
  const joint = { x: (firstPoint.x + secondPoint.x) / 2, y: (firstPoint.y + secondPoint.y) / 2 };
  snapshotMap();
  setPathEndpoint(firstPath, pendingPathConnection.end, joint);
  setPathEndpoint(endpoint.path, endpoint.end, joint);
  selectedPathId = endpoint.path.id;
  pendingPathConnection = null;
  pendingWaterPoints = [];
  waterPreviewPoint = null;
  lastDrawStrokePoints = [];
  renderMapPaths();
  renderWaterAreas();
  renderMapStamps();
  saveState();
}

function deleteSelectedMapObject() {
  if (!selectedStampId && !selectedPathId && !selectedWaterAreaId) return false;
  snapshotMap();
  if (selectedStampId) {
    appState.map.stamps = appState.map.stamps.filter(stamp => stamp.id !== selectedStampId);
    selectedStampId = '';
  }
  if (selectedPathId) {
    appState.map.paths = (appState.map.paths || []).filter(path => path.id !== selectedPathId);
    selectedPathId = '';
  }
  if (selectedWaterAreaId) {
    appState.map.waterAreas = (appState.map.waterAreas || []).filter(area => area.id !== selectedWaterAreaId);
    selectedWaterAreaId = '';
  }
  pendingPathPoint = null;
  pathPreviewPoint = null;
  pendingPathConnection = null;
  pendingWaterPoints = [];
  waterPreviewPoint = null;
  lastDrawStrokePoints = [];
  renderMapPaths();
  renderWaterAreas();
  renderMapStamps();
  saveState();
  return true;
}

function handlePathCanvasClick(event) {
  const point = getPlacementPoint(event);
  const path = findPathNearPoint(point, activeMapTool === 'delete' || event.altKey ? 28 : 18);
  if (!path) return false;
  event.preventDefault();
  event.stopPropagation();
  selectedStampId = '';
  selectedPathId = path.id;
  if (activeMapTool === 'delete' || event.altKey) {
    deleteSelectedMapObject();
  } else {
    renderMapPaths();
    renderMapStamps();
  }
  return true;
}

function placePathPoint(point) {
  if (!pendingPathPoint) {
    pendingPathPoint = point;
    pathPreviewPoint = point;
    renderMapPaths();
    return;
  }
  snapshotMap();
  selectedPathId = '';
  const x1 = pendingPathPoint.x;
  const y1 = pendingPathPoint.y;
  const x2 = point.x;
  const y2 = point.y;
  appState.map.paths.push({ id: uid(), type: appState.map.pathStyle || 'path', label: pathStyleLabel(appState.map.pathStyle), x1, y1, x2, y2, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 });
  pendingPathPoint = null;
  pathPreviewPoint = null;
  pendingPathConnection = null;
  pendingWaterPoints = [];
  waterPreviewPoint = null;
  lastDrawStrokePoints = [];
  renderMapPaths();
  renderWaterAreas();
  renderMapStamps();
  saveState();
}

function addImageStamp(src) {
  snapshotMap();
  appState.map.stamps.push({ id: uid(), type: 'image', label: 'Image', x: 120, y: 120, size: 132, image: src });
  renderMapStamps();
  saveState();
}

function setMapBackground(src) {
  snapshotMap();
  appState.map.background = src;
  syncMapBackground();
  saveState();
}

function clearMapBackground() {
  if (!appState.map.background) return;
  snapshotMap();
  appState.map.background = '';
  syncMapBackground();
  saveState();
}

function getStampContent(stamp) {
  if (stamp.image) return `<img src="${stamp.image}" alt="">`;
  if (stamp.type === 'label') return `<em class="map-label-text">${escapeHtml(stamp.label || 'Label')}</em>`;
  if (stamp.type === 'location') return `<span>⌖</span><em>${escapeHtml(stamp.label || 'Location')}</em>`;
  if (stamp.type === 'quest') return `<span>!</span><em>${escapeHtml(stamp.label || 'Quest')}</em>`;
  const symbol = getSymbolData(stamp.type);
  return `<span>${escapeHtml(symbol.mark)}</span><em>${escapeHtml(stamp.label || symbol.label)}</em>`;
}

function pathControlPoint(path) {
  return { cx: Number(path.cx ?? ((path.x1 + path.x2) / 2)), cy: Number(path.cy ?? ((path.y1 + path.y2) / 2)) };
}

function pathPathD(path) {
  const { cx, cy } = pathControlPoint(path);
  return `M ${Number(path.x1)} ${Number(path.y1)} Q ${cx} ${cy} ${Number(path.x2)} ${Number(path.y2)}`;
}

function pathMidPoint(path) {
  const { cx, cy } = pathControlPoint(path);
  return {
    x: 0.25 * Number(path.x1) + 0.5 * cx + 0.25 * Number(path.x2),
    y: 0.25 * Number(path.y1) + 0.5 * cy + 0.25 * Number(path.y2)
  };
}

function renderMapPaths(root = document) {
  const layers = $$('#map-path-layer, #overlay-map-path-layer', root);
  const pathMarkup = (appState.map.paths || []).map(path => {
    const mid = pathMidPoint(path);
    const selectedClass = selectedPathId === path.id ? ' selected-path' : '';
    return `<g data-map-path="${path.id}" class="map-path-item path-${escapeHtml(path.type || 'path')}${selectedClass}"><path d="${pathPathD(path)}"/><text x="${mid.x}" y="${mid.y - 8}">${escapeHtml(path.label || pathStyleLabel(path.type))}</text></g>`;
  }).join('');
  const previewMarkup = pendingPathPoint && pathPreviewPoint
    ? `<g class="path-preview"><path d="M ${pendingPathPoint.x} ${pendingPathPoint.y} Q ${(pendingPathPoint.x + pathPreviewPoint.x) / 2} ${(pendingPathPoint.y + pathPreviewPoint.y) / 2} ${pathPreviewPoint.x} ${pathPreviewPoint.y}"/></g>`
    : '';
  layers.forEach(layer => { layer.innerHTML = pathMarkup + previewMarkup; });
}

function renderMapStamps(root = document) {
  const layers = $$('#map-stamp-layer, #overlay-board .stamp-layer', root);
  if (!layers.length) return;
  const stampMarkup = appState.map.stamps.map(stamp => `
      <button class="map-stamp ${stamp.image ? 'image-stamp' : ''} ${stamp.type === 'label' ? 'label-stamp' : ''} ${stamp.type === 'location' ? 'location-stamp' : ''} ${stamp.type === 'quest' ? 'quest-stamp' : ''} ${activeMapTool === 'delete' ? 'delete-ready' : ''} ${selectedStampId === stamp.id ? 'selected' : ''}" data-map-stamp="${stamp.id}" tabindex="0" style="left:${stamp.x}px; top:${stamp.y}px; width:${stamp.size}px; height:${stamp.type === 'label' ? 42 : stamp.size}px;" aria-label="${escapeHtml(stamp.label || 'Map stamp')}" title="${activeMapTool === 'delete' ? 'Click to delete' : 'Click for details. Switch to Move to drag.'}">
        ${getStampContent(stamp)}
      </button>
    `).join('');
  const handleMarkup = (appState.map.paths || []).map(path => {
    const { cx, cy } = pathControlPoint(path);
    return `<button class="path-curve-handle ${activeMapTool === 'move' || selectedPathId === path.id ? 'show-handle' : ''} ${selectedPathId === path.id ? 'selected-path-handle' : ''}" data-path-handle="${path.id}" style="left:${cx - 13}px; top:${cy - 13}px;" title="Drag to curve this path" aria-label="Curve path"></button>`;
  }).join('');
  const endpointMarkup = activeMapTool === 'connectpaths'
    ? (appState.map.paths || []).flatMap(path => ['start', 'end'].map(end => {
        const pathPoint = getPathEndpoint(path, end);
        const isPending = pendingPathConnection && pendingPathConnection.pathId === path.id && pendingPathConnection.end === end;
        return `<button class="path-endpoint-handle ${isPending ? 'selected-path-endpoint' : ''}" data-path-endpoint="${path.id}:${end}" style="left:${pathPoint.x - 11}px; top:${pathPoint.y - 11}px;" title="Click two path ends to connect them" aria-label="Path endpoint"></button>`;
      })).join('')
    : '';
  layers.forEach(layer => { layer.innerHTML = stampMarkup + handleMarkup + endpointMarkup; });
}

function resizeMapCanvasView() {
  redrawMapInk();
  renderMapGrid();
  renderMapPaths();
  renderWaterAreas();
  renderMapStamps();
  applyLayerVisibility();
  updateMapHud();
}

function hydrateMapView() {
  if (!mapHydrated) {
    mapHydrated = true;
    syncMapBackground();
    redrawMapInk();
  }
  renderMapPaths();
  renderWaterAreas();
  renderMapStamps();
  applyLayerVisibility();
  updateMapHud();
}

async function clearMapInk() {
  if (!await appConfirm('Clear map ink? Stamps, paths, water, and pins stay.', 'Clear Ink')) return;
  snapshotMap();
  appState.map.ink = '';
  $$('#map-canvas, #overlay-map-canvas').forEach(canvas => canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height));
  saveState();
}

function addQuickEntry() {
  const kind = $('#quick-kind').value;
  const text = $('#quick-entry').value.trim();
  if (!text) return;
  appState.tables[kind].push({ id: uid(), text, enabled: true });
  $('#quick-entry').value = '';
  renderQuickTable();
  saveState();
}

function renderQuickTable() {
  const kind = $('#quick-kind').value;
  $('#quick-list').innerHTML = appState.tables[kind].map(item => `
    <div class="bank-row">
      <div>${escapeHtml(item.text)}</div>
      <div class="bank-actions">
        <button data-toggle-table="${item.id}" aria-label="${item.enabled === false ? 'Enable' : 'Disable'} table entry">${item.enabled === false ? 'Off' : 'On'}</button>
        <button data-delete-table="${item.id}" aria-label="Delete table entry">Delete</button>
      </div>
    </div>
  `).join('');
}

function rollQuickEntry() {
  const kind = $('#quick-kind').value;
  const enabled = appState.tables[kind].filter(item => item.enabled !== false);
  $('#quick-output').textContent = enabled.length ? pick(enabled).text : 'No active entries.';
}

function addEncounter() {
  const encounter = {
    id: uid(),
    title: $('#encounter-title').value.trim() || 'Untitled Encounter',
    scenario: $('#encounter-scenario').value.trim(),
    complication: $('#encounter-complication').value.trim(),
    reward: $('#encounter-reward').value.trim(),
    enabled: $('#encounter-enabled').checked
  };
  appState.encounters.push(encounter);
  $('#encounter-form').reset();
  $('#encounter-enabled').checked = true;
  renderEncounters();
  saveState();
}

function renderEncounters() {
  $('#encounter-list').innerHTML = appState.encounters.map(encounter => `
    <div class="bank-row">
      <strong>${escapeHtml(encounter.title)}</strong>
      <div>${escapeHtml(encounter.scenario)}</div>
      ${encounter.complication ? `<div><span class="pill">Complication</span> ${escapeHtml(encounter.complication)}</div>` : ''}
      ${encounter.reward ? `<div><span class="pill">Reward</span> ${escapeHtml(encounter.reward)}</div>` : ''}
      <div class="bank-actions">
        <button data-toggle-encounter="${encounter.id}" aria-label="${encounter.enabled === false ? 'Enable' : 'Disable'} ${escapeHtml(encounter.title)}">${encounter.enabled === false ? 'Off' : 'On'}</button>
        <button data-delete-encounter="${encounter.id}" aria-label="Delete ${escapeHtml(encounter.title)}">Delete</button>
      </div>
    </div>
  `).join('');
}

function rollEncounter() {
  const enabled = appState.encounters.filter(item => item.enabled !== false);
  if (!enabled.length) {
    $('#encounter-output').textContent = 'No active encounters.';
    return;
  }
  const item = pick(enabled);
  $('#encounter-output').innerHTML = `
    <h3>${escapeHtml(item.title)}</h3>
    <p>${escapeHtml(item.scenario)}</p>
    ${item.complication ? `<p><strong>Complication:</strong> ${escapeHtml(item.complication)}</p>` : ''}
    ${item.reward ? `<p><strong>Reward / clue:</strong> ${escapeHtml(item.reward)}</p>` : ''}
  `;
}

function addCharacter() {
  const character = {
    id: uid(),
    name: $('#character-name').value.trim() || 'Unnamed Character',
    role: $('#character-role').value.trim(),
    bio: $('#character-bio').value.trim(),
    notes: $('#character-notes').value.trim(),
    image: characterImageDraft
  };
  appState.characters.push(character);
  characterImageDraft = '';
  $('#character-form').reset();
  renderCharacters();
  saveState();
}

function renderCharacters() {
  $('#character-list').innerHTML = appState.characters.map(character => `
    <article class="card character-card">
      ${character.image ? `<img class="character-img" src="${character.image}" alt="">` : ''}
      <h3>${escapeHtml(character.name)}</h3>
      ${character.role ? `<div class="meta">${escapeHtml(character.role)}</div>` : ''}
      ${character.bio ? `<p>${escapeHtml(character.bio)}</p>` : ''}
      ${character.notes ? `<p><strong>Notes:</strong> ${escapeHtml(character.notes)}</p>` : ''}
      <button data-delete-character="${character.id}" aria-label="Delete ${escapeHtml(character.name)}">Delete</button>
    </article>
  `).join('');
}


function showLinkedScenes(tag) {
  const matches = Object.entries(appState.tasks).flatMap(([lane, tasks]) => tasks
    .filter(task => parseTags(task.text).includes(tag))
    .map(task => ({ ...task, lane })));
  const box = $('#linked-scenes-box');
  box.hidden = false;
  box.innerHTML = `<strong>${escapeHtml(tag)} scenes</strong>` + (matches.length
    ? matches.map(task => `<div class="bank-row linked-highlight"><span class="pill">${escapeHtml(task.lane)}</span> ${escapeHtml(task.text)}</div>`).join('')
    : `<div class="bank-row">No scene beats use this tag yet.</div>`);
  showView('session');
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function addTask() {
  const lane = $('#beat-lane').value || 'scenes';
  const text = $('#beat-text').value.trim();
  if (!text) return;
  if (!appState.tasks[lane]) appState.tasks[lane] = [];
  appState.tasks[lane].push({ id: uid(), text });
  $('#beat-text').value = '';
  renderTasks();
  saveState();
}

function renderTasks() {
  $$('.kanban').forEach(lane => {
    const name = lane.dataset.lane;
    lane.innerHTML = appState.tasks[name].map(task => `<button type="button" class="kanban-card" data-task="${task.id}" data-lane="${name}" aria-label="Remove beat: ${escapeHtml(task.text)}">${escapeHtml(task.text)}</button>`).join('');
  });
}

function bindDrag() {
  document.addEventListener('pointerdown', event => {
    const waterCloseTarget = event.target.closest('.water-start-close');
    if (waterCloseTarget && activeMapTool === 'waterarea') {
      finishWaterAreaFromCloseTarget(event);
      return;
    }
    const endpointTarget = event.target.closest('.path-endpoint-handle');
    if (endpointTarget && activeMapTool === 'connectpaths') {
      event.preventDefault();
      const [pathId, end] = endpointTarget.dataset.pathEndpoint.split(':');
      const path = (appState.map.paths || []).find(item => item.id === pathId);
      if (path) connectPathAtPoint(getPathEndpoint(path, end));
      return;
    }
    const handleTarget = event.target.closest('.path-curve-handle');
    const stampTarget = event.target.closest('.map-stamp');
    const waterTarget = event.target.closest('.water-area');
    const regionTarget = event.target.closest('.region-pin');
    if (handleTarget && (activeMapTool === 'delete' || event.altKey)) {
      event.preventDefault();
      selectedStampId = '';
      selectedWaterAreaId = '';
      selectedPathId = handleTarget.dataset.pathHandle;
      deleteSelectedMapObject();
      return;
    }
    if (waterTarget && (activeMapTool === 'delete' || event.altKey)) {
      event.preventDefault();
      selectedStampId = '';
      selectedPathId = '';
      selectedWaterAreaId = waterTarget.dataset.waterArea;
      deleteSelectedMapObject();
      return;
    }
    const target = handleTarget || stampTarget || waterTarget || regionTarget;
    if (!target || (event.target.tagName === 'BUTTON' && !stampTarget && !handleTarget && !waterTarget)) return;
    if ((stampTarget || waterTarget) && activeMapTool === 'delete') return;
    const isHandle = Boolean(handleTarget);
    const isStamp = Boolean(stampTarget);
    const isWater = Boolean(waterTarget);
    const item = isHandle
      ? appState.map.paths.find(path => path.id === target.dataset.pathHandle)
      : isStamp
        ? appState.map.stamps.find(stamp => stamp.id === target.dataset.mapStamp)
        : isWater
          ? (appState.map.waterAreas || []).find(area => area.id === target.dataset.waterArea)
          : appState.regions.find(region => region.id === target.dataset.pin);
    if (!item) return;
    event.preventDefault();
    const board = target.closest('.map-maker-board,.map-board');
    const targetRect = target.getBoundingClientRect();
    const offsetX = event.clientX - targetRect.left;
    const offsetY = event.clientY - targetRect.top;
    snapshotMap();
    selectedStampId = isStamp ? item.id : '';
    selectedPathId = isHandle ? item.id : '';
    selectedWaterAreaId = isWater ? item.id : '';
    const liveTarget = target;
    if (isStamp) {
      $$('.map-stamp.selected').forEach(node => node.classList.remove('selected'));
      liveTarget.classList.add('selected');
    }
    if (isWater) {
      $$('.water-area.selected-water-area').forEach(node => node.classList.remove('selected-water-area'));
      liveTarget.classList.add('selected-water-area');
    }
    liveTarget.classList.add('dragging');

    const move = moveEvent => {
      const boardRect = board.getBoundingClientRect();
      const rawX = moveEvent.clientX - boardRect.left - offsetX;
      const rawY = moveEvent.clientY - boardRect.top - offsetY;
      const scaleX = 1600 / boardRect.width;
      const scaleY = 1000 / boardRect.height;
      if (isHandle) {
        item.cx = Math.max(0, Math.min(1600, (rawX + 13) * scaleX));
        item.cy = Math.max(0, Math.min(1000, (rawY + 13) * scaleY));
        liveTarget.style.left = `${item.cx - 13}px`;
        liveTarget.style.top = `${item.cy - 13}px`;
        renderMapPaths();
      } else if (isStamp) {
        item.x = Math.max(0, Math.min(1600 - item.size, rawX * scaleX));
        item.y = Math.max(0, Math.min(1000 - item.size, rawY * scaleY));
        liveTarget.style.left = `${item.x}px`;
        liveTarget.style.top = `${item.y}px`;
      } else if (isWater) {
        item.x = Math.max(0, Math.min(1600 - (item.w || 260), rawX * scaleX));
        item.y = Math.max(0, Math.min(1000 - (item.h || 160), rawY * scaleY));
        liveTarget.style.left = `${item.x}px`;
        liveTarget.style.top = `${item.y}px`;
      } else {
        const nextX = Math.max(0, Math.min(86, (rawX / board.clientWidth) * 100));
        const nextY = Math.max(0, Math.min(86, (rawY / board.clientHeight) * 100));
        item.x = nextX;
        item.y = nextY;
        liveTarget.style.left = `${item.x}%`;
        liveTarget.style.top = `${item.y}%`;
      }
    };

    const end = () => {
      liveTarget.classList.remove('dragging');
      renderMapPaths();
      renderWaterAreas();
      renderMapStamps();
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', end);
      saveState();
    };

    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
  });
}

function loadImage(src) {
  return new Promise(resolve => {
    if (!src) return resolve(null);
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

async function exportWorldPng() {
  const nodes = appState.regions;
  if (!nodes.length) return;
  const scale = 2;
  const maxX = 1200;
  const maxY = 800;
  const canvas = document.createElement('canvas');
  canvas.width = maxX * scale;
  canvas.height = maxY * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--paper') || '#fff';
  ctx.fillRect(0, 0, maxX, maxY);
  ctx.strokeStyle = '#d0d0d0';
  for (let x = 0; x < maxX; x += 28) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, maxY); ctx.stroke(); }
  for (let y = 0; y < maxY; y += 28) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(maxX, y); ctx.stroke(); }

  for (const node of nodes) {
    const x = (node.x / 100) * maxX;
    const y = (node.y / 100) * maxY;
    const w = 176;
    const h = node.image ? 160 : 96;
    ctx.fillStyle = '#000';
    ctx.fillRect(x + 7, y + 7, w, h);
    ctx.fillStyle = '#fff';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.strokeRect(x, y, w, h);
    const image = await loadImage(node.image);
    if (image) {
      ctx.drawImage(image, x + 10, y + 10, w - 20, 64);
      ctx.strokeRect(x + 10, y + 10, w - 20, 64);
    }
    ctx.fillStyle = '#000';
    ctx.font = '900 16px system-ui';
    ctx.fillText(node.name || 'Untitled', x + 12, y + (image ? 98 : 28), w - 24);
    ctx.font = '800 12px system-ui';
    ctx.fillText(node.type || '', x + 12, y + (image ? 120 : 50), w - 24);
  }
  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/png');
  link.download = `${safeFilename(appState.campaignName, 'dm-drawing-board')}-world.png`;
  link.click();
}

function drawExportGrid(ctx, width, height) {
  const type = appState.map.gridType || 'none';
  const size = Number(appState.map.gridSize || 40);
  if (type === 'none') return;
  ctx.save();
  ctx.strokeStyle = '#bdbdbd';
  ctx.lineWidth = 1;
  if (type === 'square') {
    for (let x = 0; x < width; x += size) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    for (let y = 0; y < height; y += size) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
  } else {
    const h = Math.sqrt(3) * size / 2;
    for (let y = 0; y < height + h; y += h) {
      for (let x = 0; x < width + size; x += size * 1.5) {
        const ox = x + ((Math.round(y / h) % 2) ? size * .75 : 0);
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 3 * i;
          const px = ox + Math.cos(a) * size / 2;
          const py = y + Math.sin(a) * size / 2;
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.closePath(); ctx.stroke();
      }
    }
  }
  ctx.restore();
}

function drawExportWaterAreas(ctx) {
  ctx.save();
  for (const area of appState.map.waterAreas || []) {
    const points = waterAreaPoints(area);
    if (points.length < 3) continue;
    ctx.fillStyle = '#79c7ff';
    ctx.strokeStyle = '#161616';
    ctx.lineWidth = 5;
    ctx.beginPath();
    points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.clip();
    ctx.setLineDash([12, 10]);
    ctx.lineWidth = 3;
    ctx.beginPath();
    points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
    const x = Number(area.x || 0);
    const y = Number(area.y || 0);
    const w = Number(area.w || 260);
    const h = Number(area.h || 160);
    ctx.fillStyle = '#161616';
    ctx.font = '900 15px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(area.label || 'Water', x + w / 2, y + h / 2 + 5);
  }
  ctx.restore();
}

function applyPathCanvasStyle(ctx, type = 'path') {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = type === 'river' ? '#2778a8' : '#000';
  ctx.lineWidth = type === 'border' ? 7 : type === 'trail' || type === 'secret' ? 6 : type === 'river' ? 11 : 9;
  ctx.setLineDash(type === 'path' ? [22, 14] : type === 'trail' ? [6, 14] : type === 'border' ? [18, 8, 4, 8] : type === 'secret' ? [3, 16] : []);
}

function drawExportPaths(ctx) {
  ctx.save();
  for (const path of appState.map.paths || []) {
    const { cx, cy } = pathControlPoint(path);
    applyPathCanvasStyle(ctx, path.type || 'path');
    ctx.beginPath();
    ctx.moveTo(path.x1, path.y1);
    ctx.quadraticCurveTo(cx, cy, path.x2, path.y2);
    ctx.stroke();
  }
  ctx.restore();
}

async function exportMapPng() {
  const source = $('#map-canvas');
  const exportScale = Math.max(1, Math.min(4, Number(appState.map.exportScale || 2)));
  const canvas = document.createElement('canvas');
  canvas.width = source.width * exportScale;
  canvas.height = source.height * exportScale;
  const ctx = canvas.getContext('2d');
  ctx.scale(exportScale, exportScale);
  const layers = appState.map.layers || {};
  if (!appState.map.exportTransparent) {
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--paper') || '#fff';
    ctx.fillRect(0, 0, source.width, source.height);
  }
  const background = await loadImage(appState.map.background);
  if (background && layers.background !== false) ctx.drawImage(background, 0, 0, source.width, source.height);
  if (layers.grid !== false) drawExportGrid(ctx, source.width, source.height);
  if (layers.ink !== false) ctx.drawImage(source, 0, 0);
  if (layers.water !== false) drawExportWaterAreas(ctx);
  if (layers.paths !== false) drawExportPaths(ctx);
  if (layers.stamps !== false) for (const stamp of appState.map.stamps) {
    ctx.fillStyle = '#000';
    ctx.fillRect(stamp.x + 7, stamp.y + 7, stamp.size, stamp.size);
    ctx.fillStyle = '#fff';
    ctx.fillRect(stamp.x, stamp.y, stamp.size, stamp.size);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.strokeRect(stamp.x, stamp.y, stamp.size, stamp.size);
    if (stamp.image) {
      const image = await loadImage(stamp.image);
      if (image) ctx.drawImage(image, stamp.x + 6, stamp.y + 6, stamp.size - 12, stamp.size - 12);
    } else {
      ctx.fillStyle = '#000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (stamp.type === 'label') { ctx.font = '900 22px system-ui'; ctx.fillText(stamp.label || 'Label', stamp.x + stamp.size / 2, stamp.y + 21); }
      else { const symbol = stamp.type === 'location' ? { mark: '⌖', label: 'Location' } : stamp.type === 'quest' ? { mark: '!', label: 'Quest' } : getSymbolData(stamp.type); ctx.font = `900 ${Math.floor(stamp.size * 0.52)}px system-ui`; ctx.fillText(symbol.mark, stamp.x + stamp.size / 2, stamp.y + stamp.size / 2 - 5); ctx.font = '900 11px system-ui'; ctx.fillText(stamp.label || symbol.label, stamp.x + stamp.size / 2, stamp.y + stamp.size - 12); }
    }
  }
  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/png');
  link.download = `${safeFilename(appState.campaignName, 'dm-drawing-board')}-map-${exportScale}x.png`;
  link.click();
}

function openOverlay(kind) {
  overlayReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  currentOverlay = kind;
  $('#overlay-title').textContent = kind === 'map' ? 'Map Maker Overlay' : 'Campaign Board Overlay';
  if (kind === 'map') {
    $('#overlay-board').innerHTML = `
      <div class="overlay-map-shell"><aside class="overlay-map-tools" aria-label="Map overlay tools">
        <div class="overlay-tool-strip" role="group" aria-label="Map tools">
          <button class="map-tool-btn overlay-tool" data-map-tool="draw" type="button">Draw</button>
          <button id="overlay-water-fill-btn" class="map-action-btn water-fill-action" type="button" aria-label="Water Fill: convert the shape drawn with Draw into a custom water element">Water Fill</button>
          <button class="map-tool-btn overlay-tool" data-map-tool="erase" type="button">Erase</button>
          <button class="map-tool-btn overlay-tool" data-map-tool="symbol" type="button">Symbol</button>
          <button class="map-tool-btn overlay-tool" data-map-tool="label" type="button">Label</button>
          <button class="map-tool-btn overlay-tool" data-map-tool="location" type="button">Location Pin</button>
          <button class="map-tool-btn overlay-tool" data-map-tool="quest" type="button">Quest Pin</button>
          <button class="map-tool-btn overlay-tool" data-map-tool="waterarea" type="button">Water Area</button>
          <button class="map-tool-btn overlay-tool" data-map-tool="pathline" type="button">Path Line</button>
          <button class="map-tool-btn overlay-tool" data-map-tool="connectpaths" type="button">Connect Paths</button>
          <button class="map-tool-btn overlay-tool" data-map-tool="move" type="button">Move</button>
          <button class="map-tool-btn overlay-tool" data-map-tool="delete" type="button">Delete</button>
          <button id="overlay-undo-btn" type="button">Undo</button>
          <button id="overlay-clear-map-btn" type="button">Clear Ink</button>
        </div>
        <div class="overlay-tool-strip overlay-map-adjustments">
          <label for="overlay-brush-color">Ink</label>
          <input id="overlay-brush-color" type="color" value="#000000">
          <label for="overlay-brush-size">Size <output id="overlay-brush-size-output">6</output></label>
          <input id="overlay-brush-size" class="chunky-range" type="range" min="2" max="48" value="6">
          <label for="overlay-brush-style">Brush Feel</label>
          <select id="overlay-brush-style"><option value="marker">Marker</option><option value="pixel">Pixel Pencil</option><option value="dungeon">Dungeon Ink</option><option value="highlighter">Highlighter</option></select>
          <label for="overlay-path-style">Path Style</label>
          <select id="overlay-path-style"><option value="path">Path</option><option value="trail">Trail</option><option value="river">River</option><option value="border">Border</option><option value="secret">Secret Route</option></select>
          <label for="overlay-grid-type">Grid</label>
          <select id="overlay-grid-type"><option value="none">None</option><option value="square">Square</option><option value="hex">Hex</option></select>
          <label for="overlay-grid-size">Grid Size <output id="overlay-grid-size-output">40</output></label>
          <input id="overlay-grid-size" class="chunky-range" type="range" min="20" max="120" value="40">
          <label for="overlay-map-export-scale">Export Scale</label>
          <select id="overlay-map-export-scale"><option value="1">1x</option><option value="2">2x</option><option value="4">4x</option></select>
          <label class="mini-check"><input id="overlay-export-transparent" type="checkbox"><span>Transparent export</span></label>
          <label for="overlay-symbol-kind">Symbol</label>
          <select id="overlay-symbol-kind" aria-label="Map overlay symbol">
            <option value="mountain">Mountain</option><option value="water">Water</option><option value="forest">Forest</option><option value="city">City</option><option value="dungeon">Dungeon</option><option value="path">Path</option><option value="ruin">Ruin</option><option value="camp">Camp</option>
          </select>
        </div>
        <div class="symbol-palette overlay-symbol-palette" aria-label="Map overlay symbol buttons">
          <button type="button" data-symbol-pick="mountain">▲<span>Mountain</span></button>
          <button type="button" data-symbol-pick="water">≈<span>Water</span></button>
          <button type="button" data-symbol-pick="forest">♣<span>Forest</span></button>
          <button type="button" data-symbol-pick="city">■<span>City</span></button>
          <button type="button" data-symbol-pick="dungeon">▣<span>Dungeon</span></button>
          <button type="button" data-symbol-pick="path">━<span>Path</span></button>
          <button type="button" data-symbol-pick="ruin">✕<span>Ruin</span></button>
          <button type="button" data-symbol-pick="camp">⌂<span>Camp</span></button>
        </div>
        <div class="overlay-tool-strip">
          <label class="file-upload-btn overlay-file-btn" for="overlay-map-image-input">Upload Stamp</label>
          <input id="overlay-map-image-input" class="hidden-file" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
          <label class="file-upload-btn overlay-file-btn" for="overlay-map-bg-input">Set Map Background</label>
          <input id="overlay-map-bg-input" class="hidden-file" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
          <button id="overlay-clear-map-bg-btn" type="button">Clear Background</button>
          <button id="overlay-finish-water-area-btn" type="button">Finish Water Area</button>
          <button id="overlay-cancel-water-area-btn" type="button">Cancel Water Area</button>
          <span class="hint"><strong>Shortcuts:</strong> Ctrl/Cmd+Z undo. V move. B draw. E erase. S symbol. Del deletes selected stamp/path. Delete tool or Alt-click removes a placement. Path Line uses two clicks; Connect Paths snaps two path ends together; Move shows curve handles.</span>
        </div>
      </aside>
      <section class="overlay-map-stage"><div class="map-stage-scroll"><div class="map-maker-board overlay-map-maker" role="region" tabindex="0" aria-label="Map overlay board" aria-describedby="map-a11y-help">
        <img id="overlay-map-bg-image" class="map-bg-image" alt="">
        <div id="overlay-map-grid-layer" class="map-grid-layer"></div>
        <div id="overlay-map-water-layer" class="map-water-layer"></div>
        <svg id="overlay-map-path-layer" class="map-path-layer" viewBox="0 0 1600 1000" aria-hidden="true"></svg>
        <canvas id="overlay-map-canvas" width="1600" height="1000" aria-hidden="true"></canvas>
        <div class="stamp-layer"></div>
        <div id="overlay-map-hud" class="map-hud" aria-live="polite"></div>
      </div></div></section></div>`;
    const overlayCanvas = $('#overlay-map-canvas');
    $('#overlay-symbol-kind').value = $('#symbol-kind').value;
    overlayCanvas.addEventListener('pointerdown', startDraw);
    overlayCanvas.addEventListener('pointermove', moveDraw);
    overlayCanvas.addEventListener('pointerup', endDraw);
    overlayCanvas.addEventListener('pointercancel', endDraw);
    $('#overlay-board .map-maker-board').addEventListener('pointerdown', event => {
      if (handleWaterCloseBeforePlacement(event)) return;
    if (['label','location','quest','waterarea'].includes(activeMapTool) && !event.target.closest('.map-stamp,.path-curve-handle,.water-area')) handleMapObjectPlacement(event);
    });
    $('#overlay-board .map-maker-board').addEventListener('dblclick', event => {
      if (activeMapTool !== 'waterarea' || pendingWaterPoints.length < 3) return;
      tryFinishWaterAreaAtPoint(getPlacementPoint(event), event);
    });
    $$('.overlay-tool', $('#overlay-board')).forEach(button => button.addEventListener('click', () => setMapTool(button.dataset.mapTool)));
    $$('.overlay-symbol-palette [data-symbol-pick]').forEach(button => button.addEventListener('click', () => { $('#overlay-symbol-kind').value = button.dataset.symbolPick; $('#symbol-kind').value = button.dataset.symbolPick; setMapTool('symbol'); }));
    $('#overlay-symbol-kind').addEventListener('change', event => { $('#symbol-kind').value = event.target.value; setMapTool('symbol'); });
    $('#overlay-brush-color').addEventListener('input', event => { appState.map.brushColor = event.target.value; syncMapControlUi(); saveState(); });
    $('#overlay-brush-size').addEventListener('input', event => { appState.map.brushSize = Number(event.target.value); syncMapControlUi(); saveState(); });
    $('#overlay-brush-style').addEventListener('change', event => { appState.map.brushStyle = event.target.value; syncMapControlUi(); updateMapHud(); saveState(); });
    $('#overlay-path-style').addEventListener('change', event => { appState.map.pathStyle = event.target.value; syncMapControlUi(); updateMapHud(); saveState(); });
    $('#overlay-map-export-scale').addEventListener('change', event => { appState.map.exportScale = Number(event.target.value); syncMapControlUi(); saveState(); });
    $('#overlay-export-transparent').addEventListener('change', event => { appState.map.exportTransparent = event.target.checked; syncMapControlUi(); saveState(); });
    $('#overlay-grid-type').addEventListener('change', event => { appState.map.gridType = event.target.value; renderMapGrid(); syncMapControlUi(); saveState(); });
    $('#overlay-grid-size').addEventListener('input', event => { appState.map.gridSize = Number(event.target.value); renderMapGrid(); syncMapControlUi(); saveState(); });
    $('#overlay-map-image-input').addEventListener('change', event => readImageFile(event.target, data => addImageStamp(data), 900));
    $('#overlay-map-bg-input').addEventListener('change', event => readImageFile(event.target, data => setMapBackground(data), 1600));
    $('#overlay-clear-map-bg-btn').addEventListener('click', clearMapBackground);
    $('#overlay-water-fill-btn').addEventListener('click', waterFillFromDraw);
    $('#overlay-finish-water-area-btn').addEventListener('click', finishWaterAreaFromButton);
    $('#overlay-cancel-water-area-btn').addEventListener('click', cancelWaterArea);
    $('#overlay-undo-btn').addEventListener('click', undoMap);
    $('#overlay-clear-map-btn').addEventListener('click', clearMapInk);
    syncMapBackground();
    redrawMapInk();
    renderMapStamps();
    renderWaterAreas();
    renderMapPaths();
    renderMapGrid();
    setMapTool(activeMapTool, false);
  } else {
    $('#overlay-board').innerHTML = `
      <div class="overlay-world-shell">
        <aside class="overlay-world-tools" aria-label="Campaign overlay tools">
          <form class="overlay-tool-strip overlay-world-form" id="overlay-region-form">
            <h3>Add Campaign Entry</h3>
            <label for="overlay-region-name">Entry name</label>
            <input id="overlay-region-name" type="text" placeholder="Ashen Marches">
            <label for="overlay-region-type">Entry type</label>
            <select id="overlay-region-type">
              <option>Location</option><option>City</option><option>Dungeon</option><option>Wilderness</option><option>Faction</option><option>NPC Group</option><option>Quest</option>
            </select>
            <label for="overlay-region-tone">Tags</label>
            <input id="overlay-region-tone" type="text" placeholder="#haunted #coastal #court">
            <label for="overlay-region-scenes">Linked scenes</label>
            <input id="overlay-region-scenes" type="text" placeholder="#arrival #bossfight">
            <p class="hint info-note">Use matching hashtags in scenes. Click a tag on an entry to jump to matching scene beats.</p>
            <label for="overlay-region-secrets">Details</label>
            <textarea id="overlay-region-secrets" placeholder="Secrets, factions, hooks, details."></textarea>
            <label class="file-upload-btn overlay-file-btn" for="overlay-region-image">Add Image</label>
            <input id="overlay-region-image" class="hidden-file" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
            <button id="overlay-add-region-btn" type="submit">Add Entry</button>
          </form>
        </aside>
        <section class="overlay-world-stage">
          <div id="overlay-world-board" class="map-board overlay-world-board" role="region" aria-label="Campaign overlay board"></div>
        </section>
      </div>`;
    let overlayRegionImageDraft = '';
    $('#overlay-region-image').addEventListener('change', event => readImageFile(event.target, data => { overlayRegionImageDraft = data; }, 900));
    $('#overlay-region-form').addEventListener('submit', event => {
      event.preventDefault();
      addRegionFromValues({
        name: $('#overlay-region-name').value.trim(),
        type: $('#overlay-region-type').value,
        tone: $('#overlay-region-tone').value.trim(),
        sceneTags: $('#overlay-region-scenes').value,
        secrets: $('#overlay-region-secrets').value.trim(),
        image: overlayRegionImageDraft
      });
      overlayRegionImageDraft = '';
      $('#overlay-region-form').reset();
    });
    renderRegions($('#overlay-board'));
  }
  $('#board-overlay').hidden = false;
  const overlayCard = $('#board-overlay .overlay-card');
  requestAnimationFrame(() => ($('#overlay-close-btn') || overlayCard)?.focus());
}


function closeOverlay() {
  const overlayCanvas = $('#overlay-map-canvas');
  if (currentOverlay === 'map' && overlayCanvas) saveMapInk(overlayCanvas);
  $('#board-overlay').hidden = true;
  $('#overlay-board').innerHTML = '';
  currentOverlay = null;
  renderRegions();
  renderMapGrid();
  renderMapPaths();
  renderWaterAreas();
  renderMapStamps();
  if (overlayReturnFocus?.isConnected) overlayReturnFocus.focus();
  overlayReturnFocus = null;
}

function bindPersistence() {
  bindPersistenceValues();
  $('#campaign-name').addEventListener('input', event => { appState.campaignName = event.target.value; saveState(); });
  $('#campaign-premise').addEventListener('input', event => { appState.campaignPremise = event.target.value; saveState(); });
  $('#scratchpad').addEventListener('input', event => { appState.scratchpad = event.target.value; saveState(); });
}

async function exportData() {
  saveMapInk();
  const saved = await saveStateNow();
  if (!saved) return;
  const state = DMDashSecurity.normalizeState(appState);
  const payload = { ...state, fileType: 'dm-drawing-board-campaign', schemaVersion: DMDashSecurity.SCHEMA_VERSION, appVersion: APP_VERSION, savedAt: new Date().toISOString() };
  const result = await downloadFile(`${safeFilename(appState.campaignName, 'dm-drawing-board')}.dmdb`, JSON.stringify(payload, null, 2), 'application/json');
  if (result && !result.canceled) showToast('Campaign file saved.', 'info');
}

async function importData(file) {
  try {
    const result = await DMDashPlatform.openTextFile(file);
    if (!result || result.canceled) return;
    DMDashSecurity.assertImportSize(result.content);
    const incoming = JSON.parse(result.content);
    appState = DMDashSecurity.validateCampaignDocument(incoming);
    const saved = await saveStateNow();
    if (!saved) throw new Error('Campaign could not be stored.');
    activeMapTool = appState.map.tool || 'draw';
    document.documentElement.dataset.theme = appState.theme;
    setThemeText();
    bindPersistenceValues();
    refreshApp();
    setMapTool(activeMapTool, false);
    showToast('Campaign file opened.', 'info');
  } catch (_error) {
    await appAlert('That campaign file could not be opened.', 'Open File');
  }
}

function showMapStampDetails(stamp) {
  if (stamp.type === 'location') {
    const region = appState.regions.find(item => item.id === stamp.linkedRegionId);
    showInfoCard(stamp.label || 'Location', [region?.type || 'Location', region?.secrets || 'No details yet.']);
    return;
  }
  if (stamp.type === 'quest') {
    const task = appState.tasks[stamp.linkedLane || 'hooks']?.find(item => item.id === stamp.linkedTaskId);
    showInfoCard('Quest Pin', [task?.text || stamp.label || 'Quest']);
    return;
  }
  if (stamp.type === 'label') showInfoCard('Map Label', [stamp.label || 'Label']);
}

function hasUserContent() {
  return Boolean(appState.campaignName || appState.campaignPremise || appState.regions.length || appState.map.stamps.length || appState.map.paths.length || appState.map.waterAreas.length || Object.values(appState.tasks).some(list => list.length));
}

function makeDemoCampaign() {
  const regionIds = [uid(), uid(), uid(), uid()];
  const taskIds = [uid(), uid(), uid()];
  return mergeState(defaults, {
    theme: appState.theme,
    campaignName: 'The Crown Below',
    campaignPremise: 'A half-sunken border kingdom hides an old crown under blackwater paths, courier shrines, and ruined causeways.',
    scratchpad: 'Demo notes: export a player map, drag pins, curve paths, and try the water lasso.',
    regions: [
      { id: regionIds[0], name: 'Brinegate', type: 'City', tone: '#coastal #arrival', sceneTags: ['#arrival'], secrets: 'The tide bells ring before the dead arrive.', image: '', x: 8, y: 12 },
      { id: regionIds[1], name: 'Mosslight Fen', type: 'Wilderness', tone: '#swamp #haunted', sceneTags: ['#fen'], secrets: 'The witch-lights are reflected crowns, not fireflies.', image: '', x: 38, y: 28 },
      { id: regionIds[2], name: 'Old Causeway', type: 'Dungeon', tone: '#ruin #travel', sceneTags: ['#path'], secrets: 'Each milestone is a sealed confession.', image: '', x: 65, y: 18 },
      { id: regionIds[3], name: 'Crownwell', type: 'Faction', tone: '#royal #secret', sceneTags: ['#crown'], secrets: 'The well chooses heirs by drowning their shadows.', image: '', x: 74, y: 54 }
    ],
    tasks: {
      hooks: [{ id: taskIds[0], text: 'The ferryman refuses silver and asks for a memory. #arrival' }, { id: taskIds[1], text: 'A courier path vanishes under blue-black water. #path' }],
      scenes: [{ id: taskIds[2], text: 'Lanterns move beneath the surface near Mosslight Fen. #fen #crown' }],
      loose: []
    },
    tables: {
      rumors: [{ id: uid(), text: 'A map drawn in mud changes every dawn.', enabled: true }, { id: uid(), text: 'The queen keeps a path in a bottle.', enabled: true }],
      twists: [{ id: uid(), text: 'The safe route is only safe underwater.', enabled: true }]
    },
    encounters: [{ id: uid(), title: 'Causeway Toll', scenario: 'Three mud-armored knights demand a toll from travelers who still cast shadows.', complication: 'The path sinks 1 foot each round.', reward: 'A milestone key', enabled: true }],
    characters: [{ id: uid(), name: 'Mira Voss', role: 'Salt courier', bio: 'Knows every dry path that no longer exists.', notes: 'Taps twice before lying.', image: '' }],
    map: {
      ...defaults.map,
      brushColor: '#000000',
      brushSize: 8,
      brushStyle: 'marker',
      pathStyle: 'path',
      gridType: 'square',
      gridSize: 50,
      waterAreas: [
        { id: uid(), type: 'water', label: 'Mosslight Water', x: 230, y: 210, w: 560, h: 330, points: [{ x: 60, y: 58 }, { x: 250, y: 0 }, { x: 520, y: 85 }, { x: 548, y: 255 }, { x: 310, y: 326 }, { x: 92, y: 270 }, { x: 0, y: 155 }] },
        { id: uid(), type: 'water', label: 'Black Crown Bay', x: 970, y: 520, w: 440, h: 280, points: [{ x: 35, y: 40 }, { x: 220, y: 4 }, { x: 420, y: 95 }, { x: 380, y: 260 }, { x: 140, y: 278 }, { x: 0, y: 160 }] }
      ],
      paths: [
        { id: uid(), type: 'path', label: 'Causeway', x1: 145, y1: 180, x2: 1035, y2: 615, cx: 560, cy: 120 },
        { id: uid(), type: 'trail', label: 'Fen Trail', x1: 380, y1: 565, x2: 730, y2: 330, cx: 500, cy: 480 },
        { id: uid(), type: 'river', label: 'Crownflow', x1: 780, y1: 55, x2: 1220, y2: 810, cx: 980, cy: 440 },
        { id: uid(), type: 'secret', label: 'Smuggler Route', x1: 270, y1: 790, x2: 1040, y2: 710, cx: 620, cy: 900 }
      ],
      stamps: [
        { id: uid(), type: 'city', label: 'Brinegate', linkedRegionId: regionIds[0], x: 105, y: 150, size: 76, image: '' },
        { id: uid(), type: 'forest', label: 'Fen', linkedRegionId: regionIds[1], x: 480, y: 380, size: 78, image: '' },
        { id: uid(), type: 'dungeon', label: 'Causeway', linkedRegionId: regionIds[2], x: 930, y: 285, size: 82, image: '' },
        { id: uid(), type: 'quest', label: 'Find the Crown', linkedTaskId: taskIds[2], linkedLane: 'scenes', x: 1110, y: 610, size: 86, image: '' },
        { id: uid(), type: 'label', label: 'THE CROWN BELOW', x: 570, y: 70, size: 300, image: '' }
      ]
    }
  });
}

async function loadDemoCampaign() {
  if (hasUserContent() && !await appConfirm('Replace the current campaign with the demo?', 'Load Demo')) return;
  appState = makeDemoCampaign();
  activeMapTool = appState.map.tool || 'draw';
  await saveStateNow();
  refreshApp();
  showView('map');
  showToast('Demo campaign loaded.', 'info');
}

function refreshApp() {
  document.documentElement.dataset.theme = appState.theme;
  setThemeText();
  bindPersistenceValues();
  syncMapBackground();
  redrawMapInk();
  syncMapControlUi();
  syncLayerUi();
  renderDice();
  renderRegions();
  renderTasks();
  renderHistory();
  renderQuickTable();
  renderEncounters();
  renderCharacters();
  renderMapGrid();
  renderMapPaths();
  renderWaterAreas();
  renderMapStamps();
  applyLayerVisibility();
  updateMapHud();
}

function bindPersistenceValues() {
  if ($('#campaign-name')) $('#campaign-name').value = appState.campaignName;
  if ($('#campaign-premise')) $('#campaign-premise').value = appState.campaignPremise;
  if ($('#scratchpad')) $('#scratchpad').value = appState.scratchpad;
}

function bindEvents() {
  $$('.nav-btn').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));
  $('#add-region-btn').addEventListener('click', addRegion);
  $('#region-form').addEventListener('submit', event => { event.preventDefault(); addRegion(); });
  $('#region-image').addEventListener('change', event => readImageFile(event.target, data => { regionImageDraft = data; }, 900));
  $('#add-quick-btn').addEventListener('click', addQuickEntry);
  $('#roll-quick-btn').addEventListener('click', rollQuickEntry);
  $('#quick-kind').addEventListener('change', renderQuickTable);
  $('#add-encounter-btn').addEventListener('click', addEncounter);
  $('#roll-encounter-btn').addEventListener('click', rollEncounter);
  $('#add-character-btn').addEventListener('click', addCharacter);
  $('#character-image').addEventListener('change', event => readImageFile(event.target, data => { characterImageDraft = data; }, 900));
  $('#add-task-btn').addEventListener('click', addTask);
  $('#beat-form').addEventListener('submit', event => { event.preventDefault(); addTask(); });
  $('#save-btn').addEventListener('click', async () => { saveMapInk(); const ok = await saveStateNow(); if (ok) showToast('Campaign saved locally.', 'info'); });
  $('#demo-btn').addEventListener('click', loadDemoCampaign);
  $('#privacy-btn').addEventListener('click', showPrivacyPolicy);
  $('#export-btn').addEventListener('click', exportData);
  $('#open-file-btn').addEventListener('click', () => {
    if (DMDashPlatform.isDesktop) importData(null);
    else $('#import-file').click();
  });
  $('#import-file').addEventListener('change', event => {
    const file = event.target.files[0];
    if (file) importData(file);
    event.target.value = '';
  });
  $('#expand-map-btn').addEventListener('click', () => openOverlay('map'));
  $('#expand-world-btn').addEventListener('click', () => openOverlay('world'));
  $('#export-map-png-btn').addEventListener('click', exportMapPng);
  $('#export-world-png-btn').addEventListener('click', exportWorldPng);
  $('#undo-btn').addEventListener('click', undoMap);
  $('#clear-map-btn').addEventListener('click', clearMapInk);
  $('#clear-map-bg-btn').addEventListener('click', clearMapBackground);
  $('#overlay-export-btn').addEventListener('click', () => { if (currentOverlay === 'map') { saveMapInk($('#overlay-map-canvas') || $('#map-canvas')); exportMapPng(); } else { exportWorldPng(); } });
  $('#overlay-close-btn').addEventListener('click', closeOverlay);
  $('#theme-btn').addEventListener('click', () => {
    appState.theme = appState.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = appState.theme;
    setThemeText();
    enhanceAccessibility();
    saveState();
  });
  $('#roll-formula-btn').addEventListener('click', () => showRoll($('#dice-formula').value, rollFormula($('#dice-formula').value)));
  $('#roll-all-btn').addEventListener('click', () => [4,6,8,10,12,20,100].forEach(sides => document.querySelector(`[data-roll="${sides}"]`).click()));
  $$('.map-tool-btn').forEach(button => button.addEventListener('click', () => setMapTool(button.dataset.mapTool)));
  $('#brush-color').addEventListener('input', event => { appState.map.brushColor = event.target.value; syncMapControlUi(); saveState(); });
  $('#brush-size').addEventListener('input', event => { appState.map.brushSize = Number(event.target.value); syncMapControlUi(); saveState(); });
  $('#brush-style').addEventListener('change', event => { appState.map.brushStyle = event.target.value; syncMapControlUi(); updateMapHud(); saveState(); });
  $('#path-style').addEventListener('change', event => { appState.map.pathStyle = event.target.value; syncMapControlUi(); updateMapHud(); saveState(); });
  $('#map-export-scale').addEventListener('change', event => { appState.map.exportScale = Number(event.target.value); syncMapControlUi(); saveState(); });
  $('#export-transparent').addEventListener('change', event => { appState.map.exportTransparent = event.target.checked; syncMapControlUi(); saveState(); });
  [['background', 'layer-background'], ['grid', 'layer-grid'], ['ink', 'layer-ink'], ['water', 'layer-water'], ['paths', 'layer-paths'], ['stamps', 'layer-stamps']].forEach(([name, id]) => $(`#${id}`)?.addEventListener('change', event => setLayerVisibility(name, event.target.checked)));
  $('#grid-type').addEventListener('change', event => { appState.map.gridType = event.target.value; renderMapGrid(); syncMapControlUi(); saveState(); });
  $('#grid-size').addEventListener('input', event => { appState.map.gridSize = Number(event.target.value); renderMapGrid(); syncMapControlUi(); saveState(); });
  $('#map-image-input').addEventListener('change', event => readImageFile(event.target, data => addImageStamp(data), 900));
  $('#map-bg-input').addEventListener('change', event => readImageFile(event.target, data => setMapBackground(data), 1600));
  $('#water-fill-btn')?.addEventListener('click', waterFillFromDraw);
  $('#finish-water-area-btn')?.addEventListener('click', finishWaterAreaFromButton);
  $('#cancel-water-area-btn')?.addEventListener('click', cancelWaterArea);
  $$('.symbol-palette [data-symbol-pick]').forEach(button => button.addEventListener('click', () => { $$('#symbol-kind, #overlay-symbol-kind').forEach(select => { select.value = button.dataset.symbolPick; }); setMapTool('symbol'); }));
  $('#map-canvas').addEventListener('pointerdown', startDraw);
  $('#map-canvas').addEventListener('pointermove', moveDraw);
  $('#map-canvas').addEventListener('pointerup', endDraw);
  $('#map-canvas').addEventListener('pointercancel', endDraw);

  $('#map-maker-board').addEventListener('pointerdown', event => {
    if (handleWaterCloseBeforePlacement(event)) return;
    if (['label','location','quest','waterarea'].includes(activeMapTool) && !event.target.closest('.map-stamp,.path-curve-handle,.water-area')) handleMapObjectPlacement(event);
  });
  $('#map-maker-board').addEventListener('dblclick', event => {
    if (activeMapTool !== 'waterarea' || pendingWaterPoints.length < 3) return;
    tryFinishWaterAreaAtPoint(getPlacementPoint(event), event);
  });

  document.addEventListener('dblclick', event => {
    const closeTarget = event.target.closest('.water-start-close');
    if (closeTarget && activeMapTool === 'waterarea') {
      finishWaterAreaFromCloseTarget(event);
    }
  });

  document.addEventListener('click', event => {
    const roll = event.target.dataset.roll;
    if (roll) {
      const value = rollDie(Number(roll));
      $(`#d${roll}-total`).textContent = value;
      showRoll(`d${roll}`, { total: value, detail: `[${value}]` });
    }
    const regionDelete = event.target.dataset.deleteRegion;
    if (regionDelete) {
      appState.regions = appState.regions.filter(region => region.id !== regionDelete);
      renderRegions();
      saveState();
    }
    const characterDelete = event.target.dataset.deleteCharacter;
    if (characterDelete) {
      appState.characters = appState.characters.filter(character => character.id !== characterDelete);
      renderCharacters();
      saveState();
    }
    const tableToggle = event.target.dataset.toggleTable;
    if (tableToggle) {
      const kind = $('#quick-kind').value;
      const item = appState.tables[kind].find(entry => entry.id === tableToggle);
      if (item) item.enabled = item.enabled === false;
      renderQuickTable();
      saveState();
    }
    const tableDelete = event.target.dataset.deleteTable;
    if (tableDelete) {
      const kind = $('#quick-kind').value;
      appState.tables[kind] = appState.tables[kind].filter(entry => entry.id !== tableDelete);
      renderQuickTable();
      saveState();
    }
    const encounterToggle = event.target.dataset.toggleEncounter;
    if (encounterToggle) {
      const item = appState.encounters.find(entry => entry.id === encounterToggle);
      if (item) item.enabled = item.enabled === false;
      renderEncounters();
      saveState();
    }
    const encounterDelete = event.target.dataset.deleteEncounter;
    if (encounterDelete) {
      appState.encounters = appState.encounters.filter(entry => entry.id !== encounterDelete);
      renderEncounters();
      saveState();
    }
    const stamp = event.target.closest('[data-map-stamp]');
    if (stamp && (activeMapTool === 'delete' || event.altKey)) {
      snapshotMap();
      appState.map.stamps = appState.map.stamps.filter(item => item.id !== stamp.dataset.mapStamp);
      selectedStampId = '';
      selectedPathId = '';
      renderMapPaths();
      renderWaterAreas();
      renderMapStamps();
      saveState();
      return;
    }
    if (stamp) {
      selectedStampId = stamp.dataset.mapStamp;
      selectedPathId = '';
      const item = appState.map.stamps.find(entry => entry.id === selectedStampId);
      if (activeMapTool !== 'move' && item) showMapStampDetails(item);
      renderMapStamps();
      return;
    }
    const sceneTag = event.target.dataset.sceneTag;
    if (sceneTag) {
      showLinkedScenes(sceneTag);
      return;
    }
    const task = event.target.closest('[data-task]');
    if (task) {
      appState.tasks[task.dataset.lane] = appState.tasks[task.dataset.lane].filter(item => item.id !== task.dataset.task);
      renderTasks();
      saveState();
    }
  });
}


function bindShortcuts() {
  document.addEventListener('keydown', event => {
    if (!getDialogRoot()?.hidden) return;
    const overlayCard = $('#board-overlay:not([hidden]) .overlay-card');
    if (overlayCard) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeOverlay();
        return;
      }
      if (event.key === 'Tab') {
        const focusable = getFocusableElements(overlayCard);
        if (!focusable.length) {
          event.preventDefault();
          overlayCard.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    const tag = event.target.tagName;
    const isZoomShortcut = (event.ctrlKey || event.metaKey) && ['-', '+', '=', '0'].includes(event.key);
    if (isZoomShortcut) {
      event.preventDefault();
      if (event.key === '-') adjustAppZoom(-1);
      if (event.key === '+' || event.key === '=') adjustAppZoom(1);
      if (event.key === '0') adjustAppZoom(0);
      return;
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undoMap();
      return;
    }
    if (activeMapTool === 'waterarea' && event.key === 'Escape') {
      event.preventDefault();
      cancelWaterArea();
      return;
    }
    if (activeMapTool === 'waterarea' && event.key === 'Enter') {
      event.preventDefault();
      finishWaterAreaFromButton();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!deleteSelectedMapObject()) return;
      event.preventDefault();
      return;
    }
    const keyTool = { v: 'move', b: 'draw', e: 'erase', s: 'symbol' }[event.key.toLowerCase()];
    if (keyTool) setMapTool(keyTool);
  });
}


function enhanceAccessibility(root = document) {
  root.querySelectorAll('.map-maker-board').forEach(board => {
    board.setAttribute('role', 'region');
    board.setAttribute('aria-describedby', 'map-a11y-help');
    board.setAttribute('tabindex', '0');
  });
  root.querySelectorAll('.map-maker-board canvas').forEach(canvas => canvas.setAttribute('aria-hidden', 'true'));
}

function init() {
  document.documentElement.dataset.theme = appState.theme;
  setThemeText();
  enhanceAccessibility();
  $('#brush-color').value = appState.map.brushColor || '#000000';
  $('#brush-size').value = appState.map.brushSize || 6;
  $('#brush-size-output').textContent = appState.map.brushSize || 6;
  syncMapControlUi();
  syncLayerUi();
  setMapTool(appState.map.tool || 'draw');
  bindPersistence();
  bindEvents();
  bindDrag();
  bindShortcuts();
  renderDice();
  renderRegions();
  renderTasks();
  renderHistory();
  renderQuickTable();
  renderEncounters();
  renderCharacters();
  renderMapGrid();
  renderMapPaths();
  renderWaterAreas();
  renderMapStamps();
  applyLayerVisibility();
  updateMapHud();
  if ($('#map-view').classList.contains('active')) hydrateMapView();
  setMapTool(activeMapTool, false);
  hydrateLargeState();
}

window.addEventListener('beforeunload', saveStateNow);

init();
