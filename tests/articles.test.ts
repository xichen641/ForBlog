import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { Publisher } from '../src/publisher';
import { parseNote } from '../src/core';
import { run } from '../src/process';
import { exists } from '../src/files';
import { articlesInGroup, categoryPaths, groupArticles } from '../src/article-groups';
import type { BlogArticle } from '../src/types';
import { MemoryVault, note, temporary, blogFixture, realHexo } from './helpers';

async function legacyPost(blog: string, name = 'legacy.md', title = '旧 Hexo 文章') {
  const file = path.join(blog, 'source/_posts', name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `---\ntitle: ${title}\ndate: '2025-01-02'\n---\n旧文章正文。\n`);
  return file;
}

const article = (key: string, date: string, categories: string[][] = []): BlogArticle => ({ key, title: key, date, categoryPaths: categories, origin: 'hexo', state: 'local', fingerprint: key });

test('categories follow Hexo scalar, flat hierarchy and multiple hierarchy rules', () => {
  assert.deepEqual(categoryPaths('工具'), [['工具']]);
  assert.deepEqual(categoryPaths(['Projects', 'CLIP_Reid_Change']), [['Projects', 'CLIP_Reid_Change']]);
  assert.deepEqual(categoryPaths([['技术', '工具'], '随笔', ['技术', '工具'], [], null]), [['技术', '工具'], ['随笔']]);
  assert.deepEqual(categoryPaths(['书籍阅读 - 成长']), [['书籍阅读 - 成长']]);
  assert.deepEqual(categoryPaths([null, '', {}, ['工具', null, '']]), [['工具']]);
  assert.deepEqual(categoryPaths(undefined), []);
});

test('archive tree sorts years/months descending and retains undated or invalid posts', () => {
  const rows = [article('older', '2025-03-01'), article('recent', '2026-10-16T02:19:00Z'), article('late', '2025-10-02'), article('missing', ''), article('invalid', '2025-02-30')];
  const groups = groupArticles(rows, 'archive');
  assert.deepEqual(groups.map(group => group.label), ['2026 年', '2025 年', '日期未知']);
  assert.deepEqual(groups[1]!.children.map(group => group.label), ['10 月', '03 月']);
  assert.deepEqual(articlesInGroup(groups[1]!).map(row => row.key), ['late', 'older']);
  assert.deepEqual(groups[2]!.articles.map(row => row.key), ['missing', 'invalid']);
  assert.equal(groups.reduce((sum, group) => sum + articlesInGroup(group).length, 0), rows.length);
});

test('category tree keeps parent articles, multiple paths and uncategorized posts with unique group membership', () => {
  const rows = [article('both', '2025-01-01', [['技术'], ['技术', '工具'], ['随笔']]), article('parent', '2025-01-01', [['技术']]), article('none', '')];
  const groups = groupArticles(rows, 'category'), technology = groups.find(group => group.label === '技术')!;
  assert.deepEqual(technology.articles.map(row => row.key), ['both', 'parent']);
  assert.deepEqual(technology.children.map(group => group.label), ['工具']);
  assert.deepEqual(articlesInGroup(technology).map(row => row.key), ['both', 'parent']);
  assert.deepEqual(groups.at(-1)!.articles.map(row => row.key), ['none']);
  assert.equal(groups.at(-1)!.label, '未分类');
  assert.deepEqual(groupArticles([], 'category'), []);
});

test('catalog reads category metadata from both managed and legacy sources and falls back to a cached date', async () => {
  const temp = await temporary();
  try {
    const settings = await blogFixture(temp.root), vault = new MemoryVault(), publisher = new Publisher(settings, vault);
    const file = await legacyPost(settings.blogDir);
    await fs.writeFile(file, '---\ntitle: 旧文\ndate: ""\ncategory: [Projects, CLIP_Reid_Change]\n---\nBody');
    await fs.writeFile(path.join(settings.blogDir, 'db.json'), JSON.stringify({ models: { Post: [{ source: '_posts/legacy.md', date: '2025-03-01T10:00:00Z' }] } }));
    vault.notes.set('a.md', note('a', 'Body', { categories: ['中间件', '异步任务'] }));
    await publisher.export(['a.md']);
    const rows = await publisher.listArticles();
    assert.deepEqual(rows.find(row => row.id === 'a')!.categoryPaths, [['中间件', '异步任务']]);
    const legacy = rows.find(row => row.origin === 'hexo')!;
    assert.deepEqual(legacy.categoryPaths, [['Projects', 'CLIP_Reid_Change']]);
    assert.equal(legacy.date, '2025-03-01T10:00:00Z');
  } finally { await temp.cleanup(); }
});

