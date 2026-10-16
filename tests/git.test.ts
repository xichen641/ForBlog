import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deploy } from '../src/git';
import { run } from '../src/process';
import { exists } from '../src/files';
import { temporary, blogFixture } from './helpers';

async function remoteFixture(root: string) {
  const settings = await blogFixture(root), remote = path.join(root, 'remote.git'), seed = path.join(root, 'seed');
  await run('git', ['init', '--bare', remote], root);
  await run('git', ['--git-dir', remote, 'config', 'uploadpack.allowFilter', 'true'], root);
  await fs.mkdir(seed); await run('git', ['init', '-b', 'main'], seed);
  await run('git', ['config', 'user.name', 'Test'], seed); await run('git', ['config', 'user.email', 'test@localhost'], seed);
  await fs.writeFile(path.join(seed, '.nojekyll'), '');
  for (let index = 0; index < 3; index++) {
    await fs.writeFile(path.join(seed, 'index.html'), `remote-${index}`);
    await run('git', ['add', '-A'], seed); await run('git', ['commit', '-m', `version-${index}`], seed);
  }
  await run('git', ['push', remote, 'main'], seed);
  await fs.mkdir(path.join(settings.blogDir, 'public')); await fs.writeFile(path.join(settings.blogDir, 'public/index.html'), 'remote-2');
  return { settings, seed, remote, target: { repo: pathToFileURL(remote).href, branch: 'main' }, directory: path.join(settings.blogDir, '.forblog/deploy') };
}

test('first deployment shallow clones existing history and no-op preserves the remote commit', async () => {
  const temp = await temporary();
  try {
    const fixture = await remoteFixture(temp.root), lines: string[] = [];
    const first = await deploy(fixture.settings.blogDir, fixture.target, 'git', line => lines.push(line));
    assert.equal(first.pushed, false);
    assert.equal((await run('git', ['rev-parse', '--is-shallow-repository'], fixture.directory)).stdout, 'true');
    assert.equal((await run('git', ['rev-list', '--count', 'HEAD'], fixture.directory)).stdout, '1');
    assert.ok(lines.some(line => line.includes('浅克隆'))); assert.ok(lines.some(line => /Receiving objects|Cloning into/.test(line)));
    assert.ok(lines.some(line => line.includes('获取部署分支')));
    assert.equal((await deploy(fixture.settings.blogDir, fixture.target, 'git', () => {})).commit, first.commit);
  } finally { await temp.cleanup(); }
});

test('cancelled first clone removes staging and can be retried successfully', async () => {
  const temp = await temporary();
  try {
    const fixture = await remoteFixture(temp.root), controller = new AbortController(), lines: string[] = [];
    await assert.rejects(deploy(fixture.settings.blogDir, fixture.target, 'git', line => {
      lines.push(line); if (line.includes('Cloning into')) controller.abort();
    }, controller.signal), /取消/);
    assert.ok(lines.some(line => line.includes('已清理未完成')));
    assert.equal(await exists(fixture.directory), false);
    assert.deepEqual((await fs.readdir(path.dirname(fixture.directory))).filter(name => name.startsWith('deploy-initializing-')), []);
    assert.equal((await deploy(fixture.settings.blogDir, fixture.target, 'git', () => {})).pushed, false);
  } finally { await temp.cleanup(); }
});

test('shallow deployment fast-forwards remote advances and retries a rejected local commit', async () => {
  const temp = await temporary();
  try {
    const fixture = await remoteFixture(temp.root);
    await deploy(fixture.settings.blogDir, fixture.target, 'git', () => {});
    await fs.writeFile(path.join(fixture.seed, 'index.html'), 'remote-3');
    await run('git', ['add', '-A'], fixture.seed); await run('git', ['commit', '-m', 'remote advance'], fixture.seed);
    await run('git', ['push', fixture.remote, 'main'], fixture.seed);
    await fs.writeFile(path.join(fixture.settings.blogDir, 'public/index.html'), 'remote-3');
    assert.equal((await deploy(fixture.settings.blogDir, fixture.target, 'git', () => {})).pushed, false);
    await fs.writeFile(path.join(fixture.settings.blogDir, 'public/index.html'), 'local change');
    await fs.writeFile(path.join(fixture.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await assert.rejects(deploy(fixture.settings.blogDir, fixture.target, 'git', () => {}), /Git 推送博客/);
    const pending = (await run('git', ['rev-parse', 'HEAD'], fixture.directory)).stdout;
    await fs.unlink(path.join(fixture.remote, 'hooks/pre-receive'));
    const retry = await deploy(fixture.settings.blogDir, fixture.target, 'git', () => {});
    assert.equal(retry.pushed, true); assert.equal(retry.commit, pending); assert.equal(retry.written, 0);
  } finally { await temp.cleanup(); }
});

test('first publish can replace remote-only media without downloading its blob', async () => {
  const temp = await temporary();
  try {
    const fixture = await remoteFixture(temp.root);
    await fs.writeFile(path.join(fixture.seed, 'old-media.bin'), Buffer.alloc(1024 * 1024, 7));
    await run('git', ['add', '-A'], fixture.seed); await run('git', ['commit', '-m', 'old media'], fixture.seed);
    const media = (await run('git', ['rev-parse', 'HEAD:old-media.bin'], fixture.seed)).stdout;
    const original = (await run('git', ['rev-parse', 'HEAD'], fixture.seed)).stdout;
    await run('git', ['push', fixture.remote, 'main'], fixture.seed);
    await fs.writeFile(path.join(fixture.settings.blogDir, 'public/index.html'), 'new site');
    const result = await deploy(fixture.settings.blogDir, fixture.target, 'git', () => {});
    assert.equal(result.pushed, true);
    const missing = await run('git', ['rev-list', '--objects', '--missing=print', original], fixture.directory);
    assert.ok(missing.stdout.includes(`?${media}`), 'obsolete media must remain unfetched');
    assert.equal((await run('git', ['--git-dir', fixture.remote, 'ls-tree', '--name-only', 'main'], temp.root)).stdout, '.nojekyll\nindex.html');
  } finally { await temp.cleanup(); }
});
