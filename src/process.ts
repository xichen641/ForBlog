import { spawn } from 'node:child_process';
import type { Log } from './types';
export interface CommandResult { code: number; stdout: string; stderr: string }
export async function run(executable: string, args: string[], cwd: string, options: { signal?: AbortSignal; allowFailure?: boolean; log?: Log; timeout?: number } = {}): Promise<CommandResult> {
  if (options.signal?.aborted) throw new Error('操作已取消');
  return new Promise((resolve, reject) => {
    // No shell interpolation: paths, note text and Git arguments remain separate arguments.
    const child = spawn(executable, args, {
      cwd, shell: false, windowsHide: true, signal: options.signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    const limit = 128 * 1024;
    child.stdout.on('data', (data: Buffer) => { stdout = (stdout + data.toString('utf8')).slice(-limit); });
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString('utf8')).slice(-limit); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('命令执行超时，请检查网络或本地构建环境')); }, options.timeout ?? 180_000);
    child.once('error', error => { clearTimeout(timer); reject(new Error(`无法启动 ${executable}：${error.message}`)); });
    child.once('close', code => {
      clearTimeout(timer);
      const result = { code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() };
      if (result.code !== 0 && !options.allowFailure) reject(new Error(`命令执行失败（${result.code}）：${redact(stderr || stdout)}`));
      else resolve(result);
    });
  });
}
export function redact(message: string): string {
  return message.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@').replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]');
}
