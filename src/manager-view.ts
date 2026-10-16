import { App, ItemView, Modal, Setting, setIcon, type WorkspaceLeaf } from 'obsidian';
import { articlesInGroup, groupArticles, type ArticleGroup, type ArticleGrouping } from './article-groups';
import type { BlogArticle } from './types';

export const ARTICLE_VIEW = 'forblog-articles';
export interface ArticleManagerHost {
  app: App;
  articleCatalog(): Promise<{ articles: BlogArticle[]; pending: number; backup?: string }>;
  unpublishSelection(articles: BlogArticle[]): Promise<boolean>;
  retryArticleDeployment(): Promise<boolean>;
}

class ConfirmBatchWithdrawal extends Modal {
  private confirmed = false;
  constructor(app: App, private articles: BlogArticle[], private execute: () => void) { super(app); }
  onOpen(): void {
    this.contentEl.addClass('forblog-confirm-content');
    this.titleEl.addClass('forblog-confirm-heading');
    this.titleEl.setText(`下架所选 ${this.articles.length} 篇文章`);
    this.contentEl.createEl('p', { text: '所选文章将从博客下架并统一部署。Obsidian 原稿和原始附件保留，博客源码会先备份。' });
    const list = this.contentEl.createEl('ul', { cls: 'forblog-confirm-list' });
    for (const article of this.articles) {
      const row = list.createEl('li');
      row.createEl('strong', { text: article.title });
      row.createEl('div', { text: article.key, cls: 'forblog-article-path' });
    }
    new Setting(this.contentEl).addButton(button => button.setButtonText('取消').onClick(() => this.close()))
      .addButton(button => button.setButtonText('确认下架并部署').setWarning().onClick(() => {
        if (this.confirmed) return;
        this.confirmed = true; this.close(); this.execute();
      }));
  }
}

