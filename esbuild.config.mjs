import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dependencyNotices } from './scripts/licenses.mjs';
const context = await esbuild.context({
  entryPoints: ['src/main.ts'], outfile: 'main.js', bundle: true, metafile: true,
  external: ['obsidian', 'electron', ...builtinModules, ...builtinModules.map(x => `node:${x}`)],
  platform: 'node', format: 'cjs', target: 'es2022', logLevel: 'info',
  sourcemap: process.argv.includes('--watch') ? 'inline' : false,
  banner: { js: '/* ForBlog — generated Obsidian desktop plugin. */' },
  footer: { js: `/*\n${(await dependencyNotices()).replaceAll('*/', '* /')}\n*/` }
});
if (process.argv.includes('--watch')) await context.watch();
else {
  const result = await context.rebuild();
  await mkdir('dist', { recursive: true });
  await writeFile('dist/build-meta.json', JSON.stringify(result.metafile, null, 2));
  await context.dispose();
}
