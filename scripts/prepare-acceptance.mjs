import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stringify } from 'yaml';

const project = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(project, '.acceptance', 'desktop-20261015');
const vault = path.join(root, 'ForBlog验收');
const blog = path.join(root, 'hexo-blog');
const remote = path.join(root, 'remote.git');
if (await fs.stat(root).then(() => true, () => false)) throw new Error('验收目录已存在，保留已有结果，不覆盖。');
await fs.mkdir(path.join(vault, '.obsidian', 'plugins', 'forblog'), { recursive: true });
await fs.mkdir(path.join(vault, '附件'), { recursive: true });
await fs.mkdir(path.join(blog, 'source', '_posts'), { recursive: true });
await fs.writeFile(path.join(vault, '.obsidian', 'app.json'), JSON.stringify({ attachmentFolderPath: '附件', alwaysUpdateLinks: true }, null, 2));
await fs.writeFile(path.join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['forblog']));
for (const name of ['main.js', 'manifest.json', 'styles.css']) await fs.copyFile(path.join(project, name), path.join(vault, '.obsidian', 'plugins', 'forblog', name));
const git = process.env.FORBLOG_TEST_GIT ?? 'git';
const initialized = spawnSync(git, ['init', '--bare', remote], { encoding: 'utf8', windowsHide: true });
if (initialized.status !== 0) throw new Error(initialized.stderr);
await fs.symlink(path.join(project, 'node_modules'), path.join(blog, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
await fs.writeFile(path.join(blog, 'package.json'), JSON.stringify({ name: 'forblog-desktop-acceptance', hexo: { version: '7.3.0' }, dependencies: {
  'hexo-renderer-marked': '7.0.1', 'hexo-renderer-ejs': '2.0.0', 'hexo-renderer-stylus': '3.0.1', 'hexo-theme-fluid': '1.9.8', 'hexo-generator-index': '4.0.0'
} }, null, 2));
await fs.writeFile(path.join(blog, '_config.yml'), stringify({ title: 'ForBlog 真实窗口验收', author: 'ForBlog Test', url: 'https://forblog.example.test', theme: 'fluid', language: 'zh-CN', source_dir: 'source', public_dir: 'public', deploy: { type: 'git', repo: remote, branch: 'main' } }));
await fs.writeFile(path.join(blog, '_config.fluid.yml'), stringify({ navbar: { blog_title: 'ForBlog UI 验收' }, index: { banner_img: '' }, post: { banner_img: '' } }));
await fs.writeFile(path.join(vault, '.obsidian', 'plugins', 'forblog', 'data.json'), JSON.stringify({ blogDir: blog, siteUrl: 'https://forblog.example.test', nodePath: process.execPath, gitPath: git, previewPort: 19488 }, null, 2));
await fs.writeFile(path.join(vault, '真实窗口验收.md'), '# ForBlog UI 验收\n\n真实窗口初始版本 V1。\n\n![[验收图.png|240]]\n\n[[参考笔记|参考文章]]\n\n%% FORBLOG_PRIVATE_COMMENT 不应出现在博客 %%\n\n```python\nprint("Hello ForBlog")\n```\n');
await fs.writeFile(path.join(vault, '参考笔记.md'), '---\n' + stringify({ title: '参考文章', date: '2026-10-15T10:00:00+08:00', blog_publish: true, blog_id: 'reference-note', blog_slug: 'reference-note' }) + '---\n# 参考文章\n\n用于验证批量发布和双链转换。\n');
await fs.writeFile(path.join(vault, '私有笔记.md'), '# 私有笔记\nPRIVATE_NOTE_MUST_NOT_EXPORT\n');
await fs.writeFile(path.join(vault, '附件', '验收图.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
await fs.writeFile(path.join(root, 'environment.json'), JSON.stringify({ root, vault, blog, remote }, null, 2));
console.log(JSON.stringify({ root, vault, blog, remote }, null, 2));
