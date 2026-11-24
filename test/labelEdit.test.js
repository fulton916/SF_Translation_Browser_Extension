import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sfWrite, SfError } from '../src/sfApi.js';
import { translationRequest, plainError, editorLanguages, loadLabelEditor, saveLabelTranslation, MESSAGES, MAX_VALUE } from '../src/labelEdit.js';

const LABEL = '101000000000001AAA';
const LOC = '0Hd000000000001AAA';
const BASE = '/services/data/v67.0/tooling/sobjects/ExternalStringLocalization';
const session = { host: 'x.my.salesforce.com', sid: 's' };

test('a language without a translation is created with ExternalStringId, Language and Value', () => {
  assert.deepEqual(translationRequest({ labelId: LABEL, language: 'fr', value: 'Bonjour' }), {
    method: 'POST',
    path: BASE,
    body: { ExternalStringId: LABEL, Language: 'fr', Value: 'Bonjour' },
  });
});

test('an existing translation is updated with Value only (Language is fixed after create)', () => {
  assert.deepEqual(translationRequest({ labelId: LABEL, language: 'fr', value: 'Salut', existingId: LOC }), {
    method: 'PATCH',
    path: `${BASE}/${LOC}`,
    body: { Value: 'Salut' },
  });
});

test('remove deletes the existing record, and needs one', () => {
  assert.deepEqual(translationRequest({ labelId: LABEL, language: 'fr', existingId: LOC, remove: true }), { method: 'DELETE', path: `${BASE}/${LOC}`, body: null });
  assert.throws(() => translationRequest({ labelId: LABEL, language: 'fr', remove: true }), /no translation to remove/);
});

test('empty and too-long values are stopped before any request', () => {
  assert.throws(() => translationRequest({ labelId: LABEL, language: 'fr', value: '   ' }), { message: MESSAGES.empty });
  assert.throws(() => translationRequest({ labelId: LABEL, language: 'fr', value: 'x'.repeat(MAX_VALUE + 1) }), { message: MESSAGES.tooLong });
  assert.equal(translationRequest({ labelId: LABEL, language: 'fr', value: 'x'.repeat(MAX_VALUE) }).body.Value.length, 1000);
});

test('ids are checked before they go into a path', () => {
  assert.throws(() => translationRequest({ labelId: LABEL, language: 'fr', value: 'a', existingId: '../x' }), /Unexpected/);
  assert.throws(() => translationRequest({ labelId: "x' OR", language: 'fr', value: 'a' }), /Unexpected/);
});

test('Salesforce error codes become plain words', () => {
  const err = (code, message = 'x') => new SfError(400, message, code);
  assert.equal(plainError(err('INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY', 'insufficient access rights on cross-reference id'), 'save'), 'Saving needs the Manage Translation permission.');
  assert.equal(plainError(err('INVALID_TYPE', "sObject type 'ExternalString' is not supported"), 'read'), 'Reading labels needs View Setup and Configuration.');
  assert.equal(plainError(err('STRING_TOO_LONG'), 'save'), MESSAGES.tooLong);
  assert.equal(plainError(err('REQUIRED_FIELD_MISSING'), 'save'), MESSAGES.empty);
  assert.equal(plainError(err('DUPLICATE_VALUE'), 'save'), MESSAGES.changed);
  assert.equal(plainError(err('SOMETHING_ELSE', 'Raw text'), 'save'), 'Raw text');
});

test('the editor offers active languages only, never the label\'s own language', () => {
  const rows = [
    { Language: 'en_US', IsActive: true },
    { Language: 'fr', IsActive: true },
    { Language: 'de', IsActive: true },
    { Language: 'es', IsActive: false },
  ];
  const langs = editorLanguages('en_US', [{ Id: LOC, Language: 'fr', Value: 'Bonjour' }, { Id: 'x', Language: 'es', Value: 'Hola' }], rows);
  assert.deepEqual(langs.map((l) => l.code), ['fr', 'de']); // sorted by name: French, German
  assert.deepEqual(langs.find((l) => l.code === 'fr'), { code: 'fr', name: 'French', id: LOC, value: 'Bonjour' });
  assert.deepEqual(langs.find((l) => l.code === 'de'), { code: 'de', name: 'German', id: null, value: null });
});

test('sfWrite sends the method, JSON body and session; 204 gives null', async () => {
  const calls = [];
  globalThis.fetch = async (u, init) => (calls.push({ u, init }), { ok: true, status: 204, text: async () => '' });
  assert.equal(await sfWrite(session, 'PATCH', `${BASE}/${LOC}`, { Value: 'a' }), null);
  assert.equal(calls[0].u, `https://x.my.salesforce.com${BASE}/${LOC}`);
  assert.equal(calls[0].init.method, 'PATCH');
  assert.equal(calls[0].init.body, '{"Value":"a"}');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer s');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  await assert.rejects(sfWrite(session, 'GET', '/x'), /not a write method/);
});

