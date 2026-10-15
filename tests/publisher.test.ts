import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Publisher } from '../src/publisher';
import { inside, mirror, exists } from '../src/files';
import { deploy } from '../src/git';
import { run, redact } from '../src/process';
import { MemoryVault, note, temporary, blogFixture } from './helpers';

test('repeat exports preserve mtimes; asset edits and renames are incremental', async () => {
  const temp = await temporary();
  try {
    const settings = await blogFixture(temp.root); const vault = new MemoryVault();
    vault.notes.set('a.md', note('a', '![[image.png]]')); vault.notes.set('b.md', note('b')); vault.binaries.set('image.png', Buffer.from('first'));
    const publisher = new Publisher(settings, vault);
    const initial = await publisher.export(['a.md', 'b.md']); assert.equal(initial.changed, 2);
    const fileA = path.join(settings.blogDir, 'source/_posts/forblog/a.md'), fileB = path.join(settings.blogDir, 'source/_posts/forblog/b.md');
    const beforeA = (await fs.stat(fileA)).mtimeMs, beforeB = (await fs.stat(fileB)).mtimeMs;
    const again = await publisher.export(['a.md', 'b.md']); assert.equal(again.changed, 0); assert.equal(again.skipped, 2);
    assert.equal((await fs.stat(fileA)).mtimeMs, beforeA); assert.equal((await fs.stat(fileB)).mtimeMs, beforeB);
    vault.binaries.set('image.png', Buffer.from('second'));
    const updated = await publisher.export(['a.md', 'b.md']); assert.equal(updated.changed, 1); assert.equal(updated.skipped, 1);
    assert.equal(await exists(path.join(settings.blogDir, 'source', initial.plans[0]!.assets[0]!.path)), false);
    assert.equal((await fs.stat(fileB)).mtimeMs, beforeB);
    vault.notes.set('moved/a.md', vault.notes.get('a.md')!); vault.notes.delete('a.md');
    const moved = await publisher.export(['moved/a.md']); assert.equal(moved.changed, 0); assert.equal(moved.manifest.notes.a!.source, 'moved/a.md');
  } finally { await temp.cleanup(); }
});
test('preflight prevents partial export, path traversal and unmanaged overwrites', async () => {
  const temp = await temporary();
  try {
    const settings = await blogFixture(temp.root), vault = new MemoryVault();
    vault.notes.set('a.md', note('a')); vault.notes.set('b.md', note('b', '![[missing.png]]'));
    const publisher = new Publisher(settings, vault);
    await assert.rejects(publisher.export(['a.md', 'b.md']), /找不到/);
    assert.equal(await exists(path.join(settings.blogDir, 'source/_posts/forblog/a.md')), false);
    await assert.rejects(inside(settings.blogDir, '../outside'), /不安全/);
    const output = path.join(settings.blogDir, 'source/_posts/forblog'); await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'a.md'), 'manual');
    await assert.rejects(publisher.export(['a.md']), /拒绝覆盖/);
  } finally { await temp.cleanup(); }
});
test('failed publication keeps pending fingerprints; slug stays stable', async () => {
  const temp = await temporary();
  try {
    const settings = await blogFixture(temp.root, { deploy: { type: 'git', repo: path.join(temp.root, 'missing.git'), branch: 'main' } }), vault = new MemoryVault();
    vault.notes.set('a.md', note('a')); const publisher = new Publisher(settings, vault);
    await assert.rejects(publisher.publish(['a.md']), /依赖未安装/);
    assert.ok((await publisher.manifest()).notes.a); assert.deepEqual((await publisher.manifest()).published, {});
    vault.notes.set('a.md', note('a', 'same', { blog_slug: 'renamed' }));
    await assert.rejects(publisher.export(['a.md']), /网址已固定/);
  } finally { await temp.cleanup(); }
});
test('unpublish guards inbound links and only removes owned exports', async () => {
  const temp = await temporary();
  try {
    const settings = await blogFixture(temp.root), vault = new MemoryVault();
    vault.notes.set('a.md', note('a', '[[b]]')); vault.notes.set('b.md', note('b'));
    const publisher = new Publisher(settings, vault); await publisher.export(['a.md', 'b.md']);
    await assert.rejects(publisher.unpublish('b'), /解除/);
    await publisher.unpublish('a');
    assert.equal(await exists(path.join(settings.blogDir, 'source/_posts/forblog/a.md')), false);
    assert.equal(await exists(path.join(settings.blogDir, 'source/_posts/forblog/b.md')), true);
    assert.ok(vault.notes.has('a.md'));
  } finally { await temp.cleanup(); }
});
test('directory mirror writes only changed files and removes stale files', async () => {
  const temp = await temporary();
  try {
    const source = path.join(temp.root, 'source'), destination = path.join(temp.root, 'destination');
    await fs.mkdir(source); await fs.writeFile(path.join(source, 'a'), 'A'); await fs.writeFile(path.join(source, 'b'), 'B');
    assert.deepEqual(await mirror(source, destination), { written: 2, deleted: 0 });
    const before = (await fs.stat(path.join(destination, 'b'))).mtimeMs;
    assert.deepEqual(await mirror(source, destination), { written: 0, deleted: 0 });
    await fs.writeFile(path.join(source, 'a'), 'AA');
    assert.deepEqual(await mirror(source, destination), { written: 1, deleted: 0 });
    assert.equal((await fs.stat(path.join(destination, 'b'))).mtimeMs, before);
    await fs.unlink(path.join(source, 'a')); assert.deepEqual(await mirror(source, destination), { written: 0, deleted: 1 });
  } finally { await temp.cleanup(); }
});
test('real Git deployment to local bare repository is incremental and retries rejected pushes', async () => {
  const temp = await temporary();
  try {
    const settings = await blogFixture(temp.root), remote = path.join(temp.root, '中文 remote.git');
    await run('git', ['init', '--bare', remote], temp.root);
    await fs.mkdir(path.join(settings.blogDir, 'public')); await fs.writeFile(path.join(settings.blogDir, 'public/index.html'), 'one');
    const target = { repo: remote, branch: 'main' };
    const first = await deploy(settings.blogDir, target, 'git', () => {}); assert.equal(first.pushed, true);
    const second = await deploy(settings.blogDir, target, 'git', () => {}); assert.equal(second.pushed, false); assert.equal(second.written, 0); assert.equal(second.commit, first.commit);
    await fs.writeFile(path.join(settings.blogDir, 'public/index.html'), 'two');
    await fs.writeFile(path.join(remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await assert.rejects(deploy(settings.blogDir, target, 'git', () => {}));
    assert.equal((await run('git', ['--git-dir', remote, 'rev-parse', 'main'], temp.root)).stdout, first.commit);
    await fs.unlink(path.join(remote, 'hooks/pre-receive'));
    const retry = await deploy(settings.blogDir, target, 'git', () => {}); assert.equal(retry.pushed, true); assert.equal(retry.written, 0); assert.notEqual(retry.commit, first.commit);
  } finally { await temp.cleanup(); }
});
test('credentials in command errors are redacted', () => {
  assert.equal(redact('https://user:secret@github.com/x ghp_abcd123'), 'https://[redacted]@github.com/x [redacted]');
});
test('managed paths reject junctions and publish locks serialize concurrent windows', async () => {
  const temp = await temporary();
  try {
    const settings = await blogFixture(temp.root), vault = new MemoryVault();
    const outside = path.join(temp.root, 'outside'); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(settings.blogDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(inside(settings.blogDir, 'linked/file'), /符号链接/);
    const publisher = new Publisher(settings, vault);
    let unlock!: () => void, acquired!: () => void;
    const ready = new Promise<void>(resolve => acquired = resolve);
    const hold = new Promise<void>(resolve => unlock = resolve);
    const first = publisher.withLock(async () => { acquired(); await hold; });
    await ready;
    try { await assert.rejects(publisher.withLock(async () => {}), /正在执行/); }
    finally { unlock(); await first; }
    assert.equal(await exists(path.join(settings.blogDir, '.forblog/publish.lock')), false);
  } finally { await temp.cleanup(); }
});
