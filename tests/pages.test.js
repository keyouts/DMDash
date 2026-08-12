const test = require('node:test');
const assert = require('node:assert/strict');
const { access, readFile } = require('fs/promises');
const path = require('path');
const { buildPages } = require('../scripts/build-pages');

test('builds static pages output', async () => {
  const output = await buildPages();
  for (const file of ['index.html', 'styles.css', 'renderer.js', 'platform.js', 'shared/security.js', '.nojekyll']) {
    await access(path.join(output, file));
  }
  const html = await readFile(path.join(output, 'index.html'), 'utf8');
  const renderer = await readFile(path.join(output, 'renderer.js'), 'utf8');
  assert.match(html, /shared\/security\.js/);
  assert.match(html, /platform\.js/);
  assert.match(html, /id="privacy-btn"/);
  assert.match(renderer, /title: 'Privacy Policy'/);
  assert.doesNotMatch(html, /electron\/main\.js/);
});
