import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soqlLike, loadLabelTranslations } from '../src/sfApi.js';

test('soqlLike escapes quotes, backslash, % and _', () => {
  assert.equal(soqlLike(String.raw`it's 50%_x\y`), String.raw`it\'s 50\%\_x\\y`);
});

test('label translations are searched by text and label ids, never loaded in full', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(decodeURIComponent(u));
    return { ok: true, json: async () => ({ records: [], done: true }) };
  };
  await loadLabelTranslations({ host: 'x.my.salesforce.com', sid: 's' }, "Owner's  Name", ['000000000000001AAA']);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/tooling\/query\/\?q=SELECT Id, ExternalStringId, Language, Value FROM ExternalStringLocalization WHERE /);
  assert.match(urls[0], /Value LIKE '%Owner\\'s Name%'/);
  assert.match(urls[0], /ExternalStringId IN \('000000000000001AAA'\)/);
  assert.match(urls[0], /LIMIT 2000$/);
});

test('short text uses an exact match', async () => {
  const urls = [];
  globalThis.fetch = async (u) => (urls.push(decodeURIComponent(u)), { ok: true, json: async () => ({ records: [], done: true }) });
  await loadLabelTranslations({ host: 'x', sid: 's' }, 'Ja', []);
  assert.match(urls[0], /WHERE Value = 'Ja' LIMIT/);
});
