// Missing-translations report (README Roadmap Phase 4, issue #14): pure logic, no chrome.* or network
// calls, so it is unit tested in Node. src/reportApi.js reads the org; src/reportPage.js shows the report.

import { languageName, namespaceOf, workbench } from './locator.js';

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

// ---------- item types ----------

export const ITEM_TYPE = {
  CUSTOM_LABEL: 'Custom label',
  FIELD_LABEL: 'Field label',
  PICKLIST_VALUE: 'Picklist value',
  RELATED_LIST_LABEL: 'Related list label',
  RECORD_TYPE: 'Record type',
  TAB: 'Tab',
};
export const ITEM_TYPES = Object.values(ITEM_TYPE);

// ---------- readMetadata XML (Translations, CustomObjectTranslation, GlobalValueSetTranslation) ----------

const XML_ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decodeXml = (s) =>
  String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return XML_ENT[e.toLowerCase()] ?? m;
    const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
const tagRe = (tag, flags) => new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, flags);
const blocks = (xml, tag) => [...String(xml || '').matchAll(tagRe(tag, 'g'))].map((m) => m[1]);
const dropBlocks = (xml, tags) => tags.reduce((x, t) => x.replace(tagRe(t, 'g'), ''), String(xml || ''));
const COMMENT_ONLY = /^\s*<!--([\s\S]*?)-->\s*$/;

/** Plain text of a child element (no markup inside), or null. */
function text(xml, tag) {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:[\\w-]+:)?${tag}>`).exec(String(xml || ''));
  return m ? decodeXml(m[1]).trim() : null;
}

/**
 * A translatable element of a readMetadata answer. Absent: null (nothing to translate). Untranslated, the
 * element holds only a comment with the master text (dev org, checked live: `<label><!-- Paint Color --></label>`),
 * or nothing at all. Returns { translation, master }: translation is null when there is none.
 */
export function slot(xml, tag) {
  const s = String(xml || '');
  if (new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?/>`).test(s)) return { translation: null, master: null };
  const m = tagRe(tag).exec(s);
  if (!m) return null;
  const c = COMMENT_ONLY.exec(m[1]);
  if (c) return { translation: null, master: decodeXml(c[1].trim()) || null };
  const t = decodeXml(m[1].replace(/<!--[\s\S]*?-->/g, '')).trim();
  return { translation: t || null, master: null };
}

/** readMetadata response → { fullName → record XML }. */
export function metadataRecords(xml) {
  const out = {};
  for (const body of blocks(xml, 'records')) {
    const name = text(body, 'fullName'); // the record's own fullName is its first element
    if (name) out[name] = body;
  }
  return out;
}

/** One CustomObjectTranslation record → the parts the report checks. */
export function parseObjectTranslation(body) {
  if (!body) return null;
  return {
    caseValues: blocks(dropBlocks(body, ['fields']), 'caseValues').map((b) => ({ plural: text(b, 'plural') === 'true', caseType: text(b, 'caseType'), value: slot(b, 'value') })),
    fields: blocks(body, 'fields').map((b) => {
      const own = dropBlocks(b, ['picklistValues', 'caseValues']);
      return {
        name: text(own, 'name'),
        label: slot(own, 'label'),
        relationshipLabel: slot(own, 'relationshipLabel'),
        picklistValues: blocks(b, 'picklistValues').map((p) => ({ masterLabel: text(p, 'masterLabel'), translation: slot(p, 'translation') })),
      };
    }),
    recordTypes: blocks(body, 'recordTypes').map((b) => ({ name: text(b, 'name'), label: slot(b, 'label') })),
  };
}

/** One Translations record (one language) → its custom tabs [{ name, label }]. */
export function parseTranslations(body) {
  if (!body) return null;
  return { customTabs: blocks(body, 'customTabs').map((b) => ({ name: text(b, 'name'), label: slot(b, 'label') })) };
}

/** One GlobalValueSetTranslation record → [{ masterLabel, translation }]. */
export function parseValueSetTranslation(body) {
  if (!body) return null;
  return blocks(body, 'valueTranslation').map((b) => ({ masterLabel: text(b, 'masterLabel'), translation: slot(b, 'translation') }));
}

// ---------- items per language ----------
// Each check returns every item it looked at, translated or not, so the report can show coverage.
// Item: { language, type, object, objectLabel, name, master, translated, translation, goto }; translation is the
// translated text, or null when missing.

const labelAndApi = (label, api) => (label && label !== api ? `${label} (${api})` : api);
const NO_ORG = {}; // workbench() only needs the org for its click-path text, which the report does not show
const wb = (args) => workbench(NO_ORG, args).goto;

/**
 * Custom labels: one ExternalStringLocalization row per translated label and language. Labels whose own
 * language is `language` are the master text there; package labels are left out (see isOwnItem).
 * `labels`: ExternalString rows { Id, Name, NamespacePrefix, Value, Language }; `localizations`: { Id, ExternalStringId, Language, Value }.
 */
