// Edit a custom label translation from the panel (issue #25, README Roadmap Phase 3 part 1).
// Tooling API ExternalStringLocalization, tested in the dev org (issue #25 comment):
// - Create takes ExternalStringId, Language, Value. Update takes Value only. Delete is allowed.
// - Value: at most 1000 characters, never empty. Language is fixed after create.
// - Salesforce accepts inactive languages and the label's own language, so the editor blocks them here.
// - Saving needs Manage Translation. View Setup and Configuration alone allows only reading.

import { API_VERSION, SfError, queryAll, sfWrite } from './sfApi.js';
import { activeLanguages } from './report.js';

export const MAX_VALUE = 1000;
const OBJECT_PATH = `/services/data/${API_VERSION}/tooling/sobjects/ExternalStringLocalization`;
const ID = /^[a-zA-Z0-9]{15,18}$/;

export const MESSAGES = {
  noSavePermission: 'Saving needs the Manage Translation permission.',
  noReadPermission: 'Reading labels needs View Setup and Configuration.',
  empty: 'Type a translation before saving.',
  tooLong: `A translation holds at most ${MAX_VALUE} characters.`,
  notOffered: 'This language is not an active translation language for this label.',
  noLabel: 'This custom label is not in the org any more. Click Refresh org data.',
  noWorkbench: 'Translation Workbench is off in this org, so there are no translation languages. Setup → Translation Language Settings turns it on.',
  changed: 'Someone changed this translation in Salesforce while the editor was open. Click Reload to see the current values.',
};

/**
 * The Tooling API request for one change. `existingId`: the language's translation record, if it has one.
 * remove → DELETE that record; existingId → PATCH Value; otherwise POST a new record.
 * Throws an Error with plain words when the value can't be saved.
 */
export function translationRequest({ labelId, language, value, existingId = null, remove = false }) {
  if (remove) {
    if (!ID.test(existingId || '')) throw new Error('There is no translation to remove.');
    return { method: 'DELETE', path: `${OBJECT_PATH}/${existingId}`, body: null };
  }
  const text = String(value ?? '');
  if (!text.trim()) throw new Error(MESSAGES.empty);
  if (text.length > MAX_VALUE) throw new Error(MESSAGES.tooLong);
  if (existingId) {
    if (!ID.test(existingId)) throw new Error('Unexpected translation Id.');
    return { method: 'PATCH', path: `${OBJECT_PATH}/${existingId}`, body: { Value: text } };
  }
  if (!ID.test(labelId || '')) throw new Error('Unexpected custom label Id.');
  if (!language) throw new Error('Pick a language.');
  return { method: 'POST', path: OBJECT_PATH, body: { ExternalStringId: labelId, Language: language, Value: text } };
}

/** Salesforce errors in plain words. `action`: 'read' or 'save'. */
export function plainError(e, action) {
  const code = e?.code || '';
  if (/^INSUFFICIENT_ACCESS/.test(code)) return action === 'read' ? MESSAGES.noReadPermission : MESSAGES.noSavePermission;
  // API Enabled alone: "sObject type 'ExternalString' is not supported" (dev org test user).
  if (code === 'INVALID_TYPE' || (action === 'read' && /not supported/i.test(e?.message || ''))) return MESSAGES.noReadPermission;
  if (code === 'STRING_TOO_LONG') return MESSAGES.tooLong;
  if (code === 'REQUIRED_FIELD_MISSING') return MESSAGES.empty;
  if (code === 'ENTITY_IS_DELETED' || code === 'NOT_FOUND' || code === 'DUPLICATE_VALUE') return MESSAGES.changed;
  return e?.message || String(e);
}

/**
 * The languages the editor offers: active Translation Workbench languages without the label's own language.
 * `translations`: the label's ExternalStringLocalization rows. Returns [{ code, name, id, value }].
 */
export function editorLanguages(labelLanguage, translations, translationRows) {
  const byLang = new Map((translations || []).map((t) => [t.Language, t]));
  return activeLanguages(translationRows, labelLanguage).map((l) => ({
    ...l,
    id: byLang.get(l.code)?.Id || null,
    value: byLang.get(l.code)?.Value ?? null,
  }));
}

/** One custom label, its translations and the languages to offer, read fresh from the org. */
export async function loadLabelEditor(session, labelId) {
  if (!ID.test(labelId || '')) throw new Error('Unexpected custom label Id.');
  const tooling = { tooling: true };
  const readError = (e) => {
    if (e?.status === 401) throw e;
    throw new SfError(e?.status || 400, plainError(e, 'read'), e?.code || null);
  };
  // The Translation object exists only while Translation Workbench is on: its own message, not View Setup's.
  const languages = queryAll(session, 'SELECT Language, IsActive FROM Translation').catch((e) => ({ failed: e }));
  const [[label], translations] = await Promise.all([
    queryAll(session, `SELECT Id, Name, NamespacePrefix, Language, Value FROM ExternalString WHERE Id = '${labelId}'`, tooling),
    queryAll(session, `SELECT Id, Language, Value FROM ExternalStringLocalization WHERE ExternalStringId = '${labelId}'`, tooling),
  ]).catch(readError);
  const rows = await languages;
  if (rows.failed) {
    if (rows.failed.status === 401) throw rows.failed;
    throw new SfError(rows.failed.status || 400, rows.failed.code === 'INVALID_TYPE' ? MESSAGES.noWorkbench : plainError(rows.failed, 'read'), rows.failed.code || null);
  }
  if (!label) throw new SfError(404, MESSAGES.noLabel);
  return {
    label: { id: label.Id, name: label.Name, namespace: label.NamespacePrefix || null, language: label.Language, value: label.Value },
    languages: editorLanguages(label.Language, translations, rows),
  };
}

/**
 * Saves (or, with remove, deletes) one language's translation, then reads the label back.
 * The record Id is read fresh here, so a translation added elsewhere in the meantime is updated, not duplicated.
 * Returns { editor, language, saved } where `saved` is the value now in the org (null after a remove).
 */
export async function saveLabelTranslation(session, { labelId, language, value, remove = false }) {
  const before = await loadLabelEditor(session, labelId);
  const lang = before.languages.find((l) => l.code === language);
  if (!lang) throw new Error(MESSAGES.notOffered);
  if (remove && !lang.id) return { editor: before, language, saved: null };
  const req = translationRequest({ labelId, language, value, existingId: lang.id, remove });
  try {
    await sfWrite(session, req.method, req.path, req.body);
  } catch (e) {
    if (e?.status === 401) throw e;
    throw new SfError(e?.status || 400, plainError(e, 'save'), e?.code || null);
  }
  const editor = await loadLabelEditor(session, labelId);
  return { editor, language, saved: editor.languages.find((l) => l.code === language)?.value ?? null };
}
