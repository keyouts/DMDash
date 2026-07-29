(function attachSecurity(root, factory) {
  const api = Object.freeze(factory());
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') Object.defineProperty(root, 'DMDashSecurity', { value: api, configurable: false, writable: false });
})(typeof globalThis === 'object' ? globalThis : this, function createSecurity() {
  const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
  const MAX_STATE_BYTES = 30 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
  const SCHEMA_VERSION = 9;
  const IMAGE_PATTERN = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\r\n]+$/i;
  const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
  const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
  const TAG_PATTERN = /^#[a-z0-9_-]{1,40}$/;
  const textEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  function byteLength(value) {
    const text = String(value ?? '');
    if (typeof Buffer === 'function') return Buffer.byteLength(text, 'utf8');
    if (textEncoder) return textEncoder.encode(text).byteLength;
    return unescape(encodeURIComponent(text)).length;
  }

  function cleanText(value, maxLength = 2000) {
    return String(value ?? '').replace(/\u0000/g, '').slice(0, maxLength);
  }

  function cleanId(value, fallback = '') {
    const candidate = cleanText(value, 80).trim();
    if (ID_PATTERN.test(candidate)) return candidate;
    if (ID_PATTERN.test(fallback)) return fallback;
    if (typeof crypto === 'object' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `id-${Math.random().toString(36).slice(2, 12)}`;
  }

  function cleanOptionalId(value) {
    const candidate = cleanText(value, 80).trim();
    return ID_PATTERN.test(candidate) ? candidate : '';
  }

  function cleanBoolean(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function cleanNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function cleanEnum(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
  }

  function cleanColor(value, fallback = '#000000') {
    const candidate = cleanText(value, 7);
    return COLOR_PATTERN.test(candidate) ? candidate.toLowerCase() : fallback;
  }

  function cleanTag(value) {
    const candidate = cleanText(value, 42).trim().toLowerCase();
    return TAG_PATTERN.test(candidate) ? candidate : '';
  }

  function cleanTags(value) {
    const source = Array.isArray(value) ? value : cleanText(value, 2000).match(/#[a-z0-9_-]+/gi) || [];
    return [...new Set(source.map(cleanTag).filter(Boolean))].slice(0, 24);
  }

  function cleanArray(value, limit, mapper) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, limit).map((item, index) => mapper(item, index)).filter(Boolean);
  }

  function safeImageData(value) {
    const candidate = typeof value === 'string' ? value : '';
    if (!candidate || candidate.length > Math.ceil(MAX_IMAGE_BYTES * 1.38)) return '';
    if (!IMAGE_PATTERN.test(candidate)) return '';
    return candidate;
  }

  function cleanPoint(point) {
    if (!point || typeof point !== 'object') return null;
    return {
      x: cleanNumber(point.x, -2000, 4000, 0),
      y: cleanNumber(point.y, -2000, 3000, 0)
    };
  }

  function cleanRegion(region, index) {
    if (!region || typeof region !== 'object') return null;
    return {
      id: cleanId(region.id, `region-${index}`),
      name: cleanText(region.name, 200) || 'Unnamed Place',
      type: cleanEnum(region.type, ['Location', 'City', 'Dungeon', 'Wilderness', 'Faction', 'NPC Group', 'Quest'], 'Location'),
      tone: cleanText(region.tone, 500),
      sceneTags: cleanTags(region.sceneTags),
      secrets: cleanText(region.secrets, 12000),
      image: safeImageData(region.image),
      x: cleanNumber(region.x, 0, 100, 8),
      y: cleanNumber(region.y, 0, 100, 8)
    };
  }

  function cleanTask(task, index) {
    if (!task || typeof task !== 'object') return null;
    return {
      id: cleanId(task.id, `task-${index}`),
      text: cleanText(task.text, 6000),
      lane: cleanEnum(task.lane, ['hooks', 'scenes', 'loose'], undefined)
    };
  }

  function cleanTableEntry(entry, index) {
    if (!entry || typeof entry !== 'object') return null;
    return {
      id: cleanId(entry.id, `table-${index}`),
      text: cleanText(entry.text, 4000),
      enabled: cleanBoolean(entry.enabled, true)
    };
  }

  function cleanEncounter(entry, index) {
    if (!entry || typeof entry !== 'object') return null;
    return {
      id: cleanId(entry.id, `encounter-${index}`),
      title: cleanText(entry.title, 240) || 'Untitled Encounter',
      scenario: cleanText(entry.scenario, 8000),
      complication: cleanText(entry.complication, 4000),
      reward: cleanText(entry.reward, 4000),
      enabled: cleanBoolean(entry.enabled, true)
    };
  }

  function cleanCharacter(entry, index) {
    if (!entry || typeof entry !== 'object') return null;
    return {
      id: cleanId(entry.id, `character-${index}`),
      name: cleanText(entry.name, 200) || 'Unnamed Character',
      role: cleanText(entry.role, 300),
      bio: cleanText(entry.bio, 8000),
      notes: cleanText(entry.notes, 12000),
      image: safeImageData(entry.image)
    };
  }

  function cleanStamp(stamp, index) {
    if (!stamp || typeof stamp !== 'object') return null;
    return {
      id: cleanId(stamp.id, `stamp-${index}`),
      type: cleanEnum(stamp.type, ['mountain', 'water', 'forest', 'city', 'dungeon', 'path', 'ruin', 'camp', 'note', 'label', 'location', 'quest', 'image'], 'note'),
      label: cleanText(stamp.label, 300),
      note: cleanText(stamp.note, 4000),
      image: safeImageData(stamp.image),
      linkedRegionId: cleanOptionalId(stamp.linkedRegionId),
      linkedTaskId: cleanOptionalId(stamp.linkedTaskId),
      linkedLane: cleanEnum(stamp.linkedLane, ['hooks', 'scenes', 'loose'], 'hooks'),
      x: cleanNumber(stamp.x, -500, 2100, 80),
      y: cleanNumber(stamp.y, -500, 1500, 80),
      size: cleanNumber(stamp.size, 24, 600, 84)
    };
  }

  function cleanPath(path, index) {
    if (!path || typeof path !== 'object') return null;
    const x1 = cleanNumber(path.x1, -500, 2100, 0);
    const y1 = cleanNumber(path.y1, -500, 1500, 0);
    const x2 = cleanNumber(path.x2, -500, 2100, 0);
    const y2 = cleanNumber(path.y2, -500, 1500, 0);
    return {
      id: cleanId(path.id, `path-${index}`),
      type: cleanEnum(path.type, ['path', 'trail', 'river', 'border', 'secret'], 'path'),
      label: cleanText(path.label, 120),
      x1,
      y1,
      x2,
      y2,
      cx: cleanNumber(path.cx, -1000, 2600, (x1 + x2) / 2),
      cy: cleanNumber(path.cy, -1000, 2000, (y1 + y2) / 2)
    };
  }

  function cleanWaterArea(area, index) {
    if (!area || typeof area !== 'object') return null;
    return {
      id: cleanId(area.id, `water-${index}`),
      type: 'water',
      label: cleanText(area.label, 120) || 'Water',
      x: cleanNumber(area.x, -500, 2100, 0),
      y: cleanNumber(area.y, -500, 1500, 0),
      w: cleanNumber(area.w, 20, 2100, 120),
      h: cleanNumber(area.h, 20, 1500, 120),
      customFill: cleanBoolean(area.customFill, false),
      points: cleanArray(area.points, 240, cleanPoint)
    };
  }

  function normalizeState(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const sourceMap = source.map && typeof source.map === 'object' ? source.map : {};
    const sourceTasks = source.tasks && typeof source.tasks === 'object' ? source.tasks : {};
    const sourceTables = source.tables && typeof source.tables === 'object' ? source.tables : {};
    const layers = sourceMap.layers && typeof sourceMap.layers === 'object' ? sourceMap.layers : {};
    const legacyPaths = sourceMap.paths || sourceMap.roads || [];
    const map = {
      ink: safeImageData(sourceMap.ink),
      background: safeImageData(sourceMap.background),
      stamps: cleanArray(sourceMap.stamps, 500, cleanStamp),
      paths: cleanArray(legacyPaths, 1000, cleanPath),
      waterAreas: cleanArray(sourceMap.waterAreas, 300, cleanWaterArea),
      layers: {
        background: cleanBoolean(layers.background, true),
        grid: cleanBoolean(layers.grid, true),
        ink: cleanBoolean(layers.ink, true),
        water: cleanBoolean(layers.water, true),
        paths: cleanBoolean(layers.paths, true),
        stamps: cleanBoolean(layers.stamps, true)
      },
      tool: cleanEnum(sourceMap.tool, ['draw', 'erase', 'symbol', 'label', 'location', 'quest', 'waterarea', 'pathline', 'connectpaths', 'move', 'delete'], 'draw'),
      brushColor: cleanColor(sourceMap.brushColor),
      brushSize: cleanNumber(sourceMap.brushSize, 1, 80, 6),
      brushStyle: cleanEnum(sourceMap.brushStyle, ['marker', 'pencil', 'rough'], 'marker'),
      pathStyle: cleanEnum(sourceMap.pathStyle, ['path', 'trail', 'river', 'border', 'secret'], 'path'),
      exportScale: cleanEnum(Number(sourceMap.exportScale), [1, 2, 3, 4], 2),
      exportTransparent: cleanBoolean(sourceMap.exportTransparent, false),
      gridType: cleanEnum(sourceMap.gridType, ['square', 'hex', 'none'], 'square'),
      gridSize: cleanNumber(sourceMap.gridSize, 16, 160, 40)
    };
    if (!source.map && Array.isArray(source.flowNodes)) {
      map.stamps = cleanArray(source.flowNodes, 500, (node, index) => cleanStamp({
        id: node?.id,
        type: 'note',
        label: node?.title,
        note: node?.text,
        image: node?.image,
        x: node?.x,
        y: node?.y,
        size: node?.image ? 120 : 86
      }, index));
    }
    const state = {
      theme: cleanEnum(source.theme, ['light', 'dark'], 'light'),
      campaignName: cleanText(source.campaignName, 240),
      campaignPremise: cleanText(source.campaignPremise, 12000),
      scratchpad: cleanText(source.scratchpad, 120000),
      regions: cleanArray(source.regions, 200, cleanRegion),
      tasks: {
        hooks: cleanArray(sourceTasks.hooks, 400, cleanTask),
        scenes: cleanArray(sourceTasks.scenes, 400, cleanTask),
        loose: cleanArray(sourceTasks.loose, 400, cleanTask)
      },
      history: cleanArray(source.history, 16, item => cleanText(item, 1000)),
      tables: {
        rumors: cleanArray(sourceTables.rumors, 500, cleanTableEntry),
        twists: cleanArray(sourceTables.twists, 500, cleanTableEntry)
      },
      encounters: cleanArray(source.encounters, 300, cleanEncounter),
      characters: cleanArray(source.characters, 200, cleanCharacter),
      map
    };
    if (byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) throw new Error('Campaign exceeds the storage limit.');
    return state;
  }

  function validateCampaignDocument(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Campaign file must contain an object.');
    if (document.fileType && document.fileType !== 'dm-drawing-board-campaign') throw new Error('Campaign file type is not supported.');
    const schema = Number(document.schemaVersion || 0);
    if (schema > SCHEMA_VERSION) throw new Error('Campaign file was created by a newer app version.');
    return normalizeState(document);
  }

  function assertImportSize(value) {
    if (byteLength(value) > MAX_IMPORT_BYTES) throw new Error('Campaign file exceeds the import limit.');
  }

  function sanitizeFilename(value, fallback = 'dm-drawing-board') {
    const cleaned = cleanText(value, 100).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return cleaned || fallback;
  }

  function isSafeExternalUrl(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === 'https:';
    } catch (_error) {
      return false;
    }
  }

  return {
    MAX_IMPORT_BYTES,
    MAX_STATE_BYTES,
    MAX_IMAGE_BYTES,
    SCHEMA_VERSION,
    assertImportSize,
    byteLength,
    cleanColor,
    cleanId,
    cleanText,
    isSafeExternalUrl,
    normalizeState,
    safeImageData,
    sanitizeFilename,
    validateCampaignDocument
  };
});
