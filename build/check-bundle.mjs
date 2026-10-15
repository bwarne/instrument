// Checks the packaged app can load its dependencies: every package in app.asar must contain the file
// its package.json "main" points to. The "files" excludes in package.json once dropped debug/src,
// so 1.0.5 failed at launch. `npm run release` runs this after building.
import { createRequire } from 'node:module';
import { posix } from 'node:path';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const archive = process.argv[2] || 'dist/mac-arm64/AnInstrument.app/Contents/Resources/app.asar';

const files = new Set(asar.listPackage(archive).map((f) => f.replace(/^\//, '')));
const missing = [];
let checked = 0;
for (const f of files) {
  const m = f.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\/package\.json$/);
  if (!m) continue;
  const pkg = JSON.parse(asar.extractFile(archive, f).toString());
  if (!pkg.main) continue; // index.js by default, or exports only
  checked++;
  const main = posix.normalize(posix.join(m[1], pkg.main));
  const found = [main, main + '.js', main + '.json', posix.join(main, 'index.js')].some((p) => files.has(p));
  if (!found) missing.push(`${m[1]}: main "${pkg.main}"`);
}
if (missing.length) {
  console.error(`app.asar is missing entry files, so the app would fail at launch:\n  ${missing.join('\n  ')}\nCheck the "files" excludes in package.json.`);
  process.exit(1);
}
console.log(`bundle check: ${checked} packages' entry files present`);
