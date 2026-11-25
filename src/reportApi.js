// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Org reads for the missing-translations report (issue #14). Read-only: only queries and readMetadata,
// never a create, update or delete.

import { queryAll, soapCall, loadOrgData, SfError } from './sfApi.js';
import { layoutName, loadButtons } from './orgIndex.js';
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
const NO_FIELDS = 'on standard objects without custom fields';
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
 * with a custom field, a record type or another translatable item of the org's own: `itemObjects`, one list of
 * object names per item type (package items are left out, see isOwnItem).
 */
export function reportObjects(objects, ...itemObjects) {
  const known = new Set((objects || []).map((o) => o.name));
  const out = new Set();
  for (const o of objects || []) if (/__c$/.test(o.name) && isOwnItem(o.name)) out.add(o.name);
  for (const n of itemObjects.flatMap((list) => list || [])) {
    if (n && known.has(n) && API_NAME.test(n) && isOwnItem(n) && !/__(mdt|e|b|x|kav|share|history|feed)$/i.test(n)) out.add(n);
  }
  return [...out].sort();
}

/**
 * Objects with custom fields of the org's own that are not in the object list: newer than the API version, and
 * Activity (never listed; it owns the custom fields of events and tasks). Their
 * CustomObjectTranslation files can still be read by name. A field without an object name has the table's API name,
 * or an Id (it starts with a digit: Data Cloud objects, which Translation Workbench does not hold).
 */
export function unlistedObjects(objects, fieldObjects) {
  const known = new Set((objects || []).map((o) => o.name));
  return reportObjects((fieldObjects || []).filter((n) => n && !known.has(n) && !/^\d/.test(n)).map((name) => ({ name })), fieldObjects);
}

/**
 * Objects of the page layouts an admin has changed since they were created (Layout rows). Only these can hold a
 * section name the org typed; Salesforce's own unchanged layouts (most objects of a large org) are left out.
 */
export function editedLayoutObjects(layouts) {
  const edited = (layouts || []).filter((l) => l.LastModifiedDate !== l.CreatedDate);
  return [...new Set(edited.map((l) => l.EntityDefinition?.QualifiedApiName || layoutName(`${l.TableEnumOrId}-`)?.object).filter(Boolean))];
}

