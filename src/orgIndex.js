import { queryAll, soapCall, xmlBlocks, xmlValue, dropBlocks, escapeXml, parseSectionTranslations } from './sfApi.js';

// Org-wide search data (#24): page layout section names, screen flow text and button labels of the whole
// org, not only the object on the current page. Metadata API listMetadata + readMetadata, 10 names per call,
// 6 calls at a time: UAT2's 507 layouts in about 3 s (one Metadata API retrieve took over 2 minutes there;
// Tooling reads layout metadata one row per call). Buttons come from one WebLink query. Kept per org in
// chrome.storage.local, so a new browser session does not read it again.

export const ORG_INDEX_TTL_MS = 24 * 60 * 60 * 1000;
// A read with a missing source (no metadata access, an error) is kept 5 minutes, in memory only.
const PARTIAL_TTL_MS = 5 * 60 * 1000;
// The shape of the stored copy: 2 = sections split from standardSections, flow versions and footer buttons.
const INDEX_VERSION = 2;
const READ_BATCH = 10; // readMetadata reads at most 10 names per call
const PARALLEL = 6;
const STORAGE_PREFIX = 'sftl:orgIndex:';
const memory = new Map();

// ---------- metadata parsing (pure, unit tested) ----------

const decodeName = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Layout fullName prefixes that are not an object name, and the object Translation Workbench → Layout Section
 * lists their layouts under. Seen in the dev org (Nov 2026): CommunityMemberLayout under User, CaseClose under
 * Case. The others follow the same naming (the object the layout belongs to). Global (the global publisher
 * layout) has no sections.
 */
const LAYOUT_OBJECTS = {
  CaseClose: 'Case',
  CaseInteraction: 'Case',
  CommunityMemberLayout: 'User',
  UserAlt: 'User',
  LiveChatTranscriptActive: 'LiveChatTranscript',
  LiveChatTranscriptWaiting: 'LiveChatTranscript',
};

/** "Account-Account %28Sales%29 Layout" (a Layout fullName) → { object: 'Account', layout: 'Account (Sales) Layout' }. */
export function layoutName(fullName) {
  const full = decodeName(String(fullName || ''));
  const dash = full.indexOf('-');
  if (dash <= 0) return null;
  const prefix = full.slice(0, dash);
  return { object: LAYOUT_OBJECTS[prefix] || prefix, layout: full.slice(dash + 1) };
}

/**
 * A page layout's section names, in page order: `sections` the names an admin typed (customLabel true), which
 * Translation Workbench → Layout Section lists; `standardSections` Salesforce's own names (customLabel false,
 * e.g. "Account Information"), which it does not list (dev org, Nov 2026: Account shows only the one layout
 * with a custom-named section, and only that section).
 */
export function layoutSections(xml) {
  const custom = [];
  const standard = [];
  for (const b of xmlBlocks(xml, 'layoutSections')) {
    const own = dropBlocks(b, ['layoutColumns']);
    const label = xmlValue(own, 'label');
    if (!label || !label.trim()) continue;
    (xmlValue(own, 'customLabel') === 'false' ? standard : custom).push(label);
  }
  return { sections: custom, standardSections: standard };
}

/** The section names Translation Workbench → Layout Section lists for a page layout, in page order. */
export function parseLayoutSections(xml) {
  return layoutSections(xml).sections;
}

/** The spans of the top-level <tag>…</tag> blocks of `xml`, nested blocks of the same tag kept whole. */
function blockSpans(xml, tag) {
  const re = new RegExp(`<(/?)(?:[\\w-]+:)?${tag}(?:\\s[^>]*?)?(/?)>`, 'g');
  const spans = [];
  let depth = 0;
  let open = null;
  for (const m of xml.matchAll(re)) {
    if (m[2]) continue; // <tag/>
    if (!m[1]) {
      if (depth++ === 0) open = m;
    } else if (depth > 0 && --depth === 0) spans.push({ start: open.index, inner: open.index + open[0].length, end: m.index, close: m.index + m[0].length });
  }
  return spans;
}

/** The direct children <tag>…</tag> of a block (their inner XML), nested blocks of the same tag kept whole. */
export function childBlocks(xml, tag) {
  const s = String(xml || '');
  return blockSpans(s, tag).map((b) => s.slice(b.inner, b.end));
}

/** `xml` without its top-level <tag> blocks (nesting-aware, unlike dropBlocks). */
function withoutChildren(xml, tag) {
  const s = String(xml || '');
  let out = '';
  let at = 0;
  for (const b of blockSpans(s, tag)) {
    out += s.slice(at, b.start);
    at = b.close;
  }
  return out + s.slice(at);
}

