const { cp, mkdir, rm, writeFile } = require('fs/promises');
const path = require('path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist-pages');
const files = ['index.html', 'styles.css', 'renderer.js', 'platform.js', 'LICENSE'];

async function buildPages() {
  await rm(output, { recursive: true, force: true });
  await mkdir(path.join(output, 'shared'), { recursive: true });
  for (const file of files) await cp(path.join(root, file), path.join(output, file));
  await cp(path.join(root, 'shared', 'security.js'), path.join(output, 'shared', 'security.js'));
  await writeFile(path.join(output, '.nojekyll'), '', 'utf8');
  return output;
}

if (require.main === module) {
  buildPages().then(directory => console.log(directory)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildPages };
