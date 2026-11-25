// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Dev only: the unpacked extension reloads itself after a code change, with no click on Reload.
// Run `npm run dev` and leave it running. It writes dev.json next to manifest.json (gitignored, never
// in the zip). The background worker finds that file and polls GET /__version every 30 seconds.
import http from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { versionOf } from './version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SFTL_DEV_PORT) || 5763;
const marker = path.join(root, 'dev.json');

http
  .createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.url === '/__version') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ v: versionOf(root) }));
      return;
    }
    res.statusCode = 404;
    res.end();
  })
  .listen(port, '127.0.0.1', () => {
    writeFileSync(marker, JSON.stringify({ port }) + '\n');
    console.log(`SFTL dev reload on http://127.0.0.1:${port}/__version (wrote dev.json). Ctrl+C to stop.`);
  });

const stop = () => {
  rmSync(marker, { force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
