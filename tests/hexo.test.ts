import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Publisher } from '../src/publisher';
import { run } from '../src/process';
import { exists } from '../src/files';
import { PreviewServer } from '../src/preview';
import { MemoryVault, note, temporary, blogFixture, realHexo } from './helpers';

test('real Hexo + local Git: publish, no-op, asset-only update, preview and unpublish', { timeout: 90_000 }, async () => {
  const temp = await temporary(); const preview = new PreviewServer();
  try {
    const remote = path.join(temp.root, 'remote.git'); await run('git', ['init', '--bare', remote], temp.root);
    const settings = await blogFixture(temp.root, { deploy: { type: 'git', repo: remote, branch: 'main' } });
    await realHexo(settings);
    const vault = new MemoryVault(); vault.notes.set('a.md', note('a', '# Hello\n![[图片.png|300]]')); vault.notes.set('b.md', note('b', 'Unchanged')); vault.binaries.set('附件/图片.png', Buffer.from('first image'));
    const publisher = new Publisher(settings, vault);
    const first = await publisher.publish(['a.md', 'b.md']); assert.equal(first.deployment!.pushed, true); assert.equal(first.pending, false);
    const article = await fs.readFile(path.join(settings.blogDir, 'public/posts/a/index.html'), 'utf8'); assert.match(article, /Hello/); assert.match(article, /\/project\/assets\/forblog\/a/);
    const unchangedFile = path.join(settings.blogDir, '.forblog/deploy/posts/b/index.html'); const before = (await fs.stat(unchangedFile)).mtimeMs;
    const again = await publisher.publish(['a.md', 'b.md']); assert.equal(again.changed, 0); assert.equal(again.built, false); assert.equal(again.deployment!.pushed, false);
    const oldAsset = first.plans[0]!.assets[0]!.path;
    vault.binaries.set('附件/图片.png', Buffer.from('second image'));
    const next = await publisher.publish(['a.md']); assert.equal(next.changed, 1); assert.equal(next.deployment!.pushed, true);
    assert.equal((await fs.stat(unchangedFile)).mtimeMs, before);
    assert.equal(await exists(path.join(settings.blogDir, 'public', oldAsset)), false);
    const diff = await run('git', ['diff', '--name-only', first.deployment!.commit, next.deployment!.commit], path.join(settings.blogDir, '.forblog/deploy'));
    assert.match(diff.stdout, /posts\/a\/index.html/); assert.doesNotMatch(diff.stdout, /posts\/b\//);
    vault.notes.set('a.md', note('a', '# Preview draft'));
    const draft = await publisher.publish(['a.md'], { preview: true }); assert.equal(draft.pending, true);
    assert.equal((await publisher.manifest()).published.a!.fingerprint, next.manifest.published.a!.fingerprint);
    // A project subpath is served locally with the same prefix.
    await preview.start(path.join(settings.blogDir, 'public'), 'https://blog.example.test/project', 19487);
    const response = await fetch(preview.url('https://blog.example.test/project', 'a', 19487)); assert.equal(response.status, 200); assert.match(await response.text(), /Preview draft/);
    const outside = await fetch('http://127.0.0.1:19487/_config.yml'); assert.equal(outside.status, 404);
    await preview.stop();
    await publisher.unpublish('a'); await publisher.publish([]);
    assert.equal(await exists(path.join(settings.blogDir, '.forblog/deploy/posts/a/index.html')), false);
    assert.equal((await publisher.manifest()).published.a, undefined);
    assert.ok(vault.notes.has('a.md'));
  } finally { await preview.stop(); await temp.cleanup(); }
});
test('real Fluid theme renders exported article and preserves project asset paths', { timeout: 60_000 }, async () => {
  const temp = await temporary();
  try {
    const settings = await blogFixture(temp.root, { theme: 'fluid' }); await realHexo(settings);
    await fs.unlink(path.join(settings.blogDir, 'scripts/fixture.js'));
    await fs.writeFile(path.join(settings.blogDir, 'package.json'), JSON.stringify({
      name: 'fluid-test', hexo: { version: '7.3.0' }, dependencies: { 'hexo-renderer-marked': '7.0.1', 'hexo-renderer-ejs': '2.0.0', 'hexo-renderer-stylus': '3.0.1', 'hexo-theme-fluid': '1.9.8', 'hexo-generator-index': '4.0.0' }
    }));
    const vault = new MemoryVault(); vault.notes.set('a.md', note('a', '# Fluid smoke\n![[图.png|400]]\n```js\nconst value = "{{ literal }}";\n```'));
    vault.binaries.set('附件/图.png', Buffer.from('test image'));
    const result = await new Publisher(settings, vault).publish(['a.md'], { preview: true });
    assert.equal(result.built, true);
    const html = await fs.readFile(path.join(settings.blogDir, 'public/posts/a/index.html'), 'utf8');
    assert.match(html, /Fluid smoke/); assert.match(html, /\/project\/assets\/forblog\/a\//); assert.match(html, /literal/);
    assert.equal(await exists(path.join(settings.blogDir, 'public/css/main.css')), true);
  } finally { await temp.cleanup(); }
});
test('unpublishing an article that was only previewed removes its cached HTML', { timeout: 30_000 }, async () => {
  const temp = await temporary();
  try {
    const settings = await blogFixture(temp.root); await realHexo(settings);
    const vault = new MemoryVault(); vault.notes.set('a.md', note('a'));
    const publisher = new Publisher(settings, vault);
    await publisher.publish(['a.md'], { preview: true });
    assert.deepEqual((await publisher.manifest()).published, {});
    await publisher.unpublish('a');
    const next = await publisher.publish([], { preview: true });
    assert.equal(next.built, true);
    assert.equal(await exists(path.join(settings.blogDir, 'public/posts/a/index.html')), false);
  } finally { await temp.cleanup(); }
});
