# ForBlog

将 Obsidian 公开笔记、图片和 PDF 增量同步到本地 Hexo，再通过 Git 发布静态站点。桌面端插件，使用 TypeScript 开发；不依赖 Shell commands，也不需要在笔记中写终端命令。

## 安装与首次使用

开发环境需要 Node.js 20+ 和 Git。使用插件的电脑还需要已经安装依赖的 Hexo 博客。

```powershell
cd D:\LB\ForBlog
npm ci
npm run check
npm run package
```

生成的 `dist/forblog/` 是可直接安装的插件文件夹，包含 `main.js`、`manifest.json` 和 `styles.css`。先在独立的测试 Vault 安装和验证：

```powershell
npm run install:local -- "D:\你的测试Vault"
```

该命令只复制插件文件，不自动启用插件，也不会修改笔记。在 Obsidian 的 **设置 → 第三方插件** 中启用 ForBlog。也可以手动将 `dist/forblog` 复制到目标 Vault 的 `.obsidian/plugins/forblog`。

插件设置建议值（根据你电脑的实际路径填写）：

| 字段 | 示例 | 用途 |
| --- | --- | --- |
| Hexo 博客目录 | `D:\Myblog` | 包含 `_config.yml`、`source`、`node_modules` 的目录 |
| 博客网址 | `https://xichen641.github.io` | 可覆盖 Hexo `url`；项目站点需要包含子路径 |
| Node.js 程序 | `D:\nodejs\node.exe` | 运行博客本地安装的 Hexo |
| Git 程序 | `D:\Git\cmd\git.exe` | 使用现有 SSH 或 Git 凭据管理器认证 |
| 预览端口 | `4000` | 仅监听 `127.0.0.1` |

博客 `_config.yml` 的部署配置示例：

```yaml
deploy:
  type: git
  repo: git@github.com:xichen641/xichen641.github.io.git
  branch: main
```

首次使用时，在 Obsidian 打开笔记，按 `Ctrl+P`，执行 **ForBlog: 设置当前笔记的发布属性**，填写标题、网址名称、标签和分类。保存后先执行 **检查当前笔记的发布变更**，再执行 **预览当前笔记（不推送）**，确认后执行 **发布当前笔记（增量）**。

可以在快捷键设置中绑定这些命令。侧边栏发送按钮、笔记右键菜单也可以发布当前笔记。

## 笔记格式

插件的发布属性界面会生成下面的 YAML；也可以手动填写：

```yaml
---
title: CLIP-ReID 学习笔记
date: "2026-10-15T10:00:00+08:00"
tags:
  - ReID
  - CLIP
categories:
  - 论文阅读
blog_publish: true
blog_id: reid-001
blog_slug: clip-reid
---
```

- `blog_publish` 必须显式为 `true`；缺省或 `false` 的笔记不会被批量发布。批量发现使用顶层 `blog_publish: true` 写法。
- `blog_id` 是固定文章身份，界面自动生成 UUID。标题、文件名和笔记所在目录可以更改；请保留这个 ID。
- `blog_slug` 决定 `/posts/clip-reid/` 这样的固定网址，首次导出后锁定。如需改变，先处理引用并下架旧文章。
- `date` 是首次发布时间，`updated` 可选。未填写 `updated` 时，只在公开内容变化时更新，重复同步不会刷新时间。
- `tags`、`categories` 使用字符串数组；分类按 Hexo 层级解释。
- 导出只保留标题、时间、标签、分类和插件控制的渲染字段。其他 Front Matter 不进入博客文章。

发布操作使用打开编辑器的内容快照。保存发布属性使用 Obsidian 官方的 Front Matter API，不整体重写正文。

## 命令

| 命令 | 行为 |
| --- | --- |
| 设置当前笔记的发布属性 | 配置公开标记、固定身份和文章信息 |
| 检查当前笔记的发布变更 | 只检查；不写博客，不构建、不推送 |
| 仅同步当前笔记到 Hexo | 导出 Markdown 和附件；不构建、不推送 |
| 预览当前笔记 | 增量导出并构建，通过本地 HTTP 服务打开实际 Hexo 页面；不推送 |
| 发布当前笔记 | 导出该笔记，构建站点，差异同步并推送 |
| 发布所有修改的公开笔记 | 扫描公开笔记，只写入有变化的文章和附件 |
| 完整重建并发布博客 | 对已有 Hexo 内容清理缓存、完整构建并部署；不隐式导出其他笔记 |
| 重试推送已同步的博客内容 | 构建当前已导出快照（如需要），重试 Git 发布 |
| 打开当前笔记的博客页面 | 使用成功推送记录中的固定网址 |
| 下架当前笔记 | 确认后移除对应导出文件、关闭笔记发布标记，再构建和部署 |
| 停止博客预览服务 | 关闭本地预览服务 |

下架不会删除 Obsidian 原稿或原始附件。其他已导出文章若有对目标文章的链接，会要求先解除链接并同步这些文章，避免下架后留下断链。关闭 `blog_publish` 或删除原稿只停止同步，不自动下架线上文章。

## 增量更新如何工作

插件使用 SHA-256 对公开正文、公开属性、转换后的链接、附件内容和转换器版本计算指纹，不只依赖文件修改时间。只改图片也会识别为文章变化；只改未导出的私有属性不会重新发布。

