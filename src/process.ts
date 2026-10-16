import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import type { Log } from './types';
export interface CommandResult { code: number; stdout: string; stderr: string }
export class ProcessCleanupError extends Error {}

export async function waitForProcessGroupExit(pid: number, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (true) {
    try { process.kill(-pid, 0); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return;
      // Darwin can return EPERM while a killed group's zombies await reaping.
      // Keep waiting: EPERM alone never proves that the group has disappeared.
      if (code !== 'EPERM') throw error;
    }
    if (Date.now() >= deadline) throw new Error('进程组在终止后仍未退出');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function terminateTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    // kill() only sends the signal. Wait for the process group to disappear,
    // including children and zombies awaiting reaping, before reporting cleanup.
    await waitForProcessGroupExit(pid);
    return;
  }
  // Git for Windows starts another git.exe, ssh.exe and index-pack. Killing only
  // the wrapper leaves those children holding the destination and output pipes.
  await new Promise<void>((resolve, reject) => {
    const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    killer.once('error', reject);
    killer.once('close', code => code === 0 ? resolve() : reject(new Error(`taskkill 返回 ${code}`)));
  });
}

export async function run(executable: string, args: string[], cwd: string, options: { signal?: AbortSignal; allowFailure?: boolean; log?: Log; timeout?: number; label?: string } = {}): Promise<CommandResult> {
  if (options.signal?.aborted) throw new Error('操作已取消');
  return new Promise((resolve, reject) => {
    // No shell interpolation: paths, note text and Git arguments remain separate arguments.
    const child = spawn(executable, args, {
      cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    let settled = false, stopping = false, closed = false;
    const label = options.label ?? `${path.basename(executable)} ${args[0] ?? ''}`.trim();
    const timeout = options.timeout ?? 180_000;
    const limit = 128 * 1024;
    const streams = [{ decoder: new StringDecoder('utf8'), pending: '' }, { decoder: new StringDecoder('utf8'), pending: '' }];
    const output = (index: number, value: string, flush = false) => {
      if (index === 0) stdout = (stdout + value).slice(-limit); else stderr = (stderr + value).slice(-limit);
      const stream = streams[index]!;
      const lines = (stream.pending + value).split(/[\r\n]+/);
      stream.pending = flush ? '' : lines.pop()!.slice(-limit);
      for (const line of lines) { const cleaned = redact(stripVTControlCharacters(line)).trimEnd(); if (cleaned) options.log?.(cleaned); }
    };
    child.stdout.on('data', (data: Buffer) => output(0, streams[0]!.decoder.write(data)));
    child.stderr.on('data', (data: Buffer) => output(1, streams[1]!.decoder.write(data)));
    const finish = (error?: Error, code = -1) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      for (let index = 0; index < streams.length; index++) output(index, streams[index]!.decoder.end(), true);
      child.stdout.destroy(); child.stderr.destroy();
      const result = { code, stdout: stripVTControlCharacters(stdout).trim(), stderr: stripVTControlCharacters(stderr).trim() };
      if (error) reject(error);
      else if (code !== 0 && !options.allowFailure) reject(new Error(`${label}执行失败（${code}）：${redact(result.stderr || result.stdout)}`));
      else resolve(result);
    };
    const stop = (reason: string) => {
      if (settled || stopping) return;
      stopping = true;
      void (child.pid ? terminateTree(child.pid) : Promise.resolve()).then(
        () => finish(new Error(`${label}：${reason}；进程树已终止`)),
        error => closed ? finish(new Error(`${label}：${reason}；命令已结束`)) : finish(new ProcessCleanupError(`${label}：${reason}；终止进程树失败，请检查残留进程：${String(error)}`))
      );
    };
    const abort = () => stop('操作已取消');
    const timer = setTimeout(() => stop(`命令执行超时（${Math.ceil(timeout / 1000)} 秒）`), timeout);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once('error', error => { if (!stopping) finish(new Error(`无法启动 ${label}：${error.message}`)); });
    child.once('close', code => {
      closed = true;
      if (!stopping) finish(undefined, code ?? -1);
    });
  });
}
export function redact(message: string): string {
  return message.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@').replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]');
}
