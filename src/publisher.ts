import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { prepare, parseNote, safeName } from './core';
import { emptyManifest, type ExportResult, type Log, type Manifest, type Settings, type VaultSource } from './types';
import { exists, hash, inside, walk, writeChanged } from './files';
import { deploy, type DeployResult, type GitTarget } from './git';
import { run } from './process';

export class Publisher {
  constructor(readonly settings: Settings, readonly vault: VaultSource, readonly log: Log = () => {}, readonly signal?: AbortSignal) {}
  async config(): Promise<{ siteUrl: string; git?: GitTarget }> {
    if (!path.isAbsolute(this.settings.blogDir)) throw new Error('请在设置中填写博客目录的绝对路径');
    const file = await inside(this.settings.blogDir, '_config.yml');
    const doc = parseDocument(await fs.readFile(file, 'utf8'));
    if (doc.errors.length) throw new Error('博客 _config.yml 格式错误');
    const config = doc.toJS() as Record<string, unknown>;
    if (!config || typeof config !== 'object') throw new Error('无效的 Hexo 配置');
    if (config.source_dir !== undefined && config.source_dir !== 'source' || config.public_dir !== undefined && config.public_dir !== 'public') throw new Error('首版仅支持 source_dir: source 和 public_dir: public');
    const siteUrl = this.settings.siteUrl.trim() || String(config.url ?? '');
    let url: URL;
    try { url = new URL(siteUrl); } catch { throw new Error('请先填写有效的博客网址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname === 'example.com' || url.username || url.password || url.search || url.hash) throw new Error('博客网址无效；请在插件设置中替换 example.com');
    const deploys = Array.isArray(config.deploy) ? config.deploy : [config.deploy];
    const gitItems = deploys.filter((d: unknown) => d && typeof d === 'object' && (d as { type?: string }).type === 'git');
    const item = gitItems.length === 1 ? gitItems[0] as Record<string, unknown> : undefined;
    let git: GitTarget | undefined;
    if (item && typeof item.repo === 'string' && !item.repo.includes('\n')) {
      git = { repo: item.repo, branch: typeof item.branch === 'string' ? item.branch : 'gh-pages' };
    }
    return { siteUrl, git };
  }
  async manifest(): Promise<Manifest> {
    const file = await inside(this.settings.blogDir, '.forblog/manifest.json');
    if (!await exists(file)) return emptyManifest();
    const data = JSON.parse(await fs.readFile(file, 'utf8')) as Manifest;
    if (data.version !== 1 || !data.notes || !data.published || Array.isArray(data.notes)) throw new Error('发布记录版本不兼容或损坏');
    for (const [id, entry] of Object.entries(data.notes)) {
      if (!safeName(id) || !entry || !Array.isArray(entry.assets) || !Array.isArray(entry.linkTargets) || typeof entry.source !== 'string' || !safeName(entry.slug, true)) throw new Error('发布记录中存在无效文章');
      if (entry.assets.some(asset => typeof asset !== 'string' || !asset.startsWith(`assets/forblog/${id}/`))) throw new Error('发布记录中存在越界的附件路径');
      for (const asset of entry.assets) await inside(this.settings.blogDir, `source/${asset}`);
    }
    return data;
  }
  async check(requested: string[]) {
    const { siteUrl } = await this.config();
    const manifest = await this.manifest();
    return prepare(this.vault, requested, manifest, siteUrl, new Date().toISOString());
  }
  async withLock<T>(action: () => Promise<T>): Promise<T> {
    const file = await inside(this.settings.blogDir, '.forblog/publish.lock');
    await fs.mkdir(path.dirname(file), { recursive: true });
    let handle;
    try { handle = await fs.open(file, 'wx'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Crash recovery only when the lock's owner process is provably gone.
      const owner = JSON.parse(await fs.readFile(file, 'utf8')) as { pid: number };
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('发布锁损坏，请检查 .forblog/publish.lock');
      try { process.kill(owner.pid, 0); throw new Error('另一个发布任务正在执行，请稍后重试'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      await fs.unlink(file);
      handle = await fs.open(file, 'wx');
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      if (this.signal?.aborted) throw new Error('操作已取消');
      return await action();
    } finally { await handle.close(); await fs.unlink(file); }
  }
  private async save(manifest: Manifest): Promise<void> {
    await writeChanged(await inside(this.settings.blogDir, '.forblog/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  private async exportUnlocked(requested: string[], manifest: Manifest): Promise<ExportResult> {
    const { siteUrl } = await this.config();
    const now = new Date().toISOString();
    this.log('检查笔记、链接和附件…');
    const plans = await prepare(this.vault, requested, manifest, siteUrl, now);
    // Resolve all destinations before mutating any exported files.
    for (const plan of plans) {
      const destination = await inside(this.settings.blogDir, `source/_posts/forblog/${plan.id}.md`);
      if (!manifest.notes[plan.id] && await exists(destination)) throw new Error(`拒绝覆盖非本插件管理的文件：${destination}`);
      for (const asset of plan.assets) await inside(this.settings.blogDir, `source/${asset.path}`);
    }
    let changed = 0, skipped = 0;
    for (const plan of plans) {
      if (this.signal?.aborted) throw new Error('操作已取消');
      const previous = manifest.notes[plan.id];
      let touched = await writeChanged(await inside(this.settings.blogDir, `source/_posts/forblog/${plan.id}.md`), plan.markdown);
      for (const asset of plan.assets) {
        if (await writeChanged(await inside(this.settings.blogDir, `source/${asset.path}`), asset.data)) touched = true;
      }
      const currentAssets = new Set(plan.assets.map(a => a.path));
      for (const old of previous?.assets ?? []) if (!currentAssets.has(old)) {
        await fs.rm(await inside(this.settings.blogDir, `source/${old}`), { force: true }); touched = true;
      }
      if (touched || previous?.fingerprint !== plan.fingerprint) changed++; else skipped++;
      manifest.notes[plan.id] = {
        source: plan.source, slug: plan.slug, title: plan.title, date: plan.date,
        fingerprint: plan.fingerprint, updated: String(parseNote(plan.source, plan.markdown).meta.updated),
        assets: [...currentAssets], linkTargets: plan.linkTargets
      };
      for (const warning of plan.warnings) this.log(`提示：${warning}`);
    }
    await this.save(manifest);
    const pending = JSON.stringify(Object.keys(manifest.notes).sort()) !== JSON.stringify(Object.keys(manifest.published).sort()) || Object.entries(manifest.notes).some(([id, note]) => manifest.published[id]?.fingerprint !== note.fingerprint);
    this.log(`文章：${changed} 篇有变化，${skipped} 篇未变化`);
    return { manifest, plans, changed, skipped, pending };
  }
  async export(requested: string[]): Promise<ExportResult> {
    return this.withLock(async () => this.exportUnlocked(requested, await this.manifest()));
  }
  private async signature(): Promise<string> {
    const blog = this.settings.blogDir;
    const names = (await fs.readdir(blog)).filter(n => /^_config.*\.(yml|yaml)$/.test(n) || ['package.json', 'package-lock.json'].includes(n)).sort();
    const parts: [string, string][] = [];
    for (const name of names) parts.push([name, hash(await fs.readFile(await inside(blog, name)))]);
    if (await exists(path.join(blog, 'themes'))) for (const name of await walk(path.join(blog, 'themes'))) parts.push([`themes/${name}`, hash(await fs.readFile(await inside(blog, `themes/${name}`)))]);
    return hash(JSON.stringify({ version: 1, siteUrl: (await this.config()).siteUrl, parts }));
  }
  private async build(manifest: Manifest, force: boolean, changed: boolean): Promise<boolean> {
    const signature = await this.signature();
    const configChanged = !!manifest.buildSignature && manifest.buildSignature !== signature;
    if (!force && !changed && manifest.buildSignature === signature && await exists(path.join(this.settings.blogDir, 'public/index.html'))) return false;
    const cli = path.join(this.settings.blogDir, 'node_modules', 'hexo', 'bin', 'hexo');
    if (!await exists(cli)) throw new Error('博客依赖未安装：请在博客目录执行 npm install');
    const { siteUrl } = await this.config();
    const root = new URL(siteUrl).pathname.replace(/\/$/, '') + '/';
    await writeChanged(await inside(this.settings.blogDir, '.forblog/hexo.yml'), stringify({ url: siteUrl, root }));
    const configArgs = ['--config', '_config.yml,.forblog/hexo.yml'];
    if (force || configChanged) {
      this.log('全局配置变化或请求完整构建，重建 Hexo 缓存…');
      await run(this.settings.nodePath, [cli, 'clean', ...configArgs], this.settings.blogDir, { signal: this.signal, log: this.log, label: 'Hexo 清理缓存' });
    }
    this.log('Hexo 构建中…');
    await run(this.settings.nodePath, [cli, 'generate', '--bail', ...configArgs], this.settings.blogDir, { signal: this.signal, log: this.log, label: 'Hexo 构建' });
    this.log('Hexo 构建完成，正在校验文章和附件…');
    for (const note of Object.values(manifest.notes)) {
      const output = await inside(this.settings.blogDir, `public/posts/${note.slug}/index.html`);
      if (!await exists(output) || !(await fs.stat(output)).size) throw new Error(`Hexo 未生成文章页面：${note.slug}`);
      for (const asset of note.assets) if (!await exists(await inside(this.settings.blogDir, `public/${asset}`))) throw new Error(`Hexo 未生成附件：${asset}`);
    }
    manifest.buildSignature = signature;
    await this.save(manifest);
    return true;
  }
  async publish(requested: string[], options: { preview?: boolean; force?: boolean } = {}): Promise<ExportResult & { built: boolean; deployment?: DeployResult }> {
    return this.withLock(async () => {
      const config = await this.config();
      if (!options.preview && !config.git) throw new Error('仅支持 _config.yml 中单个字符串 repo 的 Git 部署配置');
      const result = await this.exportUnlocked(requested, await this.manifest());
      const built = await this.build(result.manifest, !!options.force, result.changed > 0 || result.pending);
      if (options.preview) return { ...result, built };
      // Even a no-change run checks the remote, so an interrupted push can be retried.
      const deployment = await deploy(this.settings.blogDir, config.git!, this.settings.gitPath, this.log, this.signal);
      result.manifest.published = Object.fromEntries(Object.entries(result.manifest.notes).map(([id, note]) => [id, { fingerprint: note.fingerprint, slug: note.slug }]));
      result.manifest.lastCommit = deployment.commit;
      await this.save(result.manifest);
      this.log(deployment.pushed ? 'Git 推送完成；GitHub Pages 上线状态需单独验证' : '静态产物无变化，无需推送');
      return { ...result, pending: false, built, deployment };
    });
  }
  async unpublish(id: string): Promise<void> {
    if (!safeName(id)) throw new Error('无效的文章 ID');
    await this.withLock(async () => {
      const manifest = await this.manifest();
      const entry = manifest.notes[id];
      if (!entry) throw new Error('该笔记没有本地发布记录');
      const references = Object.entries(manifest.notes).filter(([other, note]) => other !== id && note.linkTargets.includes(id));
      if (references.length) throw new Error(`请先解除其他文章对本篇的链接并重新发布：${references.map(([, n]) => n.title).join('、')}`);
      await fs.rm(await inside(this.settings.blogDir, `source/_posts/forblog/${id}.md`), { force: true });
      for (const asset of entry.assets) await fs.rm(await inside(this.settings.blogDir, `source/${asset}`), { force: true });
      delete manifest.notes[id];
      // A preview-only article can have no published fingerprint. Invalidate
      // the build separately so its old HTML still gets removed on next build.
      delete manifest.buildSignature;
      // Keep published[id] until the subsequent build and push succeeds.
      await this.save(manifest);
    });
  }
}
