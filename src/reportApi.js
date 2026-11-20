// Org reads for the missing-translations report (issue #14). Read-only: only queries and readMetadata,
// never a create, update or delete.

import { queryAll, soapCall, loadOrgData, SfError } from './sfApi.js';
import {
  activeLanguages,
  metadataRecords,
  parseObjectTranslation,
  parseTranslations,
  parseValueSetTranslation,
  labelItems,
  objectItems,
  tabItems,
  valueSetItems,
  isOwnItem,
  summarize,
} from './report.js';

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

const API_NAME = /^[A-Za-z0-9_]+$/;
const LANGUAGE = /^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,4})?$/;
const READ_BATCH = 10; // readMetadata reads at most 10 names per call
const PARALLEL = 3;

/**
 * readMetadata of `type` for many names: { fullName → record XML }, `batch` names per call (at most 10),
 * 3 calls at a time.
 */
export async function readMetadata(session, type, fullNames, onProgress, { batch = READ_BATCH } = {}) {
  const size = Math.max(1, Math.min(batch, READ_BATCH));
  const chunks = [];
  for (let i = 0; i < fullNames.length; i += size) chunks.push(fullNames.slice(i, i + size));
  const out = {};
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      const body = `<s:readMetadata><s:type>${type}</s:type>${chunk.map((n) => `<s:fullNames>${n}</s:fullNames>`).join('')}</s:readMetadata>`;
      Object.assign(out, metadataRecords(await soapCall(session, 'metadata', '', body)));
      onProgress?.(++done, chunks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker));
  return out;
}

/**
 * The objects whose translations the report reads: the org's own custom objects, and standard objects
 * with a custom field or a record type of the org's own (package fields are left out, see isOwnItem).
 */
export function reportObjects(objects, customFieldObjects, recordTypeObjects) {
  const known = new Set((objects || []).map((o) => o.name));
  const out = new Set();
  for (const o of objects || []) if (/__c$/.test(o.name) && isOwnItem(o.name)) out.add(o.name);
  for (const n of [...(customFieldObjects || []), ...(recordTypeObjects || [])]) {
    if (n && known.has(n) && API_NAME.test(n) && isOwnItem(n) && !/__(mdt|e|b|x|kav|share|history|feed)$/i.test(n)) out.add(n);
  }
  return [...out].sort();
}

/**
 * Every checked item of the active languages, and the summary (report.js summarize).
 * `onProgress(text)`: a short status line while it reads. Read-only.
 * Returns { orgDefault, languages, missing, warnings }.
 */