// Child elements of a screen field that hold a <name> or text of their own.
const FIELD_PARTS = ['inputParameters', 'outputParameters', 'visibilityRule', 'validationRule', 'dataTypeMappings', 'choiceReferences', 'defaultValue', 'processMetadataValues'];

function screenFields(xml) {
  return childBlocks(xml, 'fields').flatMap((b) => {
    const own = dropBlocks(withoutChildren(b, 'fields'), FIELD_PARTS);
    return [{ name: xmlValue(own, 'name'), fieldType: xmlValue(own, 'fieldType'), fieldText: xmlValue(own, 'fieldText'), helpText: xmlValue(own, 'helpText') }, ...screenFields(b)];
  });
}

/**
 * A Flow (readMetadata record) and its label (FlowDefinitionView: the Flow XML has many <label>s, one per
 * element) → { name, label, version, screens: [{ name, label, fields: [{ name, fieldType, fieldText, helpText }],
 * buttonLabels, buttons: [{ aspect, label }] }] }, the shape loadFlowScreens returns for the flow on the current
 * page. `version`: the number of the version read (readMetadata reads the newest one).
 */
export function parseFlow(name, xml, label = null, version = null) {
  const screens = childBlocks(xml, 'screens').map((b) => {
    const own = dropBlocks(withoutChildren(b, 'fields'), ['rules', 'connector', 'triggers', 'actions', 'processMetadataValues']);
    const buttons = FOOTER_BUTTONS.map(([tag, aspect]) => ({ aspect, label: xmlValue(own, tag) })).filter((x) => x.label && x.label.trim());
    return {
      name: xmlValue(own, 'name'),
      label: xmlValue(own, 'label') || xmlValue(own, 'name'),
      fields: screenFields(b).filter((f) => f.name),
      buttonLabels: buttons.map((x) => x.label),
      buttons,
    };
  });
  return { name, label: label || name, version, screens };
}

// A screen's own footer button labels (Flow Builder → Configure Footer), and their Aspect in Translation
// Workbench → Flow → Flow Component "Screen Info" (dev org, Nov 2026).
const FOOTER_BUTTONS = [
  ['backButtonLabel', 'Back Button Label'],
  ['nextOrFinishButtonLabel', 'Next or Finish Button Label'],
  ['pauseButtonLabel', 'Pause Button Label'],
];

/** A readMetadata response → its records: [{ fullName, xml }]. Names that do not exist are left out by Salesforce. */
export function readMetadataRecords(xml) {
  return childBlocks(xml, 'records').map((r) => ({ fullName: xmlValue(r, 'fullName'), xml: r }));
}

// ---------- Salesforce calls ----------

/**
 * Metadata API listMetadata: the fullNames of one metadata type. Managed-package items are left out:
 * readMetadata returns them empty (UAT2: 171 of 507 layouts came back as <records xsi:nil="true"/>).
 * Their states: installed, installedEditable, deprecated, deprecatedEditable, deleted.
 */
export async function listMetadataNames(session, type) {
  const xml = await soapCall(session, 'metadata', '', `<s:listMetadata><s:queries><s:type>${type}</s:type></s:queries></s:listMetadata>`);
  return xmlBlocks(xml, 'result')
    .filter((b) => !/^(installed|deprecated|deleted)/.test(xmlValue(b, 'manageableState') || ''))
    .map((b) => xmlValue(b, 'fullName'))
    .filter(Boolean);
}

/**
 * readMetadata for many names: 10 per call, 6 calls at a time. A call that fails leaves its names out and
 * calls `warn` (the read then counts as partial: not stored, read again soon); an expired session (401)
 * stops the read. Returns [{ fullName, xml }].
 */
