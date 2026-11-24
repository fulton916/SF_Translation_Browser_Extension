import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadUserLanguage, SfError } from '../src/sfApi.js';
import { loadMyLanguage, switchMyLanguage, plainSaveError, MESSAGES } from '../src/myLanguage.js';

const NAME = 'me@example.com';
const ME = '005000000000001AAA';
let n = 0;

/** A fake org with one signed-in user, and a fake chrome.storage.local. Each has its own host (the language cache is per host). */
function fake({ language = 'en_US', userId = ME, updateable = true, failWrite = null, host = null, mem = {} } = {}) {
  const f = { session: { host: host || `org${++n}.my.salesforce.com`, sid: 's' }, language, mem, calls: [] };
  f.store = {
    get: async (k) => (k in f.mem ? { [k]: f.mem[k] } : {}),
    set: async (o) => void Object.assign(f.mem, o),
    remove: async (k) => void delete f.mem[k],
  };
  globalThis.fetch = async (u, init = {}) => {
    const method = init.method || 'GET';
    f.calls.push({ method, url: u, body: init.body ? JSON.parse(init.body) : null, mem: { ...f.mem } });
    const reply = (status, body) => ({ ok: status < 300, status, text: async () => (body == null ? '' : JSON.stringify(body)), json: async () => body });
    if (method === 'PATCH') {
      if (failWrite instanceof Error) throw failWrite;
      if (failWrite) return reply(failWrite.status || 400, [failWrite]);
      f.language = JSON.parse(init.body).LanguageLocaleKey;
      return reply(204, null);
    }
    if (/userinfo$/.test(u)) return reply(200, { user_id: userId, language: f.language });
    if (/describe$/.test(u)) {
      const picklistValues = ['en_US', 'fr', 'de', 'es'].map((value) => ({ value, active: value !== 'es' }));
      return reply(200, { fields: [{ name: 'LanguageLocaleKey', updateable, picklistValues }] });
    }
    return reply(200, { Username: NAME, LanguageLocaleKey: f.language });
  };
  f.writes = () => f.calls.filter((c) => c.method !== 'GET').map(({ method, url, body }) => ({ method, url, body }));
  f.before = async () => (await loadMyLanguage(f.session, f.store)).before;
  return f;
}

test('load: the user, the language now and the active languages; nothing to switch back, no write', async () => {
  const f = fake();
  assert.deepEqual(await loadMyLanguage(f.session, f.store), { username: 'me@example.com', current: 'en_US', languages: ['en_US', 'fr', 'de'], before: null, blocked: null });
  assert.deepEqual(f.writes(), []);
});

test('switch writes only LanguageLocaleKey on the session user, and the memory is stored before the write', async () => {
  const f = fake();
  assert.deepEqual(await switchMyLanguage(f.session, f.store, 'fr', NAME), { language: 'fr', changed: true });
  assert.deepEqual(f.writes(), [{ method: 'PATCH', url: `https://${f.session.host}/services/data/v60.0/sobjects/User/${ME}`, body: { LanguageLocaleKey: 'fr' } }]);
  assert.deepEqual(Object.values(f.calls.find((c) => c.method === 'PATCH').mem), ['en_US']);
  assert.equal(await f.before(), 'en_US');
});

test('Switch back returns to the language before the FIRST switch, then forgets it', async () => {
  const f = fake();
  await switchMyLanguage(f.session, f.store, 'fr', NAME);
  await switchMyLanguage(f.session, f.store, 'de', NAME);
  assert.equal(await f.before(), 'en_US');
  assert.deepEqual(await switchMyLanguage(f.session, f.store, null, NAME), { language: 'en_US', changed: true });
  assert.equal(f.language, 'en_US');
  assert.deepEqual(f.mem, {});
  await assert.rejects(switchMyLanguage(f.session, f.store, null, NAME), { message: MESSAGES.nothingToSwitchBack });
});

test('picking the first language from the list also forgets it', async () => {
  const f = fake();
  await switchMyLanguage(f.session, f.store, 'fr', NAME);
  await switchMyLanguage(f.session, f.store, 'en_US', NAME);
  assert.deepEqual(f.mem, {});
});

test('went back in personal settings: nothing to switch back, and the next switch remembers again', async () => {
  const f = fake();
  await switchMyLanguage(f.session, f.store, 'fr', NAME);
  f.language = 'en_US';
  assert.equal(await f.before(), null);
  await switchMyLanguage(f.session, f.store, 'de', NAME);
  assert.equal(await f.before(), 'en_US');
});

test('the language already in use: no write, no memory', async () => {
  const f = fake();
  assert.deepEqual(await switchMyLanguage(f.session, f.store, 'en_US', NAME), { language: 'en_US', changed: false });
  assert.deepEqual(f.writes(), []);
  assert.deepEqual(f.mem, {});
});

test('each user of an org has their own memory', async () => {
  const f = fake();
  await switchMyLanguage(f.session, f.store, 'fr', NAME);
  const other = fake({ userId: '005000000000002AAA', host: f.session.host, mem: f.mem, language: 'de' });
  assert.equal(await other.before(), null);
});

