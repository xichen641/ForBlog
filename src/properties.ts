import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { safeName } from './core';

export interface PublishDraft {
  id: string;
  title: string;
  slug: string;
  date: string;
  updated: string;
  tags: string;
  categories: string;
}
export interface ExistingArticle { id: string; slug: string; date: string }
const validDate = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
const validList = (value: unknown): boolean => value == null || Array.isArray(value) && value.every(item => typeof item === 'string');
function listText(value: unknown): string {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string').join(', ') : typeof value === 'string' ? value : '';
}

export function needsPublishProperties(meta: Record<string, unknown>): boolean {
  return meta.blog_publish !== true || !safeName(meta.blog_id) || !safeName(meta.blog_slug, true)
    || typeof meta.title !== 'string' || !meta.title.trim() || !validDate(meta.date)
    || meta.updated !== undefined && !validDate(meta.updated)
    || !validList(meta.tags) || !validList(meta.categories);
}

export function publishDefaults(source: string, meta: Record<string, unknown>, existing?: ExistingArticle, now = new Date().toISOString()): PublishDraft {
  const basename = path.posix.basename(source, '.md');
  const id = existing?.id ?? (safeName(meta.blog_id) ? meta.blog_id : randomUUID());
  const stem = basename.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  const suffix = id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return {
    id,
    title: typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : basename,
    slug: existing?.slug ?? (safeName(meta.blog_slug, true) ? meta.blog_slug : `${stem || 'post'}-${suffix}`),
    date: validDate(meta.date) ? meta.date : existing?.date ?? now,
    updated: validDate(meta.updated) ? meta.updated : '',
    tags: listText(meta.tags),
    categories: meta.categories === undefined ? path.posix.dirname(source).split('/').filter(part => part !== '.').at(-1) ?? '' : listText(meta.categories)
  };
}

export function applyPublishDraft(meta: Record<string, unknown>, draft: PublishDraft): void {
  if (!safeName(draft.id) || !safeName(draft.slug, true)) throw new Error('网址名称只能包含小写字母、数字和连字符，且不能是系统保留名称');
  if (!draft.title.trim()) throw new Error('请输入文章标题');
  if (!validDate(draft.date) || draft.updated.trim() && !validDate(draft.updated)) throw new Error('请输入有效的发布日期和更新时间，例如 2026-10-16T10:00:00+08:00');
  meta.title = draft.title.trim();
  meta.blog_id = draft.id;
  meta.blog_slug = draft.slug;
  meta.blog_publish = true;
  meta.date = draft.date.trim();
  if (draft.updated.trim()) meta.updated = draft.updated.trim();
  else delete meta.updated;
  meta.tags = draft.tags.split(/[,，]/).map(value => value.trim()).filter(Boolean);
  meta.categories = draft.categories.split(/[,，]/).map(value => value.trim()).filter(Boolean);
}