test('catalog includes nested Hexo posts, managed posts, hidden/malformed posts and cached renderer formats', async () => {
  const temp = await temporary();
  try {
    const settings = await blogFixture(temp.root), vault = new MemoryVault(), publisher = new Publisher(settings, vault);
    await legacyPost(settings.blogDir, 'nested/中文.md');
    await legacyPost(settings.blogDir, 'hidden.md');
    await fs.appendFile(path.join(settings.blogDir, 'source/_posts/hidden.md'), '');
    await fs.writeFile(path.join(settings.blogDir, 'source/_posts/hidden.md'), '---\ntitle: 隐藏文章\npublished: false\n---\nBody');
    await fs.writeFile(path.join(settings.blogDir, 'source/_posts/broken.md'), '---\ntitle: [broken\n---\nBody');
    await fs.writeFile(path.join(settings.blogDir, 'source/_posts/image.png'), 'image');
    await fs.writeFile(path.join(settings.blogDir, 'source/_posts/custom.rst'), 'A rendered post');
    await fs.writeFile(path.join(settings.blogDir, 'db.json'), JSON.stringify({ models: { Post: [{ source: '_posts/custom.rst', title: 'RST 文章' }, { source: '../../private.md', title: 'bad cache' }] } }));
    vault.notes.set('a.md', note('a'));
    await publisher.export(['a.md']);
    const rows = await publisher.listArticles();
    assert.equal(rows.length, 5);
    assert.equal(rows.find(row => row.id === 'a')!.origin, 'forblog'); assert.equal(rows.find(row => row.id === 'a')!.state, 'pending');
    assert.equal(rows.find(row => row.title === '隐藏文章')!.state, 'hidden');
    assert.ok(rows.find(row => row.key.endsWith('broken.md'))!.warning);
    assert.equal(rows.find(row => row.key.endsWith('custom.rst'))!.title, 'RST 文章');
    assert.equal(rows.find(row => row.title === '旧 Hexo 文章')!.origin, 'hexo');
    await fs.writeFile(path.join(settings.blogDir, 'db.json'), '{invalid cache');
    assert.equal((await publisher.listArticles()).length, 4);
  } finally { await temp.cleanup(); }
});

test('mixed batch archives only selected posts, preserves originals/shared assets and deploys once', { timeout: 60_000 }, async () => {
  const temp = await temporary();
  try {
    const remote = path.join(temp.root, 'remote.git'); await run('git', ['init', '--bare', remote], temp.root);
    const settings = await blogFixture(temp.root, { deploy: { type: 'git', repo: remote, branch: 'main' } });
    await realHexo(settings);
    const legacy = await legacyPost(settings.blogDir), originalLegacy = await fs.readFile(legacy, 'utf8');
    await fs.mkdir(path.join(settings.blogDir, 'source/images')); await fs.writeFile(path.join(settings.blogDir, 'source/images/shared.png'), 'shared');
    const vault = new MemoryVault(); vault.notes.set('a.md', note('a', '原稿正文\n![[image.png]]')); vault.notes.set('b.md', note('b', '保留文章'));
    vault.binaries.set('image.png', Buffer.from('original image'));
    const publisher = new Publisher(settings, vault), initial = await publisher.publish(['a.md', 'b.md']);
    const rows = await publisher.listArticles(), selected = rows.filter(row => row.id === 'a' || row.origin === 'hexo');
    assert.equal(selected.length, 2);
    const originalBody = parseNote('a.md', vault.notes.get('a.md')!).body;
    const removed = await publisher.unpublishArticles(selected, { updateMarkers: async articles => {
      for (const article of articles) if (article.id) {
        const parsed = parseNote('a.md', vault.notes.get('a.md')!); parsed.meta.blog_publish = false;
        vault.notes.set('a.md', `---\n${stringify(parsed.meta)}---\n${parsed.body}`);
      }
    } });
    assert.equal(removed.count, 2); assert.equal(removed.deployment!.pushed, true);
    assert.equal(await fs.readFile(path.join(settings.blogDir, removed.backup, 'source/_posts/legacy.md'), 'utf8'), originalLegacy);
    assert.equal(parseNote('a.md', vault.notes.get('a.md')!).body, originalBody);
    assert.equal(parseNote('a.md', vault.notes.get('a.md')!).meta.blog_publish, false);
    assert.equal(vault.binaries.get('image.png')!.toString(), 'original image');
    assert.equal(await exists(path.join(settings.blogDir, 'public/posts/a/index.html')), false);
    assert.equal(await exists(path.join(settings.blogDir, 'public/legacy/index.html')), false);
    assert.equal(await exists(path.join(settings.blogDir, 'public/posts/b/index.html')), true);
    assert.equal(await fs.readFile(path.join(settings.blogDir, 'source/images/shared.png'), 'utf8'), 'shared');
    assert.ok(await exists(path.join(settings.blogDir, removed.backup, 'source', initial.plans[0]!.assets[0]!.path)));
    assert.equal(await exists(path.join(settings.blogDir, 'source', initial.plans[0]!.assets[0]!.path)), false);
    const manifest = await publisher.manifest();
    assert.deepEqual(Object.keys(manifest.published), ['b']); assert.ok(manifest.withdrawn!.a); assert.equal(manifest.pendingWithdrawal, undefined);
    const deployment = path.join(settings.blogDir, '.forblog/deploy');
    assert.equal((await run('git', ['rev-list', '--count', `${initial.deployment!.commit}..HEAD`], deployment)).stdout, '1');
    assert.deepEqual((await publisher.listArticles()).map(row => row.id), ['b']);
  } finally { await temp.cleanup(); }
});

