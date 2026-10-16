import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { Script } from 'node:vm';
import { builtinModules } from 'node:module';
import { parse } from '@adobe/css-tools';

const root = new URL('../', import.meta.url);
const json = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const manifest = await json('manifest.json');
const pkg = await json('package.json');
const lock = await json('package-lock.json');
const versions = await json('versions.json');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(pkg.version, manifest.version);
assert.equal(lock.version, manifest.version);
assert.equal(lock.packages[''].version, manifest.version);
assert.equal(versions[manifest.version], manifest.minAppVersion);
assert.equal(manifest.isDesktopOnly, true, 'Node APIs require a desktop-only plugin');
assert.match(manifest.id, /^[a-z0-9-]+$/);
assert.ok(!manifest.id.includes('obsidian'));
assert.ok(manifest.name && manifest.author);
assert.ok(manifest.description.length <= 250 && manifest.description.endsWith('.'));
const tag = process.argv[2];
if (tag) assert.equal(tag, manifest.version, 'Release tag must match manifest.version without a v prefix');
for (const file of ['README.md', 'LICENSE', `docs/releases/${manifest.version}.md`]) {
  assert.ok((await stat(new URL(file, root))).size > 0, `${file} is required`);
}
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  const source = await readFile(new URL(file, root));
  const packaged = await readFile(new URL(`dist/${manifest.id}/${file}`, root));
  assert.ok(source.length > 0 && source.equals(packaged), `${file}: package differs from source`);
}
const script = await readFile(new URL('main.js', root), 'utf8');
new Script(script, { filename: 'main.js' });
assert.ok(script.includes('Third-party notices for ForBlog.'));
assert.ok(!script.includes('sourceMappingURL='), 'Release must not contain a development source map');
const meta = await json('dist/build-meta.json');
const allowed = new Set(['obsidian', ...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
for (const output of Object.values(meta.outputs)) {
  for (const item of output.imports) assert.ok(item.external && allowed.has(item.path), `Unexpected runtime import: ${item.path}`);
  assert.ok(Object.entries(output.inputs).every(([name, data]) => data.bytesInOutput === 0 || !/node_modules\/(hexo[^/]*|katex|braces|sprintf-js)\//.test(name)), 'Development renderers must not be bundled');
}
parse(await readFile(new URL('styles.css', root), 'utf8'));
console.log(`Release ${manifest.version} validated: metadata, assets, JavaScript, CSS and licenses.`);
