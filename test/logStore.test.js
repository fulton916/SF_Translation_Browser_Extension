import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, makeEntry, addEntry, getEntries, clearEntries, formatEntries, LOG_KEY, LOG_MAX } from '../src/logStore.js';

function fakeStorage() {
  const data = {};
  return {
    data,
    get: async (k) => ({ [k]: data[k] }),
    set: async (o) => Object.assign(data, structuredClone(o)),
    remove: async (k) => delete data[k],
  };
}

test('sanitize removes session ids, bearer tokens and query strings', () => {
  const s = sanitize('sid 00D000000000001!AQ8AQ.x_y-z and Bearer abc.def at https://x.my.salesforce.com/a/b?sid=123&x=1 end');
  assert.ok(!s.includes('AQ8AQ'));
  assert.ok(!s.includes('abc.def'));
  assert.ok(!s.includes('sid=123'));
  assert.match(s, /https:\/\/x\.my\.salesforce\.com\/a\/b\?…/);
});

test('makeEntry normalizes level and truncates', () => {
  const e = makeEntry({ level: 'bogus', where: 'w', message: 'x'.repeat(5000), details: { a: 1 } }, 0);
  assert.equal(e.level, 'info');
  assert.equal(e.at, '1970-01-01T00:00:00.000Z');
  assert.equal(e.message.length, 1000);
  assert.equal(e.details, '{"a":1}');
});

test('entries are appended in order and capped', async () => {
  const st = fakeStorage();
  await Promise.all(Array.from({ length: LOG_MAX + 5 }, (_, i) => addEntry({ level: 'info', where: 't', message: `m${i}` }, st)));
  const list = await getEntries(st);
  assert.equal(list.length, LOG_MAX);
  assert.equal(list[0].message, 'm5');
  assert.equal(list.at(-1).message, `m${LOG_MAX + 4}`);
  await clearEntries(st);
  assert.equal(st.data[LOG_KEY], undefined);
});

test('formatEntries makes pasteable text', () => {
  const txt = formatEntries([makeEntry({ level: 'error', where: 'auto-fill', message: 'Stopped: boom', page: 'h/p', details: { rows: ['A'] } }, 0)], '0.1.0');
  assert.match(txt, /^SF Translation Locator log v0\.1\.0 \(1 entries\)/);
  assert.match(txt, /ERROR \[auto-fill\] Stopped: boom/);
  assert.match(txt, /page: h\/p/);
});
