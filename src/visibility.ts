import { isMap, parseDocument } from 'yaml';
import type { ArticleVisibility } from './types';

// Hexo accepts YAML/JSON headers with or without a leading separator. Keep
// the body byte-for-byte, including CRLF, when changing the published flag.
function frontMatter(raw: string) {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '', text = raw.slice(bom.length);
  const prefix = /^(-{3,}|;{3,})\r?\n([\s\S]*?)\r?\n\1(?:\r?\n|$)/.exec(text);
  const suffix = !/^(-{3,}|;{3,})/.test(text) ? /^([\s\S]+?)\r?\n(-{3,}|;{3,})(?:\r?\n|$)/.exec(text) : null;
  if (!prefix && !suffix && /^(-{3,}|;{3,})/.test(text)) throw new Error('文章属性分隔符未闭合');
  const match = prefix ?? suffix, separator = prefix?.[1] ?? suffix?.[2] ?? '---';
  const header = prefix?.[2] ?? suffix?.[1] ?? '';
  const body = match ? text.slice(match[0].length) : text;
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const json = separator.startsWith(';');
  const doc = json ? undefined : parseDocument(header, { uniqueKeys: true });
  if (doc?.errors.length) throw new Error(`文章属性格式错误：${doc.errors[0]!.message}`);
  if (doc?.contents && !isMap(doc.contents)) throw new Error('文章属性必须是对象');
  const meta: unknown = json ? JSON.parse(`{${header}}`) : doc!.toJS() ?? {};
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('文章属性必须是对象');
  return { meta: meta as Record<string, unknown>, write(visibility: ArticleVisibility) {
    let data: string;
    if (json) data = JSON.stringify({ ...meta, published: visibility === 'public' }, null, 2).slice(1, -1).trim();
    else { doc!.set('published', visibility === 'public'); data = doc!.toString().trimEnd(); }
    return `${bom}${prefix || !match ? separator + newline : ''}${data.replace(/\r?\n/g, newline)}${newline}${separator}${newline}${body}`;
  } };
}

export const articleMetadata = (raw: string): Record<string, unknown> => frontMatter(raw).meta;
export const rewriteArticleVisibility = (raw: string, visibility: ArticleVisibility): string => frontMatter(raw).write(visibility);