1. 先完整检查本次选中的笔记和附件，再开始写入导出文件。
2. 对生成的 Markdown 和附件逐一比较字节，内容一致时不写文件，保留修改时间。
3. 普通发布保留 Hexo `db.json` 与 `public` 缓存。Hexo 仍运行站点生成器，未变化的文件跳过写入；首页、归档、标签和搜索索引按实际影响更新。
4. 生成文件差异同步到专用 Git 工作目录，仅写入和删除变化文件。无产物变化就不创建新提交、不推送。
5. Git 推送成功后才更新 `published` 指纹。推送失败保留已导出内容和待推送提交，可以重试。

全局 Hexo 配置、依赖锁文件、插件使用的博客网址或本地 `themes/` 改变时，触发完整重建。通过 npm 安装的主题版本由依赖锁文件反映；手工修改 `node_modules`、博客 `scripts/` 或其他未跟踪构建输入后，请执行完整重建。

部署始终维护完整站点快照。GitHub Pages 平台仍按站点版本发布，插件不承诺平台内部只部署一篇文章。

## 文件与发布记录

```text
Hexo 博客目录/
├─ source/
│  ├─ _posts/forblog/<blog_id>.md
│  └─ assets/forblog/<blog_id>/<内容哈希>-<附件文件名>
└─ .forblog/
   ├─ manifest.json    # 已导出/已推送指纹、链接和附件归属
   ├─ hexo.yml         # 构建时的网址覆盖配置，不修改原 _config.yml
   ├─ publish.lock     # 跨窗口发布锁
   └─ deploy/          # 独立 Git 工作目录，正常快进推送
```

请保留 `.forblog/manifest.json`，丢失它就会失去文章归属和增量记录。若将 Hexo 源码加入 Git，建议忽略 `.forblog/deploy/`、`.forblog/publish.lock` 和 `.forblog/hexo.yml`，并自行决定是否备份 manifest（其中包含本地笔记相对路径）。

首次部署会克隆目标分支。已有 `hexo-deployer-git` 的 `.deploy_git` 不会被修改；插件使用自己的 `.forblog/deploy`。不要在插件发布过程中同时运行其他部署工具。插件不强制推送，远端分歧会报错；在本地生成的提交身份为 `ForBlog <forblog@localhost>`。

**预览和仅同步会改变博客本地源码/构建产物。下一次部署会发布整个已导出快照，包含此前预览留下的待发布修改。** 这是“同步后预览”的工作方式。若只想检查而不改变博客，使用“检查当前笔记的发布变更”。

## 支持的语法与边界

| 内容 | 首版行为 |
| --- | --- |
| Markdown 标题、代码块、表格 | 保留，交由博客现有渲染器处理 |
| `![[图片.png]]`、`![[图片.png\|600x400]]` | 复制图片并转换为带尺寸的 HTML 图片 |
| 普通/引用式 Markdown 本地图片与附件 | 解析、复制、重写为博客资源地址 |
| `[[文章\|别名]]` | 目标已导出或在本批次中时转换为博客链接 |
| 指向未公开笔记的双链 | 转为显示文字并提示，不隐式公开其他笔记 |
| `![[论文.pdf#page=3]]` | 复制 PDF，生成浏览器原生 iframe 和下载链接；不依赖 PDF.js |
| 音视频附件 | 支持 mp3/ogg/wav/mp4，生成原生播放器 |
| `%%私有注释%%` | 删除正文中的注释，保留代码和公式中的示例；未闭合注释阻止发布 |
| 数学公式、Mermaid | 保留并提示，需要博客自行配置渲染器/主题 |
| 笔记嵌入、标题/块双链、Dataview | 明确报错，先转换为静态内容或整篇文章链接 |
| SVG、Canvas、其他附件类型 | 首版不导出，明确提示不支持 |
| Markdown 中 `/...` 根路径、外部链接 | 视为已有网站地址保留，不从 Vault 复制 |

内部链接解析依赖 Obsidian 的 MetadataCache。首次给新文章建立关联，建议在同一批次发布；已导出文章中的纯文字引用不会因单独发布目标笔记而自动改写，执行“发布所有修改的公开笔记”会重新计算链接依赖。

插件不会将整个 Vault 或整个附件目录复制进博客。路径越界、托管目录符号链接、缺失附件、身份/网址冲突以及覆盖非托管文章都会阻止发布。Obsidian 原稿中的普通文字和原生 HTML 仍按作者提供的公开内容导出。

## 验证与开发

```powershell
npm run dev      # 监听源码并重新打包
npm run check    # 类型检查、打包、自动测试
npm run package  # 生成 dist/forblog
```

自动测试覆盖转换、附件独立变化、无变化时修改时间不变、笔记移动、错误预检查、下架、文件差异同步、真实本地 Git 推送/拒绝/重试，以及真实 Hexo 构建和本地 HTTP 预览。所有 Git 测试仅使用临时本地裸仓库，不推送 GitHub。

另有真实 Fluid 主题渲染检查，以及对打包后插件的模拟 Obsidian API 加载、11 个命令注册和发布属性编辑检查。模拟 API 检查不替代真实 Obsidian 窗口中的验收。

本地检查通过不等同于已验证 Obsidian 实际加载、真实 GitHub 认证或 GitHub Pages 上线。启用插件后，先用测试文章预览，再执行首次真实发布。

开发参考：[Obsidian 插件开发](https://docs.obsidian.md/Plugins/Getting%20started/Build%20a%20plugin)、[Vault API](https://docs.obsidian.md/Plugins/Vault)、[Hexo 生成](https://hexo.io/docs/generating)。
