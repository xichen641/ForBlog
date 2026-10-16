import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { prepare, parseNote, safeName } from './core';
import { emptyManifest, type ArticleVisibility, type BlogArticle, type ExportResult, type Log, type Manifest, type Settings, type VaultSource } from './types';
import { listBlogArticles, resolveArticleSelection, validateArticleSelection } from './articles';
import { articleMetadata, rewriteArticleVisibility } from './visibility';
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
      if (entry.hidden !== undefined && typeof entry.hidden !== 'boolean') throw new Error('文章可见性记录格式错误');
      if (entry.assets.some(asset => typeof asset !== 'string' || !asset.startsWith(`assets/forblog/${id}/`))) throw new Error('发布记录中存在越界的附件路径');
      for (const asset of entry.assets) await inside(this.settings.blogDir, `source/${asset}`);
    }
    if (data.withdrawn !== undefined) {
      if (!data.withdrawn || typeof data.withdrawn !== 'object' || Array.isArray(data.withdrawn)) throw new Error('下架记录格式错误');
      for (const [id, entry] of Object.entries(data.withdrawn)) {
        if (!safeName(id) || !entry || typeof entry.source !== 'string' || !safeName(entry.slug, true) || typeof entry.backup !== 'string' || !entry.backup.startsWith('.forblog/trash/')) throw new Error('下架记录中存在无效文章');
        await inside(this.settings.blogDir, entry.backup);
      }
    }
    if (data.pendingWithdrawal) {
      if (!Number.isSafeInteger(data.pendingWithdrawal.count) || data.pendingWithdrawal.count < 1 || typeof data.pendingWithdrawal.backup !== 'string' || !data.pendingWithdrawal.backup.startsWith('.forblog/trash/')) throw new Error('待部署下架记录格式错误');
      await inside(this.settings.blogDir, data.pendingWithdrawal.backup);
    }
    if (data.pendingVisibility !== undefined) {
      if (!data.pendingVisibility || typeof data.pendingVisibility !== 'object' || Array.isArray(data.pendingVisibility)) throw new Error('待部署可见性记录格式错误');
      for (const [key, visibility] of Object.entries(data.pendingVisibility)) {
        if (!key.startsWith('source/_posts/') || !['public', 'hidden'].includes(visibility)) throw new Error('待部署可见性记录无效');
        await inside(this.settings.blogDir, key);
      }
    }
    return data;
  }
  async check(requested: string[]) {
    const { siteUrl } = await this.config();
    const manifest = await this.manifest();
    return prepare(this.vault, requested, manifest, siteUrl, new Date().toISOString());
  }
  async listArticles(): Promise<BlogArticle[]> {
    await this.config();
    return listBlogArticles(this.settings.blogDir, await this.manifest());
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
    for (const [id, entry] of Object.entries(manifest.notes)) if (!entry.hidden) {
      const file = await inside(this.settings.blogDir, `source/_posts/forblog/${id}.md`);
      if (await exists(file) && articleMetadata(await fs.readFile(file, 'utf8')).published === false) {
        entry.hidden = true; manifest.rebuildRequired = true;
        manifest.pendingVisibility ??= {};
        manifest.pendingVisibility[`source/_posts/forblog/${id}.md`] = 'hidden';
      }
    }
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
        assets: [...currentAssets], linkTargets: plan.linkTargets, ...(previous?.hidden ? { hidden: true } : {})
      };
      if (manifest.withdrawn) delete manifest.withdrawn[plan.id];
      for (const warning of plan.warnings) this.log(`提示：${warning}`);
    }
    await this.save(manifest);
    const pending = !!Object.keys(manifest.pendingVisibility ?? {}).length || JSON.stringify(Object.keys(manifest.notes).sort()) !== JSON.stringify(Object.keys(manifest.published).sort()) || Object.entries(manifest.notes).some(([id, note]) => manifest.published[id]?.fingerprint !== note.fingerprint || !!manifest.published[id]?.hidden !== !!note.hidden);
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
    force ||= !!manifest.rebuildRequired;
    const signature = await this.signature();
    const configChanged = !!manifest.buildSignature && manifest.buildSignature !== signature;
    if (!force && !changed && manifest.buildSignature === signature && await exists(path.join(this.settings.blogDir, 'public/index.html'))) return false;
    const cli = path.join(this.settings.blogDir, 'node_modules', 'hexo', 'bin', 'hexo');
    if (!await exists(cli)) throw new Error('博客依赖未安装：请在博客目录执行 npm install');
    const { siteUrl } = await this.config();
    const root = new URL(siteUrl).pathname.replace(/\/$/, '') + '/';
    await writeChanged(await inside(this.settings.blogDir, '.forblog/hexo.yml'), stringify({ url: siteUrl, root, render_drafts: false }));
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
      if (note.hidden) {
        if (await exists(output)) throw new Error(`Hexo 仍生成隐藏文章，已阻止部署：${note.slug}`);
        for (const asset of note.assets) await fs.rm(await inside(this.settings.blogDir, `public/${asset}`), { force: true });
        continue;
      }
      if (!await exists(output) || !(await fs.stat(output)).size) throw new Error(`Hexo 未生成文章页面：${note.slug}`);
      for (const asset of note.assets) if (!await exists(await inside(this.settings.blogDir, `public/${asset}`))) throw new Error(`Hexo 未生成附件：${asset}`);
    }
    manifest.buildSignature = signature;
    delete manifest.rebuildRequired;
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
      const deployment = await this.deployUnlocked(result.manifest, config.git!);
      return { ...result, pending: false, built, deployment };
    });
  }
  private async deployUnlocked(manifest: Manifest, target: GitTarget): Promise<DeployResult> {
    const deployment = await deploy(this.settings.blogDir, target, this.settings.gitPath, this.log, this.signal);
    manifest.published = Object.fromEntries(Object.entries(manifest.notes).map(([id, note]) => [id, { fingerprint: note.fingerprint, slug: note.slug, ...(note.hidden ? { hidden: true } : {}) }]));
    manifest.lastCommit = deployment.commit;
    delete manifest.pendingWithdrawal;
    delete manifest.pendingVisibility;
    await this.save(manifest);
    this.log(deployment.pushed ? 'Git 推送完成；GitHub Pages 上线状态需单独验证' : '静态产物无变化，无需推送');
    return deployment;
  }
  async setArticleVisibility(selection: BlogArticle[], visibility: ArticleVisibility, options: { deploy?: boolean } = {}): Promise<{ count: number; deployment?: DeployResult }> {
    if (!['public', 'hidden'].includes(visibility)) throw new Error('无效的文章可见性');
    return this.withLock(async () => {
      const config = await this.config();
      if (options.deploy !== false && !config.git) throw new Error('请先配置单个 Git 部署目标');
      const manifest = await this.manifest();
      const articles = resolveArticleSelection(selection, await listBlogArticles(this.settings.blogDir, manifest), '修改可见性');
      if (articles.some(article => article.state === 'missing' || article.warning)) throw new Error('所选文章源码缺失或属性格式有误，请修复后重试');
      const changed = articles.filter(article => article.visibility !== visibility);
      if (!changed.length) return { count: 0 };
      const ids = new Set(articles.flatMap(article => article.id ? [article.id] : []));
      if (visibility === 'hidden') {
        const references = Object.entries(manifest.notes).filter(([id, note]) => !note.hidden && !ids.has(id) && note.linkTargets.some(target => ids.has(target)));
        if (references.length) throw new Error(`其他公开文章仍引用所选文章，请先解除链接并发布，或一同隐藏：${references.map(([, note]) => note.title).join('、')}`);
      } else {
        const unavailable = articles.filter(article => article.id && manifest.notes[article.id]!.linkTargets.some(target => manifest.notes[target]?.hidden && !ids.has(target)));
        if (unavailable.length) throw new Error(`文章仍链接到隐藏文章，请先修改链接并同步，或将目标文章一同设为公开：${unavailable.map(article => article.title).join('、')}`);
      }
      const edits: { file: string; original: string; next: string }[] = [];
      for (const article of changed) {
        const file = await inside(this.settings.blogDir, article.key), original = await fs.readFile(file, 'utf8');
        if (hash(original) !== article.fingerprint) throw new Error(`文章已改变，请刷新列表：${article.title}`);
        edits.push({ file, original, next: rewriteArticleVisibility(original, visibility) });
      }
      const written: typeof edits = [];
      try {
        for (const edit of edits) {
          if (this.signal?.aborted) throw new Error('操作已取消');
          await writeChanged(edit.file, edit.next); written.push(edit);
        }
        manifest.pendingVisibility ??= {};
        for (const article of changed) {
          manifest.pendingVisibility[article.key] = visibility;
          if (article.id) manifest.notes[article.id]!.hidden = visibility === 'hidden';
        }
        manifest.rebuildRequired = true;
        await this.save(manifest);
      } catch (error) {
        for (const edit of written.reverse()) await writeChanged(edit.file, edit.original);
        throw error;
      }
      this.log(`已将 ${changed.length} 篇文章设为${visibility === 'hidden' ? '隐藏' : '公开'}，源码和 Obsidian 原稿保留`);
      if (options.deploy === false) return { count: changed.length };
      try {
        await this.build(manifest, true, true);
        return { count: changed.length, deployment: await this.deployUnlocked(manifest, config.git!) };
      } catch (error) {
        throw new Error(`可见性已保存到本地，部署未完成，可重试部署：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
  async unpublishArticles(selection: BlogArticle[], options: { deploy?: boolean; updateMarkers?: (articles: BlogArticle[]) => Promise<void> } = {}): Promise<{ count: number; backup: string; deployment?: DeployResult }> {
    return this.withLock(async () => {
      const config = await this.config();
      if (options.deploy !== false && !config.git) throw new Error('请先配置单个 Git 部署目标');
      const manifest = await this.manifest();
      const articles = validateArticleSelection(selection, await listBlogArticles(this.settings.blogDir, manifest), manifest);
      const backup = `.forblog/trash/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
      const moves: { source: string; destination: string }[] = [];
      for (const article of articles) {
        const names = [article.key, ...(article.id ? manifest.notes[article.id]!.assets.map(asset => `source/${asset}`) : [])];
        for (const name of names) {
          const source = await inside(this.settings.blogDir, name);
          const destination = await inside(this.settings.blogDir, `${backup}/${name}`);
          if (await exists(source)) moves.push({ source, destination });
        }
      }
      if (this.signal?.aborted) throw new Error('操作已取消');
      await writeChanged(await inside(this.settings.blogDir, `${backup}/record.json`), JSON.stringify({ created: new Date().toISOString(), articles }, null, 2) + '\n');
      const moved: typeof moves = [];
      try {
        for (const move of moves) {
          if (this.signal?.aborted) throw new Error('操作已取消');
          await fs.mkdir(path.dirname(move.destination), { recursive: true });
          await fs.rename(move.source, move.destination); moved.push(move);
        }
        manifest.withdrawn ??= {};
        for (const article of articles) if (article.id) {
          const note = manifest.notes[article.id]!;
          manifest.withdrawn[article.id] = { source: note.source, title: note.title, slug: note.slug, date: note.date, backup };
          delete manifest.notes[article.id];
        }
        for (const article of articles) if (manifest.pendingVisibility) delete manifest.pendingVisibility[article.key];
        manifest.pendingWithdrawal = { count: (manifest.pendingWithdrawal?.count ?? 0) + articles.length, backup };
        delete manifest.buildSignature; manifest.rebuildRequired = true;
        await this.save(manifest);
      } catch (error) {
        for (const move of moved.reverse()) {
          try { await fs.mkdir(path.dirname(move.source), { recursive: true }); await fs.rename(move.destination, move.source); }
          catch { throw new Error(`下架中断，部分文件保留在备份目录，请检查：${backup}；${String(error)}`); }
        }
        throw error;
      }
      this.log(`已备份并从博客源码移出 ${articles.length} 篇文章；备份：${backup}`);
      try {
        await options.updateMarkers?.(articles);
        if (options.deploy === false) return { count: articles.length, backup };
        await this.build(manifest, true, true);
        const deployment = await this.deployUnlocked(manifest, config.git!);
        return { count: articles.length, backup, deployment };
      } catch (error) {
        throw new Error(`下架已保存到本地，原稿和备份保留（${backup}）。部署未完成，可重试部署：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
  async unpublish(id: string): Promise<void> {
    if (!safeName(id)) throw new Error('无效的文章 ID');
    const article = (await this.listArticles()).find(row => row.id === id);
    if (!article) throw new Error('该笔记没有本地发布记录');
    await this.unpublishArticles([article], { deploy: false });
  }
}
