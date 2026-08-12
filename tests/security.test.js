const test = require('node:test');
const assert = require('node:assert/strict');
const security = require('../shared/security');

const pixel = 'data:image/png;base64,iVBORw0KGgo=';

test('normalizes imported state', () => {
  const state = security.normalizeState({
    theme: 'unknown',
    campaignName: 'A'.repeat(400),
    regions: [{ id: 'bad id"', name: '<img>', image: 'data:image/svg+xml;base64,PHN2Zz4=' }],
    map: { brushColor: 'url(https://example.com)', paths: [{ type: 'evil', x1: Infinity }] }
  });
  assert.equal(state.theme, 'light');
  assert.equal(state.campaignName.length, 240);
  assert.equal(state.regions[0].name, '<img>');
  assert.equal(state.regions[0].image, '');
  assert.match(state.regions[0].id, /^[a-z0-9][a-z0-9_-]{0,79}$/i);
  assert.equal(state.map.brushColor, '#000000');
  assert.equal(state.map.paths[0].type, 'path');
  assert.equal(state.map.paths[0].x1, 0);
});

test('allows raster data only', () => {
  assert.equal(security.safeImageData(pixel), pixel);
  assert.equal(security.safeImageData('data:image/svg+xml;base64,PHN2Zz4='), '');
  assert.equal(security.safeImageData('https://example.com/a.png'), '');
});

test('rejects unsupported documents', () => {
  assert.throws(() => security.validateCampaignDocument([]));
  assert.throws(() => security.validateCampaignDocument({ fileType: 'other' }));
  assert.throws(() => security.validateCampaignDocument({ schemaVersion: security.SCHEMA_VERSION + 1 }));
});

test('limits imported content', () => {
  assert.throws(() => security.assertImportSize('x'.repeat(security.MAX_IMPORT_BYTES + 1)));
  assert.doesNotThrow(() => security.assertImportSize('{}'));
});

test('sanitizes filenames', () => {
  assert.equal(security.sanitizeFilename('../../My Campaign'), 'my-campaign');
  assert.equal(security.sanitizeFilename('', 'fallback'), 'fallback');
});

test('matches package metadata', () => {
  const packageJson = require('../package.json');
  const packageLock = require('../package-lock.json');
  assert.equal(packageJson.version, '1.2.4');
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.equal(packageLock.packages[''].devDependencies.electron, packageJson.devDependencies.electron);
  assert.equal(packageJson.main, 'electron/main.js');
});