export function labelItems(labels, localizations, language) {
  const done = new Map((localizations || []).filter((l) => l.Language === language).map((l) => [l.ExternalStringId, l]));
  return (labels || [])
    .filter((l) => l?.Id && !l.NamespacePrefix && l.Language !== language)
    .map((l) => ({
      language,
      type: ITEM_TYPE.CUSTOM_LABEL,
      object: null,
      objectLabel: null,
      name: l.Name,
      master: l.Value ?? '',
      translated: done.has(l.Id),
      translation: done.has(l.Id) ? done.get(l.Id).Value ?? '' : null,
      // A translated label opens its translation to edit (buildGotoUrl), an untranslated one the New screen.
      goto: { page: 'label', labelId: l.Id, masterLanguage: l.Language, existing: done.get(l.Id)?.Id ? { [language]: done.get(l.Id).Id } : {}, namespace: null },
    }));
}

/** An org's own item, not a managed package's (packages ship their own translations, which the org does not hold). */
export const isOwnItem = (apiName) => !namespaceOf(apiName);

/**
 * Field labels, related list labels, picklist values and record types of one object, and its tab (custom
 * objects with a tab). `translation`/`master`: parseObjectTranslation of "<object>-<language>" and of
 * "<object>-<org default>" (the master texts, as comments). `objectLabel`: the object's label for display.
 */
export function objectItems({ object, objectLabel = null, language, translation, master, hasTab = false }) {
  if (!translation) return [];
  const label = objectLabel || object;
  const masterField = (name) => master?.fields?.find((f) => f.name === name) || null;
  // `found`: the slot ({ translation }) or the translated text itself.
  const item = (type, name, masterText, found, goto) => {
    const t = (typeof found === 'string' ? found : found?.translation) || null;
    return { language, type, object, objectLabel: label, name, master: masterText ?? '', translated: !!t, translation: t, goto };
  };
  const out = [];
  for (const f of translation.fields || []) {
    if (!f.name || !isOwnItem(f.name)) continue;
    const m = masterField(f.name);
    const fieldMaster = m?.label?.master || f.label?.master || f.name;
    if (f.label) {
      out.push(
        item(ITEM_TYPE.FIELD_LABEL, `${object}.${f.name}`, fieldMaster, f.label,
          wb({ component: 'Custom Field', object, objectLabel: label, aspect: 'Field Label', row: labelAndApi(fieldMaster, f.name), rows: [fieldMaster, f.name] }))
      );
    }
    if (f.relationshipLabel) {
      const relMaster = m?.relationshipLabel?.master || f.relationshipLabel.master || fieldMaster;
      out.push(
        item(ITEM_TYPE.RELATED_LIST_LABEL, `${object}.${f.name}`, relMaster, f.relationshipLabel,
          wb({ component: 'Custom Field', object, objectLabel: label, aspect: 'Related List Label', row: labelAndApi(fieldMaster, f.name), rows: [fieldMaster, relMaster, f.name] }))
      );
    }
    for (const pv of f.picklistValues || []) {
      if (!pv.masterLabel || !pv.translation) continue;
      out.push(
        item(ITEM_TYPE.PICKLIST_VALUE, `${object}.${f.name}: ${pv.masterLabel}`, pv.masterLabel, pv.translation,
          wb({ component: 'Picklist Value', object, objectLabel: label, row: `${pv.masterLabel} (field: ${fieldMaster})`, rows: [pv.masterLabel], parent: fieldMaster }))
      );
    }
  }
  for (const rt of translation.recordTypes || []) {
    if (!rt.name || !rt.label || !isOwnItem(rt.name)) continue;
    const rtMaster = master?.recordTypes?.find((x) => x.name === rt.name)?.label?.master || rt.label.master || rt.name;
    out.push(
      item(ITEM_TYPE.RECORD_TYPE, `${object}.${rt.name}`, rtMaster, rt.label,
        wb({ component: 'Record Type', object, objectLabel: label, aspect: 'Field Label', row: labelAndApi(rtMaster, rt.name), rows: [rtMaster, rt.name] }))
    );
  }
  // A custom object's tab shows its plural name: translated when any of its name forms is (Rename Tabs and Labels).
  if (hasTab && (translation.caseValues || []).length) {
    // German lists every grammatical case: the Nominative plural is the tab's text.
    const plural = (cv) => cv.find((c) => c.plural && (!c.caseType || c.caseType === 'Nominative'))?.value || cv.find((c) => c.plural)?.value;
    const tabMaster = plural(master?.caseValues || [])?.translation || plural(master?.caseValues || [])?.master || label;
    const tabText = plural(translation.caseValues)?.translation || translation.caseValues.find((c) => c.value?.translation)?.value.translation || null;
    out.push(item(ITEM_TYPE.TAB, object, tabMaster, tabText, { page: 'rename', object, custom: true, tabLabel: tabMaster, plural: true }));
  }
  return out;
}

/**
 * Web, Visualforce and Lightning page tabs (Translations "customTabs"). Custom object tabs are in
 * objectItems. `translation`/`master`: parseTranslations of the language and of the org default.
 */
