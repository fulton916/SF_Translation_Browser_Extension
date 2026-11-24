// Switch the signed-in user's own Salesforce language from the panel (issue #46).
// User.LanguageLocaleKey, tested in the dev org as an admin and as a Minimum Access user: both can save it
// on their own record (204), and userinfo reads the new language right after.
// The record Id always comes from the session itself (userinfo), never from the page or a message.

import { API_VERSION, SfError, sfFetch, sfWrite, setUserLanguage } from './sfApi.js';

const USER_PATH = `/services/data/${API_VERSION}/sobjects/User`;
const USER_ID = /^005[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/;

export const MESSAGES = {
  noPermission: 'Your Salesforce permissions do not allow changing your language. Nothing was changed. Your Salesforce admin can change it for you.',
  notOffered: 'This language is not available in this org. Nothing was changed.',
  noUser: 'Salesforce did not return your user. Reload the page and try again.',
  nothingToSwitchBack: 'You have not switched your language from the panel, so there is nothing to switch back.',
};

/** A refused save in plain words. Salesforce's own message is kept for rules an admin made (validation rule, flow, trigger). */
export function plainSaveError(e) {
  const code = e?.code || '';
  if (e?.status === 403 || /^INSUFFICIENT_ACCESS/.test(code) || code === 'INVALID_FIELD_FOR_INSERT_UPDATE') return MESSAGES.noPermission;
  if (code === 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST') return MESSAGES.notOffered;
  return `Salesforce did not save your language: ${e?.message || e}`;
}

/** Where the language before the first switch is kept: per org and user (a sandbox copy has the same user Ids). */
const memoryKey = (session, userId) => `languageBefore:${session.host}|${userId}`;

async function readOwnUser(session) {
  const info = await sfFetch(session, '/services/oauth2/userinfo');
  if (!USER_ID.test(info?.user_id || '')) throw new Error(MESSAGES.noUser);
  const [user, describe] = await Promise.all([
    sfFetch(session, `${USER_PATH}/${info.user_id}?fields=Username,LanguageLocaleKey`),
    sfFetch(session, `${USER_PATH}/describe`),
  ]);
  const field = (describe.fields || []).find((f) => f.name === 'LanguageLocaleKey');
  return {
    id: info.user_id,
    username: user.Username,
    current: user.LanguageLocaleKey,
    canSave: !!field?.updateable,
    languages: (field?.picklistValues || []).filter((v) => v.active).map((v) => v.value),
  };
}

/**
 * The signed-in user's language, the languages to pick from, and the language before the first switch.
 * `store`: chrome.storage.local (get / set / remove).
 * Returns { username, current, languages, before, blocked }: `before` is null when there is nothing to switch
 * back to; `blocked` is the reason when the user can't save.
 */
export async function loadMyLanguage(session, store) {
  const user = await readOwnUser(session);
  const key = memoryKey(session, user.id);
  const before = (await store.get(key))[key] || null;
  return {
    username: user.username,
    current: user.current,
    languages: user.languages,
    before: before && before !== user.current ? before : null,
    blocked: user.canSave ? null : MESSAGES.noPermission,
  };
}

/**
 * Saves the signed-in user's own language. `language`: a language code, or null for Switch back.
 * The language before the first switch is remembered until the user is back on it.
 * Returns { language, changed }.
 */
export async function switchMyLanguage(session, store, language) {
  const user = await readOwnUser(session);
  const key = memoryKey(session, user.id);
  const before = (await store.get(key))[key] || null;
  const to = language ?? before;
  if (!to) throw new Error(MESSAGES.nothingToSwitchBack);
  // A memory equal to the language now is an old one (the user went back in personal settings): start over.
  const first = before && before !== user.current ? before : user.current;
  const changed = to !== user.current;
  if (changed) {
    if (!user.canSave) throw new Error(MESSAGES.noPermission);
    if (!user.languages.includes(to)) throw new Error(MESSAGES.notOffered);
    // Before the write: a stopped worker must not lose the language to go back to.
    if (first !== before) await store.set({ [key]: first });
    try {
      await sfWrite(session, 'PATCH', `${USER_PATH}/${user.id}`, { LanguageLocaleKey: to });
    } catch (e) {
      // A lost reply (no status) keeps the memory: the save can have gone through.
      if (!e?.status) throw e;
      if (first === user.current) await store.remove(key);
      if (e.status === 401) throw e;
      throw new SfError(e.status, plainSaveError(e), e.code || null);
    }
  }
  setUserLanguage(session, to);
  if (to === first) await store.remove(key);
  return { language: to, changed };
}
