const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('fs/promises');
const path = require('path');

const root = path.resolve(__dirname, '..');

async function source(file) {
  return readFile(path.join(root, file), 'utf8');
}

test('uses standard desktop startup', async () => {
  const packageJson = JSON.parse(await source('package.json'));
  assert.equal(packageJson.scripts.start, 'electron .');
  assert.equal(packageJson.main, 'electron/main.js');
  assert.equal(packageJson.devDependencies.electron, '43.2.0');
});
