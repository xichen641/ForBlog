import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { dependencyNotices } from './licenses.mjs';
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const directory = new URL(`../dist/${manifest.id}/`, import.meta.url);
await mkdir(directory, { recursive: true });
for (const name of ['main.js', 'manifest.json', 'styles.css', 'README.md', 'README.en.md', 'CHANGELOG.md', 'VERIFICATION.md', 'LICENSE']) await copyFile(new URL(`../${name}`, import.meta.url), new URL(name, directory));
await writeFile(new URL('THIRD-PARTY-NOTICES.txt', directory), await dependencyNotices());
console.log(`Plugin bundle: ${directory.pathname}`);
