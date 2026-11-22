import { queryAll, soapCall, xmlBlocks, xmlValue, dropBlocks, escapeXml } from './sfApi.js';

// Org-wide search data (#24): page layout section names, screen flow text and button labels of the whole
// org, not only the object on the current page. Metadata API listMetadata + readMetadata, 10 names per call,
// 6 calls at a time: UAT2's 507 layouts in about 3 s (one Metadata API retrieve took over 2 minutes there;
// Tooling reads layout metadata one row per call). Buttons come from one WebLink query. Kept per org in
// chrome.storage.local, so a new browser session does not read it again.

export const ORG_INDEX_TTL_MS = 24 * 60 * 60 * 1000;
// A read with a missing source (no metadata access, an error) is kept 5 minutes, in memory only.
const PARTIAL_TTL_MS = 5 * 60 * 1000;
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

/** "Account-Account %28Sales%29 Layout" (a Layout fullName) → { object: 'Account', layout: 'Account (Sales) Layout' }. */
export function layoutName(fullName) {
  const full = decodeName(String(fullName || ''));
  const dash = full.indexOf('-');
  return dash > 0 ? { object: full.slice(0, dash), layout: full.slice(dash + 1) } : null;
}

/** A page layout's section names, in page order (Translation Workbench → Layout Section lists them). */
export function parseLayoutSections(xml) {
  return xmlBlocks(xml, 'layoutSections')
    .map((b) => xmlValue(dropBlocks(b, ['layoutColumns']), 'label'))
    .filter((l) => l && l.trim());
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

// Top-level Flow elements other than screens; each has a <name> or <label> of its own.
const FLOW_PARTS = ['processMetadataValues', 'variables', 'formulas', 'decisions', 'assignments', 'recordLookups', 'recordCreates', 'recordUpdates', 'recordDeletes', 'actionCalls', 'subflows', 'loops', 'choices', 'dynamicChoiceSets', 'textTemplates', 'constants', 'stages', 'waits', 'start', 'collectionProcessors', 'transforms', 'customErrors'];

/**
 * A Flow (readMetadata record) → { name, label, screens: [{ name, label, fields: [{ name, fieldType, fieldText, helpText }], buttonLabels }] },
 * the shape loadFlowScreens returns for the flow on the current page.
 */
export function parseFlow(name, xml) {
  const screens = childBlocks(xml, 'screens').map((b) => {
    const own = dropBlocks(withoutChildren(b, 'fields'), ['rules', 'connector', 'triggers', 'actions', 'processMetadataValues']);
    return {
      name: xmlValue(own, 'name'),
      label: xmlValue(own, 'label') || xmlValue(own, 'name'),
      fields: screenFields(b).filter((f) => f.name),
      buttonLabels: ['backButtonLabel', 'nextOrFinishButtonLabel', 'pauseButtonLabel'].map((t) => xmlValue(own, t)).filter((l) => l && l.trim()),
    };
  });
  const top = dropBlocks(withoutChildren(xml, 'screens'), FLOW_PARTS);
  return { name, label: xmlValue(top, 'label') || name, screens };
}

/** A readMetadata response → its records: [{ fullName, xml }]. Names that do not exist are left out by Salesforce. */
export function readMetadataRecords(xml) {
  return childBlocks(xml, 'records').map((r) => ({ fullName: xmlValue(r, 'fullName'), xml: r }));
}

// ---------- Salesforce calls ----------

/**
 * Metadata API listMetadata: the fullNames of one metadata type. Managed-package items are left out:
 * readMetadata returns them empty (UAT2: 171 of 507 layouts came back as <records xsi:nil="true"/>).
 */
export async function listMetadataNames(session, type) {
  const xml = await soapCall(session, 'metadata', '', `<s:listMetadata><s:queries><s:type>${type}</s:type></s:queries></s:listMetadata>`);
  return xmlBlocks(xml, 'result')
    .filter((b) => xmlValue(b, 'manageableState') !== 'installed')
    .map((b) => xmlValue(b, 'fullName'))
    .filter(Boolean);
}

/**
 * readMetadata for many names: 10 per call, 6 calls at a time. A call that fails (one odd name) leaves its
 * 10 names out; an expired session (401) stops the read. Returns [{ fullName, xml }].
 */
export async function readMetadataAll(session, type, names) {
  const batches = [];
  for (let i = 0; i < names.length; i += READ_BATCH) batches.push(names.slice(i, i + READ_BATCH));
  const records = [];
  let failed = 0;
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
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
  if (batches.length && failed === batches.length) throw new Error(`readMetadata ${type} failed`);
  return records;
}

/** Every page layout's section names: [{ object, layout, sections }] (layouts without a named section left out). */
export async function loadLayoutSections(session) {
  const records = await readMetadataAll(session, 'Layout', await listMetadataNames(session, 'Layout'));
  return records
    .map((r) => ({ ...layoutName(r.fullName), sections: parseLayoutSections(r.xml) }))
    .filter((l) => l.object && l.sections.length);
}

/** The org's own screen flows (not managed-package ones), with their screens. */
export async function loadScreenFlows(session) {
  const rows = await queryAll(session, "SELECT ApiName FROM FlowDefinitionView WHERE ProcessType = 'Flow' AND NamespacePrefix = null");
  const names = rows.map((r) => r.ApiName).filter((n) => /^[A-Za-z0-9_]+$/.test(n || ''));
  const records = await readMetadataAll(session, 'Flow', names);
  return records.map((r) => parseFlow(r.fullName, r.xml)).filter((f) => f.screens.length);
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

async function buildOrgIndex(session) {
  const settled = await Promise.allSettled(SOURCES.map(([, , load]) => load(session)));
  const index = { at: Date.now(), warnings: [] };
  settled.forEach((r, i) => {
    const [key, what] = SOURCES[i];
    if (r.status === 'fulfilled') index[key] = r.value;
    else {
      if (r.reason?.status === 401) throw r.reason;
      index[key] = null;
      index.warnings.push(`${what} not searched org-wide: ${r.reason?.message || r.reason}`);
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

const fresh = (index) => !!index && Date.now() - index.at < (index.warnings?.length ? PARTIAL_TTL_MS : ORG_INDEX_TTL_MS);

/**
 * The org-wide search data, read once per org and kept 24 hours (memory, then chrome.storage.local).
 * `refresh`: read it again now. Returns { at, layouts, flows, buttons, warnings }; `at` is when it was read.
 * A source that could not be read is null, with a warning. A failed read is not kept.
 */
export function loadOrgIndex(session, { refresh = false } = {}) {
  const host = session.host;
  const hit = memory.get(host);
  const promise = (async () => {
    if (!refresh && hit) {
      const index = await hit.promise.catch(() => null);
      if (fresh(index)) return index;
    }
    if (!refresh) {
      const stored = await readStored(host);
      if (fresh(stored)) return stored;
    }
    const index = await buildOrgIndex(session);
    if (!index.warnings.length) await writeStored(host, index);
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

/** Forget the copies in memory (tests). */
export function clearOrgIndexMemory() {
  memory.clear();
}
