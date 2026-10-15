import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Load the actual CJS bundle against a small public-API stub. This verifies
// packaging and command wiring; it does not replace an Obsidian UI test.
test('compiled Obsidian bundle loads, registers commands, and edits publish properties through the API', async () => {
  const commands: { id: string; checkCallback?: (checking: boolean) => boolean; callback?: () => void }[] = [];
  const textChanges = new Map<string, (value: string) => void>();
  const buttons = new Map<string, () => Promise<void> | void>();
  const modals: MockModal[] = [];
  const frontmatter: Record<string, unknown> = { private: 'preserved' };
  class Element {
    text = '';
    setText(value: string) { this.text = value; return this; }
    createEl() { return new Element(); }
    appendText(value: string) { this.text += value; }
    empty() {}
  }
  class MockFile { path = 'notes/a.md'; extension = 'md'; basename = 'a'; }
  const file = new MockFile();
  const app = {
    workspace: { getActiveFile: () => file, getLeavesOfType: () => [], on: () => ({}) },
    metadataCache: { getFileCache: () => ({ frontmatter }) },
    fileManager: { processFrontMatter: async (_file: MockFile, callback: (fm: Record<string, unknown>) => void) => callback(frontmatter) }
  };
  class MockPlugin {
    app = app;
    async loadData() { return null; }
    async saveData() {}
    addStatusBarItem() { return new Element(); }
    addSettingTab() {}
    addCommand(command: typeof commands[number]) { commands.push(command); }
    addRibbonIcon() {}
    registerEvent() {}
  }
  class MockModal {
    app = app; titleEl = new Element(); contentEl = new Element();
    constructor() { modals.push(this); }
    open() { (this as unknown as { onOpen: () => void }).onOpen(); }
    close() {}
  }
  class MockSetting {
    name = '';
    setName(name: string) { this.name = name; return this; }
    setDesc() { return this; }
    addText(callback: (text: unknown) => void) {
      const control = { setValue: () => control, setPlaceholder: () => control, onChange: (change: (value: string) => void) => { textChanges.set(this.name, change); return control; } };
      callback(control); return this;
    }
    addButton(callback: (button: unknown) => void) {
      let title = '';
      const control = { setButtonText: (value: string) => { title = value; return control; }, setCta: () => control, setWarning: () => control, onClick: (click: () => Promise<void> | void) => { buttons.set(title, click); return control; } };
      callback(control); return this;
    }
  }
  const stubs = { Plugin: MockPlugin, Modal: MockModal, PluginSettingTab: class {}, Setting: MockSetting, MarkdownView: class {}, TFile: MockFile, Notice: class {} };
  const module = { exports: {} as { default: new () => { onload: () => Promise<void>; onunload: () => void } } };
  const require = createRequire(import.meta.url);
  const source = await fs.readFile(new URL('../main.js', import.meta.url), 'utf8');
  runInNewContext(source, { module, exports: module.exports, require: (id: string) => id === 'obsidian' ? stubs : require(id), process, console, Buffer, URL, AbortController, TextEncoder, TextDecoder, setTimeout, clearTimeout });
  const plugin = new module.exports.default(); await plugin.onload();
  assert.equal(commands.length, 11);
  assert.ok(commands.some(c => c.id === 'publish-changed'));
  assert.ok(commands.some(c => c.id === 'retry-publish'));
  const configure = commands.find(c => c.id === 'configure-note')!;
  assert.equal(configure.checkCallback!(true), true); configure.checkCallback!(false);
  textChanges.get('网址名称')!('smoke-note');
  await buttons.get('保存发布属性')!();
  assert.equal(frontmatter.blog_publish, true); assert.equal(frontmatter.blog_slug, 'smoke-note');
  assert.match(String(frontmatter.blog_id), /^[\da-f-]{36}$/); assert.equal(frontmatter.private, 'preserved');
  plugin.onunload();
});
