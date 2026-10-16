import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { stringify } from 'yaml';
import { parseNote } from '../src/core';
import { temporary } from './helpers';
import type { Settings, VaultSource } from '../src/types';
import type { Publisher } from '../src/publisher';

type Action = (publisher: Publisher, source: VaultSource, log: (line: string) => void) => Promise<void>;
type PluginApi = {
  onload(): Promise<void>; onunload(): void; settings: Settings;
  task(action: Action, overrides?: Map<string, string>): Promise<void>;
  preview: { start(): Promise<void>; stop(): Promise<void>; url(): string };
};
type Command = { id: string; checkCallback?: (checking: boolean) => boolean; callback?: () => void };

async function harness(raw = '# 未发布的笔记\n\n正文不变。\n') {
  const temp = await temporary();
  const commands: Command[] = [], modals: MockModal[] = [], notices: string[] = [];
  const values = new Map<string, string>(), textChanges = new Map<string, (value: string) => void>();
  const disabled = new Map<string, boolean>(), buttons = new Map<string, () => Promise<void> | void>();
  const ribbons = new Map<string, () => void>(), events = new Map<string, (...args: unknown[]) => void>();
  let disk = raw, writes = 0;
  class Element {
    text = ''; setText(value: string) { this.text = value; return this; }
    createEl() { return new Element(); } appendText(value: string) { this.text += value; } empty() {}
  }
  class MockFile { path = '50_知识库/PydanticAI/几个问题.md'; extension = 'md'; basename = '几个问题'; }
  const file = new MockFile();
  class MockMarkdownView { file = file; editor = { getValue: () => raw }; }
  const app = {
    workspace: { getActiveFile: () => file, getLeavesOfType: () => [{ view: new MockMarkdownView() }], on: (event: string, callback: (...args: unknown[]) => void) => { events.set(event, callback); return {}; } },
    metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
    vault: { read: async () => disk, getMarkdownFiles: () => [file], getAbstractFileByPath: () => file },
    fileManager: { processFrontMatter: async (_file: MockFile, callback: (fm: Record<string, unknown>) => void) => {
      const parsed = parseNote(file.path, disk); callback(parsed.meta); writes++;
      disk = `---\n${stringify(parsed.meta)}---\n${parsed.body}`;
      // Intentionally keep the editor/cache stale to exercise snapshot refresh.
    } }
  };
  class MockPlugin {
    app = app; async loadData() { return { blogDir: temp.root, siteUrl: 'https://blog.example.test' }; } async saveData() {}
    addStatusBarItem() { return new Element(); } addSettingTab() {}
    addCommand(command: Command) { commands.push(command); }
    addRibbonIcon(_icon: string, label: string, callback: () => void) { ribbons.set(label, callback); }
    registerEvent() {}
  }
  class MockModal {
    app = app; titleEl = new Element(); contentEl = new Element();
    constructor() { modals.push(this); }
    open() { (this as unknown as { onOpen(): void }).onOpen(); }
    close() { (this as unknown as { onClose?: () => void }).onClose?.(); }
  }
  class MockSetting {
    name = ''; setName(name: string) { this.name = name; return this; } setDesc() { return this; }
    addText(callback: (text: unknown) => void) {
      const control = {
        setValue: (value: string) => { values.set(this.name, value); return control; },
        setPlaceholder: () => control, setDisabled: (value: boolean) => { disabled.set(this.name, value); return control; },
        onChange: (change: (value: string) => void) => { textChanges.set(this.name, change); return control; }
      }; callback(control); return this;
    }
    addButton(callback: (button: unknown) => void) {
      let title = '';
      const control = { setButtonText: (value: string) => { title = value; return control; }, setCta: () => control, setWarning: () => control, onClick: (click: () => Promise<void> | void) => { buttons.set(title, click); return control; } };
      callback(control); return this;
    }
  }
  const stubs = { Plugin: MockPlugin, Modal: MockModal, PluginSettingTab: class {}, Setting: MockSetting, MarkdownView: MockMarkdownView, TFile: MockFile, Notice: class { constructor(message: string) { notices.push(message); } } };
  const module = { exports: {} as { default: new () => PluginApi } };
  const require = createRequire(import.meta.url);
  runInNewContext(await fs.readFile(new URL('../main.js', import.meta.url), 'utf8'), {
    module, exports: module.exports, require: (id: string) => id === 'obsidian' ? stubs : require(id),
    process, console, Buffer, URL, AbortController, TextEncoder, TextDecoder, setTimeout, clearTimeout, window: { open() {} }
  });
  const plugin = new module.exports.default(); await plugin.onload();
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 30));
  return {
    temp, file, app, plugin, commands, modals, notices, values, textChanges, disabled, buttons, ribbons, events, tick,
    get disk() { return disk; }, get writes() { return writes; },
    async command(id: string) { const command = commands.find(c => c.id === id)!; if (command.checkCallback) { assert.equal(command.checkCallback(true), true); command.checkCallback(false); } else command.callback!(); await tick(); },
    async cleanup() { plugin.onunload(); await temp.cleanup(); }
  };
}

