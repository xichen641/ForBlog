import { readFile, readdir } from 'node:fs/promises';

// Include the complete notices in main.js: Obsidian installs only three assets.
export async function dependencyNotices() {
  const root = new URL('../', import.meta.url);
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
  const sections = ['Third-party notices for ForBlog.\nRuntime dependencies from package-lock.json (including transitive dependencies).'];
  for (const [directory, info] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (!directory || info.dev) continue;
    const base = new URL(`${directory}/`, root);
    const files = (await readdir(base)).filter(name => /^(licen[sc]e|copying)(\..*)?$/i.test(name)).sort();
    const name = directory.split('node_modules/').at(-1);
    // remark-math 6.0.0 omits its monorepo license from the npm tarball.
    const notices = name === 'remark-math' && !files.length
      ? [await readFile(new URL('licenses/remark-math.txt', root), 'utf8')]
      : await Promise.all(files.map(file => readFile(new URL(file, base), 'utf8')));
    if (!notices.length) throw new Error(`Missing license: ${directory}`);
    sections.push(`${name}@${info.version} (${info.license})\n${notices.join('\n')}`);
  }
  return sections.join('\n\n--------------------\n\n').replace(/\r\n/g, '\n');
}
