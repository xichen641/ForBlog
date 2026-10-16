# 发布与社区目录提交

## 发布前

1. 同步 `manifest.json`、`package.json`、`package-lock.json` 的版本，以及 `versions.json` 中对应版本的最低 Obsidian 要求。
2. 更新 `CHANGELOG.md` 和 `docs/releases/<版本>.md`；记录兼容性验证范围，不能把类型检查等同于真实桌面验收。
3. 执行 `npm ci`、`npm run check`、`npm run package`、`npm run validate:release -- <版本>`。
4. 对打包后的插件做桌面验收，检查首次配置、管理页和取消路径；涉及发布、隐藏、下架的完整流程优先在临时博客和本地 Git 远端中运行。
5. 检查差异，只提交项目源码与文档。`data.json`、Vault 内容、`.acceptance`、`node_modules`、部署目录和凭据不应进入提交。

## 创建 GitHub Release

本项目采用直接合入 `main` 的个人维护流程，不要求创建 PR。将已审查、验证的修改提交并推送到 `main` 后，等待该提交的 **Test and release** 流程通过。它会在 Windows / macOS 与 Node.js 20 / 24 的四种组合上构建、运行测试并验证安装包。

```powershell
git tag -a 0.3.1 -m "发布 ForBlog 0.3.1"
git push origin 0.3.1
```

标签必须与 `manifest.json` 的 `version` 完全一致，不加 `v`。标签流程会重新测试，使用短期 `GITHUB_TOKEN` 创建草稿、上传完整附件后再公开发布；不需要维护个人访问令牌。

附件包括独立的 `main.js`、`manifest.json`、`styles.css`，以及便于手动安装的 ZIP 和 `SHA256SUMS.txt`。第三方依赖许可证内嵌在 `main.js`，ZIP 中也有独立文本。

发布后核对标签指向的提交、Actions 结果、Release 是否公开，以及三个独立附件的哈希与本地交付文件是否一致。如果上传阶段失败，先检查草稿及附件，再修复发布流程；不要将不完整的草稿直接公开，也不要覆盖已经公开的版本标签。

## 首次提交 Obsidian 社区目录

GitHub Release 与社区收录是两个步骤。当前官方流程为：

1. 使用 Obsidian 账号登录 [社区目录](https://community.obsidian.md/)，连接具有仓库维护权限的 GitHub 账号。
2. 在插件提交入口填写仓库 `https://github.com/xichen641/ForBlog`，确认所有者和维护承诺后提交审核。
3. 按自动检查与审核反馈修复问题，更新版本并发布新 Release；不要把本地检查通过表述为官方审核通过。

仓库根目录保留 `manifest.json`、`README.md` 和 `LICENSE`，默认分支的插件信息与已发布版本保持一致。社区目录从与 manifest 版本匹配的 Release 下载三个独立安装文件。

官方依据（2026-10-16 核对）：[提交插件](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)、[提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)、[开发者政策](https://docs.obsidian.md/community-directory/developer-policies)、[账号与仓库关联](https://docs.obsidian.md/community-directory/set-up-and-claim)。
