import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
export async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
// Every managed write/delete goes through this check, including symlink ancestors.
export async function inside(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '..' || p === '.' || p.toLowerCase() === '.git')) {
    throw new Error(`不安全的相对路径：${relative}`);
  }
  const base = path.resolve(root);
  const target = path.resolve(base, ...relative.split('/'));
  if (!target.startsWith(base + path.sep)) throw new Error(`路径越界：${relative}`);
  let current = base;
  for (const part of ['', ...relative.split('/')]) {
    if (part) current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`管理目录中不能包含符号链接：${current}`);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return target;
}
export async function writeChanged(file: string, data: string | Uint8Array): Promise<boolean> {
  const next = Buffer.from(data);
  try { if ((await fs.readFile(file)).equals(next)) return false; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, next); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
  return true;
}
export async function walk(root: string, relative = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`不能同步符号链接：${name}`);
    if (entry.isDirectory()) result.push(...await walk(root, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`不支持的文件类型：${name}`);
  }
  return result.sort();
}
export async function mirror(source: string, destination: string): Promise<{ written: number; deleted: number }> {
  await fs.mkdir(destination, { recursive: true });
  const incoming = await walk(source);
  const old = await walk(destination);
  const keep = new Set(incoming);
  let written = 0, deleted = 0;
  // File deletions first also handle a file becoming a directory.
  for (const file of old) if (!keep.has(file)) {
    await fs.unlink(await inside(destination, file)); deleted++;
  }
  for (const file of incoming) {
    const target = await inside(destination, file);
    // Remove empty directory left by a directory becoming a file.
    if (await exists(target) && (await fs.lstat(target)).isDirectory()) await removeEmpty(target);
    if (await writeChanged(target, await fs.readFile(await inside(source, file)))) written++;
  }
  return { written, deleted };
}
async function removeEmpty(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`目录仍包含文件：${directory}`);
    await removeEmpty(path.join(directory, entry.name));
  }
  await fs.rmdir(directory);
}