export async function loadMissingTranslations(session, { onProgress } = {}) {
  const say = (t) => onProgress?.(t);
  say('Reading the active languages…');
  const { orgDefault, languages } = await loadActiveLanguages(session);
  if (!languages.length) return { orgDefault, ...summarize([], []), warnings: [] };
  const codes = languages.map((l) => l.code).filter((c) => LANGUAGE.test(c));
  if (!LANGUAGE.test(orgDefault || '')) throw new SfError(400, `Org default language not read (${orgDefault || 'empty'}).`);
  const warnings = [];
  const soft = (what) => (e) => {
    if (e?.status === 401) throw e;
    warnings.push(`${what} not checked: ${e?.message || e}`);
    return null;
  };

  say('Reading custom labels, objects and tabs…');
  const [org, localizations, fieldObjects, rtObjects, valueSets] = await Promise.all([
    loadOrgData(session),
    queryAll(session, `SELECT ExternalStringId, Language FROM ExternalStringLocalization WHERE Language IN ('${codes.join("','")}')`, { tooling: true }).catch(soft('Custom labels')),
    queryAll(session, 'SELECT EntityDefinition.QualifiedApiName FROM CustomField WHERE NamespacePrefix = null', { tooling: true })
      .then((r) => r.map((f) => f.EntityDefinition?.QualifiedApiName))
      .catch(soft('Field labels on standard objects')),
    queryAll(session, 'SELECT SobjectType FROM RecordType WHERE NamespacePrefix = null')
      .then((r) => r.map((x) => x.SobjectType))
      .catch(soft('Record types on standard objects')),
    queryAll(session, 'SELECT DeveloperName, MasterLabel FROM GlobalValueSet WHERE NamespacePrefix = null', { tooling: true }).catch(soft('Global value sets')),
  ]);
  warnings.push(...(org.warnings || []).filter((w) => /^(Custom labels|Object names|Tabs) not searched/.test(w)).map((w) => w.replace(' not searched', ' not checked')));

  const items = [];
  if (org.customLabels && localizations) for (const c of codes) items.push(...labelItems(org.customLabels, localizations, c));

  // Objects: "<object>-<language>" per language, and "<object>-<org default>" for the master texts.
  const objects = reportObjects(org.objects, fieldObjects, rtObjects);
  const withTab = new Set((org.tabs || []).filter((t) => t.IsCustom && t.SobjectName).map((t) => t.SobjectName));
  const labelOf = new Map((org.objects || []).map((o) => [o.name, o.label]));
  const objectNames = objects.flatMap((o) => [orgDefault, ...codes].map((c) => `${o}-${c}`));
  const objectXml = await readMetadata(session, 'CustomObjectTranslation', objectNames, (d, n) => say(`Reading object translations… ${d} of ${n}`)).catch(
    soft('Field labels, picklist values, related list labels, record types and object tabs')
  );
  if (objectXml) {
    for (const o of objects) {
      const master = parseObjectTranslation(objectXml[`${o}-${orgDefault}`]);
      for (const c of codes) {
        items.push(...objectItems({ object: o, objectLabel: labelOf.get(o), language: c, translation: parseObjectTranslation(objectXml[`${o}-${c}`]), master, hasTab: withTab.has(o) }));
      }
    }
  }

  // Web tabs are in the Translations file of each language, which also holds every custom label, flow and
  // report type: UAT2 (33 languages), 1.5 MB and 19 s per language. Read only when the org has a web tab
  // of its own, one language per call.
  const sets = (valueSets || []).filter((v) => API_NAME.test(v.DeveloperName || ''));
  const webTabs = (org.tabs || []).filter((t) => t.IsCustom && !t.SobjectName && isOwnItem(t.Name));
  const progress = { tabs: 0, tabsOf: webTabs.length ? codes.length + 1 : 0, sets: 0, setsOf: 0 };
  const sayTabs = () =>
    say(`Reading ${[progress.tabsOf ? `tab translations… ${progress.tabs} of ${progress.tabsOf}` : '', progress.setsOf ? `global value sets… ${progress.sets} of ${progress.setsOf}` : ''].filter(Boolean).join(', ') || 'tabs and global value sets…'}`);
  sayTabs();
  const [tabXml, setXml] = await Promise.all([
    webTabs.length
      ? readMetadata(session, 'Translations', [orgDefault, ...codes], (d) => ((progress.tabs = d), sayTabs()), { batch: 1 }).catch(soft('Web tabs'))
      : {},
    sets.length
      ? readMetadata(session, 'GlobalValueSetTranslation', sets.flatMap((v) => codes.map((c) => `${v.DeveloperName}-${c}`)), (d, n) => ((progress.sets = d), (progress.setsOf = n), sayTabs())).catch(
          soft('Global value set values')
        )
      : {},
  ]);
  if (tabXml) {
    const master = parseTranslations(tabXml[orgDefault]);
    for (const c of codes) items.push(...tabItems({ language: c, translation: parseTranslations(tabXml[c]), master }));
  }
  if (setXml) {
    for (const v of sets) {
      for (const c of codes) {
        items.push(...valueSetItems({ language: c, valueSet: { name: v.DeveloperName, label: v.MasterLabel }, values: parseValueSetTranslation(setXml[`${v.DeveloperName}-${c}`]) }));
      }
    }
  }
  return { orgDefault, ...summarize(languages, items), warnings };
}