/**
 * Every checked item of the active languages, and the summary (report.js summarize).
 * `onProgress(text)`: a short status line while it reads. Read-only.
 * Returns { orgDefault, languages, items, missing, warnings }.
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
  const [org, localizations, fieldObjects, rtObjects, valueSets, quickActions, buttons, layouts] = await Promise.all([
    loadOrgData(session),
    queryAll(session, `SELECT Id, ExternalStringId, Language, Value FROM ExternalStringLocalization WHERE Language IN ('${codes.join("','")}')`, { tooling: true }).catch(soft('Custom labels')),
    queryAll(session, 'SELECT TableEnumOrId, EntityDefinition.QualifiedApiName FROM CustomField WHERE NamespacePrefix = null', { tooling: true })
      .then((r) => r.map((f) => f.EntityDefinition?.QualifiedApiName || f.TableEnumOrId))
      .catch(soft('Field labels on standard objects')),
    queryAll(session, 'SELECT SobjectType FROM RecordType WHERE NamespacePrefix = null')
      .then((r) => r.map((x) => x.SobjectType))
      .catch(soft('Record types on standard objects')),
    queryAll(session, 'SELECT DeveloperName, MasterLabel FROM GlobalValueSet WHERE NamespacePrefix = null', { tooling: true }).catch(soft('Global value sets')),
    // StandardLabel: the action shows a Salesforce label (LogACall, NewChild…), which Translation Workbench does not list.
    queryAll(session, 'SELECT DeveloperName, MasterLabel, SobjectType FROM QuickActionDefinition WHERE NamespacePrefix = null AND StandardLabel = null', { tooling: true }).catch(soft('Quick actions')),
    loadButtons(session).catch(soft(`Buttons and links ${NO_FIELDS}`)),
    queryAll(session, 'SELECT Name, TableEnumOrId, EntityDefinition.QualifiedApiName, CreatedDate, LastModifiedDate FROM Layout WHERE NamespacePrefix = null', { tooling: true }).catch(
      soft(`Layout sections ${NO_FIELDS}`)
    ),
  ]);
  warnings.push(...(org.warnings || []).filter((w) => /^(Custom labels|Object names|Tabs|Validation messages) not searched/.test(w)).map((w) => w.replace('Validation messages', `Validation messages ${NO_FIELDS}`).replace(' not searched', ' not checked')));

  const items = [];
  if (org.customLabels && localizations) for (const c of codes) items.push(...labelItems(org.customLabels, localizations, c));

  // Objects: "<object>-<language>" per language, and "<object>-<org default>" for the master texts.
  const ownButtons = (buttons || []).filter((b) => !b.namespace);
  const rules = (org.validationRules || []).filter((v) => !v.NamespacePrefix); // active ones only
  const ruleObjects = rules.map((v) => v.EntityDefinition?.QualifiedApiName);
  const activeRules = org.validationRules ? new Set(rules.map((v) => `${v.EntityDefinition?.QualifiedApiName}.${v.ValidationName}`)) : null;
  const actions = new Map((quickActions || []).map((a) => [`${a.SobjectType}.${a.DeveloperName}`, a.MasterLabel]));
  const buttonLabels = new Map(ownButtons.map((b) => [`${b.object}.${b.name}`, b.label]));
  const ownLayouts = new Set((layouts || []).map((l) => l.Name));
  const withItems = reportObjects(org.objects, fieldObjects, rtObjects, ruleObjects, (quickActions || []).map((a) => a.SobjectType), ownButtons.map((b) => b.object));
  // Objects that can only have a layout section: the org default file first, so each language is read only for
  // those that have one (few objects, even in a large org).
  const layoutOnly = reportObjects(org.objects, editedLayoutObjects(layouts)).filter((o) => !withItems.includes(o));
  const probe = await readMetadata(session, 'CustomObjectTranslation', layoutOnly.map((o) => `${o}-${orgDefault}`)).catch(soft(`Layout sections ${NO_FIELDS}`));
  // A switched-off feature leaves fields on an object the org does not have: its file is empty.
  const unlisted = org.objects ? unlistedObjects(org.objects, fieldObjects) : [];
  const unlistedXml = await readMetadata(session, 'CustomObjectTranslation', unlisted.map((o) => `${o}-${orgDefault}`)).catch(soft(unlisted.join(', ')));
  const objects = [
    ...withItems,
    ...layoutOnly.filter((o) => parseObjectTranslation(probe?.[`${o}-${orgDefault}`])?.sections.length),
    ...unlisted.filter((o) => parseObjectTranslation(unlistedXml?.[`${o}-${orgDefault}`])?.fields.length),
  ].sort();
  const withTab = new Set((org.tabs || []).filter((t) => t.IsCustom && t.SobjectName).map((t) => t.SobjectName));
  const labelOf = new Map((org.objects || []).map((o) => [o.name, o.label]));
  const objectNames = objects.flatMap((o) => [orgDefault, ...codes].map((c) => `${o}-${c}`));
  const objectXml = await readMetadata(session, 'CustomObjectTranslation', objectNames, (d, n) => say(`Reading object translations… ${d} of ${n}`)).catch(
    soft('Field labels, help texts, picklist values, related list labels, record types, validation messages, layout sections, quick actions, buttons and links, and object tabs')
  );
  if (objectXml) {
    for (const o of objects) {
      const master = parseObjectTranslation(objectXml[`${o}-${orgDefault}`]);
      for (const c of codes) {
        items.push(...objectItems({ object: o, objectLabel: labelOf.get(o), language: c, translation: parseObjectTranslation(objectXml[`${o}-${c}`]), master, hasTab: withTab.has(o), actions, buttonLabels, activeRules, ownLayouts }));
      }
    }
  }

  // Web tabs are in the Translations file of each language, which also holds every custom label, flow and
  // report type: over 1 MB and many seconds per language in a large test sandbox. Read only when the org has a web tab
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