test('the next lookup reads the new language, not the cached one', async () => {
  const f = fake();
  assert.equal(await loadUserLanguage(f.session), 'en_US'); // cached 15 s
  await switchMyLanguage(f.session, f.store, 'fr', NAME);
  assert.equal(await loadUserLanguage(f.session), 'fr');
  await switchMyLanguage(f.session, f.store, null, NAME);
  assert.equal(await loadUserLanguage(f.session), 'en_US');
});

test('a user who cannot save sees the reason, nothing is written or remembered', async () => {
  const f = fake({ updateable: false });
  assert.equal((await loadMyLanguage(f.session, f.store)).blocked, MESSAGES.noPermission);
  await assert.rejects(switchMyLanguage(f.session, f.store, 'fr', NAME), { message: MESSAGES.noPermission });
  assert.deepEqual(f.writes(), []);
  assert.deepEqual(f.mem, {});
});

test('Salesforce refuses the save: reason shown, memory and cached language unchanged', async () => {
  const f = fake({ failWrite: { errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Ask IT first.' } });
  await assert.rejects(switchMyLanguage(f.session, f.store, 'fr', NAME), { message: 'Salesforce did not save your language: Ask IT first.' });
  assert.deepEqual(f.mem, {});
  assert.equal(await loadUserLanguage(f.session), 'en_US');
});

test('a lost reply keeps the memory', async () => {
  const f = fake({ failWrite: new TypeError('Failed to fetch') });
  await assert.rejects(switchMyLanguage(f.session, f.store, 'fr', NAME), /Failed to fetch/);
  assert.deepEqual(Object.values(f.mem), ['en_US']);
});

test('a server error keeps the memory too', async () => {
  const f = fake({ failWrite: { status: 503, errorCode: 'SERVER_UNAVAILABLE', message: 'busy' } });
  await assert.rejects(switchMyLanguage(f.session, f.store, 'fr', NAME), /busy/);
  assert.deepEqual(Object.values(f.mem), ['en_US']);
});

test('a page left open from another sign-in is refused without a write', async () => {
  const f = fake();
  for (const name of ['admin@example.com', undefined]) {
    await assert.rejects(switchMyLanguage(f.session, f.store, 'fr', name), { message: MESSAGES.otherUser });
  }
  assert.deepEqual(f.writes(), []);
  assert.deepEqual(f.mem, {});
});

test('an earlier memory survives a refused save', async () => {
  const f = fake();
  await switchMyLanguage(f.session, f.store, 'fr', NAME);
  const refused = fake({ language: 'fr', host: f.session.host, mem: f.mem, failWrite: { errorCode: 'X', message: 'no' } });
  await assert.rejects(switchMyLanguage(refused.session, refused.store, 'de', NAME), /no/);
  assert.deepEqual(Object.values(refused.mem), ['en_US']);
});

test('languages the org does not offer, and an unexpected user Id, are stopped before any write', async () => {
  for (const language of ['es', 'xx']) {
    const f = fake();
    await assert.rejects(switchMyLanguage(f.session, f.store, language, NAME), { message: MESSAGES.notOffered });
    assert.deepEqual(f.writes(), []);
  }
  for (const userId of ['001000000000001AAA', '../x', '']) {
    const f = fake({ userId });
    await assert.rejects(switchMyLanguage(f.session, f.store, 'fr', NAME), { message: MESSAGES.noUser });
    assert.deepEqual(f.writes(), []);
  }
});

test('signed out: userinfo answers 403 Bad_OAuth_Token, the panel says the session expired', async () => {
  const f = fake();
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => 'Bad_OAuth_Token' });
  await assert.rejects(loadMyLanguage(f.session, f.store), { status: 403, message: /^Session expired/ });
  await assert.rejects(switchMyLanguage(f.session, f.store, 'fr', NAME), { message: /^Session expired/ });
  assert.deepEqual(f.mem, {});
});

test('save errors in plain words', () => {
  assert.equal(plainSaveError(new SfError(400, 'x', 'INSUFFICIENT_ACCESS_OR_READONLY')), MESSAGES.noPermission);
  assert.equal(plainSaveError(new SfError(403, 'API limit.', 'REQUEST_LIMIT_EXCEEDED')), 'Salesforce did not save your language: API limit.');
  assert.equal(plainSaveError(new SfError(400, 'x', 'INVALID_FIELD_FOR_INSERT_UPDATE')), MESSAGES.noPermission);
  assert.equal(plainSaveError(new SfError(400, 'x', 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST')), MESSAGES.notOffered);
});

test('no page or message can name the user: the background reads op, language and the name to compare', () => {
  const src = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  const listener = src.slice(src.indexOf("'sftl:myLanguage'"), src.indexOf('async function openTranslation'));
  assert.match(listener, /const \{ op, language, username \} = msg;/);
  assert.doesNotMatch(listener, /msg\./);
});
