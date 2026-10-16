import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/process';

test('command output streams before exit, decodes UTF8, strips ANSI and redacts progress', async () => {
  const lines: string[] = [];
  let firstLine!: () => void;
  const first = new Promise<void>(resolve => firstLine = resolve);
  let exited = false;
  const command = run(process.execPath, ['-e', `
    process.stdout.write('\\x1b[32mready\\x1b[39m\\n');
    const text = Buffer.from('中文输出\\n');
    process.stdout.write(text.subarray(0, 2));
    setTimeout(() => {
      process.stdout.write(text.subarray(2));
      process.stderr.write('Receiving: 10%\\rReceiving: 100%\\rghp_abcd123\\n');
    }, 100);
    setTimeout(() => process.stdout.write('tail'), 400);
  `], process.cwd(), { log: line => { lines.push(line); firstLine(); } }).then(result => { exited = true; return result; });
  await first; assert.equal(exited, false);
  const result = await command;
  assert.equal(result.code, 0); assert.match(result.stdout, /中文输出/);
  assert.deepEqual(lines, ['ready', '中文输出', 'Receiving: 10%', 'Receiving: 100%', '[redacted]', 'tail']);
  assert.ok(lines.every(line => !line.includes('\x1b') && !line.includes('ghp_')));
});

function treeScript(): string {
  const leaf = `console.log('pid:' + process.pid); setInterval(() => {}, 1000);`;
  const branch = `const { spawn } = require('node:child_process'); console.log('pid:' + process.pid); spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
  return `const { spawn } = require('node:child_process'); console.log('pid:' + process.pid); spawn(process.execPath, ['-e', ${JSON.stringify(branch)}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
}

for (const mode of ['timeout', 'cancel'] as const) {
  test(`${mode} terminates the root, child and grandchild before rejection`, { timeout: 12_000 }, async () => {
    const pids: number[] = [], controller = new AbortController();
    const result = run(process.execPath, ['-e', treeScript()], process.cwd(), {
      label: 'Git 测试克隆', timeout: mode === 'timeout' ? 1500 : 8000, signal: controller.signal,
      log: line => {
        if (line.startsWith('pid:')) pids.push(Number(line.slice(4)));
        if (mode === 'cancel' && pids.length === 3) controller.abort();
      }
    });
    await assert.rejects(result, mode === 'timeout' ? /Git 测试克隆.*超时.*进程树已终止/ : /Git 测试克隆.*取消.*进程树已终止/);
    assert.equal(pids.length, 3);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
}

test('nonzero and startup errors identify the failing stage and allowFailure preserves status', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'process.stderr.write("failed"); process.exit(7)'], process.cwd(), { label: 'Git 获取部署分支' }), /Git 获取部署分支执行失败（7）：failed/);
  assert.equal((await run(process.execPath, ['-e', 'process.exit(7)'], process.cwd(), { allowFailure: true })).code, 7);
  await assert.rejects(run('forblog-missing-executable-000', [], process.cwd(), { label: 'Hexo 构建' }), /无法启动 Hexo 构建/);
});
