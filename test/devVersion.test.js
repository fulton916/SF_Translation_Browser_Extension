import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { versionOf } from '../dev/version.mjs';

test('dev reload: the version changes when a src file or the manifest changes, and only then', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sftl-dev-'));
  try {
    mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
    writeFileSync(path.join(root, 'manifest.json'), '{}');
    writeFileSync(path.join(root, 'src', 'a.js'), 'a');
    writeFileSync(path.join(root, 'src', 'sub', 'b.js'), 'b');
    writeFileSync(path.join(root, 'README.md'), 'not loaded by Chrome');
    const v1 = versionOf(root);
    assert.equal(versionOf(root), v1, 'stable when nothing changed');

    writeFileSync(path.join(root, 'README.md'), 'changed');
    assert.equal(versionOf(root), v1, 'files Chrome does not load are ignored');

    writeFileSync(path.join(root, 'src', 'sub', 'b.js'), 'bb');
    const v2 = versionOf(root);
    assert.notEqual(v2, v1, 'a nested src file');

    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(root, 'manifest.json'), later, later);
    assert.notEqual(versionOf(root), v2, 'the manifest (same size, new mtime)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
