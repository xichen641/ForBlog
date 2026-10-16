import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPublishDraft, needsPublishProperties, publishDefaults } from '../src/properties';
import { identity, safeName } from '../src/core';

test('plain Chinese note gets a complete valid editable publishing template', () => {
  const draft = publishDefaults('50_知识库/AI与LLM/PydanticAI/几个问题.md', {}, undefined, '2026-10-16T02:00:00.000Z');
  assert.equal(draft.title, '几个问题'); assert.equal(draft.categories, 'PydanticAI');
  assert.ok(safeName(draft.slug, true)); assert.match(draft.slug, /^post-[a-z0-9]{8}$/);
  const meta: Record<string, unknown> = { private: 'preserved' };
  applyPublishDraft(meta, draft);
  assert.equal(needsPublishProperties(meta), false); assert.equal(meta.private, 'preserved');
  assert.equal(identity({ source: 'note.md', body: '', meta }).id, draft.id);
});
test('invalid existing attributes are repaired and normalized without changing unrelated fields', () => {
  const draft = publishDefaults('folder/note.md', { blog_id: 12, blog_slug: '中文', date: 'invalid', updated: 'invalid', tags: 'python, Obsidian', categories: [12, 'AI'] });
  const meta: Record<string, unknown> = { updated: 'invalid', private: true };
  applyPublishDraft(meta, draft);
  assert.deepEqual(meta.tags, ['python', 'Obsidian']); assert.deepEqual(meta.categories, ['AI']);
  assert.equal(meta.updated, undefined); assert.equal(meta.private, true); assert.equal(needsPublishProperties(meta), false);
});
test('already exported identity and permalink override invalid note properties', () => {
  const draft = publishDefaults('moved/note.md', { blog_id: 'new-id', blog_slug: 'new-slug' }, { id: 'original', slug: 'fixed', date: '2025-01-01T00:00:00Z' });
  assert.equal(draft.id, 'original'); assert.equal(draft.slug, 'fixed'); assert.equal(draft.date, '2025-01-01T00:00:00Z');
});
test('template validates before writing, and unchanged valid metadata bypasses setup', () => {
  const draft = publishDefaults('note.md', {}), meta: Record<string, unknown> = {};
  assert.throws(() => applyPublishDraft(meta, { ...draft, date: 'bad' }), /有效/); assert.deepEqual(meta, {});
  assert.throws(() => applyPublishDraft(meta, { ...draft, slug: 'con' }), /保留/); assert.deepEqual(meta, {});
  applyPublishDraft(meta, draft); assert.equal(needsPublishProperties(meta), false);
  assert.equal(needsPublishProperties({ ...meta, blog_publish: false }), true);
  assert.equal(needsPublishProperties({ ...meta, tags: 'needs-normalization' }), true);
  assert.equal(needsPublishProperties({ ...meta, updated: 'bad' }), true);
});
