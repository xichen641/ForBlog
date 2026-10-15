import { mkdir, copyFile, readFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
const vault = process.argv[2];
if (!vault || !path.isAbsolute(vault)) throw new Error('用法：npm run install:local -- "测试 Vault 的绝对路径"');
const root = await realpath(vault);
if (!(await lstat(path.join(root, '.obsidian'))).isDirectory()) throw new Error('目标不是已初始化的 Obsidian Vault');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const target = path.join(root, '.obsidian', 'plugins', manifest.id);
for (const part of ['.obsidian', '.obsidian/plugins', `.obsidian/plugins/${manifest.id}`]) {
  try { if ((await lstat(path.join(root, part))).isSymbolicLink()) throw new Error('插件安装路径不能包含符号链接'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await mkdir(target, { recursive: true });
for (const name of ['main.js', 'manifest.json', 'styles.css']) await copyFile(new URL(`../${name}`, import.meta.url), path.join(target, name));
console.log(`已安装到 ${target}；请在 Obsidian 中启用 ForBlog。`);