test('compiled bundle registers 11 commands and offers a valid prefilled editable template', async () => {
  const h = await harness();
  try {
    assert.equal(h.commands.length, 11);
    await h.command('configure-note');
    assert.equal(h.values.get('标题'), '几个问题'); assert.match(h.values.get('网址名称')!, /^post-[a-z0-9]{8}$/);
    assert.equal(h.values.get('分类'), 'PydanticAI'); assert.equal(h.writes, 0);
    h.textChanges.get('网址名称')!('smoke-note');
    await h.buttons.get('保存发布属性')!(); await h.tick();
    const note = parseNote(h.file.path, h.disk);
    assert.equal(note.meta.blog_publish, true); assert.equal(note.meta.blog_slug, 'smoke-note');
    assert.match(String(note.meta.blog_id), /^[\da-f-]{36}$/); assert.equal(note.body, '# 未发布的笔记\n\n正文不变。\n');
  } finally { await h.cleanup(); }
});

test('publish, preview, export and check auto-open setup and continue with freshly saved metadata', async () => {
  for (const [id, label, expected] of [['publish-note', '发布', 'publish'], ['preview-note', '预览', 'preview'], ['export-note', '同步', 'export'], ['check-note', '检查', 'check']] as const) {
    const h = await harness();
    try {
      const operations: string[] = [];
      h.plugin.preview = { start: async () => {}, stop: async () => {}, url: () => 'http://localhost/' };
      h.plugin.task = async (action, overrides) => {
        const source: VaultSource = { listNotes: async () => [h.file.path], readNote: async name => overrides?.get(name) ?? '', resolveLink: () => undefined, readBinary: async () => new Uint8Array() };
        const saved = parseNote(h.file.path, await source.readNote(h.file.path));
        assert.equal(saved.meta.blog_publish, true); assert.ok(saved.meta.blog_id); assert.ok(saved.meta.blog_slug);
        const plan = { id: String(saved.meta.blog_id), slug: String(saved.meta.blog_slug), fingerprint: '', assets: [], linkTargets: [], warnings: [] };
        const fake = {
          settings: h.plugin.settings,
          publish: async (_files: string[], options?: { preview?: boolean }) => { operations.push(options?.preview ? 'preview' : 'publish'); return { plans: [plan] }; },
          export: async () => { operations.push('export'); }, check: async () => { operations.push('check'); return [plan]; },
          config: async () => ({ siteUrl: 'https://blog.example.test' }), manifest: async () => ({ published: {} })
        } as unknown as Publisher;
        await action(fake, source, () => {});
      };
      await h.command(id);
      assert.equal(h.modals.at(-1)!.titleEl.text, '设置博客发布属性'); assert.equal(h.writes, 0); assert.deepEqual(operations, []);
      await h.buttons.get(`保存并继续${label}`)!(); await h.tick();
      assert.deepEqual(operations, [expected]); assert.equal(h.writes, 1);
    } finally { await h.cleanup(); }
  }
});

