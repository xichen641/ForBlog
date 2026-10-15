import { App, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_SETTINGS, type Settings, type VaultSource } from './types';
import { parseNote, articleUrl, markedForPublishing, safeName } from './core';
import { Publisher } from './publisher';
import { PreviewServer } from './preview';
import { redact } from './process';

class ObsidianSource implements VaultSource {
  private snapshots = new Map<string, string>();
  constructor(private app: App) {
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file) this.snapshots.set(leaf.view.file.path, leaf.view.editor.getValue());
    }
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
  constructor(app: App, private file: TFile, private onSaved: () => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText('设置博客发布属性');
    const current = this.app.metadataCache.getFileCache(this.file)?.frontmatter ?? {};
    let title = typeof current.title === 'string' ? current.title : this.file.basename;
    let slug = typeof current.blog_slug === 'string' ? current.blog_slug : '';
    let tags = Array.isArray(current.tags) ? current.tags.join(', ') : '';
    let categories = Array.isArray(current.categories) ? current.categories.join(', ') : '';
    new Setting(this.contentEl).setName('标题').addText(t => t.setValue(title).onChange(v => title = v));
    new Setting(this.contentEl).setName('网址名称').setDesc('小写字母、数字和连字符。首次导出后固定。').addText(t => t.setPlaceholder('clip-reid').setValue(slug).onChange(v => slug = v.trim()));
    new Setting(this.contentEl).setName('标签').setDesc('用逗号分隔').addText(t => t.setValue(tags).onChange(v => tags = v));
    new Setting(this.contentEl).setName('分类').setDesc('用逗号分隔；按 Hexo 分类层级解释').addText(t => t.setValue(categories).onChange(v => categories = v));
    this.contentEl.createEl('p', { text: '保存后将标记 blog_publish: true。文章正文及其引用附件会在你执行发布命令时公开。' });
    new Setting(this.contentEl).addButton(b => b.setButtonText('保存发布属性').setCta().onClick(async () => {
      if (!safeName(slug, true)) { new Notice('网址名称只能包含小写字母、数字和连字符，且不能是系统保留名称'); return; }
      try {
        await this.app.fileManager.processFrontMatter(this.file, fm => {
          fm.title = title.trim() || this.file.basename;
          fm.blog_id ??= randomUUID();
          fm.blog_slug = slug;
          fm.blog_publish = true;
          fm.date ||= new Date().toISOString();
          fm.tags = tags.split(/[,，]/).map(t => t.trim()).filter(Boolean);
          fm.categories = categories.split(/[,，]/).map(t => t.trim()).filter(Boolean);
        });
        this.close(); this.onSaved();
      } catch (error) { new Notice(`保存失败：${String(error)}`); }
    }));
  }
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
  private controller?: AbortController;
  private preview = new PreviewServer();
  private status!: HTMLElement;
  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<Settings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...saved };
    this.status = this.addStatusBarItem(); this.status.setText('ForBlog：就绪');
    this.addSettingTab(new ForBlogSettings(this.app, this));
    const currentCommand = (id: string, name: string, action: (file: TFile) => void) => this.addCommand({ id, name, checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') return false;
      if (!checking) action(file);
      return true;
    } });
    currentCommand('configure-note', '设置当前笔记的发布属性', f => new PublishProperties(this.app, f, () => new Notice('发布属性已保存')).open());
    currentCommand('check-note', '检查当前笔记的发布变更', f => void this.task(async (publisher, source, log) => {
      const plans = await publisher.check([f.path]);
      const manifest = await publisher.manifest();
      const note = plans[0]!;
      log(manifest.published[note.id]?.fingerprint === note.fingerprint ? '与上次推送版本一致' : '有待发布变更');
      log(`附件：${note.assets.length} 个；已转换笔记链接：${note.linkTargets.length} 个`);
      for (const warning of note.warnings) log(`提示：${warning}`);
      log(articleUrl((await publisher.config()).siteUrl, note.slug));
    }));
    currentCommand('export-note', '仅同步当前笔记到 Hexo（不推送）', f => void this.task(async publisher => { await publisher.export([f.path]); }));
    currentCommand('preview-note', '预览当前笔记（不推送）', f => void this.task(async (publisher, source, log) => {
      const result = await publisher.publish([f.path], { preview: true });
      const { siteUrl } = await publisher.config();
      await this.preview.start(path.join(publisher.settings.blogDir, 'public'), siteUrl, publisher.settings.previewPort);
      const url = this.preview.url(siteUrl, result.plans[0]!.slug, publisher.settings.previewPort);
      log(url); window.open(url);
    }));
    currentCommand('publish-note', '发布当前笔记（增量）', f => void this.task(async publisher => {
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
        // Disable the marker even when a subsequent push fails, so batch publish won't recreate it.
        await publisher.unpublish(id);
        await this.app.fileManager.processFrontMatter(f, fm => { fm.blog_publish = false; });
        await publisher.publish([]);
      })).open();
    });
    this.addCommand({ id: 'publish-changed', name: '发布所有修改的公开笔记（增量）', callback: () => void this.task(async (publisher, source) => {
      const selected: string[] = [];
      for (const name of await source.listNotes()) {
        const raw = await source.readNote(name);
        if (markedForPublishing(raw) && parseNote(name, raw).meta.blog_publish === true) selected.push(name);
      }
      if (!selected.length) throw new Error('没有设置 blog_publish: true 的笔记');
      await publisher.publish(selected);
    }) });
    this.addCommand({ id: 'rebuild', name: '完整重建并发布博客', callback: () => void this.task(async publisher => { await publisher.publish([], { force: true }); }) });
    this.addCommand({ id: 'retry-publish', name: '重试推送已同步的博客内容', callback: () => void this.task(async publisher => { await publisher.publish([]); }) });
    this.addCommand({ id: 'stop-preview', name: '停止博客预览服务', callback: () => void this.preview.stop().then(() => new Notice('预览已停止')) });
    this.addRibbonIcon('send', 'ForBlog：发布当前笔记', () => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') { new Notice('请先打开一篇 Markdown 笔记'); return; }
      void this.task(async publisher => { await publisher.publish([file.path]); });
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') menu.addItem(item => item.setTitle('ForBlog：发布到博客').setIcon('send').onClick(() => void this.task(async publisher => { await publisher.publish([file.path]); })));
    }));
  }
  private async task(action: (publisher: Publisher, source: VaultSource, log: (line: string) => void) => Promise<void>): Promise<void> {
    if (this.busy) { new Notice('ForBlog 正在处理另一个任务'); return; }
    this.busy = true; this.controller = new AbortController();
    this.status.setText('ForBlog：处理中');
    const modal = new ProgressModal(this.app, () => this.controller?.abort()); modal.open();
    const log = (line: string) => modal.log(line);
    const source = new ObsidianSource(this.app);
    try {
      await action(new Publisher({ ...this.settings }, source, log, this.controller.signal), source, log);
      log('任务完成'); this.status.setText('ForBlog：就绪');
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      log(`失败：${message}`); new Notice(`ForBlog：${message}`, 9000); this.status.setText('ForBlog：操作失败');
    } finally { modal.finish(); this.busy = false; this.controller = undefined; }
  }
  onunload(): void { this.controller?.abort(); void this.preview.stop(); }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
}

class ForBlogSettings extends PluginSettingTab {
  constructor(app: App, private plugin: ForBlogPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl('h2', { text: 'ForBlog' });
    containerEl.createEl('p', { text: '将公开笔记增量同步到本地 Hexo，再通过现有 Git 认证发布。' });
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
