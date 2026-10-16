import { App, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import path from 'node:path';
import { DEFAULT_SETTINGS, type BlogArticle, type Settings, type VaultSource } from './types';
import { ARTICLE_VIEW, ArticleManagerView } from './manager-view';
import { parseNote, articleUrl, markedForPublishing, safeName } from './core';
import { Publisher } from './publisher';
import { PreviewServer } from './preview';
import { redact } from './process';
import { applyPublishDraft, needsPublishProperties, publishDefaults, type PublishDraft } from './properties';

class ObsidianSource implements VaultSource {
  private snapshots = new Map<string, string>();
  constructor(private app: App, overrides?: Map<string, string>) {
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file) this.snapshots.set(leaf.view.file.path, leaf.view.editor.getValue());
    }
    // Front Matter writes can finish before the open editor/cache refreshes.
    for (const [name, raw] of overrides ?? []) this.snapshots.set(name, raw);
  }
  async listNotes(): Promise<string[]> { return this.app.vault.getMarkdownFiles().map(f => f.path); }
  async readNote(name: string): Promise<string> {
    if (this.snapshots.has(name)) return this.snapshots.get(name)!;
    const file = this.app.vault.getAbstractFileByPath(name);
    if (!(file instanceof TFile)) throw new Error(`笔记不存在：${name}`);
    return this.app.vault.read(file);
  }
  resolveLink(link: string, source: string): string | undefined { return this.app.metadataCache.getFirstLinkpathDest(link, source)?.path; }
  async readBinary(name: string): Promise<Uint8Array> {
    const file = this.app.vault.getAbstractFileByPath(name);
    if (!(file instanceof TFile)) throw new Error(`附件不存在：${name}`);
    return new Uint8Array(await this.app.vault.readBinary(file));
  }
}

class ProgressModal extends Modal {
  private lines?: HTMLElement;
  private button?: HTMLButtonElement;
  private done = false;
  constructor(app: App, private cancel: () => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText('ForBlog 发布日志');
    this.lines = this.contentEl.createEl('pre', { cls: 'forblog-log' });
    this.button = this.contentEl.createEl('button', { text: '取消操作' });
    this.button.onclick = () => this.done ? this.close() : this.cancel();
  }
  log(line: string): void {
    if (this.lines) { this.lines.appendText(redact(line) + '\n'); this.lines.scrollTop = this.lines.scrollHeight; }
  }
  finish(): void { this.done = true; this.button?.setText('关闭'); }
}

class PublishProperties extends Modal {
  private settled = false;
  private saving = false;
  constructor(app: App, private file: TFile, private draft: PublishDraft, private complete: (saved: string | null) => void, private continuation?: string, private fixedSlug?: string) { super(app); }
  onOpen(): void {
    this.titleEl.setText('设置博客发布属性');
    this.contentEl.createEl('p', { text: `已根据「${this.file.basename}」预填发布模板，你可以修改后保存。取消不会修改笔记。` });
    new Setting(this.contentEl).setName('标题').addText(t => t.setValue(this.draft.title).onChange(v => this.draft.title = v));
    new Setting(this.contentEl).setName('网址名称').setDesc(this.fixedSlug ? '已导出文章的网址保持固定。' : '已自动生成，可修改为小写英文、数字和连字符。首次导出后固定。').addText(t => t.setPlaceholder('clip-reid').setValue(this.draft.slug).setDisabled(!!this.fixedSlug).onChange(v => this.draft.slug = v.trim()));
    new Setting(this.contentEl).setName('发布日期').setDesc('支持 ISO 日期时间，例如 2026-10-16T10:00:00+08:00。').addText(t => t.setValue(this.draft.date).onChange(v => this.draft.date = v));
    new Setting(this.contentEl).setName('更新时间（可选）').setDesc('留空时由插件按公开内容变化自动维护。').addText(t => t.setValue(this.draft.updated).onChange(v => this.draft.updated = v));
    new Setting(this.contentEl).setName('标签').setDesc('用逗号分隔').addText(t => t.setValue(this.draft.tags).onChange(v => this.draft.tags = v));
    new Setting(this.contentEl).setName('分类').setDesc('默认取笔记所在文件夹，可修改；用逗号分隔。').addText(t => t.setValue(this.draft.categories).onChange(v => this.draft.categories = v));
    this.contentEl.createEl('p', { text: this.continuation === '发布' ? '保存后将标记为可公开文章，并立即继续发布到配置的博客。' : this.continuation ? `保存后将标记为可公开文章，并继续${this.continuation}；本次操作不会推送。` : '保存后将标记为可公开文章，正文及引用附件会在你执行发布命令时公开。' });
    new Setting(this.contentEl).addButton(b => b.setButtonText('取消').onClick(() => this.close())).addButton(b => b.setButtonText(this.continuation ? `保存并继续${this.continuation}` : '保存发布属性').setCta().onClick(async () => {
      if (this.saving) return;
      try {
        applyPublishDraft({}, this.draft);
        if (this.fixedSlug && this.draft.slug !== this.fixedSlug) throw new Error('已导出文章的网址不能修改');
        this.saving = true;
        await this.app.fileManager.processFrontMatter(this.file, fm => {
          applyPublishDraft(fm, this.draft);
        });
        const saved = await this.app.vault.read(this.file);
        this.settled = true;
        this.complete(saved);
        this.close();
      } catch (error) { new Notice(`保存失败：${String(error)}`); }
      finally { this.saving = false; }
    }));
  }
  onClose(): void { if (!this.settled) { this.settled = true; this.complete(null); } }
}

