import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { articleMetadata, rewriteArticleVisibility } from '../src/visibility';
import { Publisher } from '../src/publisher';
import { parseNote } from '../src/core';
import { exists } from '../src/files';
import { run } from '../src/process';
import { MemoryVault, note, temporary, blogFixture, realHexo } from './helpers';

test('visibility updates preserve YAML comments/body/CRLF and support Hexo JSON and prefix-free headers', () => {
  const body = '正文\r\n\r\n---\r\n原文分隔线保持不变\r\n';
  const raw = '\uFEFF---\r\n# 保留注释\r\ntitle: 旧文\r\nprivate: keep\r\n---\r\n' + body;
  const hidden = rewriteArticleVisibility(raw, 'hidden');
  assert.ok(hidden.startsWith('\uFEFF---\r\n')); assert.ok(hidden.endsWith(body));
  assert.match(hidden, /# 保留注释/); assert.equal(articleMetadata(hidden).private, 'keep');
  assert.equal(articleMetadata(hidden).published, false);
  assert.equal(articleMetadata(rewriteArticleVisibility(hidden, 'public')).published, true);
  for (const value of ['title: 无前缀\n---\nBody\n', '"title": "JSON 旧文",\n"custom": "keep"\n;;;\nBody\n', ';;;\n"title": "JSON 有前缀"\n;;;\nBody\n']) {
    const result = rewriteArticleVisibility(value, 'hidden');
    assert.equal(articleMetadata(result).published, false); assert.ok(result.endsWith('Body\n'));
    assert.equal(articleMetadata(rewriteArticleVisibility(result, 'public')).published, true);
  }
  assert.equal(articleMetadata(rewriteArticleVisibility('# 无属性\n', 'hidden')).published, false);
  assert.throws(() => rewriteArticleVisibility('---\ntitle: broken\n', 'hidden'), /分隔符未闭合/);
  assert.throws(() => rewriteArticleVisibility('---\ntitle: [broken\n---\nBody', 'hidden'), /格式错误/);
});

test('mixed visibility roundtrip uses real Hexo/local Git, preserves originals and stays hidden through incremental sync', { timeout: 60_000 }, async () => {
  const temp = await temporary();
  try {
    const remote = path.join(temp.root, 'remote.git'); await run('git', ['init', '--bare', remote], temp.root);
    const settings = await blogFixture(temp.root, { render_drafts: true, deploy: { type: 'git', repo: remote, branch: 'main' } }); await realHexo(settings);
    const legacy = path.join(settings.blogDir, 'source/_posts/legacy.md'), legacyBody = '旧文章正文\r\n';
    await fs.writeFile(legacy, '---\r\ntitle: Legacy title\r\ncustom: keep\r\ndate: 2025-01-01\r\n---\r\n' + legacyBody);
    const vault = new MemoryVault(); vault.notes.set('a.md', note('a', 'Managed body\n![[image.png]]')); vault.notes.set('b.md', note('b', 'Unchanged'));
    vault.binaries.set('image.png', Buffer.from('original image'));
    const publisher = new Publisher(settings, vault), first = await publisher.publish(['a.md', 'b.md']);
    const original = vault.notes.get('a.md'), originalAsset = first.plans.find(plan => plan.id === 'a')!.assets[0]!.path;
    const choose = async () => (await publisher.listArticles()).filter(row => row.id === 'a' || row.origin === 'hexo');
    const hidden = await publisher.setArticleVisibility(await choose(), 'hidden'); assert.equal(hidden.count, 2); assert.equal(hidden.deployment!.pushed, true);
    assert.equal((await run('git', ['rev-list', '--count', `${first.deployment!.commit}..HEAD`], path.join(settings.blogDir, '.forblog/deploy'))).stdout, '1');
    assert.equal(await exists(path.join(settings.blogDir, 'public/posts/a/index.html')), false);
    assert.equal(await exists(path.join(settings.blogDir, 'public/legacy/index.html')), false);
    assert.equal(await exists(path.join(settings.blogDir, 'public/posts/b/index.html')), true);
    assert.equal(await exists(path.join(settings.blogDir, 'public', originalAsset)), false);
    assert.equal(await exists(path.join(settings.blogDir, 'source', originalAsset)), true);
    assert.doesNotMatch(await fs.readFile(path.join(settings.blogDir, 'public/index.html'), 'utf8'), /Article a|Legacy title/);
    assert.ok((await fs.readFile(legacy, 'utf8')).endsWith(legacyBody)); assert.equal(articleMetadata(await fs.readFile(legacy, 'utf8')).custom, 'keep');
    assert.equal(vault.notes.get('a.md'), original); assert.equal(vault.binaries.get('image.png')!.toString(), 'original image');
    assert.equal((await publisher.manifest()).published.a!.hidden, true);
    assert.equal((await publisher.manifest()).pendingVisibility, undefined);
    assert.equal((await choose()).every(row => row.visibility === 'hidden'), true);
    vault.notes.set('a.md', note('a', 'Updated while hidden\n![[image.png]]'));
    await publisher.publish(['a.md']);
    assert.equal(parseNote('a.md', await fs.readFile(path.join(settings.blogDir, 'source/_posts/forblog/a.md'), 'utf8')).meta.published, false);
    assert.equal(await exists(path.join(settings.blogDir, 'public/posts/a/index.html')), false);
    const restored = await publisher.setArticleVisibility(await choose(), 'public'); assert.equal(restored.count, 2);
    assert.match(await fs.readFile(path.join(settings.blogDir, 'public/posts/a/index.html'), 'utf8'), /Updated while hidden/);
    assert.equal(await exists(path.join(settings.blogDir, 'public/legacy/index.html')), true);
    assert.equal(await exists(path.join(settings.blogDir, 'public', originalAsset)), true);
    assert.equal(parseNote('a.md', vault.notes.get('a.md')!).meta.blog_publish, true);
    const unchanged = (await publisher.listArticles()).filter(row => row.id === 'a');
    const before = (await fs.stat(path.join(settings.blogDir, unchanged[0]!.key))).mtimeMs;
    assert.equal((await publisher.setArticleVisibility(unchanged, 'public')).count, 0);
    assert.equal((await fs.stat(path.join(settings.blogDir, unchanged[0]!.key))).mtimeMs, before);
    const source = path.join(settings.blogDir, unchanged[0]!.key);
    await fs.writeFile(source, rewriteArticleVisibility(await fs.readFile(source, 'utf8'), 'hidden'));
    await publisher.export(['a.md']);
    assert.equal((await publisher.manifest()).notes.a!.hidden, true);
    assert.equal((await publisher.listArticles()).find(row => row.id === 'a')!.visibilityPending, true);
    assert.equal(articleMetadata(await fs.readFile(source, 'utf8')).published, false);
  } finally { await temp.cleanup(); }
});

test('rejected visibility deployment retains desired state and supports retry for a legacy-only blog', { timeout: 60_000 }, async () => {
  const temp = await temporary();
  try {
    const remote = path.join(temp.root, 'remote.git'); await run('git', ['init', '--bare', remote], temp.root);
    const settings = await blogFixture(temp.root, { deploy: { type: 'git', repo: remote, branch: 'main' } }); await realHexo(settings);
    await fs.writeFile(path.join(settings.blogDir, 'source/_posts/legacy.md'), '---\ntitle: Legacy\n---\nBody\n');
    const publisher = new Publisher(settings, new MemoryVault()); await publisher.publish([]);
    await fs.writeFile(path.join(remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await assert.rejects(publisher.setArticleVisibility(await publisher.listArticles(), 'hidden'), /可见性已保存到本地.*部署未完成/);
    const rows = await publisher.listArticles(); assert.equal(rows[0]!.visibility, 'hidden'); assert.equal(rows[0]!.visibilityPending, true);
    assert.equal((await publisher.manifest()).pendingVisibility!['source/_posts/legacy.md'], 'hidden');
    await fs.unlink(path.join(remote, 'hooks/pre-receive'));
    assert.equal((await publisher.publish([])).deployment!.pushed, true);
    assert.equal((await publisher.manifest()).pendingVisibility, undefined);
    assert.equal(await exists(path.join(settings.blogDir, '.forblog/deploy/legacy/index.html')), false);
  } finally { await temp.cleanup(); }
});

test('visibility preflight rejects stale, duplicate, malformed and missing articles before any source changes', async () => {
  const temp = await temporary();
  try {
    const settings = await blogFixture(temp.root), publisher = new Publisher(settings, new MemoryVault());
    const one = path.join(settings.blogDir, 'source/_posts/a.md'), two = path.join(settings.blogDir, 'source/_posts/b.md');
    const original = '---\ntitle: Good\n---\nBody\n'; await fs.writeFile(one, original); await fs.writeFile(two, '---\ntitle: [bad\n---\nBody');
    let rows = await publisher.listArticles();
    await assert.rejects(publisher.setArticleVisibility(rows, 'hidden', { deploy: false }), /属性格式有误/);
    assert.equal(await fs.readFile(one, 'utf8'), original);
    await assert.rejects(publisher.setArticleVisibility([rows[0]!, rows[0]!], 'hidden', { deploy: false }), /重复文章/);
    await fs.appendFile(one, 'Changed');
    await assert.rejects(publisher.setArticleVisibility([rows.find(row => row.key.endsWith('/a.md'))!], 'hidden', { deploy: false }), /已改变/);
    rows = await publisher.listArticles(); await fs.unlink(one);
    await assert.rejects(publisher.setArticleVisibility([rows.find(row => row.key.endsWith('/a.md'))!], 'hidden', { deploy: false }), /已改变/);
    assert.equal(await exists(path.join(settings.blogDir, '.forblog/manifest.json')), false);
  } finally { await temp.cleanup(); }
});

test('visibility guards inbound and outgoing managed links and new links to hidden notes become text', async () => {
  const temp = await temporary();
  try {
    const settings = await blogFixture(temp.root), vault = new MemoryVault(); vault.notes.set('a.md', note('a', '[[b]]')); vault.notes.set('b.md', note('b'));
    const publisher = new Publisher(settings, vault); await publisher.export(['a.md', 'b.md']);
    let rows = await publisher.listArticles();
    await assert.rejects(publisher.setArticleVisibility(rows.filter(row => row.id === 'b'), 'hidden', { deploy: false }), /一同隐藏/);
    await publisher.setArticleVisibility(rows, 'hidden', { deploy: false }); rows = await publisher.listArticles();
    await assert.rejects(publisher.setArticleVisibility(rows.filter(row => row.id === 'a'), 'public', { deploy: false }), /一同设为公开/);
    await publisher.setArticleVisibility(rows, 'public', { deploy: false });
    vault.notes.set('a.md', note('a', 'No link')); await publisher.export(['a.md']);
    await publisher.setArticleVisibility((await publisher.listArticles()).filter(row => row.id === 'b'), 'hidden', { deploy: false });
    vault.notes.set('a.md', note('a', '[[b]]')); const plans = await publisher.check(['a.md']);
    assert.equal(plans[0]!.linkTargets.length, 0); assert.doesNotMatch(plans[0]!.markdown, /\]\(https:/);
    assert.ok(plans[0]!.warnings.length);
  } finally { await temp.cleanup(); }
});
