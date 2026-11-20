// Missing-translations report (README Roadmap Phase 4, issue #14): pure logic, no chrome.* or network
// calls, so it is unit tested in Node. src/reportApi.js reads the org; src/reportPage.js shows the report.

import { languageName } from './locator.js';

/**
 * Translation Workbench languages that are active, without the org default (its text is the master, not a
 * translation). `rows`: Translation records { Language, IsActive } (dev org: fr, de active; en_US default).
 * Returns [{ code, name }] sorted by name.
 */
export function activeLanguages(rows, orgDefault) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const code = r?.Language;
    if (!code || r.IsActive !== true || code === orgDefault || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name: languageName(code) || code });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
