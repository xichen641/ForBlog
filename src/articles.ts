import * as fs from 'node:fs/promises';
import path from 'node:path';
import { articleMetadata } from './visibility';
import { categoryPaths } from './article-groups';
import { exists, hash, inside, walk } from './files';
import type { BlogArticle, Manifest } from './types';

export async function listBlogArticles(blog: string, manifest: Manifest): Promise<BlogArticle[]> {
  const root = await inside(blog, 'source/_posts');
  const names = await exists(root) ? await walk(root) : [];
  const cached = new Map<string, Record<string, unknown>>();
  try {
    const db = JSON.parse(await fs.readFile(await inside(blog, 'db.json'), 'utf8')) as { models?: { Post?: Record<string, unknown>[] } };
    if (Array.isArray(db.models?.Post)) for (const post of db.models.Post) if (typeof post.source === 'string') cached.set(`source/${post.source}`, post);
  } catch (error) {
    // A cache is optional and may predate the current source. It never grants
    // deletion authority: every selectable row must still be a local post.
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const owned = new Map(Object.entries(manifest.notes).map(([id, note]) => [`source/_posts/forblog/${id}.md`, { id, note }]));
  const keys = new Set(names.filter(name => /\.(md|markdown|mkd|mkdn|mdown|html|htm)$/i.test(name) || cached.has(`source/_posts/${name}`)).map(name => `source/_posts/${name}`));
  for (const key of owned.keys()) keys.add(key);
  const articles: BlogArticle[] = [];
  for (const key of keys) {
    const file = await inside(blog, key), owner = owned.get(key), cache = cached.get(key);
    const raw = await exists(file) ? await fs.readFile(file, 'utf8') : undefined;
    let meta: Record<string, unknown> = {}, warning: string | undefined;
    if (raw !== undefined) {
      try { meta = articleMetadata(raw); } catch { warning = '文章属性格式有误，请修复后修改可见性；仍可备份下架。'; }
    }
    const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : owner?.note.title ?? (typeof cache?.title === 'string' ? cache.title : path.posix.basename(key, path.posix.extname(key)));
    const date = typeof meta.date === 'string' && meta.date.trim() ? meta.date : owner?.note.date ?? (typeof cache?.date === 'string' ? cache.date : '');
    articles.push({
      key, title, date, categoryPaths: categoryPaths(meta.categories || meta.category), origin: owner ? 'forblog' : 'hexo', fingerprint: raw === undefined ? 'missing' : hash(raw),
      visibility: meta.published === false || owner?.note.hidden ? 'hidden' : 'public', visibilityPending: !!manifest.pendingVisibility?.[key],
      state: raw === undefined ? 'missing' : meta.published === false ? 'hidden' : owner ? manifest.published[owner.id]?.fingerprint === owner.note.fingerprint ? 'published' : 'pending' : 'local',
      id: owner?.id, noteSource: owner?.note.source, warning
    });
  }
  return articles.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title, 'zh-CN') || a.key.localeCompare(b.key));
}

export function resolveArticleSelection(selected: BlogArticle[], current: BlogArticle[], action = '下架'): BlogArticle[] {
  if (!selected.length) throw new Error(`请先勾选要${action}的文章`);
  const rows = new Map(current.map(row => [row.key, row])), seen = new Set<string>();
  const resolved = selected.map(row => {
    if (seen.has(row.key)) throw new Error(`${action}列表包含重复文章`);
    seen.add(row.key);
    const fresh = rows.get(row.key);
    if (!fresh || fresh.fingerprint !== row.fingerprint || fresh.id !== row.id || fresh.origin !== row.origin) throw new Error(`文章已改变，请刷新列表后重新选择：${row.title}`);
    return fresh;
  });
  return resolved;
}

export function validateArticleSelection(selected: BlogArticle[], current: BlogArticle[], manifest: Manifest): BlogArticle[] {
  const resolved = resolveArticleSelection(selected, current);
  const ids = new Set(resolved.flatMap(row => row.id ? [row.id] : []));
  const references = Object.entries(manifest.notes).filter(([id, note]) => !ids.has(id) && note.linkTargets.some(target => ids.has(target)));
  if (references.length) throw new Error(`请先解除其他文章对所选文章的链接并重新发布，或将引用文章一同下架：${references.map(([, note]) => note.title).join('、')}`);
  return resolved;
}
