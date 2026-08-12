const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('fs/promises');
const path = require('path');

const root = path.resolve(__dirname, '..');

async function source(file) {
  return readFile(path.join(root, file), 'utf8');
}

test('exposes accessible file and status controls', async () => {
  const html = await source('index.html');
  assert.match(html, /id="open-file-btn"/);
  assert.match(html, /id="open-file-help" class="sr-only"/);
  assert.match(html, /id="dice-result"[^>]*role="status"/);
  assert.match(html, /id="encounter-output"[^>]*aria-live="polite"/);
  assert.match(html, /id="privacy-btn"/);
  assert.match(html, /id="privacy-help" class="sr-only"/);
});

test('includes concise privacy information', async () => {
  const renderer = await source('renderer.js');
  assert.match(renderer, /title: 'Privacy Policy'/);
  assert.match(renderer, /GitHub Pages/);
  assert.match(renderer, /Electron App/);
  assert.match(renderer, /does not collect, sell, or share personal information/);
});

test('provides modal focus management', async () => {
  const html = await source('index.html');
  const renderer = await source('renderer.js');
  assert.match(html, /class="overlay-card" role="dialog" aria-modal="true"/);
  assert.match(renderer, /getFocusableElements/);
  assert.match(renderer, /returnFocus\?\.isConnected/);
  assert.match(renderer, /overlayReturnFocus\?\.isConnected/);
});
