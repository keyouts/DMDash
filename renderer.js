// State setup
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
  map: { ink: '', background: '', stamps: [], paths: [], waterAreas: [], tool: 'draw', brushColor: '#000000', brushSize: 6, gridType: 'square', gridSize: 40 }
};
let appState = mergeState(defaults, savedState);
let regionImageDraft = '';
let characterImageDraft = '';
let activeMapTool = appState.map.tool || 'draw';
let drawing = false;
let lastPoint = null;
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
let currentDrawStrokePoints = [];
let lastDrawStrokePoints = [];
let lastDrawStrokeInkBefore = '';
let activeDrawStrokeInkBefore = '';
let lastDrawStrokeBrushSize = 6;
let saveTimer = null;
let mapHydrated = false;
const undoStack = [];

// Element helpers
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

// Zoom controls
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

// Undo stack
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
  selectedPathId = '';
  selectedWaterAreaId = '';
  currentDrawStrokePoints = [];
  lastDrawStrokePoints = [];
  lastDrawStrokeInkBefore = '';
  activeDrawStrokeInkBefore = '';
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
    image.hidden = !appState.map.background;
  });
}

const uid = () => crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];


// Safe storage
function loadStoredState() {
  try {
    return JSON.parse(localStorage.getItem('dm-drawing-board-state') || '{}');
  } catch (_error) {
    localStorage.removeItem('dm-drawing-board-state');
    return {};
  }
}

// State helpers
function mergeState(base, incoming) {
  const next = { ...base, ...incoming };
  next.tasks = { ...base.tasks, ...(incoming.tasks || {}) };
  next.tables = { ...base.tables, ...(incoming.tables || {}) };
  next.encounters = incoming.encounters || [];
  next.characters = incoming.characters || [];
  next.regions = incoming.regions || [];
  next.map = { ...base.map, ...(incoming.map || {}) };
  next.map.stamps = next.map.stamps || [];
  const legacyMapPaths = incoming.map && incoming.map['ro' + 'ads'];
  next.map.paths = next.map.paths || legacyMapPaths || [];
  next.map.paths = next.map.paths.map(item => ({
    ...item,
    type: item.type === ('ro' + 'ad') ? 'path' : (item.type || 'path'),
    label: item.label === ('Ro' + 'ad') ? 'Path' : (item.label || 'Path')
  }));
  next.map.waterAreas = next.map.waterAreas || [];
  next.map.gridType = next.map.gridType || 'square';
  next.map.gridSize = Number(next.map.gridSize || 40);
  if (!incoming.map && incoming.flowNodes) {
    next.map.stamps = incoming.flowNodes.map(node => ({
      id: node.id || uid(),
      type: 'note',
      label: node.title || 'Note',
      note: node.text || '',
      image: node.image || '',
      x: node.x || 80,
      y: node.y || 80,
      size: node.image ? 120 : 86
    }));
  }
  return next;
}

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem('dm-drawing-board-state', JSON.stringify(appState));
    } catch (_error) {
      alert('This campaign is too large for browser storage. Export a campaign file, then remove oversized images.');
    }
  }, 120);
}

function saveStateNow() {
  clearTimeout(saveTimer);
  try {
    localStorage.setItem('dm-drawing-board-state', JSON.stringify(appState));
  } catch (_error) {
    alert('This campaign is too large for browser storage. Export a campaign file, then remove oversized images.');
  }
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

// File helpers
function readImageFile(input, callback, maxSize = 1400) {
  const file = input.files && input.files[0];
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > 8 * 1024 * 1024) {
    alert('Choose an image under 8 MB.');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => compressImage(reader.result, maxSize).then(callback);
  reader.readAsDataURL(file);
}

function compressImage(src, maxSize) {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    image.onerror = () => resolve(src);
    image.src = src;
  });
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function safeFilename(name, fallback) {
  return (name || fallback).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || fallback;
}

// Navigation logic
function showView(name) {
  $$('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === name));
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `${name}-view`));
  if (name === 'map') requestAnimationFrame(hydrateMapView);
}

// Region logic
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
        <button data-delete-region="${region.id}">Delete</button>
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

// Dice logic
function rollDie(sides) {
  return Math.floor(Math.random() * sides) + 1;
}

