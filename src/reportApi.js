// Org reads for the missing-translations report (issue #14). Read-only: only queries and readMetadata,
// never a create, update or delete.

import { queryAll, SfError } from './sfApi.js';
import { activeLanguages } from './report.js';

/**
 * The org default language and the active Translation Workbench languages besides it.
 * The Translation object holds one row per Workbench language with IsActive (dev org, checked live).
 * Returns { orgDefault, languages: [{ code, name }] }. Throws an SfError when the languages cannot be read.
 */
export async function loadActiveLanguages(session) {
  const [org, rows] = await Promise.all([
    queryAll(session, 'SELECT LanguageLocaleKey FROM Organization'),
    queryAll(session, 'SELECT Language, IsActive FROM Translation').catch((e) => {
      if (e?.status === 401) throw e;
      // The Translation object exists only while Translation Workbench is on.
      throw new SfError(e?.status || 400, `Translation Workbench languages not read: ${String(e?.message || e).replace(/\.$/, '')}. The report needs Translation Workbench on (Setup → Translation Language Settings).`);
    }),
  ]);
  const orgDefault = org[0]?.LanguageLocaleKey || null;
  return { orgDefault, languages: activeLanguages(rows, orgDefault) };
}