class ConfirmUnpublish extends Modal {
  constructor(app: App, private title: string, private execute: () => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText('从博客下架文章');
    this.contentEl.createEl('p', { text: `将从博客下架「${this.title}」并部署变更，同时关闭笔记的发布标记。Obsidian 原稿和原始附件会保留。` });
    new Setting(this.contentEl).addButton(b => b.setButtonText('取消').onClick(() => this.close())).addButton(b => b.setButtonText('下架并部署').setWarning().onClick(() => { this.close(); this.execute(); }));
  }
}

export default class ForBlogPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  private busy = false;
  private preparing = false;
  private propertiesModal?: PublishProperties;
  private controller?: AbortController;
  private preview = new PreviewServer();
  private status!: HTMLElement;
  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<Settings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...saved };
    this.status = this.addStatusBarItem(); this.status.setText('ForBlog：就绪');
    this.addSettingTab(new ForBlogSettings(this.app, this));
    this.registerView(ARTICLE_VIEW, leaf => new ArticleManagerView(leaf, this));
    this.addCommand({ id: 'manage-articles', name: '管理博客文章（批量下架）', callback: () => void this.openArticleManager() });
    this.addRibbonIcon('library-big', 'ForBlog：文章管理', () => void this.openArticleManager());
    const currentCommand = (id: string, name: string, action: (file: TFile) => void) => this.addCommand({ id, name, checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') return false;
      if (!checking) action(file);
      return true;
    } });
    currentCommand('configure-note', '设置当前笔记的发布属性', f => void this.noteTask(f));
    currentCommand('check-note', '检查当前笔记的发布变更', f => void this.noteTask(f, '检查', async (publisher, source, log) => {
      const plans = await publisher.check([f.path]);
      const manifest = await publisher.manifest();
      const note = plans[0]!;
      log(manifest.published[note.id]?.fingerprint === note.fingerprint ? '与上次推送版本一致' : '有待发布变更');
      log(`附件：${note.assets.length} 个；已转换笔记链接：${note.linkTargets.length} 个`);
      for (const warning of note.warnings) log(`提示：${warning}`);
      log(articleUrl((await publisher.config()).siteUrl, note.slug));
    }));
    currentCommand('export-note', '仅同步当前笔记到 Hexo（不推送）', f => void this.noteTask(f, '同步', async publisher => { await publisher.export([f.path]); }));
    currentCommand('preview-note', '预览当前笔记（不推送）', f => void this.noteTask(f, '预览', async (publisher, source, log) => {
      const result = await publisher.publish([f.path], { preview: true });
      const { siteUrl } = await publisher.config();
      await this.preview.start(path.join(publisher.settings.blogDir, 'public'), siteUrl, publisher.settings.previewPort);
      const url = this.preview.url(siteUrl, result.plans[0]!.slug, publisher.settings.previewPort);
      log(url); window.open(url);
    }));
    currentCommand('publish-note', '发布当前笔记（增量）', f => void this.noteTask(f, '发布', async publisher => {
      const result = await publisher.publish([f.path]);
      new Notice(result.deployment?.pushed ? 'Git 推送完成；Pages 上线待验证' : '没有需要推送的静态文件');
    }));
    currentCommand('open-article', '打开当前笔记的博客页面', f => void this.task(async (publisher, source) => {
      const note = parseNote(f.path, await source.readNote(f.path));
      const id = note.meta.blog_id;
      if (!safeName(id)) throw new Error('当前笔记没有有效的 blog_id');
      const published = (await publisher.manifest()).published[id];
      if (!published) throw new Error('尚无成功推送记录');
      window.open(articleUrl((await publisher.config()).siteUrl, published.slug));
    }));
    currentCommand('unpublish-note', '下架当前笔记', f => {
      new ConfirmUnpublish(this.app, f.basename, () => void this.task(async (publisher, source) => {
        const id = parseNote(f.path, await source.readNote(f.path)).meta.blog_id;
        if (!safeName(id)) throw new Error('当前笔记没有有效的 blog_id');
        const article = (await publisher.listArticles()).find(row => row.id === id);
        if (!article) throw new Error('该笔记没有本地发布记录');
        await publisher.unpublishArticles([article], { updateMarkers: rows => this.updateWithdrawalMarkers(rows) });
      })).open();
    });
    this.addCommand({ id: 'publish-changed', name: '发布所有修改的公开笔记（增量）', callback: () => void this.task(async (publisher, source) => {
      const selected: string[] = [];
      const manifest = await publisher.manifest();
      for (const name of await source.listNotes()) {
        const raw = await source.readNote(name);
        if (markedForPublishing(raw)) {
          const meta = parseNote(name, raw).meta;
          if (meta.blog_publish === true && !manifest.withdrawn?.[String(meta.blog_id)]) selected.push(name);
        }
      }
      if (!selected.length) throw new Error('没有可批量发布的公开笔记；已下架文章需单独重新发布');
      await publisher.publish(selected);
    }) });
    this.addCommand({ id: 'rebuild', name: '完整重建并发布博客', callback: () => void this.task(async publisher => { await publisher.publish([], { force: true }); }) });
    this.addCommand({ id: 'retry-publish', name: '重试推送已同步的博客内容', callback: () => void this.task(async publisher => { await publisher.publish([]); }) });
    this.addCommand({ id: 'stop-preview', name: '停止博客预览服务', callback: () => void this.preview.stop().then(() => new Notice('预览已停止')) });
    this.addRibbonIcon('send', 'ForBlog：发布当前笔记', () => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') { new Notice('请先打开一篇 Markdown 笔记'); return; }
      void this.noteTask(file, '发布', async publisher => { await publisher.publish([file.path]); });
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') menu.addItem(item => item.setTitle('ForBlog：发布到博客').setIcon('send').onClick(() => void this.noteTask(file, '发布', async publisher => { await publisher.publish([file.path]); })));
    }));
  }
  async openArticleManager(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(ARTICLE_VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf(true); await leaf.setViewState({ type: ARTICLE_VIEW, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }
  async articleCatalog(): Promise<{ articles: BlogArticle[]; pending: number; backup?: string }> {
    const publisher = new Publisher({ ...this.settings }, new ObsidianSource(this.app));
    const manifest = await publisher.manifest();
    return { articles: await publisher.listArticles(), pending: manifest.pendingWithdrawal?.count ?? 0, backup: manifest.pendingWithdrawal?.backup };
  }
  async unpublishSelection(articles: BlogArticle[]): Promise<boolean> {
    return this.task(async publisher => {
      const result = await publisher.unpublishArticles(articles, { updateMarkers: rows => this.updateWithdrawalMarkers(rows) });
      new Notice(`已下架 ${result.count} 篇文章；原稿保留，博客源码已备份。`);
    });
  }
  async retryArticleDeployment(): Promise<boolean> { return this.task(async publisher => { await publisher.publish([]); }); }
  private async updateWithdrawalMarkers(articles: BlogArticle[]): Promise<void> {
    const ids = new Set(articles.flatMap(article => article.id ? [article.id] : []));
    if (!ids.size) return;
    const matches = new Map<string, TFile[]>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      let meta: Record<string, unknown>;
      try { meta = parseNote(file.path, await this.app.vault.read(file)).meta; } catch { continue; }
      if (typeof meta.blog_id === 'string' && ids.has(meta.blog_id)) matches.set(meta.blog_id, [...matches.get(meta.blog_id) ?? [], file]);
    }
    for (const files of matches.values()) if (files.length > 1) throw new Error(`多个原笔记使用相同文章身份，请先处理：${files.map(file => file.path).join('、')}`);
    for (const [id, files] of matches) await this.app.fileManager.processFrontMatter(files[0]!, fm => {
      if (fm.blog_id !== id) throw new Error('原笔记身份已改变，请重新检查发布属性');
      fm.blog_publish = false;
    });
  }
  private async noteTask(file: TFile, continuation?: string, action?: (publisher: Publisher, source: VaultSource, log: (line: string) => void) => Promise<void>): Promise<void> {
    if (this.busy || this.preparing) { new Notice('ForBlog 正在处理另一个任务'); return; }
    this.preparing = true;
    let overrides: Map<string, string> | undefined;
    try {
      const source = new ObsidianSource(this.app);
      const note = parseNote(file.path, await source.readNote(file.path));
      if (!action || needsPublishProperties(note.meta)) {
        const manifest = await new Publisher({ ...this.settings }, source).manifest();
        const entry = Object.entries(manifest.notes).find(([id, item]) => id === note.meta.blog_id || item.source === file.path);
        const existing = entry ? { id: entry[0], slug: entry[1].slug, date: entry[1].date } : undefined;
        const draft = publishDefaults(file.path, note.meta, existing);
        const saved = await new Promise<string | null>(resolve => {
          this.propertiesModal = new PublishProperties(this.app, file, draft, resolve, continuation, existing?.slug);
          this.propertiesModal.open();
        });
        if (saved === null) return;
        overrides = new Map([[file.path, saved]]);
        if (!action) new Notice('发布属性已保存');
      }
    } catch (error) {
      new Notice(`ForBlog：${redact(error instanceof Error ? error.message : String(error))}`, 9000);
      return;
    } finally { this.preparing = false; this.propertiesModal = undefined; }
    // Create the publishing snapshot after the form has saved, never before it.
    if (action) await this.task(action, overrides);
  }
  private async task(action: (publisher: Publisher, source: VaultSource, log: (line: string) => void) => Promise<void>, overrides?: Map<string, string>): Promise<boolean> {
    if (this.busy || this.preparing) { new Notice('ForBlog 正在处理另一个任务'); return false; }
    this.busy = true; this.controller = new AbortController();
    this.status.setText('ForBlog：处理中');
    const modal = new ProgressModal(this.app, () => this.controller?.abort()); modal.open();
    const log = (line: string) => modal.log(line);
    const source = new ObsidianSource(this.app, overrides);
    try {
      await action(new Publisher({ ...this.settings }, source, log, this.controller.signal), source, log);
      log('任务完成'); this.status.setText('ForBlog：就绪');
      return true;
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      log(`失败：${message}`); new Notice(`ForBlog：${message}`, 9000); this.status.setText('ForBlog：操作失败');
      return false;
    } finally { modal.finish(); this.busy = false; this.controller = undefined; }
  }
  onunload(): void { this.propertiesModal?.close(); this.controller?.abort(); void this.preview.stop(); }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
}

class ForBlogSettings extends PluginSettingTab {
  constructor(app: App, private plugin: ForBlogPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl('h2', { text: 'ForBlog' });
    containerEl.createEl('p', { text: '将公开笔记增量同步到本地 Hexo，再通过现有 Git 认证发布。' });
    new Setting(containerEl).setName('博客文章管理').setDesc('查看 ForBlog 和原有 Hexo 文章，勾选后批量下架，保留原稿。').addButton(button => button.setButtonText('打开文章管理').onClick(() => { void this.plugin.openArticleManager(); }));
    const field = (key: 'blogDir' | 'siteUrl' | 'nodePath' | 'gitPath', name: string, description: string, placeholder = '') => {
      new Setting(containerEl).setName(name).setDesc(description).addText(t => t.setPlaceholder(placeholder).setValue(this.plugin.settings[key]).onChange(async v => { this.plugin.settings[key] = v.trim(); await this.plugin.saveSettings(); }));
    };
    field('blogDir', 'Hexo 博客目录', '包含 _config.yml、source 和 node_modules 的绝对路径。', 'D:\\Myblog');
    field('siteUrl', '博客网址', '留空则读取 Hexo url；需要包含项目子路径。', 'https://xichen641.github.io');
    field('nodePath', 'Node.js 程序', '可填写 node.exe 的绝对路径；Obsidian 可能没有终端里的 PATH。', 'D:\\nodejs\\node.exe');
    field('gitPath', 'Git 程序', '可填写 git.exe 的绝对路径。', 'D:\\Git\\cmd\\git.exe');
    new Setting(containerEl).setName('预览端口').setDesc('仅监听本机 127.0.0.1。').addText(t => t.setValue(String(this.plugin.settings.previewPort)).onChange(async value => {
      const port = Number(value); if (Number.isSafeInteger(port) && port >= 1024 && port <= 65535) { this.plugin.settings.previewPort = port; await this.plugin.saveSettings(); }
    }));
    containerEl.createEl('p', { text: '部署目标从 _config.yml 的 deploy.repo / deploy.branch 读取。支持单个 Git 仓库；不保存 Token，不使用强制推送。预览和仅同步操作都可能留下待发布内容，下一次部署会发布整个 Hexo 当前快照。' });
  }
}