function rollFormula(formula) {
  const cleaned = formula.toLowerCase().replace(/\s+/g, '');
  const parts = cleaned.match(/[+-]?[^+-]+/g) || [];
  let total = 0;
  const detail = [];
  for (const part of parts) {
    const sign = part.startsWith('-') ? -1 : 1;
    const token = part.replace(/^[+-]/, '');
    const dice = token.match(/^(\d*)d(\d+)(kh1|kl1)?$/);
    if (dice) {
      const count = Math.min(Number(dice[1] || 1), 100);
      const sides = Number(dice[2]);
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

// Map helpers
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
  $$('.symbol-palette [data-symbol-pick]').forEach(button => button.classList.toggle('active', button.dataset.symbolPick === symbolValue));
  $$('#brush-color, #overlay-brush-color').forEach(input => { input.value = appState.map.brushColor || '#000000'; });
  $$('#brush-size, #overlay-brush-size').forEach(input => { input.value = appState.map.brushSize || 6; });
  $$('#brush-size-output, #overlay-brush-size-output').forEach(output => { output.textContent = appState.map.brushSize || 6; });
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
    layer.hidden = type === 'none';
  });
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
  if (['symbol','label','location','quest','waterarea','pathline','connectpaths'].includes(activeMapTool)) {
    handleMapObjectPlacement(event);
    return;
  }
  if (activeMapTool === 'delete') return;
  if (activeMapTool !== 'draw' && activeMapTool !== 'erase') return;
  snapshotMap();
  drawing = true;
  lastPoint = getCanvasPoint(event);
  if (activeMapTool === 'draw') {
    activeDrawStrokeInkBefore = appState.map.ink || '';
    lastDrawStrokeBrushSize = Number(appState.map.brushSize || 6);
    currentDrawStrokePoints = [{ x: lastPoint.x, y: lastPoint.y }];
  } else {
    currentDrawStrokePoints = [];
  }
  event.currentTarget.setPointerCapture(event.pointerId);
}

function moveDraw(event) {
  const canvas = event.currentTarget || $('#map-canvas');
  if (activeMapTool === 'pathline' && pendingPathPoint) {
    pathPreviewPoint = getCanvasPoint(event, canvas);
    renderMapPaths();
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
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Number(appState.map.brushSize || 6);
  if (activeMapTool === 'erase') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = Number(appState.map.brushSize || 6) * 2.1;
  } else {
    ctx.strokeStyle = appState.map.brushColor || '#000000';
  }
  ctx.beginPath();
  ctx.moveTo(lastPoint.x, lastPoint.y);
  ctx.lineTo(point.x, point.y);
  ctx.stroke();
  ctx.restore();
  if (drawing && activeMapTool === 'draw') {
    const previousStrokePoint = currentDrawStrokePoints[currentDrawStrokePoints.length - 1];
    if (!previousStrokePoint || Math.hypot(point.x - previousStrokePoint.x, point.y - previousStrokePoint.y) >= 3) {
      currentDrawStrokePoints.push({ x: point.x, y: point.y });
    }
  }
  lastPoint = point;
}

