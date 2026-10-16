# macOS 适配验收

日期：2026-10-16（Asia/Shanghai）。源码基线：`13e14062fec2e5b9285e435cad4103eb994669df`，ForBlog 0.3.0，叠加本次适配修复。

## 环境与结果

| 项目 | 本机验证结果 |
| --- | --- |
| 系统 | macOS 27.0.1（26A434），Apple Silicon / arm64 |
| 开发工具 | Node.js v24.21.0、npm 11.19.0、Apple Git 2.54.0 |
| 博客依赖 | 锁文件安装，Hexo 7.3.0、Fluid 1.9.8 |
| 构建与测试 | 最终 `npm run check`：65/65 通过，无跳过 |
| 打包与校验 | `npm run package`、`npm run validate:release -- 0.3.0` 通过 |
| 独立安装 | 安装脚本成功写入含中文和空格路径的测试 Vault；三个安装文件与源码构建、打包产物 SHA-256 一致 |
| Obsidian | 原运行版本 1.13.7；通过设置页应用已下载的 1.14.4 更新，应用日志确认加载 1.14.4 |
| 真实桌面验收 | 已完成独立 Vault 的加载、属性、预览、发布、增量更新、文章管理、隐藏/恢复、下架和缺失附件错误检查 |

## 发现并修复的问题

POSIX 进程组收到 `SIGKILL` 后，系统仍需要时间完成进程退出和回收。原实现立即报告“进程树已终止”，取消与超时测试均可能观察到仍存在的 PID。本机诊断在报错瞬间观察到根进程为 `<defunct>`，100 毫秒后消失。

`src/process.ts` 现在发送信号后轮询进程组，确认不存在后才返回，等待上限 5 秒。既有的真实三层进程测试分别验证超时和主动取消，无需降低断言。定向 4 项进程测试及完整 63 项测试均通过。

真实桌面增量测试还发现：阅读视图已显示外部修改后的 V2 正文，发布却误用隐藏编辑器中的旧 V1，显示“0 篇有变化”。这是本次 macOS 验收发现的跨平台快照问题。`ObsidianSource` 现在仅对 `getMode() === 'source'` 的编辑视图采集编辑器快照，阅读视图读取 Vault。新增两个真实打包插件回归测试，分别验证阅读视图更新与编辑模式未落盘内容优先；最终 65 项测试全部通过。真实窗口重载修复后，同一篇 V2 正文被正确识别并发布。

设置页按系统展示博客目录、Node.js 和 Git 路径示例，并将 `.exe` 专用提示改为可执行文件说明。Mac 通过 nvm 安装的 Node.js 仍需填写实际绝对路径，未引入自动安装或程序搜索逻辑。

验收初始化脚本现在支持传入独立目录，默认目录改为执行日期；已存在的目录继续拒绝覆盖。GitHub Actions 测试矩阵增加 macOS 与 Node.js 20 / 24，远端运行结果待后续推送后核对。

## 已验证的范围

完整测试包含真实临时 Hexo/Fluid 构建、仅绑定本机的 HTTP 预览、临时本地 Git 裸仓库的发布与失败重试、中文和空格路径、附件增量变化、双链、文章隐藏和恢复、混合下架、发布锁、路径和符号链接校验，以及模拟 Obsidian API 中的插件加载和管理页操作。

真实窗口检查与文件/Git 读回结果见下节。真实 GitHub 认证与 Pages 上线不属于本次本地测试结果。

## 复现与证据

本轮日志在仓库的 `.acceptance/macos-20261016/`（已被 Git 忽略）：

- `check.log`：初始 61/63 通过，两个进程清理断言失败。
- `process-before-fix.json`：PID、报错瞬间和 100 毫秒后的进程状态。
- `process-after-fix.log`：4 项进程测试通过。
- `check-after-fix.log`：进程回收修复后 63 项完整测试通过。
- `check-final.log`：包含两个快照回归测试的最终 65 项测试通过。
- `package-final.log`、`validate-release-final.log`：最终产物打包与校验。
- `installation.json`：三个安装文件的 SHA-256 一致性及本地部署目标校验。
- `中文 空格/environment.json`：独立 Vault、Hexo 博客和本地 Git 远端路径。
- `cancel-unchanged.json`：取消属性表单后，三个测试原稿的 SHA-256 均未变化。
- `desktop-preview.json`：HTTP 200、标题、私有注释排除和预览未推送记录。
- `desktop-first-publish.json`、`desktop-repeat-publish.json`：首次发布和无变化重复发布。
- `desktop-incremental-before-fix.json`、`desktop-incremental-after-fix.json`：阅读视图快照问题修复前后对照。
- `desktop-before-asset-change.json`、`desktop-asset-change.json`：仅修改图片、正文 SHA-256 不变的增量发布。
- `desktop-hidden.json`、`desktop-visible.json`：文章隐藏、恢复与页面/资源读回。
- `desktop-withdrawal.json`、`desktop-missing-asset.json`：下架备份和缺失附件预检查。
- `final-summary.json`：最终测试、安装一致性、Git、原稿恢复、私有内容排除、锁和预览服务状态汇总。

