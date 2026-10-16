import { spawnSync } from 'node:child_process';

// Preserve the full test output in the job log and surface failures in check
// annotations, which remain readable without downloading authenticated logs.
if (!process.env.npm_execpath) throw new Error('Run through npm run check:ci');
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'check'], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) console.error(result.error);
if (result.status !== 0 && process.env.GITHUB_ACTIONS === 'true') {
  const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`.slice(-12_000);
  // GitHub truncates each annotation; split the tail so assertion details survive.
  for (let offset = 0; offset < details.length; offset += 2500) {
    const escaped = details.slice(offset, offset + 2500).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.error(`::error title=Build and test failure ${offset / 2500 + 1}::${escaped}`);
  }
}
process.exit(result.status ?? 1);
