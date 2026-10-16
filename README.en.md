# ForBlog

[中文完整文档](README.md) · [Releases](https://github.com/xichen641/ForBlog/releases) · [Issues](https://github.com/xichen641/ForBlog/issues)

Publish notes and attachments from Obsidian to a local Hexo blog, then deploy the generated site through Git. Only explicitly selected or opted-in notes are exported. The plugin UI is currently in Chinese.

Features include a publishing-properties form, incremental content and attachment export, internal-link conversion, local preview, an article manager grouped by archive or category, batch withdrawal, and public/hidden visibility for both ForBlog exports and existing Hexo posts. Obsidian originals are retained when withdrawing posts.

## Requirements

- Obsidian desktop 1.14.4 or later. This conservative minimum matches the version used for desktop acceptance; older versions have not been verified.
- Windows and macOS Apple Silicon desktop acceptance has been performed. All 65 automated tests pass on the tested Mac. Linux and Intel Mac remain unverified; mobile is unsupported.
- Node.js 20+ and Git installed separately, plus an initialized local Hexo blog with its dependencies already installed. The plugin does not install dependencies.
- Integration fixtures use Hexo 7.3.0 and Fluid 1.9.8. The blog must use `source` and `public` directories and one Git deployment repository.

## Install and upgrade

Download `main.js`, `manifest.json` and `styles.css` from the [0.3.1 release](https://github.com/xichen641/ForBlog/releases/tag/0.3.1). Put them in `<vault>/.obsidian/plugins/forblog/`, then enable ForBlog under Settings → Community plugins. Alternatively, extract the `forblog` folder from the release ZIP into `.obsidian/plugins/`.

Configure the absolute Hexo directory, site URL, Node.js executable and Git executable in ForBlog settings. Git authentication must already work with the remote configured in the blog's `_config.yml` (`deploy.type: git`, `deploy.repo`, `deploy.branch`). No ForBlog account or subscription is required; your hosting provider may require an account.

On macOS, use `Cmd+P` for the command palette. Run `command -v node` and `command -v git` in Terminal and enter their absolute paths in ForBlog settings, especially when Node.js is installed with nvm: Obsidian launched from the Dock may have a different PATH. See the [macOS acceptance record](docs/macos-acceptance.md) for the verified scope.

The macOS compatibility fixes are included in 0.3.1. The older 0.3.0 assets do not contain these fixes.

To upgrade, disable ForBlog, replace only the three installation files, preserve `data.json`, then enable it again. Existing settings are retained.

Open a note and run **ForBlog: 预览当前笔记（不推送）** from the command palette. A missing publishing configuration opens an editable form; saving writes front matter and continues. Review the preview, then run the publish command when ready. Batch publishing considers only notes with top-level `blog_publish: true`.

## Data, network and filesystem access

ForBlog reads notes and referenced attachments through Obsidian APIs. Explicit publishing-property edits and withdrawal may update note front matter; withdrawal does not delete the original note or original attachments. Bulk discovery scans Markdown notes to find explicit publishing flags.

The plugin accesses your configured Hexo folder outside the vault to read configuration, export selected articles/assets, run the locally installed Hexo build, and manage `.forblog` state, deployment checkout and withdrawal backups. It starts local Node.js and Git processes. Use a blog and Hexo plugins you trust.

Git connects to the remote you configured for fetch/push and uses your existing SSH or credential-manager authentication. ForBlog has no telemetry or plugin-operated remote service, stores no access-token field, and does not download executables or update itself. Settings are stored locally in the plugin's `data.json`; do not put credentials in repository URLs.

Preview serves the generated site only on `127.0.0.1`. The opened blog page can load external assets configured by your theme or content. Opening a published article accesses your configured website.

## Publishing semantics and limitations

Unchanged notes and attachments are skipped. Hexo may still regenerate shared indexes, archives or search files; Git deploys only changed output. A later deployment publishes the current complete exported Hexo snapshot, including changes left by earlier preview or sync operations.

Hidden articles are excluded from generated pages, but hiding or withdrawing is not access control: old Git commits, hosting caches and third-party copies may retain previously published content.

Canvas, Dataview execution, SVG attachments and arbitrary Obsidian plugin rendering are not supported. See the [Chinese manual](README.md) for commands, supported formats, recovery and configuration details.

## Development and release

```sh
npm ci
npm run check
npm run package
npm run validate:release -- 0.3.1
```

See [verification evidence](VERIFICATION.md) and the [release guide](RELEASING.md). GitHub release availability does not imply acceptance into the Obsidian Community directory.

MIT license. Runtime dependency license texts are embedded in `main.js` and included as `THIRD-PARTY-NOTICES.txt` in the packaged directory.
