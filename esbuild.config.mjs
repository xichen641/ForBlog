import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
const context = await esbuild.context({
  entryPoints: ['src/main.ts'], outfile: 'main.js', bundle: true,
  external: ['obsidian', 'electron', ...builtinModules, ...builtinModules.map(x => `node:${x}`)],
  platform: 'node', format: 'cjs', target: 'es2022', logLevel: 'info',
  sourcemap: process.argv.includes('--watch') ? 'inline' : false,
  banner: { js: '/* ForBlog — generated Obsidian desktop plugin. */' }
});
if (process.argv.includes('--watch')) await context.watch();
else { await context.rebuild(); await context.dispose(); }