test('cancel, close and plugin unload do not modify or publish the note', async () => {
  for (const mode of ['cancel', 'close', 'unload']) {
    const h = await harness();
    try {
      let tasks = 0; h.plugin.task = async () => { tasks++; };
      await h.command('publish-note');
      if (mode === 'cancel') await h.buttons.get('取消')!();
      else if (mode === 'close') h.modals.at(-1)!.close();
      else h.plugin.onunload();
      await h.tick();
      assert.equal(h.writes, 0); assert.equal(tasks, 0); assert.equal(parseNote(h.file.path, h.disk).meta.blog_publish, undefined);
    } finally { await h.cleanup(); }
  }
});

test('valid article publishes directly without setup and ribbon/context menu share the setup flow', async () => {
  const h = await harness('---\ntitle: Existing\nblog_id: existing\nblog_slug: existing\nblog_publish: true\ndate: "2026-10-16"\n---\nBody');
  try {
    let tasks = 0; h.plugin.task = async () => { tasks++; };
    await h.command('publish-note'); assert.equal(tasks, 1); assert.equal(h.modals.length, 0);
  } finally { await h.cleanup(); }
  for (const entry of ['ribbon', 'menu']) {
    const h = await harness();
    try {
      if (entry === 'ribbon') h.ribbons.get('ForBlog：发布当前笔记')!();
      else {
        let click!: () => void;
        const item = { setTitle: () => item, setIcon: () => item, onClick: (callback: () => void) => { click = callback; return item; } };
        h.events.get('file-menu')!({ addItem: (callback: (value: typeof item) => void) => callback(item) }, h.file);
        click();
      }
      await h.tick(); assert.equal(h.modals.at(-1)!.titleEl.text, '设置博客发布属性'); assert.equal(h.writes, 0);
    } finally { await h.cleanup(); }
  }
});

test('editing an already exported article keeps its identity and locks its permalink', async () => {
  const h = await harness('---\nprivate: preserved\n---\nBody');
  try {
    await fs.mkdir(path.join(h.temp.root, '.forblog'));
    await fs.writeFile(path.join(h.temp.root, '.forblog/manifest.json'), JSON.stringify({ version: 1, notes: { original: { source: h.file.path, slug: 'fixed', date: '2025-01-01', assets: [], linkTargets: [] } }, published: {} }));
    await h.command('configure-note');
    assert.equal(h.values.get('网址名称'), 'fixed'); assert.equal(h.disabled.get('网址名称'), true);
    await h.buttons.get('保存发布属性')!(); await h.tick();
    const meta = parseNote(h.file.path, h.disk).meta;
    assert.equal(meta.blog_id, 'original'); assert.equal(meta.blog_slug, 'fixed'); assert.equal(meta.private, 'preserved');
  } finally { await h.cleanup(); }
});

test('actual bundled exporter resumes from saved properties even while the editor and metadata cache are stale', async () => {
  const h = await harness();
  try {
    await fs.mkdir(path.join(h.temp.root, 'source/_posts'), { recursive: true });
    await fs.writeFile(path.join(h.temp.root, '_config.yml'), 'url: https://blog.example.test\n');
    await h.command('export-note');
    assert.equal(h.writes, 0);
    await h.buttons.get('保存并继续同步')!();
    const id = String(parseNote(h.file.path, h.disk).meta.blog_id);
    const output = path.join(h.temp.root, `source/_posts/forblog/${id}.md`);
    let exported = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      try { exported = await fs.readFile(output, 'utf8'); if (exported) break; } catch { /* asynchronous command is still running */ }
      await h.tick();
    }
    assert.match(exported, /title: 几个问题/); assert.match(exported, /正文不变/);
    assert.equal(h.notices.some(message => /失败|未设置有效/.test(message)), false);
    // Wait for the export manifest/lock cleanup before deleting the test fixture.
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await fs.access(path.join(h.temp.root, '.forblog/publish.lock')); } catch { break; }
      await h.tick();
    }
    assert.equal(JSON.parse(await fs.readFile(path.join(h.temp.root, '.forblog/manifest.json'), 'utf8')).notes[id].source, h.file.path);
  } finally { await h.cleanup(); }
});
