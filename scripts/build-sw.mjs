// After `astro build`: writes dist/sw.js with this build's app shell and assets
// to precache, and a version so old caches are dropped on update.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DIST = 'dist';
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(DIST, p).split(sep).join('/'));
  }
})(DIST);

const precache = [];
for (const f of files) {
  if (f === 'sw.js' || f === '_headers' || f.endsWith('.woff')) continue; // woff2 is enough for every browser we target
  if (f.endsWith('.html')) {
    // Pages are served without the extension: index.html → /, sell/add.html → /sell/add
    precache.push(f === 'index.html' ? '/' : `/${f.replace(/(index)?\.html$/, '').replace(/\/$/, '')}`);
  } else if (f.startsWith('_astro/') || f.startsWith('icons/') || ['favicon.svg', 'manifest.webmanifest'].includes(f)) {
    precache.push(`/${f}`);
  }
}
precache.sort();

const hash = createHash('sha256');
for (const f of files.sort()) hash.update(f).update(readFileSync(join(DIST, f)));
const version = hash.digest('hex').slice(0, 12);

const sw = readFileSync('scripts/sw.template.js', 'utf8')
  .replace('__VERSION__', version)
  .replace('__PRECACHE__', JSON.stringify(precache, null, 2));
writeFileSync(join(DIST, 'sw.js'), sw);
console.log(`sw.js: version ${version}, ${precache.length} files precached`);
