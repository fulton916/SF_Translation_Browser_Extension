// Fingerprint of every file Chrome loads for the extension (manifest.json and src/): path, mtime and size.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function versionOf(root) {
  const files = ['manifest.json'];
  const walk = (dir) => {
    for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else files.push(rel);
    }
  };
  walk('src');
  const h = createHash('sha1');
  for (const f of files.sort()) {
    const s = statSync(path.join(root, f));
    h.update(`${f}:${s.mtimeMs}:${s.size}\n`);
  }
  return h.digest('hex').slice(0, 12);
}