```sh
npm ci
npm run check
npm run package
npm run validate:release -- 0.3.0
FORBLOG_TEST_GIT=/usr/bin/git node scripts/prepare-acceptance.mjs ".acceptance/mac-desktop/中文 空格"
```

测试 Vault：`/Users/chenxi/LB/ForBlog/.acceptance/macos-20261016/中文 空格/ForBlog验收`。博客部署目标为同级 `remote.git`，只写本机。

## 真实窗口验收结果

1. 在 Obsidian 1.14.4 中启用 ForBlog，设置页读回正确的 Mac 博客目录、nvm Node.js 和 `/usr/bin/git`，命令面板列出 12 个命令。
2. 普通测试笔记执行预览后自动显示完整属性模板。取消前后三个原稿指纹相同；再次输入固定网址 `mac-test` 和中文分类 `macOS,验收`，保存后属性写入并继续构建。`http://127.0.0.1:19488/posts/mac-test/` 返回 HTTP 200，18025 字节，包含标题且排除私有注释，发布记录数量为 0。
3. 通过真实命令发布两篇公开笔记。双链转换为 `/posts/reference-note/`，私有笔记未导出。再次执行相同命令，日志显示“0 篇有变化，2 篇未变化”“静态文件：0 个写入，0 个删除”，提交不变。
4. 阅读视图外部更新 V2 正文的问题修复后，真实窗口显示“1 篇有变化，1 篇未变化”，正文页面包含 V2。随后只替换测试 PNG，同样识别 1 篇变化，新资源哈希生效，原稿 SHA-256 不变。
5. 管理页正确列出两篇 ForBlog 和一篇旧 Hexo 文章。归档切换分类后保留选择，勾选 `macOS` 分组得到两篇文章；混合下架确认准确列出两篇，取消后没有部署。
6. 从单篇可见性入口隐藏测试文章，页面移除且原稿不变；恢复公开后页面和独占图片重新生成，待部署记录清空。
7. 只勾选旧 Hexo 测试文章并确认下架，源码移至 `.forblog/trash/`，页面消失，另两篇文章保留。
8. 临时加入缺失附件引用，真实错误日志和 Notice 明确指出文件与缺失目标；导出稿 SHA-256 和 Git 提交保持不变。随后恢复测试原稿。插件重载后原预览端口不再监听。
9. 最终插件重载后，Mac 路径示例与已有配置均正确；恢复后的笔记检查显示“与上次推送版本一致”，附件与已转换链接各 1 个。管理页保留两篇公开文章、未选择文章；部署工作区干净，无发布锁和未完成的初始化目录。

所有提交均位于本机 `remote.git`：

| 操作 | 提交 |
| --- | --- |
| 首次发布 | `810b2ffacaca7d0f90ed795ae914b7b3d44dc751` |
| 重复发布 | 仍为 `810b2ffacaca7d0f90ed795ae914b7b3d44dc751` |
| V2 正文 | `52e8eea9756c5624fa1a0d9b19cdc79ff371f323` |
| 仅图片变化 | `159bce0a3ee777c120f4fdb42394bbabf2461acd` |
| 隐藏 | `7f680c026d92398b774c9b83430cceec6ad643e0` |
| 恢复公开 | `a481ef8010529f77cac05e412ee56eb68fe09d1b` |
| 下架旧文 | `1deeba923a446989e8409a677f9831481113aea7` |

## 验证边界

上述结论适用于本机 macOS 27.0.1 / Apple Silicon、Obsidian 1.14.4 和 Node.js 24。Intel Mac、Linux、其他 Obsidian 版本、Node.js 20 的 Mac 实跑以及真实 GitHub 认证/Pages 上线尚未在本轮验证。GitHub Actions 矩阵已配置，远端运行结果须另行核对。本次未发布新版本；现有线上 0.3.0 Release 不会自动包含这些适配修复。