export async function readMetadataAll(session, type, names, warn = () => {}) {
  const batches = [];
  for (let i = 0; i < names.length; i += READ_BATCH) batches.push(names.slice(i, i + READ_BATCH));
  const records = [];
  let failed = 0;
  let lastError = null;
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      const body = `<s:readMetadata><s:type>${type}</s:type>${batch.map((n) => `<s:fullNames>${escapeXml(n)}</s:fullNames>`).join('')}</s:readMetadata>`;
      try {
        records.push(...readMetadataRecords(await soapCall(session, 'metadata', '', body)));
      } catch (e) {
        if (e?.status === 401) throw e;
        failed++;
        lastError = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
  // Every call failed: the error keeps Salesforce's code, so an access error is told apart.
  if (batches.length && failed === batches.length) throw Object.assign(new Error(`readMetadata ${type} failed`), { code: lastError?.code ?? null });
  if (failed) warn(`${failed} of ${batches.length} readMetadata ${type} calls failed`);
  return records;
}

/**
 * Every page layout's section names: [{ object, layout, sections, standardSections }] (layouts without a named
 * section left out). A layout with standard names only stays: it shows which objects' layouts were read.
 */
export async function loadLayoutSections(session, warn) {
  const records = await readMetadataAll(session, 'Layout', await listMetadataNames(session, 'Layout'), warn);
  return records
    .map((r) => ({ ...layoutName(r.fullName), ...layoutSections(r.xml) }))
    .filter((l) => l.object && (l.sections.length || l.standardSections.length));
}

/**
 * The newest version number of each of the org's own screen flows (readMetadata reads that version). Translation
 * Workbench → Flow → Screen Info asks for the Flow Version and starts at version 1. {} when it cannot be read.
 */
async function flowVersions(session) {
  const rows = await queryAll(session, "SELECT FlowDefinitionView.ApiName, VersionNumber FROM FlowVersionView WHERE FlowDefinitionView.ProcessType = 'Flow' AND FlowDefinitionView.NamespacePrefix = null").catch(() => []);
  const out = {};
  for (const r of rows) {
    const name = r.FlowDefinitionView?.ApiName;
    if (name && Number.isInteger(r.VersionNumber) && !(out[name] >= r.VersionNumber)) out[name] = r.VersionNumber;
  }
  return out;
}

/** The org's own screen flows (not managed-package ones), with their screens. */
export async function loadScreenFlows(session, warn) {
  const [rows, versions] = await Promise.all([queryAll(session, "SELECT ApiName, Label FROM FlowDefinitionView WHERE ProcessType = 'Flow' AND NamespacePrefix = null"), flowVersions(session)]);
  const labels = new Map(rows.filter((r) => /^[A-Za-z0-9_]+$/.test(r.ApiName || '')).map((r) => [r.ApiName, r.Label]));
  const records = await readMetadataAll(session, 'Flow', [...labels.keys()], warn);
  return records.map((r) => parseFlow(r.fullName, r.xml, labels.get(r.fullName), versions[r.fullName] ?? null)).filter((f) => f.screens.length);
}

/** Custom buttons and links (Translation Workbench → Button and Link Label), every object. */
export async function loadButtons(session) {
  const rows = await queryAll(session, 'SELECT Name, MasterLabel, NamespacePrefix, PageOrSobjectType FROM WebLink');
  return rows.filter((r) => r.MasterLabel && r.PageOrSobjectType).map((r) => ({ name: r.Name, label: r.MasterLabel, object: r.PageOrSobjectType, namespace: r.NamespacePrefix || null }));
}

const SOURCES = [
  ['layouts', 'Page layout sections', loadLayoutSections],
  ['flows', 'Flows', loadScreenFlows],
  ['buttons', 'Buttons', loadButtons],
];

// Errors that mean this user may not read the source (no Modify Metadata, no View Setup): reading it again
// gives the same answer until an admin changes the user's permissions.
const ACCESS_CODES = new Set(['INSUFFICIENT_ACCESS', 'INSUFFICIENT_ACCESS_OR_READONLY', 'API_DISABLED_FOR_ORG', 'API_CURRENTLY_DISABLED', 'INVALID_TYPE']);
export const isAccessError = (e) => e?.status === 403 || ACCESS_CODES.has(e?.code) || /^INSUFFICIENT_ACCESS\b/.test(e?.message || '');

/**
 * Reads every source. `previous`: the full copy read before (expired, or the one a refresh replaces): a
 * source that fails now keeps its earlier data, so a failed refresh does not hide what was found before.
 * `denied`: sources an earlier read was refused with an access error ({ key: message }). They are not read
 * again (and not warned about again) until "Refresh org data", which passes none.
 */
async function buildOrgIndex(session, previous = null, denied = {}) {
  const index = { v: INDEX_VERSION, at: Date.now(), warnings: [], denied: {} };
  const settled = await Promise.allSettled(
    SOURCES.map(([key, what, load]) => (denied[key] ? Promise.reject(Object.assign(new Error(denied[key]), { carried: true })) : load(session, (w) => index.warnings.push(`${what} partly searched org-wide: ${w}`))))
  );
  settled.forEach((r, i) => {
    const [key, what] = SOURCES[i];
    if (r.status === 'fulfilled') index[key] = r.value;
    else {
      if (r.reason?.status === 401) throw r.reason;
      const kept = previous?.[key] ?? null;
      index[key] = kept;
      const message = `${what} not searched org-wide: ${r.reason?.message || r.reason}${kept ? ' (searched the copy read earlier)' : ''}`;
      if (r.reason?.carried || isAccessError(r.reason)) index.denied[key] = r.reason?.message || String(r.reason);
      // An access error is shown once, by the read that met it; the copy kept for 24 hours does not repeat it.
      if (r.reason?.carried) return;
      if (isAccessError(r.reason)) index.notices = [...(index.notices || []), message];
      else index.warnings.push(message);
    }
  });
  return index;
}

const storage = () => globalThis.chrome?.storage?.local || null;

async function readStored(host) {
  try {
    return (await storage()?.get(STORAGE_PREFIX + host))?.[STORAGE_PREFIX + host] || null;
  } catch {
    return null;
  }
}

async function writeStored(host, index) {
  try {
    await storage()?.set({ [STORAGE_PREFIX + host]: index });
  } catch {
    // Storage full or not available: the copy in memory still serves this browser session.
  }
}

// A copy of an older shape (before INDEX_VERSION) is read again: v1 kept Salesforce's standard section names.
const current = (index) => !!index && index.v === INDEX_VERSION;
const fresh = (index) => current(index) && Date.now() - index.at < (index.warnings?.length ? PARTIAL_TTL_MS : ORG_INDEX_TTL_MS);
// A copy served again: its access notices were shown by the lookup that read it.
const served = (index) => (index.notices?.length ? { ...index, notices: [] } : index);

/**
 * The org-wide search data, read once per org and kept 24 hours (memory, then chrome.storage.local).
 * `refresh`: read it again now. Returns { at, layouts, flows, buttons, warnings, notices, denied }; `at` is when
 * it was read. A source that could not be read is null (or its earlier copy), with a warning. A failed read is
 * not kept. A source refused with an access error is a notice, shown by this lookup only, and that source is
 * not read again until a refresh (`denied`); the rest of the copy is kept 24 hours as usual.
 */
export function loadOrgIndex(session, { refresh = false } = {}) {
  const host = session.host;
  const hit = memory.get(host);
  const promise = (async () => {
    // A read still running that fails makes this lookup fail too (no second read of its own).
    const before = hit ? await hit.promise : null;
    if (!refresh && fresh(before)) return served(before);
    const stored = await readStored(host);
    if (!refresh && fresh(stored)) return served(stored);
    const copies = [before, stored].filter(current).sort((a, b) => b.at - a.at);
    const previous = copies.find((x) => !x.warnings?.length) || null;
    const index = await buildOrgIndex(session, previous, refresh ? {} : copies[0]?.denied || {});
    if (!index.warnings.length) await writeStored(host, served(index));
    return index;
  })();
  // A read still running is shared: a second lookup waits for it (above) and stores nothing.
  if (refresh || !hit || hit.settled) {
    const entry = { promise, settled: false };
    memory.set(host, entry);
    promise.then(
      () => (entry.settled = true),
      () => memory.get(host) === entry && memory.delete(host)
    );
  }
  return promise;
}

const translationMemory = new Map();

/**
 * Viewing another language, a section header shows its translation, not the master name the org-wide data
 * holds. The section translations of every object whose layouts have custom-named sections, in `language`:
 * readMetadata CustomObjectTranslation "<Object>-<language>", 10 per call (as the layouts). Kept 24 hours in
 * memory per org, language and read of the org-wide data (a refresh reads them again). Returns [{ object, layout, section (master name), label (translation) }].
 */
export function loadOrgSectionTranslations(session, index, language) {
  if (!/^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,4})?$/.test(language || '')) return Promise.resolve([]);
  const objects = [...new Set((index?.layouts || []).filter((l) => l.sections?.length && /^[A-Za-z0-9_]+$/.test(l.object)).map((l) => l.object))].sort();
  const key = `${session.host}|${language}|${index?.at}`;
  const hit = translationMemory.get(key);
  if (hit && Date.now() - hit.at < ORG_INDEX_TTL_MS) return hit.promise;
  const promise = readMetadataAll(session, 'CustomObjectTranslation', objects.map((o) => `${o}-${language}`)).then((records) =>
    records.flatMap((r) => {
      const object = (r.fullName || '').slice(0, (r.fullName || '').lastIndexOf('-'));
      return object ? parseSectionTranslations(r.xml).map((t) => ({ object, ...t })) : [];
    })
  );
  translationMemory.set(key, { at: Date.now(), promise });
  promise.catch(() => translationMemory.get(key)?.promise === promise && translationMemory.delete(key));
  return promise;
}

/** Forget the copies in memory (tests). */
export function clearOrgIndexMemory() {
  memory.clear();
  translationMemory.clear();
}