export class ArticleManagerView extends ItemView {
  private articles: BlogArticle[] = [];
  private selected = new Set<string>();
  private query = '';
  private origin = 'all';
  private grouping: ArticleGrouping = 'archive';
  private collapsed = new Set<string>();
  private loading = false;
  private pending = 0;
  private closed = false;
  private generation = 0;
  private rows!: HTMLTableSectionElement;
  private summary!: HTMLElement;
  private selection!: HTMLElement;
  private selectionCount!: HTMLElement;
  private clear!: HTMLButtonElement;
  private modes = new Map<ArticleGrouping, HTMLButtonElement>();
  private message!: HTMLElement;
  private withdraw!: HTMLButtonElement;
  private retry!: HTMLButtonElement;
  private refreshButton!: HTMLButtonElement;
  private all!: HTMLInputElement;
  constructor(leaf: WorkspaceLeaf, private host: ArticleManagerHost) { super(leaf); }
  getViewType(): string { return ARTICLE_VIEW; }
  getDisplayText(): string { return 'ForBlog 文章管理'; }
  getIcon(): string { return 'library-big'; }
  async onOpen(): Promise<void> {
    this.closed = false;
    const root = this.contentEl; root.empty(); root.addClass('forblog-manager');
    const shell = root.createDiv({ cls: 'forblog-manager-shell' });
    const heading = shell.createDiv({ cls: 'forblog-manager-heading' });
    const headingText = heading.createDiv();
    headingText.createEl('div', { text: 'FORBLOG', cls: 'forblog-manager-eyebrow' });
    headingText.createEl('h2', { text: '文章管理' });
    this.refreshButton = this.iconButton(heading, '刷新列表', 'refresh-cw');
    this.refreshButton.addEventListener('click', () => { void this.refresh(); });

    const toolbar = shell.createDiv({ cls: 'forblog-manager-toolbar' });
    const modes = toolbar.createDiv({ cls: 'forblog-view-switch', attr: { role: 'group', 'aria-label': '文章展示方式' } });
    for (const [value, label, icon] of [['archive', '归档', 'archive'], ['category', '分类', 'folder-tree']] as const) {
      const button = modes.createEl('button', { attr: { 'aria-label': value === 'archive' ? '按博客归档' : '按分类', 'aria-pressed': String(this.grouping === value), type: 'button' } });
      setIcon(button.createEl('span', { cls: 'forblog-icon', attr: { 'aria-hidden': 'true' } }), icon);
      button.createEl('span', { text: label });
      button.addEventListener('click', () => { this.grouping = value; this.renderRows(); });
      this.modes.set(value, button);
    }
    const searchBox = toolbar.createDiv({ cls: 'forblog-search' });
    setIcon(searchBox.createEl('span', { cls: 'forblog-icon', attr: { 'aria-hidden': 'true' } }), 'search');
    const search = searchBox.createEl('input', { type: 'search', placeholder: '搜索文章…', attr: { 'aria-label': '搜索博客文章' } });
    search.addEventListener('input', () => { this.query = search.value.trim().toLocaleLowerCase(); this.collapsed.clear(); this.renderRows(); });
    const filter = toolbar.createEl('select', { cls: 'forblog-source-filter', attr: { 'aria-label': '按文章来源筛选' } });
    for (const [value, text] of [['all', '全部来源'], ['forblog', 'ForBlog'], ['hexo', 'Hexo']]) filter.createEl('option', { text, value });
    filter.value = this.origin;
    filter.addEventListener('change', () => { this.origin = filter.value; this.renderRows(); });

    this.message = shell.createDiv({ cls: 'forblog-manager-message', attr: { role: 'status' } });
    this.message.hidden = true;
    const actions = shell.createDiv({ cls: 'forblog-list-tools' });
    const counts = actions.createDiv({ cls: 'forblog-list-meta' });
    this.summary = counts.createEl('span');
    const grouping = counts.createDiv({ cls: 'forblog-group-tools' });
    const expand = this.iconButton(grouping, '展开全部', 'chevrons-up-down');
    expand.addEventListener('click', () => { this.collapsed.clear(); this.renderRows(); });
    const collapse = this.iconButton(grouping, '折叠全部', 'chevrons-down-up');
    collapse.addEventListener('click', () => {
      const visit = (groups: ArticleGroup[]) => { for (const group of groups) { this.collapsed.add(group.key); visit(group.children); } };
      visit(groupArticles(this.visibleArticles(), this.grouping)); this.renderRows();
    });
    this.selection = actions.createDiv({ cls: 'forblog-selection' });
    this.selectionCount = this.selection.createEl('span', { cls: 'forblog-selection-count', attr: { 'aria-live': 'polite' } });
    this.clear = this.selection.createEl('button', { text: '取消选择', cls: 'forblog-text-button', attr: { 'aria-label': '清空选择' } });
    this.clear.addEventListener('click', () => { this.selected.clear(); this.renderRows(); });
    this.withdraw = this.selection.createEl('button', { text: '下架所选', cls: 'forblog-withdraw', attr: { 'aria-label': '下架所选文章' } });
    this.withdraw.addEventListener('click', () => {
      const selection = this.articles.filter(article => this.selected.has(article.key));
      if (!this.loading && selection.length) new ConfirmBatchWithdrawal(this.app, selection, () => { void this.perform(() => this.host.unpublishSelection(selection)); }).open();
    });
    this.retry = actions.createEl('button', { text: '重试部署下架变更' });
    this.retry.hidden = true;
    this.retry.addEventListener('click', () => { if (this.pending > 0) void this.perform(() => this.host.retryArticleDeployment()); });
    const scroll = shell.createDiv({ cls: 'forblog-article-scroll' });
    const table = scroll.createEl('table', { cls: 'forblog-article-table' });
    const header = table.createEl('thead').createEl('tr');
    this.all = header.createEl('th').createEl('input', { type: 'checkbox', attr: { 'aria-label': '全选当前筛选结果' } });
    this.all.addEventListener('change', () => {
      for (const article of this.visibleArticles()) if (this.all.checked) this.selected.add(article.key); else this.selected.delete(article.key);
      this.renderRows();
    });
    for (const title of ['文章', '来源', '状态', '发布日期']) header.createEl('th', { text: title });
    this.rows = table.createEl('tbody');
    await this.refresh();
  }
  private iconButton(parent: HTMLElement, label: string, icon: string): HTMLButtonElement {
    const button = parent.createEl('button', { cls: 'forblog-icon-button', attr: { 'aria-label': label, title: label, type: 'button' } });
    setIcon(button, icon); return button;
  }
  async onClose(): Promise<void> { this.closed = true; this.generation++; }
  private visibleArticles(): BlogArticle[] {
    return this.articles.filter(article => (this.origin === 'all' || article.origin === this.origin) && (!this.query || `${article.title} ${article.key} ${article.noteSource ?? ''} ${article.categoryPaths.flat().join(' ')}`.toLocaleLowerCase().includes(this.query)));
  }
  async refresh(): Promise<void> {
    if (this.loading || this.closed) return;
    const generation = ++this.generation;
    this.loading = true; this.updateControls(); this.message.hidden = false; this.message.setText('正在读取博客文章…');
    try {
      const catalog = await this.host.articleCatalog();
      if (this.closed || generation !== this.generation) return;
      this.articles = catalog.articles; this.selected.clear(); this.pending = catalog.pending;
      this.retry.hidden = catalog.pending === 0;
      this.message.hidden = catalog.pending === 0;
      this.message.setText(catalog.pending ? `${catalog.pending} 篇文章已在本地下架，仍待部署。备份：${catalog.backup}` : '');
    } catch (error) { if (!this.closed) { this.message.hidden = false; this.message.setText(`读取失败：${error instanceof Error ? error.message : String(error)}`); } }
    finally { this.loading = false; if (!this.closed) this.renderRows(); }
  }
  private updateControls(): void {
    if (!this.withdraw) return;
    this.withdraw.disabled = this.loading || !this.selected.size;
    this.clear.disabled = this.loading;
    this.selection.hidden = !this.selected.size;
    this.selectionCount.setText(`已选择 ${this.selected.size} 篇`);
    for (const [mode, button] of this.modes) button.setAttribute('aria-pressed', String(mode === this.grouping));
    this.refreshButton.disabled = this.loading; this.retry.disabled = this.loading || this.pending === 0; this.all.disabled = this.loading;
    const visible = this.visibleArticles().length;
    this.summary.setText(visible === this.articles.length ? `${this.articles.length} 篇文章` : `${visible} / ${this.articles.length} 篇文章`);
  }
  private renderRows(): void {
    this.rows.empty();
    const visible = this.visibleArticles();
    const states = { published: '已推送', pending: '待发布', local: '公开', hidden: '未公开', missing: '源码缺失' };
    const renderArticle = (article: BlogArticle, depth: number) => {
      const row = this.rows.createEl('tr', { attr: { 'data-article-key': article.key, 'data-selected': String(this.selected.has(article.key)) } });
      const checkbox = row.createEl('td').createEl('input', { type: 'checkbox', attr: { 'aria-label': `选择文章：${article.title}` } });
      checkbox.checked = this.selected.has(article.key); checkbox.disabled = this.loading;
      checkbox.addEventListener('change', () => { if (this.loading) return; if (checkbox.checked) this.selected.add(article.key); else this.selected.delete(article.key); this.renderRows(); });
      const title = row.createEl('td', { attr: { style: `--forblog-group-depth: ${depth}` }, cls: 'forblog-article-title' });
      const details = title.createEl('details', { cls: 'forblog-article-details' });
      const name = details.createEl('summary', { attr: { title: '展开查看博客源码与原笔记路径' } });
      name.createEl('span', { text: article.title, cls: 'forblog-article-name' });
      setIcon(name.createEl('span', { cls: 'forblog-detail-chevron forblog-icon', attr: { 'aria-hidden': 'true' } }), 'chevron-right');
      const paths = details.createDiv({ cls: 'forblog-article-paths' });
      paths.createEl('div', { text: `博客源码 · ${article.key}`, cls: 'forblog-article-path' });
      if (article.noteSource) paths.createEl('div', { text: `Obsidian · ${article.noteSource}`, cls: 'forblog-article-path' });
      if (this.grouping === 'archive' && article.categoryPaths.length) title.createEl('div', { text: article.categoryPaths.map(parts => parts.join(' / ')).join(' · '), cls: 'forblog-article-categories' });
      if (article.warning) title.createEl('div', { text: article.warning, cls: 'forblog-article-warning' });
      row.createEl('td').createEl('span', { text: article.origin === 'forblog' ? 'ForBlog' : 'Hexo', cls: 'forblog-source-badge' });
      row.createEl('td').createEl('span', { text: states[article.state], cls: 'forblog-article-state', attr: { 'data-state': article.state } });
      row.createEl('td', { text: article.date ? article.date.slice(0, 10) : '—', cls: 'forblog-article-date' });
    };
    const renderGroup = (group: ArticleGroup, depth: number) => {
      const members = articlesInGroup(group), selected = members.filter(article => this.selected.has(article.key)).length;
      const row = this.rows.createEl('tr', { cls: 'forblog-article-group', attr: { 'data-depth': String(depth) } });
      const checkbox = row.createEl('td').createEl('input', { type: 'checkbox', attr: { 'aria-label': `选择分组：${group.label}`, 'data-group-key': group.key } });
      checkbox.checked = selected === members.length; checkbox.indeterminate = selected > 0 && selected < members.length; checkbox.disabled = this.loading;
      checkbox.addEventListener('change', () => {
        if (this.loading) return;
        for (const article of members) if (checkbox.checked) this.selected.add(article.key); else this.selected.delete(article.key);
        this.renderRows();
      });
      const collapsed = this.collapsed.has(group.key);
      const cell = row.createEl('td', { attr: { colspan: '4', style: `--forblog-group-depth: ${depth}` } });
      const toggle = cell.createEl('button', { cls: 'forblog-group-toggle', attr: { 'aria-label': `${collapsed ? '展开' : '折叠'}分组：${group.label}`, 'aria-expanded': String(!collapsed) } });
      setIcon(toggle.createEl('span', { cls: 'forblog-icon', attr: { 'aria-hidden': 'true' } }), collapsed ? 'chevron-right' : 'chevron-down');
      toggle.createEl('span', { text: group.label });
      toggle.createEl('span', { text: String(members.length), cls: 'forblog-group-count' });
      toggle.addEventListener('click', () => { if (collapsed) this.collapsed.delete(group.key); else this.collapsed.add(group.key); this.renderRows(); });
      if (!collapsed) {
        for (const article of group.articles) renderArticle(article, depth + 1);
        for (const child of group.children) renderGroup(child, depth + 1);
      }
    };
    for (const group of groupArticles(visible, this.grouping)) renderGroup(group, 0);
    if (!visible.length) this.rows.createEl('tr').createEl('td', { text: this.articles.length ? '没有找到匹配的文章' : '暂无博客文章', cls: 'forblog-empty', attr: { colspan: '5' } });
    const count = visible.filter(article => this.selected.has(article.key)).length;
    this.all.checked = visible.length > 0 && count === visible.length;
    this.all.indeterminate = count > 0 && count < visible.length;
    this.updateControls();
  }
  private async perform(action: () => Promise<boolean>): Promise<void> {
    if (this.loading || this.closed) return;
    this.loading = true; this.renderRows();
    try { await action(); }
    finally { this.loading = false; if (!this.closed) await this.refresh(); }
  }
}