function endDraw(event) {
  if (!drawing) return;
  moveDraw(event);
  drawing = false;
  if (activeMapTool === 'draw' && currentDrawStrokePoints.length > 1) {
    lastDrawStrokePoints = currentDrawStrokePoints.map(point => ({ x: point.x, y: point.y }));
    lastDrawStrokeInkBefore = activeDrawStrokeInkBefore || '';
  }
  currentDrawStrokePoints = [];
  activeDrawStrokeInkBefore = '';
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

function handleMapObjectPlacement(event) {
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
  const entered = window.prompt(promptData[0], promptData[1]);
  const title = (entered || promptData[1]).trim();
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



function simplifyFreehandPoints(points, minDistance = 12) {
  const simplified = [];
  for (const point of points || []) {
    const previous = simplified[simplified.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= minDistance) {
      simplified.push({ x: Number(point.x), y: Number(point.y) });
    }
  }
  if (points?.length) {
    const last = points[points.length - 1];
    const previous = simplified[simplified.length - 1];
    if (!previous || previous.x !== last.x || previous.y !== last.y) simplified.push({ x: Number(last.x), y: Number(last.y) });
  }
  return simplified.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function freehandStrokeToWaterPolygon(points, width) {
  const line = simplifyFreehandPoints(points, 10);
  if (line.length < 2) return [];
  const halfWidth = Math.max(24, Math.min(90, Number(width || 60) / 2));
  const closed = line.length > 5 && Math.hypot(line[0].x - line[line.length - 1].x, line[0].y - line[line.length - 1].y) <= Math.max(halfWidth, 36);
  if (closed) return line;

  const left = [];
  const right = [];
  for (let index = 0; index < line.length; index += 1) {
    const previous = line[Math.max(0, index - 1)];
    const next = line[Math.min(line.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    left.push({ x: line[index].x + nx * halfWidth, y: line[index].y + ny * halfWidth });
    right.push({ x: line[index].x - nx * halfWidth, y: line[index].y - ny * halfWidth });
  }
  return [...left, ...right.reverse()];
}

function convertLastDrawStrokeToWater() {
  if (!lastDrawStrokePoints.length || lastDrawStrokePoints.length < 2) {
    alert('Use Draw to sketch the water shape first, then click Water Fill.');
    return;
  }
  const waterWidth = Math.max(48, Math.min(180, Number(lastDrawStrokeBrushSize || appState.map.brushSize || 6) * 6));
  const polygon = freehandStrokeToWaterPolygon(lastDrawStrokePoints, waterWidth);
  if (polygon.length < 3) {
    alert('Draw a longer water line or closed shape before using Water Fill.');
    return;
  }
  snapshotMap();
  const pad = 10;
  const xs = polygon.map(point => point.x);
  const ys = polygon.map(point => point.y);
  const minX = Math.max(0, Math.min(...xs) - pad);
  const minY = Math.max(0, Math.min(...ys) - pad);
  const maxX = Math.min(1600, Math.max(...xs) + pad);
  const maxY = Math.min(1000, Math.max(...ys) + pad);
  const area = {
    id: uid(),
    type: 'water',
    label: 'Water',
    x: minX,
    y: minY,
    w: Math.max(28, maxX - minX),
    h: Math.max(28, maxY - minY),
    points: polygon.map(point => ({
      x: Math.max(0, Math.min(maxX - minX, point.x - minX)),
      y: Math.max(0, Math.min(maxY - minY, point.y - minY))
    }))
  };
  appState.map.ink = lastDrawStrokeInkBefore || '';
  appState.map.waterAreas = appState.map.waterAreas || [];
  appState.map.waterAreas.push(area);
  selectedWaterAreaId = area.id;
  selectedPathId = '';
  selectedStampId = '';
  lastDrawStrokePoints = [];
  lastDrawStrokeInkBefore = '';
  redrawMapInk();
  renderWaterAreas();
  saveState();
}

function finishWaterArea(options = {}) {
  if (pendingWaterPoints.length < 3) return;
  const shouldPrompt = Boolean(options.promptForName);
  const entered = shouldPrompt ? window.prompt('Water area name:', 'Water') : 'Water';
  const title = (entered || 'Water').trim() || 'Water';
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
  lastWaterClosePointerTime = 0;
  setMapTool('move');
  renderWaterAreas();
  saveState();
}

function cancelWaterArea() {
  pendingWaterPoints = [];
  waterPreviewPoint = null;
  lastWaterClosePointerTime = 0;
  renderWaterAreas();
}

function finishWaterAreaFromButton() {
  if (pendingWaterPoints.length >= 3) finishWaterArea({ promptForName: false });
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
        <span class="sr-only">${escapeHtml(area.label || 'Water')}</span>
      </button>`;
  }).join('');
  const previewPoints = pendingWaterPoints.length
    ? [...pendingWaterPoints, ...(waterPreviewPoint ? [waterPreviewPoint] : [])]
    : [];
  const previewMarkup = previewPoints.length
    ? `<svg class="water-preview-svg" viewBox="0 0 1600 1000" aria-hidden="true"><polyline points="${previewPoints.map(point => `${point.x},${point.y}`).join(' ')}"/>${pendingWaterPoints.length >= 3 ? `<polygon class="water-preview-fill" points="${previewPoints.map(point => `${point.x},${point.y}`).join(' ')}"/>` : ''}<circle class="water-start-dot" cx="${pendingWaterPoints[0].x}" cy="${pendingWaterPoints[0].y}" r="5"/>${pendingWaterPoints.length >= 3 ? `<circle class="water-close-ring" cx="${pendingWaterPoints[0].x}" cy="${pendingWaterPoints[0].y}" r="20"/><text x="${pendingWaterPoints[0].x + 28}" y="${pendingWaterPoints[0].y - 18}">click start dot to fill</text>` : ''}</svg>${pendingWaterPoints.length >= 3 ? `<button class="water-start-close" type="button" style="left:${pendingWaterPoints[0].x - 28}px; top:${pendingWaterPoints[0].y - 28}px;" title="Click to close and fill water area" aria-label="Click to close and fill water area"><span class="sr-only">Click to close and fill water area</span></button>` : ''}`
    : '';
  layers.forEach(layer => { layer.innerHTML = previewMarkup + waterMarkup; });
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
    alert('Click near the end of a path to choose a connection point.');
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
  appState.map.paths.push({ id: uid(), type: 'path', label: 'Path', x1, y1, x2, y2, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 });
  pendingPathPoint = null;
  pathPreviewPoint = null;
  pendingPathConnection = null;
  pendingWaterPoints = [];
  waterPreviewPoint = null;
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
    return `<g data-map-path="${path.id}" class="path-path${selectedClass}"><path d="${pathPathD(path)}"/><text x="${mid.x}" y="${mid.y - 8}">${escapeHtml(path.label || '')}</text></g>`;
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
  renderMapGrid();
  renderMapPaths();
  renderWaterAreas();
  renderMapStamps();
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
}

function clearMapInk() {
  if (!confirm('Clear map ink? Stamps stay.')) return;
  snapshotMap();
  appState.map.ink = '';
  $$('#map-canvas, #overlay-map-canvas').forEach(canvas => canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height));
  saveState();
}

// Table logic
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
        <button data-toggle-table="${item.id}">${item.enabled === false ? 'Off' : 'On'}</button>
        <button data-delete-table="${item.id}">Delete</button>
      </div>
    </div>
  `).join('');
}

function rollQuickEntry() {
  const kind = $('#quick-kind').value;
  const enabled = appState.tables[kind].filter(item => item.enabled !== false);
  $('#quick-output').textContent = enabled.length ? pick(enabled).text : 'No active entries.';
}

// Encounter logic
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
        <button data-toggle-encounter="${encounter.id}">${encounter.enabled === false ? 'Off' : 'On'}</button>
        <button data-delete-encounter="${encounter.id}">Delete</button>
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

// Character logic
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
      <button data-delete-character="${character.id}">Delete</button>
    </article>
  `).join('');
}


// Scene links
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

// Session logic
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
    lane.innerHTML = appState.tasks[name].map(task => `<div class="kanban-card" data-task="${task.id}" data-lane="${name}">${escapeHtml(task.text)}</div>`).join('');
  });
}

// Drag logic
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

// Export canvas
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

function drawExportPaths(ctx) {
  ctx.save();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.setLineDash([22, 14]);
  for (const path of appState.map.paths || []) {
    const { cx, cy } = pathControlPoint(path);
    ctx.beginPath();
    ctx.moveTo(path.x1, path.y1);
    ctx.quadraticCurveTo(cx, cy, path.x2, path.y2);
    ctx.stroke();
  }
  ctx.restore();
}

async function exportMapPng() {
  const source = $('#map-canvas');
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--paper') || '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const background = await loadImage(appState.map.background);
  if (background) ctx.drawImage(background, 0, 0, canvas.width, canvas.height);
  drawExportGrid(ctx, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0);
  drawExportWaterAreas(ctx);
  drawExportPaths(ctx);
  for (const stamp of appState.map.stamps) {
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
  link.download = `${safeFilename(appState.campaignName, 'dm-drawing-board')}-map.png`;
  link.click();
}

// Overlay logic
function openOverlay(kind) {
  currentOverlay = kind;
  $('#overlay-title').textContent = kind === 'map' ? 'Map Maker Overlay' : 'Campaign Board Overlay';
  if (kind === 'map') {
    $('#overlay-board').innerHTML = `
      <div class="overlay-map-shell"><aside class="overlay-map-tools" aria-label="Map overlay tools">
        <div class="overlay-tool-strip" role="group" aria-label="Map tools">
          <button class="map-tool-btn overlay-tool" data-map-tool="draw" type="button">Draw</button>
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
          <button id="overlay-water-fill-btn" type="button">Water Fill</button>
        </div>
        <div class="overlay-tool-strip overlay-map-adjustments">
          <label for="overlay-brush-color">Ink</label>
          <input id="overlay-brush-color" type="color" value="#000000">
          <label for="overlay-brush-size">Size <output id="overlay-brush-size-output">6</output></label>
          <input id="overlay-brush-size" class="chunky-range" type="range" min="2" max="48" value="6">
          <label for="overlay-grid-type">Grid</label>
          <select id="overlay-grid-type"><option value="none">None</option><option value="square">Square</option><option value="hex">Hex</option></select>
          <label for="overlay-grid-size">Grid Size <output id="overlay-grid-size-output">40</output></label>
          <input id="overlay-grid-size" class="chunky-range" type="range" min="20" max="120" value="40">
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
          <input id="overlay-map-image-input" class="hidden-file" type="file" accept="image/*">
          <label class="file-upload-btn overlay-file-btn" for="overlay-map-bg-input">Set Map Background</label>
          <input id="overlay-map-bg-input" class="hidden-file" type="file" accept="image/*">
          <button id="overlay-clear-map-bg-btn" type="button">Clear Background</button>
          <span class="hint"><strong>Shortcuts:</strong> Ctrl/Cmd+Z undo. V move. B draw. E erase. S symbol. Del deletes selected stamp/path. Delete tool or Alt-click removes a placement. Draw a water line or shape, then Water Fill converts it to the water graphic. Path Line uses two clicks; Connect Paths snaps two path ends together; Move shows curve handles.</span>
        </div>
      </aside>
      <section class="overlay-map-stage"><div class="map-stage-scroll"><div class="map-maker-board overlay-map-maker" aria-label="Map overlay board">
        <img id="overlay-map-bg-image" class="map-bg-image" alt="">
        <div id="overlay-map-grid-layer" class="map-grid-layer"></div>
        <div id="overlay-map-water-layer" class="map-water-layer"></div>
        <svg id="overlay-map-path-layer" class="map-path-layer" viewBox="0 0 1600 1000" aria-hidden="true"></svg>
        <canvas id="overlay-map-canvas" width="1600" height="1000"></canvas>
        <div class="stamp-layer"></div>
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
    $('#overlay-grid-type').addEventListener('change', event => { appState.map.gridType = event.target.value; renderMapGrid(); syncMapControlUi(); saveState(); });
    $('#overlay-grid-size').addEventListener('input', event => { appState.map.gridSize = Number(event.target.value); renderMapGrid(); syncMapControlUi(); saveState(); });
    $('#overlay-map-image-input').addEventListener('change', event => readImageFile(event.target, data => addImageStamp(data), 900));
    $('#overlay-map-bg-input').addEventListener('change', event => readImageFile(event.target, data => setMapBackground(data), 1600));
    $('#overlay-clear-map-bg-btn').addEventListener('click', clearMapBackground);
    $('#overlay-undo-btn').addEventListener('click', undoMap);
    $('#overlay-clear-map-btn').addEventListener('click', clearMapInk);
    $('#overlay-water-fill-btn').addEventListener('click', convertLastDrawStrokeToWater);
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
            <input id="overlay-region-image" class="hidden-file" type="file" accept="image/*">
            <button id="overlay-add-region-btn" type="submit">Add Entry</button>
          </form>
        </aside>
        <section class="overlay-world-stage">
          <div id="overlay-world-board" class="map-board overlay-world-board" aria-label="Campaign overlay board"></div>
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
}

// Persistence logic
function bindPersistence() {
  $('#campaign-name').value = appState.campaignName;
  $('#campaign-premise').value = appState.campaignPremise;
  $('#scratchpad').value = appState.scratchpad;
  $('#campaign-name').addEventListener('input', event => { appState.campaignName = event.target.value; saveState(); });
  $('#campaign-premise').addEventListener('input', event => { appState.campaignPremise = event.target.value; saveState(); });
  $('#scratchpad').addEventListener('input', event => { appState.scratchpad = event.target.value; saveState(); });
}

// Import export
function exportData() {
  saveMapInk();
  saveStateNow();
  const payload = { ...appState, fileType: 'dm-drawing-board-campaign', version: 8, savedAt: new Date().toISOString() };
  downloadFile(`${safeFilename(appState.campaignName, 'dm-drawing-board')}.dmdb`, JSON.stringify(payload, null, 2), 'application/json');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const incoming = JSON.parse(reader.result);
      if (incoming.fileType && incoming.fileType !== 'dm-drawing-board-campaign') throw new Error('Invalid file type.');
      appState = mergeState(defaults, incoming);
      saveStateNow();
      location.reload();
    } catch (_error) {
      alert('That campaign file could not be opened.');
    }
  };
  reader.readAsText(file);
}

function showMapStampDetails(stamp) {
  if (stamp.type === 'location') {
    const region = appState.regions.find(item => item.id === stamp.linkedRegionId);
    alert(`${stamp.label || 'Location'}\n${region?.type || 'Location'}${region?.secrets ? `\n\n${region.secrets}` : ''}`);
    return;
  }
  if (stamp.type === 'quest') {
    const task = appState.tasks[stamp.linkedLane || 'hooks']?.find(item => item.id === stamp.linkedTaskId);
    alert(`Quest Pin\n${task?.text || stamp.label || 'Quest'}`);
    return;
  }
  if (stamp.type === 'label') alert(stamp.label || 'Label');
}

// Event binding
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
  $('#save-btn').addEventListener('click', () => { saveMapInk(); saveStateNow(); });
  $('#export-btn').addEventListener('click', exportData);
  $('#import-file').addEventListener('change', event => event.target.files[0] && importData(event.target.files[0]));
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
  $('#grid-type').addEventListener('change', event => { appState.map.gridType = event.target.value; renderMapGrid(); syncMapControlUi(); saveState(); });
  $('#grid-size').addEventListener('input', event => { appState.map.gridSize = Number(event.target.value); renderMapGrid(); syncMapControlUi(); saveState(); });
  $('#map-image-input').addEventListener('change', event => readImageFile(event.target, data => addImageStamp(data), 900));
  $('#map-bg-input').addEventListener('change', event => readImageFile(event.target, data => setMapBackground(data), 1600));
  $('#water-fill-btn')?.addEventListener('click', convertLastDrawStrokeToWater);
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

// App boot

// Keyboard controls
function bindShortcuts() {
  document.addEventListener('keydown', event => {
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


function textForControl(control) {
  const explicit = control.getAttribute('aria-label') || control.getAttribute('title');
  if (explicit) return explicit.trim();
  const id = control.id;
  if (id) {
    const label = Array.from(document.querySelectorAll('label[for]')).find(node => node.getAttribute('for') === id);
    if (label) return label.textContent.trim();
  }
  const dataTool = control.dataset?.mapTool;
  if (dataTool) return `Map tool: ${control.textContent.trim()}`;
  const dataView = control.dataset?.view;
  if (dataView) return `Open ${control.textContent.trim()} view`;
  const dataSymbol = control.dataset?.symbolPick;
  if (dataSymbol) return `Select ${control.textContent.trim()} symbol`;
  const text = control.textContent.trim();
  return text || control.placeholder || control.name || control.type || 'Interactive control';
}

function addScreenReaderText(control, text) {
  if (!text || control.querySelector(':scope > .sr-only')) return;
  const span = document.createElement('span');
  span.className = 'sr-only';
  span.textContent = ` ${text}`;
  control.appendChild(span);
}

function enhanceAccessibility(root = document) {
  root.querySelectorAll('button, input, select, textarea, label.file-upload-btn, [role="button"]').forEach(control => {
    const text = textForControl(control);
    if (!control.getAttribute('aria-label') && text) control.setAttribute('aria-label', text);
    if ((control.tagName === 'BUTTON' || control.getAttribute('role') === 'button') && text) addScreenReaderText(control, text);
  });
  root.querySelectorAll('.map-maker-board').forEach(board => {
    board.setAttribute('role', 'application');
    board.setAttribute('aria-describedby', 'map-a11y-help');
    board.setAttribute('tabindex', '0');
  });
}

function init() {
  document.documentElement.dataset.theme = appState.theme;
  setThemeText();
  enhanceAccessibility();
  $('#brush-color').value = appState.map.brushColor || '#000000';
  $('#brush-size').value = appState.map.brushSize || 6;
  $('#brush-size-output').textContent = appState.map.brushSize || 6;
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
  if ($('#map-view').classList.contains('active')) hydrateMapView();
  setMapTool(activeMapTool, false);
}

window.addEventListener('beforeunload', saveStateNow);

init();
