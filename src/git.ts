import * as fs from 'node:fs/promises';
import path from 'node:path';
import { exists, inside, mirror, writeChanged } from './files';
import { run } from './process';
import type { Log } from './types';

export interface GitTarget { repo: string; branch: string }
export interface DeployResult { commit: string; written: number; deleted: number; pushed: boolean }
export async function deploy(blogDir: string, target: GitTarget, gitPath: string, log: Log, signal?: AbortSignal): Promise<DeployResult> {
  if (!target.repo || target.repo.startsWith('-') || /[\r\n]/.test(target.repo) || /^https?:\/\/[^/]*@/.test(target.repo)) throw new Error('Git 仓库地址无效；认证请使用现有 SSH 或 Git 凭据管理器');
  const directory = await inside(blogDir, '.forblog/deploy');
  const git = (args: string[], cwd = directory, allowFailure = false) => run(gitPath, args, cwd, { signal, allowFailure });
  await git(['check-ref-format', '--branch', target.branch], blogDir);
  const heads = await git(['ls-remote', '--heads', '--', target.repo, `refs/heads/${target.branch}`], blogDir);
  const remoteHead = heads.stdout.split(/\s+/)[0] || undefined;
  if (!await exists(directory)) {
    await fs.mkdir(path.dirname(directory), { recursive: true });
    if (remoteHead) await git(['clone', '--single-branch', '--branch', target.branch, '--', target.repo, directory], blogDir);
    else {
      await fs.mkdir(directory);
      await git(['init', '-b', target.branch]);
      await git(['remote', 'add', 'origin', target.repo]);
    }
  }
  const origin = await git(['remote', 'get-url', 'origin']);
  if (origin.stdout !== target.repo) throw new Error('发布目录绑定了另一个 Git 仓库；请使用新的博客目录，或检查 .forblog/deploy');
  if ((await git(['symbolic-ref', '--short', 'HEAD'])).stdout !== target.branch) throw new Error('发布目录分支与部署设置不一致');
  await git(['config', 'core.autocrlf', 'false']);
  if (remoteHead) {
    await git(['fetch', 'origin', target.branch]);
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
  // Public artifacts must not be silently omitted by a global Git ignore rule.
  await git(['add', '-A', '--force']);
  const staged = await git(['diff', '--cached', '--quiet'], directory, true);
  if (staged.code > 1) throw new Error('无法检查 Git 暂存区');
  if (staged.code === 1) {
    await git(['-c', 'user.name=ForBlog', '-c', 'user.email=forblog@localhost', 'commit', '-m', 'Publish blog changes with ForBlog']);
  }
  const head = await git(['rev-parse', '--verify', 'HEAD']);
  const pushed = head.stdout !== remoteHead;
  if (pushed) {
    log('推送博客变更…');
    // Normal fast-forward push. A concurrent remote change is reported, never overwritten.
    await git(['push', 'origin', `HEAD:refs/heads/${target.branch}`]);
  }
  return { commit: head.stdout, ...changes, pushed };
}
