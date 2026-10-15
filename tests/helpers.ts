import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import type { VaultSource, Settings } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/types';
export const projectDir = fileURLToPath(new URL('../', import.meta.url));
export const time = '2026-10-15T02:00:00.000Z';
export class MemoryVault implements VaultSource {
  notes = new Map<string, string>();
  binaries = new Map<string, Uint8Array>();
  async listNotes() { return [...this.notes.keys()]; }
  async readNote(name: string) { const value = this.notes.get(name); if (value === undefined) throw new Error(`missing note ${name}`); return value; }
  resolveLink(link: string, source: string) {
    const all = [...this.notes.keys(), ...this.binaries.keys()];
    const local = path.posix.normalize(path.posix.join(path.posix.dirname(source), link));
    return all.find(p => p === local || p === local + '.md') ?? all.find(p => p === link || p === link + '.md') ?? all.find(p => path.posix.basename(p) === link || path.posix.basename(p) === link + '.md');
  }
  async readBinary(name: string) { const value = this.binaries.get(name); if (!value) throw new Error(`missing binary ${name}`); return value; }
}
export function note(id: string, body = 'Hello', extra: Record<string, unknown> = {}): string {
  return `---\n${stringify({ title: `Article ${id}`, blog_publish: true, blog_id: id, blog_slug: id, date: time, ...extra })}---\n${body}\n`;
}
export async function temporary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forblog-'));
  return { root, cleanup: async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('forblog-'));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  } };
}
export async function blogFixture(root: string, extra: Record<string, unknown> = {}): Promise<Settings> {
  const blog = path.join(root, '中文 blog');
  await fs.mkdir(path.join(blog, 'source', '_posts'), { recursive: true });
  await fs.writeFile(path.join(blog, '_config.yml'), stringify({ title: 'Test', url: 'https://blog.example.test/project', root: '/project/', permalink: ':title/', theme: '', ...extra }));
  return { ...DEFAULT_SETTINGS, blogDir: blog, nodePath: process.execPath };
}
export async function realHexo(settings: Settings): Promise<void> {
  await fs.symlink(path.join(projectDir, 'node_modules'), path.join(settings.blogDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(settings.blogDir, 'package.json'), JSON.stringify({ name: 'test-blog', hexo: { version: '7.3.0' }, dependencies: { 'hexo-renderer-marked': '7.0.1' } }));
  await fs.mkdir(path.join(settings.blogDir, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(settings.blogDir, 'scripts', 'fixture.js'), `
hexo.extend.generator.register('post', function(locals) {
  const posts = locals.posts.toArray();
  return [{path:'index.html',data:'<!doctype html><title>Test</title>'+posts.map(p=>p.title).join(',')},
    ...posts.map(p=>({path:p.path,data:'<!doctype html><title>'+p.title+'</title>'+p.content}))];
});
`);
}