test('stale/forged/duplicate selection and external inbound links reject the entire batch before moving files', async () => {
  const temp = await temporary();
  try {
    const settings = await blogFixture(temp.root), vault = new MemoryVault(), publisher = new Publisher(settings, vault);
    const legacy = await legacyPost(settings.blogDir);
    vault.notes.set('a.md', note('a', '[[b]]')); vault.notes.set('b.md', note('b'));
    await publisher.export(['a.md', 'b.md']);
    let rows = await publisher.listArticles(), old = rows.find(row => row.origin === 'hexo')!, b = rows.find(row => row.id === 'b')!;
    await assert.rejects(publisher.unpublishArticles([old, b], { deploy: false }), /引用文章一同下架/);
    assert.equal(await exists(legacy), true); assert.equal(await exists(path.join(settings.blogDir, '.forblog/trash')), false);
    await fs.appendFile(legacy, '\nChanged');
    await assert.rejects(publisher.unpublishArticles([old], { deploy: false }), /已改变/);
    await assert.rejects(publisher.unpublishArticles([{ ...old, key: '../outside.md' }], { deploy: false }), /已改变/);
    rows = await publisher.listArticles(); old = rows.find(row => row.origin === 'hexo')!;
    await assert.rejects(publisher.unpublishArticles([old, old], { deploy: false }), /重复文章/);
    await publisher.unpublishArticles(rows, { deploy: false });
    assert.equal((await publisher.listArticles()).length, 0);
    assert.ok(vault.notes.has('a.md')); assert.ok(vault.notes.has('b.md'));
  } finally { await temp.cleanup(); }
});

test('legacy-only withdrawal survives rejected push and retries without losing its backup', { timeout: 60_000 }, async () => {
  const temp = await temporary();
  try {
    const remote = path.join(temp.root, 'remote.git'); await run('git', ['init', '--bare', remote], temp.root);
    const settings = await blogFixture(temp.root, { deploy: { type: 'git', repo: remote, branch: 'main' } }); await realHexo(settings);
    const legacy = await legacyPost(settings.blogDir), publisher = new Publisher(settings, new MemoryVault());
    const first = await publisher.publish([]);
    const rows = await publisher.listArticles();
    await fs.writeFile(path.join(remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await assert.rejects(publisher.unpublishArticles(rows), /下架已保存到本地.*部署未完成/);
    const pending = await publisher.manifest(); assert.equal(pending.pendingWithdrawal!.count, 1);
    assert.equal(pending.lastCommit, first.deployment!.commit); assert.equal(await exists(legacy), false);
    assert.equal(await exists(path.join(settings.blogDir, pending.pendingWithdrawal!.backup, 'source/_posts/legacy.md')), true);
    await fs.unlink(path.join(remote, 'hooks/pre-receive'));
    const retried = await publisher.publish([]); assert.equal(retried.deployment!.pushed, true);
    assert.equal((await publisher.manifest()).pendingWithdrawal, undefined);
    assert.equal(await exists(path.join(settings.blogDir, 'public/legacy/index.html')), false);
  } finally { await temp.cleanup(); }
});

test('missing managed source still withdraws its record and backups, and explicit export can republish', async () => {
  const temp = await temporary();
  try {
    const settings = await blogFixture(temp.root), vault = new MemoryVault(); vault.notes.set('a.md', note('a'));
    const publisher = new Publisher(settings, vault); await publisher.export(['a.md']);
    await fs.unlink(path.join(settings.blogDir, 'source/_posts/forblog/a.md'));
    const row = (await publisher.listArticles())[0]!; assert.equal(row.state, 'missing');
    await publisher.unpublishArticles([row], { deploy: false });
    assert.ok((await publisher.manifest()).withdrawn!.a);
    await publisher.export(['a.md']);
    assert.equal((await publisher.manifest()).withdrawn!.a, undefined);
    assert.equal((await publisher.listArticles()).length, 1);
  } finally { await temp.cleanup(); }
});

test('legacy withdrawal keeps a durable clean-build requirement when the first rebuild fails', { timeout: 30_000 }, async () => {
  const temp = await temporary();
  try {
    const remote = path.join(temp.root, 'remote.git'); await run('git', ['init', '--bare', remote], temp.root);
    const settings = await blogFixture(temp.root, { deploy: { type: 'git', repo: remote, branch: 'main' } });
    await legacyPost(settings.blogDir);
    const publisher = new Publisher(settings, new MemoryVault());
    await assert.rejects(publisher.unpublishArticles(await publisher.listArticles()), /部署未完成.*依赖未安装/);
    assert.equal((await publisher.manifest()).rebuildRequired, true);
    assert.equal((await publisher.manifest()).pendingWithdrawal!.count, 1);
    await realHexo(settings);
    await publisher.publish([]);
    assert.equal((await publisher.manifest()).rebuildRequired, undefined);
    assert.equal((await publisher.manifest()).pendingWithdrawal, undefined);
    assert.equal(await exists(path.join(settings.blogDir, 'public/legacy/index.html')), false);
  } finally { await temp.cleanup(); }
});
