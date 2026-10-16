import path from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Root } from 'mdast';
import { hash } from './files';
import type { Asset, ExportedNote, Manifest, NotePlan, VaultSource } from './types';

const ENGINE = 'forblog-1';
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
export interface ParsedNote { source: string; body: string; meta: Record<string, unknown> }
export function safeName(value: unknown, slug = false): value is string {
  return typeof value === 'string' && (slug ? /^[a-z0-9][a-z0-9-]{0,99}$/ : /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/).test(value)
    && !Object.hasOwn(Object.prototype, value) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value);
}
export function markedForPublishing(raw: string): boolean {
  const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  return !!header && /^blog_publish:\s*true\s*(?:#.*)?$/m.test(header[1]!);
}
export function parseNote(source: string, raw: string): ParsedNote {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) return { source, body: normalized, meta: {} };
  const doc = parseDocument(match[1]!, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`${source}：Front Matter 格式错误：${doc.errors[0]!.message}`);
  const meta: unknown = doc.toJS();
  if (meta !== null && (typeof meta !== 'object' || Array.isArray(meta))) throw new Error(`${source}：Front Matter 必须是对象`);
  return { source, meta: (meta ?? {}) as Record<string, unknown>, body: normalized.slice(match[0].length) };
}
export function identity(note: ParsedNote): { id: string; slug: string } {
  const id = note.meta.blog_id, slug = note.meta.blog_slug;
  if (note.meta.blog_publish !== true) throw new Error(`${note.source}：请先设置 blog_publish: true`);
  if (!safeName(id)) throw new Error(`${note.source}：缺少有效 blog_id，请执行「设置发布属性」`);
  if (!safeName(slug, true)) throw new Error(`${note.source}：blog_slug 只能包含小写字母、数字和连字符，且不能使用系统保留名称`);
  return { id, slug };
}
function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some(x => typeof x !== 'string')) throw new Error(`${name} 必须是字符串数组`);
  return value;
}
function dateString(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error('date/updated 必须是有效日期字符串');
  return value;
}
function html(value: string): string { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function label(value: string): string { return value.replace(/([\\\[\]])/g, '\\$1').replace(/\n/g, ' '); }
function webUrl(siteUrl: string, relative: string): string {
  const base = new URL(siteUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('博客网址需要是不含凭据、查询参数和锚点的 HTTP(S) 地址');
  base.pathname = base.pathname.replace(/\/$/, '') + '/' + relative.split('/').map(encodeURIComponent).join('/');
  return base.pathname;
}
export const articleUrl = (site: string, slug: string): string => new URL(webUrl(site, `posts/${slug}/`), site).href;
interface Edit { start: number; end: number; text: string }
interface NodeLike { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: NodeLike[]; url?: string; alt?: string | null; title?: string | null; identifier?: string; value?: string }

export async function planNote(note: ParsedNote, vault: VaultSource, routes: Map<string, { id: string; slug: string }>, previous: ExportedNote | undefined, siteUrl: string, now: string): Promise<NotePlan> {
  const { id, slug } = identity(note);
  if (previous && previous.slug !== slug) throw new Error(`${note.source}：文章网址已固定为 ${previous.slug}；请先下架再更改 blog_slug`);
  const title = typeof note.meta.title === 'string' && note.meta.title.trim() ? note.meta.title.trim() : path.posix.basename(note.source, '.md');
  const date = dateString(note.meta.date, previous?.date ?? now);
  const tags = stringList(note.meta.tags, 'tags');
  const categories = stringList(note.meta.categories, 'categories');
  const explicitUpdated = note.meta.updated === undefined ? undefined : dateString(note.meta.updated, now);
  const assets = new Map<string, Asset>();
  const warnings = new Set<string>();
  const targets = new Set<string>();

  // Comments are removed before parsing, but code and math are left untouched.
  const initialTree = parser.parse(note.body) as Root;
  const protectedRanges: [number, number][] = [];
  function protect(node: NodeLike): void {
    if (['code', 'inlineCode', 'math', 'inlineMath'].includes(node.type)) {
      protectedRanges.push([node.position!.start.offset!, node.position!.end.offset!]); return;
    }
    node.children?.forEach(protect);
  }
  protect(initialTree);
  const comments: Edit[] = [];
  let cursor = 0;
  while (cursor < note.body.length) {
    const start = note.body.indexOf('%%', cursor);
    if (start < 0) break;
    const protectedRange = protectedRanges.find(([from, to]) => start >= from && start < to);
    if (protectedRange) { cursor = protectedRange[1]; continue; }
    const end = note.body.indexOf('%%', start + 2);
    if (end < 0) throw new Error(`${note.source}：存在未闭合的 Obsidian 私有注释 %%`);
    comments.push({ start, end: end + 2, text: '' }); cursor = end + 2;
  }
  let body = note.body;
  for (const comment of comments.reverse()) body = body.slice(0, comment.start) + body.slice(comment.end);
  const tree = parser.parse(body) as Root;
  const edits: Edit[] = [];
  const definitions = new Map<string, NodeLike>();
  function collect(node: NodeLike): void { if (node.type === 'definition') definitions.set(node.identifier!, node); node.children?.forEach(collect); }
  collect(tree);

  async function convert(destination: string, display: string, embed: boolean, dimensions?: string): Promise<string> {
    if (/^(https?:|mailto:|tel:)/i.test(destination)) return embed ? `![${label(display)}](<${destination}>)` : `[${label(display)}](<${destination}>)`;
    if (/^[a-z][a-z\d+.-]*:/i.test(destination) || destination.startsWith('//')) throw new Error(`${note.source}：不支持的本地链接或协议：${destination}`);
    if (destination.startsWith('#')) return `[${label(display)}](<${destination}>)`;
    const split = destination.indexOf('#');
    const rawPath = split < 0 ? destination : destination.slice(0, split);
    const fragment = split < 0 ? '' : destination.slice(split + 1);
    let decoded: string;
    try { decoded = decodeURIComponent(rawPath); } catch { throw new Error(`${note.source}：无效的链接编码 ${destination}`); }
    const resolved = vault.resolveLink(decoded, note.source);
    if (!resolved) throw new Error(`${note.source}：找不到链接目标 ${destination}`);
    if (resolved.endsWith('.md')) {
      if (embed) throw new Error(`${note.source}：首版暂不支持笔记嵌入，请改为链接：${destination}`);
      const route = routes.get(resolved);
      if (!route) { warnings.add(`未发布的笔记链接已转为文字：${destination}`); return label(display); }
      if (fragment) throw new Error(`${note.source}：跨笔记标题/块锚点尚未支持，请改为整篇链接：${destination}`);
      targets.add(route.id);
      return `[${label(display)}](${webUrl(siteUrl, `posts/${route.slug}/`)})`;
    }
    const ext = path.posix.extname(resolved).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.pdf', '.mp3', '.mp4', '.ogg', '.wav'].includes(ext)) throw new Error(`${note.source}：暂不支持发布附件类型 ${ext || '(无扩展名)'}`);
    const data = await vault.readBinary(resolved);
    const digest = hash(data);
    const filename = path.posix.basename(resolved).replace(/[<>:"|?*\u0000-\u001f]/g, '_').toLowerCase();
    const assetPath = `assets/forblog/${id}/${digest.slice(0, 12)}-${filename}`;
    assets.set(assetPath, { path: assetPath, data, hash: digest });
    const url = webUrl(siteUrl, assetPath);
    if (ext === '.pdf' && embed) {
      if (fragment && !/^page=\d+(?:&height=\d+)?$/.test(fragment)) throw new Error(`${note.source}：PDF 只支持 #page=N 或 #page=N&height=N`);
      return `<iframe src="${html(url + (fragment ? '#' + fragment : ''))}" title="${html(display)}" width="100%" height="800" loading="lazy"></iframe>\n\n[下载 PDF](${url})`;
    }
    if (fragment) throw new Error(`${note.source}：暂不支持该附件锚点：${destination}`);
    if (embed && ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'].includes(ext)) {
      if (dimensions && !/^\d{1,4}(x\d{1,4})?$/.test(dimensions)) throw new Error(`图片尺寸无效：${dimensions}`);
      const [width, height] = dimensions?.split('x') ?? [];
      return `<img src="${html(url)}" alt="${html(display)}"${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''} loading="lazy">`;
    }
    if (embed && ['.mp3', '.ogg', '.wav', '.mp4'].includes(ext)) return `<${ext === '.mp4' ? 'video' : 'audio'} controls src="${html(url)}"></${ext === '.mp4' ? 'video' : 'audio'}>`;
    return `[${label(display)}](${url})`;
  }

  async function visit(node: NodeLike, inLink = false): Promise<void> {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (['code', 'inlineCode', 'math', 'inlineMath'].includes(node.type)) {
      if (node.type === 'code' && /^(dataview|dataviewjs)$/.test((node as unknown as { lang?: string }).lang ?? '')) throw new Error(`${note.source}：Dataview 查询需要先转为静态内容`);
      if (node.type === 'code' && (node as unknown as { lang?: string }).lang === 'mermaid') warnings.add('Mermaid 需要在 Hexo 主题中配置对应渲染支持');
      if (node.type === 'math' || node.type === 'inlineMath') warnings.add('数学公式需要在 Hexo 中配置对应渲染器和主题支持');
      return;
    }
    if (start === undefined || end === undefined) return;
    if (node.type === 'html') {
      const raw = body.slice(start, end);
      if (/(?:src|href)\s*=\s*["'](?:file:|[a-z]:[\\/]|\.\.?\/)/i.test(raw) || /!\[\[|\[\[/.test(raw)) throw new Error(`${note.source}：HTML 中的本地路径/双链需要先改成 Markdown 附件链接`);
      return;
    }
    if (node.type === 'image' || node.type === 'link') {
      const destination = node.url!;
      // External links and site-root paths keep their original syntax.
      if (/^(https?:|mailto:|tel:)/i.test(destination) || destination.startsWith('/') && !destination.startsWith('//')) return;
      const display = node.type === 'image' ? node.alt ?? '' : body.slice(node.children?.[0]?.position?.start.offset ?? start + 1, node.children?.at(-1)?.position?.end.offset ?? end - 1);
      edits.push({ start, end, text: await convert(destination, display, node.type === 'image') }); return;
    }
    if (node.type === 'imageReference' || node.type === 'linkReference') {
      const def = definitions.get(node.identifier!);
      if (!def) throw new Error(`找不到引用链接定义：${node.identifier}`);
      if (/^(https?:|mailto:|tel:)/i.test(def.url!) || def.url!.startsWith('/') && !def.url!.startsWith('//')) return;
      edits.push({ start, end, text: await convert(def.url!, node.alt ?? node.identifier!, node.type === 'imageReference') }); return;
    }
    if (node.type === 'definition') return;
    if (node.type === 'text' && !inLink) {
      const raw = body.slice(start, end);
      const pattern = /(!?)\[\[([^\]\n]+)\]\]/g;
      for (const match of raw.matchAll(pattern)) {
        const at = match.index!;
        if ((raw.slice(0, at).match(/\\+$/)?.[0].length ?? 0) % 2) continue;
        const [destination, ...parts] = match[2]!.split('|');
        if (destination!.startsWith('#')) throw new Error(`${note.source}：标题/块双链尚未支持，请使用标准 Markdown 锚点链接`);
        const alias = parts.join('|');
        const dimensions = match[1] && /^\d+(x\d+)?$/.test(alias) ? alias : undefined;
        const display = dimensions ? path.posix.basename(destination!) : alias || path.posix.basename(destination!, '.md');
        edits.push({ start: start + at, end: start + at + match[0].length, text: await convert(destination!, display, !!match[1], dimensions) });
      }
    }
    for (const child of node.children ?? []) await visit(child, inLink || node.type === 'link');
  }
  await visit(tree);
  let converted = body;
  for (const edit of edits.sort((a, b) => b.start - a.start)) converted = converted.slice(0, edit.start) + edit.text + converted.slice(edit.end);
  const publicMeta = { title, date, tags, categories, permalink: `posts/${slug}/`, layout: 'post', disableNunjucks: true };
  const fingerprint = hash(JSON.stringify({ engine: ENGINE, publicMeta, explicitUpdated, converted, assets: [...assets.values()].map(a => [a.path, a.hash]).sort() }));
  const updated = explicitUpdated ?? (previous?.fingerprint === fingerprint ? previous.updated : now);
  const markdown = `---\n${stringify({ ...publicMeta, ...(previous?.hidden ? { published: false } : {}), updated }).trimEnd()}\n---\n${converted.trimEnd()}\n`;
  return { id, source: note.source, slug, title, date, fingerprint, markdown, assets: [...assets.values()], linkTargets: [...targets].sort(), warnings: [...warnings] };
}

export async function prepare(vault: VaultSource, requested: string[], manifest: Manifest, siteUrl: string, now: string): Promise<NotePlan[]> {
  // Index identities first, so duplicates fail before any blog writes.
  const notes = new Map<string, ParsedNote>();
  const ids = new Map<string, string>();
  const slugs = new Map<string, string>();
  for (const source of await vault.listNotes()) {
    const raw = await vault.readNote(source);
    if (!markedForPublishing(raw) && !requested.includes(source)) continue;
    const note = parseNote(source, raw);
    if (note.meta.blog_publish !== true) continue;
    const { id, slug } = identity(note);
    if (ids.has(id)) throw new Error(`blog_id 重复：${source} / ${ids.get(id)}`);
    if (slugs.has(slug)) throw new Error(`blog_slug 重复：${source} / ${slugs.get(slug)}`);
    ids.set(id, source); slugs.set(slug, source); notes.set(source, note);
  }
  const routes = new Map<string, { id: string; slug: string }>();
  for (const [id, entry] of Object.entries(manifest.notes)) {
    if (entry.hidden) continue;
    const source = ids.get(id) ?? entry.source;
    routes.set(source, { id, slug: entry.slug });
  }
  for (const source of requested) {
    const note = notes.get(source);
    if (!note) throw new Error(`${source}：未设置有效的发布属性`);
    if (!manifest.notes[identity(note).id]?.hidden) routes.set(source, identity(note));
  }
  const plans: NotePlan[] = [];
  for (const source of new Set(requested)) {
    const note = notes.get(source)!;
    const { id, slug } = identity(note);
    if (Object.entries(manifest.notes).some(([otherId, entry]) => otherId !== id && entry.slug === slug)) throw new Error(`网址已被另一篇导出文章占用：${slug}`);
    plans.push(await planNote(note, vault, routes, manifest.notes[id], siteUrl, now));
  }
  return plans;
}