export function tabItems({ language, translation, master }) {
  return (translation?.customTabs || [])
    .filter((t) => t.name && t.label && isOwnItem(t.name))
    .map((t) => {
      const tabMaster = master?.customTabs?.find((x) => x.name === t.name)?.label?.master || t.label.master || t.name;
      return {
        language,
        type: ITEM_TYPE.TAB,
        object: null,
        objectLabel: null,
        name: t.name,
        master: tabMaster,
        translated: !!t.label.translation,
        translation: t.label.translation || null,
        goto: wb({ component: 'Web Tab', row: tabMaster, rows: [tabMaster, t.name] }),
      };
    });
}

/** Values of one Global Value Set (`valueSet`: { name, label }; `values`: parseValueSetTranslation). */
export function valueSetItems({ language, valueSet, values }) {
  const vsLabel = valueSet.label || valueSet.name;
  return (values || [])
    .filter((v) => v.masterLabel && v.translation)
    .map((v) => ({
      language,
      type: ITEM_TYPE.PICKLIST_VALUE,
      object: null,
      objectLabel: `Global value set ${vsLabel}`,
      name: `${valueSet.name}: ${v.masterLabel}`,
      master: v.masterLabel,
      translated: !!v.translation.translation,
      translation: v.translation.translation || null,
      goto: wb({ component: 'Global Value Set', row: `${v.masterLabel} (value set: ${vsLabel})`, rows: [v.masterLabel], parent: vsLabel }),
    }));
}

/**
 * The report: per language, how many items were checked and which have no translation.
 * Returns { languages: [{ code, name, checked, missing, byType: { type → missing count } }], items, missing }:
 * every checked item and the missing ones, sorted by language, type (ITEM_TYPES order), object and name.
 */
export function summarize(languages, items) {
  const langRank = new Map((languages || []).map((l, i) => [l.code, i]));
  const all = (items || []).filter((i) => langRank.has(i.language)).sort((a, b) => langRank.get(a.language) - langRank.get(b.language) || byTypeObjectName(a, b));
  const missing = all.filter((i) => !i.translated);
  return {
    languages: (languages || []).map((l) => {
      const mine = (items || []).filter((i) => i.language === l.code);
      const byType = Object.fromEntries(ITEM_TYPES.map((t) => [t, 0]));
      for (const i of mine) if (!i.translated) byType[i.type] = (byType[i.type] || 0) + 1;
      return { ...l, checked: mine.length, missing: mine.filter((i) => !i.translated).length, byType };
    }),
    items: all,
    missing,
  };
}

const byTypeObjectName = (a, b) =>
  ITEM_TYPES.indexOf(a.type) - ITEM_TYPES.indexOf(b.type) ||
  String(a.objectLabel || '').localeCompare(String(b.objectLabel || '')) ||
  String(a.name).localeCompare(String(b.name));

/**
 * The org default language's rows: every checked item once, with its master text (the org default text is the
 * master, so nothing is missing there). Custom labels written in another language are left out: their master
 * text is not in the org default language. No goto: Translation Workbench does not translate into the org default.
 */
export function masterItems(items, orgDefault) {
  const seen = new Map();
  for (const i of items || []) {
    if (i.goto?.page === 'label' && i.goto.masterLanguage && i.goto.masterLanguage !== orgDefault) continue;
    const key = `${i.type}|${i.name}`;
    if (!seen.has(key)) seen.set(key, { ...i, language: orgDefault, translated: true, translation: i.master, goto: null });
  }
  return [...seen.values()].sort(byTypeObjectName);
}

// ---------- CSV export ----------

export const CSV_COLUMNS = ['Language code', 'Language', 'Type', 'Object', 'API name', 'Master text', 'Translation', 'Translation page'];

/** One CSV cell: quoted when needed, and text a spreadsheet would run as a formula (=, +, -, @) starts with '. */
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Items as CSV (RFC 4180, CRLF line ends, UTF-8 BOM so Excel reads accents).
 * `pageOf(item)`: the item's translation page URL, or '' (reportPage.js passes buildGotoUrl with the org origin).
 */
export function toCsv(items, { languageNames = {}, pageOf = () => '' } = {}) {
  const lines = [CSV_COLUMNS, ...(items || []).map((i) => [i.language, languageNames[i.language] || languageName(i.language) || i.language, i.type, i.objectLabel || '', i.name, i.master, i.translation ?? '', pageOf(i) || ''])];
  return '\uFEFF' + lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/**
 * The report page for the Salesforce tab at `tabUrl` (the toolbar popup and the panel link open the same page),
 * or null when the tab is no Salesforce page.
 */
export function reportPath(tabUrl) {
  let origin = null;
  try {
    origin = new URL(tabUrl || '').origin;
  } catch {
    return null;
  }
  return /^https:\/\/[^/]+\.(force\.com|salesforce\.com|salesforce-setup\.com)$/.test(origin) ? `src/report.html?org=${encodeURIComponent(origin)}` : null;
}
