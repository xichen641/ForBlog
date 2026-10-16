import * as fs from 'node:fs/promises';
import path from 'node:path';
import { exists, inside, mirror, writeChanged } from './files';
import { ProcessCleanupError, run } from './process';
import type { Log } from './types';

export interface GitTarget { repo: string; branch: string }
export interface DeployResult { commit: string; written: number; deleted: number; pushed: boolean }
export async function deploy(blogDir: string, target: GitTarget, gitPath: string, log: Log, signal?: AbortSignal): Promise<DeployResult> {
  if (!target.repo || target.repo.startsWith('-') || /[\r\n]/.test(target.repo) || /^https?:\/\/[^/]*@/.test(target.repo)) throw new Error('Git 仓库地址无效；认证请使用现有 SSH 或 Git 凭据管理器');
  const directory = await inside(blogDir, '.forblog/deploy');
  const git = (args: string[], cwd = directory, allowFailure = false, label = `Git ${args[0]}`, timeout?: number) => run(gitPath, args, cwd, { signal, allowFailure, label, timeout, log: ['clone', 'fetch', 'push'].includes(args[0]!) ? log : undefined });
  await git(['check-ref-format', '--branch', target.branch], blogDir);
  log(`Git：检查远端部署分支 ${target.branch}…`);
  const heads = await run(gitPath, ['ls-remote', '--heads', '--', target.repo, `refs/heads/${target.branch}`], blogDir, { signal, label: 'Git 查询远端分支' });
  const remoteHead = heads.stdout.split(/\s+/)[0] || undefined;
  if (!await exists(directory)) {
    await fs.mkdir(path.dirname(directory), { recursive: true });
    const staging = await fs.mkdtemp(path.join(path.dirname(directory), 'deploy-initializing-'));
    try {
      if (remoteHead) {
        log('Git：首次初始化部署仓库（浅克隆，最近 1 次提交，仅获取文件清单）…');
        await git(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--single-branch', '--no-tags', '--progress', '--branch', target.branch, '--', target.repo, staging], blogDir, false, 'Git 首次浅克隆', 300_000);
        // The complete desired site already exists in public/. Populate Git's
        // index from the remote tree without downloading old media to a worktree.
        // add -A below then records changes/deletions against that original tree.
        await git(['read-tree', 'HEAD'], staging);
      } else {
        log('Git：远端分支尚不存在，初始化部署仓库…');
        await git(['init', '-b', target.branch], staging);
        await git(['remote', 'add', 'origin', target.repo], staging);
      }
      await fs.rename(staging, directory);
    } catch (error) {
      if (!(error instanceof ProcessCleanupError)) {
        await fs.rm(staging, { recursive: true, force: true });
        log('Git：已清理未完成的初始化目录，下次可直接重试。');
      } else log(`Git：保留初始化目录以便排查残留进程：${staging}`);
      throw error;
    }
  }
  const origin = await git(['remote', 'get-url', 'origin']);
  if (origin.stdout !== target.repo) throw new Error('发布目录绑定了另一个 Git 仓库；请使用新的博客目录，或检查 .forblog/deploy');
  if ((await git(['symbolic-ref', '--short', 'HEAD'])).stdout !== target.branch) throw new Error('发布目录分支与部署设置不一致');
  await git(['config', 'core.autocrlf', 'false']);
  if (remoteHead) {
    log('Git：获取部署分支更新…');
    await git(['fetch', '--no-tags', '--progress', 'origin', target.branch], directory, false, 'Git 获取部署分支');
    const head = await git(['rev-parse', '--verify', 'HEAD'], directory, true);
    if (head.code !== 0) throw new Error('发布目录的 Git 状态不完整');
    if (head.stdout !== remoteHead) {
      const remoteIsAncestor = await git(['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'], directory, true);
      if (remoteIsAncestor.code !== 0) {
        if ((await git(['status', '--porcelain'])).stdout) throw new Error('远端已更新且本地有待发布内容，请先处理 Git 分歧');
        await git(['merge', '--ff-only', 'FETCH_HEAD']);
      }
    }
  }
  log('比较静态文件，仅同步变化内容…');
  await writeChanged(await inside(blogDir, 'public/.nojekyll'), '');
  const changes = await mirror(path.join(blogDir, 'public'), directory);
  log(`静态文件：${changes.written} 个写入，${changes.deleted} 个删除`);
  // Public artifacts must not be silently omitted by a global Git ignore rule.
  await git(['add', '-A', '--force']);
  const staged = await git(['diff', '--cached', '--quiet', '--no-renames'], directory, true);
  if (staged.code > 1) throw new Error('无法检查 Git 暂存区');
  if (staged.code === 1) {
    log('Git：提交静态文件变更…');
    await git(['-c', 'user.name=ForBlog', '-c', 'user.email=forblog@localhost', 'commit', '--quiet', '-m', 'Publish blog changes with ForBlog']);
  }
  const head = await git(['rev-parse', '--verify', 'HEAD']);
  const pushed = head.stdout !== remoteHead;
  if (pushed) {
    log('推送博客变更…');
    // Normal fast-forward push. A concurrent remote change is reported, never overwritten.
    await git(['push', '--progress', 'origin', `HEAD:refs/heads/${target.branch}`], directory, false, 'Git 推送博客');
  }
  return { commit: head.stdout, ...changes, pushed };
}
