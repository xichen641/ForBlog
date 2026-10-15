import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, parseNote, markedForPublishing } from '../src/core';
import { emptyManifest } from '../src/types';
import { MemoryVault, note, time } from './helpers';
const site = 'https://blog.example.test/project';
test('converts Chinese images, dimensions, PDFs and opted-in note links', async () => {
  const vault = new MemoryVault();
  vault.notes.set('研究/a.md', note('a', '# 研究\n![[架构 图.png|600x400]]\n![[论文.pdf#page=3]]\n[[b|参考文章]]'));
  vault.notes.set('研究/b.md', note('b'));
  vault.binaries.set('附件/架构 图.png', Buffer.from('image'));
  vault.binaries.set('附件/论文.pdf', Buffer.from('%PDF-test'));
  const [a] = await prepare(vault, ['研究/a.md', '研究/b.md'], emptyManifest(), site, time);
  assert.equal(a!.assets.length, 2);
  assert.match(a!.markdown, /width="600" height="400"/);
  assert.match(a!.markdown, /\/project\/assets\/forblog\/a\//);
  assert.match(a!.markdown, /#page=3/);
  assert.match(a!.markdown, /\[参考文章\]\(\/project\/posts\/b\/\)/);
  assert.deepEqual(a!.linkTargets, ['b']);
});
test('does not transform code or math, and removes private comments', async () => {
  const vault = new MemoryVault();
  vault.notes.set('a.md', note('a', '%%secret [[missing]]%%\n`[[example]]`\n```md\n![[missing.png]]\n%%keep%%\n```\n$[[math]]$\nPublic', { password: 'PRIVATE' }));
  const [a] = await prepare(vault, ['a.md'], emptyManifest(), site, time);
  assert.doesNotMatch(a!.markdown, /secret|PRIVATE|password|blog_publish|blog_id/);
  assert.match(a!.markdown, /`\[\[example\]\]`/);
  assert.match(a!.markdown, /!\[\[missing.png\]\]/);
  assert.match(a!.markdown, /%%keep%%/);
  assert.match(a!.markdown, /\$\[\[math\]\]\$/);
});
test('unpublished links become plain text, never implicitly publish another note', async () => {
  const vault = new MemoryVault(); vault.notes.set('a.md', note('a', '[[private|参考]]')); vault.notes.set('private.md', 'Private');
  const [a] = await prepare(vault, ['a.md'], emptyManifest(), site, time);
  assert.match(a!.markdown, /参考/); assert.equal(a!.warnings.length, 1); assert.equal(a!.linkTargets.length, 0);
});
test('asset-only changes alter the fingerprint', async () => {
  const vault = new MemoryVault(); vault.notes.set('a.md', note('a', '![[image.png]]')); vault.binaries.set('image.png', Buffer.from('first'));
  const [a] = await prepare(vault, ['a.md'], emptyManifest(), site, time);
  vault.binaries.set('image.png', Buffer.from('second'));
  const [b] = await prepare(vault, ['a.md'], emptyManifest(), site, time);
  assert.notEqual(a!.fingerprint, b!.fingerprint); assert.notEqual(a!.assets[0]!.path, b!.assets[0]!.path);
});
test('missing images, transclusions and block links fail explicitly', async () => {
  const vault = new MemoryVault(); vault.notes.set('b.md', note('b'));
  for (const body of ['![[missing.png]]', '![[b]]', '[[b#^block]]']) {
    vault.notes.set('a.md', note('a', body));
    await assert.rejects(prepare(vault, ['a.md', 'b.md'], emptyManifest(), site, time));
  }
});
test('reference-style local images are copied and links are rewritten', async () => {
  const vault = new MemoryVault(); vault.notes.set('a.md', note('a', '![diagram][pic]\n\n[pic]: <image with spaces.png>'));
  vault.binaries.set('image with spaces.png', Buffer.from('image'));
  const [a] = await prepare(vault, ['a.md'], emptyManifest(), site, time);
  assert.equal(a!.assets.length, 1); assert.match(a!.markdown, /<img src=/);
});
test('duplicate ids/slugs and non-public selections fail before export', async () => {
  const vault = new MemoryVault(); vault.notes.set('a.md', note('a')); vault.notes.set('b.md', note('a'));
  await assert.rejects(prepare(vault, ['a.md'], emptyManifest(), site, time), /重复/);
  vault.notes.set('b.md', 'Private');
  await assert.rejects(prepare(vault, ['b.md'], emptyManifest(), site, time), /发布属性/);
});
test('ignores malformed YAML in unrelated private notes', async () => {
  const vault = new MemoryVault(); vault.notes.set('a.md', note('a')); vault.notes.set('private.md', '---\nprivate: [broken\n---\nsecret');
  const plans = await prepare(vault, ['a.md'], emptyManifest(), site, time); assert.equal(plans.length, 1);
});
test('publishing marker only counts inside front matter', () => {
  assert.equal(markedForPublishing('---\nprivate: true\n---\nblog_publish: true'), false);
  assert.equal(markedForPublishing(note('a')), true);
  assert.equal(markedForPublishing('\uFEFF' + note('a')), true);
  assert.throws(() => parseNote('a', '---\na: 1\na: 2\n---\n'), /格式错误/);
});
test('private metadata changes do not change the public fingerprint', async () => {
  const vault = new MemoryVault(); vault.notes.set('a.md', note('a', 'same', { private: 'one' }));
  const [a] = await prepare(vault, ['a.md'], emptyManifest(), site, time);
  vault.notes.set('a.md', note('a', 'same', { private: 'two' }));
  const [b] = await prepare(vault, ['a.md'], emptyManifest(), site, time);
  assert.equal(a!.fingerprint, b!.fingerprint);
});
test('unclosed private comments fail; code examples do not consume prose comments', async () => {
  const vault = new MemoryVault(); vault.notes.set('a.md', note('a', '`%%example`\n%%private%%\nPublic'));
  const [a] = await prepare(vault, ['a.md'], emptyManifest(), site, time);
  assert.match(a!.markdown, /`%%example`/); assert.doesNotMatch(a!.markdown, /private/);
  vault.notes.set('a.md', note('a', '%% unclosed private content'));
  await assert.rejects(prepare(vault, ['a.md'], emptyManifest(), site, time), /未闭合/);
});
test('Dataview and reserved article names are rejected', async () => {
  const vault = new MemoryVault(); vault.notes.set('a.md', note('a', '```dataview\nLIST\n```'));
  await assert.rejects(prepare(vault, ['a.md'], emptyManifest(), site, time), /Dataview/);
  for (const id of ['constructor', 'con', 'nul']) {
    vault.notes.set('a.md', note(id));
    await assert.rejects(prepare(vault, ['a.md'], emptyManifest(), site, time), /blog_id/);
  }
});