test('sfWrite keeps the errorCode on the error', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify([{ message: 'insufficient access rights on cross-reference id', errorCode: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY' }]) });
  await assert.rejects(sfWrite(session, 'POST', BASE, {}), (e) => e.code === 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY' && e.status === 400);
});

/** A fake org: reads answer from `state`, writes change it. Records every request. */
function fakeOrg(state, { failWrite = null, failRead = null, failLanguages = null } = {}) {
  const calls = [];
  globalThis.fetch = async (u, init = {}) => {
    const url = decodeURIComponent(u);
    const method = init.method || 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : null });
    const reply = (status, body) => ({ ok: status < 300, status, text: async () => (body == null ? '' : JSON.stringify(body)), json: async () => body });
    if (method === 'GET') {
      if (failRead) return reply(400, [failRead]);
      if (failLanguages && /FROM Translation/.test(url)) return reply(400, [failLanguages]);
      const records = /FROM ExternalString WHERE/.test(url) ? [state.label] : /FROM ExternalStringLocalization/.test(url) ? state.translations : state.languages;
      return reply(200, { done: true, records });
    }
    if (failWrite) return reply(400, [failWrite]);
    if (method === 'POST') {
      const b = JSON.parse(init.body);
      state.translations.push({ Id: LOC, Language: b.Language, Value: b.Value });
      return reply(201, { id: LOC, success: true, errors: [] });
    }
    const id = url.split('/').pop();
    if (method === 'PATCH') state.translations.find((t) => t.Id === id).Value = JSON.parse(init.body).Value;
    if (method === 'DELETE') state.translations = state.translations.filter((t) => t.Id !== id);
    return reply(204, null);
  };
  return calls;
}
const orgState = () => ({
  label: { Id: LABEL, Name: 'SFTL_Greeting', NamespacePrefix: null, Language: 'en_US', Value: 'Hello' },
  translations: [],
  languages: [{ Language: 'fr', IsActive: true }, { Language: 'de', IsActive: false }, { Language: 'en_US', IsActive: true }],
});

test('save creates, then reads the value back from the org', async () => {
  const state = orgState();
  const calls = fakeOrg(state);
  const res = await saveLabelTranslation(session, { labelId: LABEL, language: 'fr', value: 'Bonjour' });
  assert.equal(res.saved, 'Bonjour');
  const writes = calls.filter((c) => c.method !== 'GET');
  assert.deepEqual(writes, [{ method: 'POST', url: `https://x.my.salesforce.com${BASE}`, body: { ExternalStringId: LABEL, Language: 'fr', Value: 'Bonjour' } }]);
  // read before (fresh Id) and after (read back)
  assert.ok(calls.indexOf(writes[0]) > 0 && calls.slice(calls.indexOf(writes[0]) + 1).some((c) => /ExternalStringLocalization/.test(c.url)));
});

test('save on an existing translation updates it; remove deletes it', async () => {
  const state = orgState();
  state.translations.push({ Id: LOC, Language: 'fr', Value: 'Bonjour' });
  const calls = fakeOrg(state);
  assert.equal((await saveLabelTranslation(session, { labelId: LABEL, language: 'fr', value: 'Salut' })).saved, 'Salut');
  assert.equal(calls.find((c) => c.method === 'PATCH').url, `https://x.my.salesforce.com${BASE}/${LOC}`);
  const removed = await saveLabelTranslation(session, { labelId: LABEL, language: 'fr', remove: true });
  assert.equal(removed.saved, null);
  assert.ok(calls.some((c) => c.method === 'DELETE'));
});

test('inactive languages and the label\'s own language are refused without a write', async () => {
  for (const language of ['de', 'en_US']) {
    const calls = fakeOrg(orgState());
    await assert.rejects(saveLabelTranslation(session, { labelId: LABEL, language, value: 'x' }), { message: MESSAGES.notOffered });
    assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
  }
});

test('no Manage Translation: the save error is in plain words', async () => {
  const state = orgState();
  fakeOrg(state, { failWrite: { message: 'insufficient access rights on cross-reference id', errorCode: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY' } });
  await assert.rejects(saveLabelTranslation(session, { labelId: LABEL, language: 'fr', value: 'Bonjour' }), { message: 'Saving needs the Manage Translation permission.' });
  assert.equal(state.translations.length, 0);
});

test('no View Setup: the read error is in plain words', async () => {
  fakeOrg(orgState(), { failRead: { message: "sObject type 'ExternalString' is not supported.", errorCode: 'INVALID_TYPE' } });
  await assert.rejects(loadLabelEditor(session, LABEL), { message: 'Reading labels needs View Setup and Configuration.' });
});

test('Translation Workbench off: its own message, not the View Setup one', async () => {
  fakeOrg(orgState(), { failLanguages: { message: "sObject type 'Translation' is not supported.", errorCode: 'INVALID_TYPE' } });
  await assert.rejects(loadLabelEditor(session, LABEL), { message: MESSAGES.noWorkbench });
});

test('sfWrite treats a 2xx reply that is not JSON as written', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 201, text: async () => '<html>ok</html>' });
  assert.equal(await sfWrite(session, 'POST', BASE, { a: 1 }), null);
});
