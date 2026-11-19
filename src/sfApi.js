import { PAGE_COMPONENT_KINDS, namespaceOf } from './locator.js';

// Salesforce API access from the extension service worker.
// Session: reuse the browser's existing login (sid cookie), the same approach
// Salesforce Inspector uses. Nothing is stored outside memory.

export const API_VERSION = 'v60.0';
const CACHE_TTL_MS = 5 * 60 * 1000;
const orgCache = new Map();
const describeCache = new Map();

export class SfError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Finds an API-usable session for the org open at pageUrl. */
export async function getSession(pageUrl) {
  const { hostname } = new URL(pageUrl);
  const pageSid = await chrome.cookies.get({ url: `https://${hostname}`, name: 'sid' });
  if (!pageSid) {
    throw new SfError(401, 'No Salesforce session found in this tab. Log in, reload the page, and try again.');
  }
  if (hostname.endsWith('.my.salesforce.com')) return { host: hostname, sid: pageSid.value };

  // Lightning (*.lightning.force.com) and Setup (*.my.salesforce-setup.com) cookies
  // are not valid for the API. Find the My Domain cookie for the same org.
  const orgId = pageSid.value.split('!')[0];
  const all = await chrome.cookies.getAll({ name: 'sid', domain: 'salesforce.com', secure: true });
  const match = all.find((c) => c.domain.endsWith('.my.salesforce.com') && c.value.startsWith(orgId + '!'));
  if (match) return { host: match.domain.replace(/^\./, ''), sid: match.value };

  const guess = hostname
    .replace(/\.lightning\.force\.com$/, '.my.salesforce.com')
    .replace(/\.my\.salesforce-setup\.com$/, '.my.salesforce.com');
  const guessed = await chrome.cookies.get({ url: `https://${guess}`, name: 'sid' });
  if (guessed) return { host: guess, sid: guessed.value };
  throw new SfError(401, `Could not find an API session for ${hostname}. Open Setup once in this org, then retry.`);
}

export async function sfFetch(session, path) {
  const res = await fetch(`https://${session.host}${path}`, {
    headers: { Authorization: `Bearer ${session.sid}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = body;
    try {
      msg = JSON.parse(body)[0]?.message || body;
    } catch {}
    if (res.status === 401) msg = 'Session expired or API access is off for your user (needs "API Enabled"). Reload Salesforce and retry.';
    throw new SfError(res.status, msg.slice(0, 300));
  }
  return res.json();
}

export async function queryAll(session, soql, { tooling = false } = {}) {
  const base = `/services/data/${API_VERSION}${tooling ? '/tooling' : ''}/query/?q=`;
  let page = await sfFetch(session, base + encodeURIComponent(soql));
  const records = [...page.records];
  while (!page.done && page.nextRecordsUrl) {
    page = await sfFetch(session, page.nextRecordsUrl);
    records.push(...page.records);
  }
  return records.map(stripAttributes);
}

export function stripAttributes(r) {
  if (!r || typeof r !== 'object') return r;
  // Keep arrays as arrays (bug: FlexiPage Metadata.flexiPageRegions became a plain object).
  if (Array.isArray(r)) return r.map(stripAttributes);
  const { attributes, ...rest } = r;
  for (const k of Object.keys(rest)) if (rest[k] && typeof rest[k] === 'object') rest[k] = stripAttributes(rest[k]);
  return rest;
}

// Each source loads independently; one failure (e.g. no Tooling access) only adds a warning.
const ORG_SOURCES = {
  customLabels: {
    what: 'Custom labels',
    load: (s) => queryAll(s, 'SELECT Id, Name, MasterLabel, NamespacePrefix, Value, Language FROM ExternalString', { tooling: true }),
  },
  objects: {
    what: 'Object names',
    load: (s) =>
      sfFetch(s, `/services/data/${API_VERSION}/sobjects`).then((r) =>
        r.sobjects.map((o) => ({ name: o.name, label: o.label, labelPlural: o.labelPlural, custom: o.custom }))
      ),
  },
  tabs: {
    what: 'Tabs',
    load: (s) => queryAll(s, 'SELECT Name, Label, IsCustom, SobjectName FROM TabDefinition'),
  },
  apps: {
    what: 'Apps',
    load: (s) => queryAll(s, 'SELECT Label, Name, NamespacePrefix, Type FROM AppMenuItem'),
  },
  validationRules: {
    what: 'Validation messages',
    load: (s) =>
      queryAll(s, 'SELECT Id, ValidationName, ErrorMessage, NamespacePrefix, EntityDefinition.QualifiedApiName FROM ValidationRule WHERE Active = true', {
        tooling: true,
      }),
  },
  // Path "Guidance for Success" (rich text HTML, one row per step) and the paths they belong to.
  pathSteps: {
    what: 'Path guidance',
    load: (s) => queryAll(s, 'SELECT Id, DeveloperName, MasterLabel, Language, Info FROM PathAssistantStepInfo', { tooling: true }),
  },
  paths: {
    what: 'Paths',
    load: (s) =>
      queryAll(s, 'SELECT Id, DeveloperName, MasterLabel, SobjectType, SobjectProcessField, RecordTypeId, IsActive FROM PathAssistant', { tooling: true }).then((paths) =>
        withObjectIds(s, paths)
      ),
  },
  userLanguage: {
    what: 'Your language',
    load: (s) => sfFetch(s, '/services/oauth2/userinfo').then((u) => u.language || null),
  },
  defaultLanguage: {
    what: 'Org default language',
    load: (s) => queryAll(s, 'SELECT LanguageLocaleKey FROM Organization').then((r) => r[0]?.LanguageLocaleKey || null),
  },
};

/**
 * A custom object's path steps name the object by its Id (EntityDefinition DurableId, 01I…), not its API
 * name (dev org, checked live). Adds SobjectId to each custom object's path; one query, none without one.
 */
export async function withObjectIds(session, paths) {
  const custom = [...new Set(paths.map((p) => p.SobjectType).filter((o) => /^[A-Za-z0-9_]+__c$/.test(o || '')))];
  if (!custom.length) return paths;
  const ents = await queryAll(session, `SELECT DurableId, QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName IN ('${custom.join("','")}')`, {
    tooling: true,
  }).catch(() => []);
  return paths.map((p) => ({ ...p, SobjectId: ents.find((e) => e.QualifiedApiName === p.SobjectType)?.DurableId || null }));
}

export function loadOrgData(session, { refresh = false } = {}) {
  const hit = orgCache.get(session.host);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = (async () => {
    const keys = Object.keys(ORG_SOURCES);
    const settled = await Promise.allSettled(keys.map((k) => ORG_SOURCES[k].load(session)));
    const org = { warnings: [] };
    settled.forEach((r, i) => {
      const k = keys[i];
      if (r.status === 'fulfilled') org[k] = r.value;
      else {
        org[k] = null;
        if (r.reason?.status === 401) throw r.reason;
        org.warnings.push(`${ORG_SOURCES[k].what} not searched: ${r.reason?.message || r.reason}`);
      }
    });
    return org;
  })();
  orgCache.set(session.host, { at: Date.now(), promise });
  promise.catch(() => orgCache.delete(session.host));
  return promise;
}

/** Escapes text for a SOQL string literal used with LIKE. */
export function soqlLike(text) {
  return String(text).replace(/[\\'%_]/g, (c) => '\\' + c);
}

/**
 * Custom label translations, searched per lookup. Big orgs have 100k+ of these
 * (one per label per language), so they are never loaded in full.
 * Returns translations of the given labels plus any translation whose value contains the text.
 */
export async function loadLabelTranslations(session, text, labelIds = []) {
  const term = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const where = [];
  if (term.length >= 3) where.push(`Value LIKE '%${soqlLike(term)}%'`);
  else if (term) where.push(`Value = '${soqlLike(term).replace(/\\([%_])/g, '$1')}'`);
  const ids = labelIds.filter((id) => /^[a-zA-Z0-9]{15,18}$/.test(id)).slice(0, 300);
  if (ids.length) where.push(`ExternalStringId IN ('${ids.join("','")}')`);
  if (!where.length) return [];
  return queryAll(session, `SELECT Id, ExternalStringId, Language, Value FROM ExternalStringLocalization WHERE ${where.join(' OR ')} LIMIT 2000`, {
    tooling: true,
  });
}

/**
 * Data Translation for one record. The feature creates a "<Object>DataTranslation" object
 * (e.g. Product2DataTranslation) once it is enabled; its text fields are the translatable ones.
 * Returns null when the object has no data translation in this org.
 */
export async function loadDataTranslation(session, org, objectName, recordId) {
  const dtObject = `${objectName}DataTranslation`;
  if (!(org.objects || []).some((o) => o.name === dtObject)) return null;
  const base = `/services/data/${API_VERSION}/sobjects`;
  const dt = await sfFetch(session, `${base}/${dtObject}/describe`);
  const SYSTEM = /^(Id|ParentId|Language|IsOutOfDate|IsDeleted|OwnerId|CreatedDate|CreatedById|LastModifiedDate|LastModifiedById|SystemModstamp)$/;
  const fields = dt.fields.filter((f) => !SYSTEM.test(f.name) && ['string', 'textarea', 'url'].includes(f.type)).map((f) => ({ name: f.name, label: f.label }));
  const out = { object: objectName, dtObject, fields, recordId: null, parent: null, rows: [] };
  if (!fields.length || !/^[a-zA-Z0-9]{15,18}$/.test(recordId || '')) return out;
  const names = fields.map((f) => f.name);
  const hasLanguage = dt.fields.some((f) => f.name === 'Language');
  const [parent, rows] = await Promise.all([
    sfFetch(session, `${base}/${objectName}/${recordId}?fields=${names.join(',')}`).catch(() => null),
    queryAll(session, `SELECT Id, ${hasLanguage ? 'Language, ' : ''}${names.join(', ')} FROM ${dtObject} WHERE ParentId = '${recordId}'`).catch(() => []),
  ]);
  return { ...out, recordId, parent, rows };
}

const flexiCache = new Map();

/**
 * Reads one Lightning App Builder component (e.g. a Dynamic Forms field section) from a record
 * page's metadata. The page's generated tag is "forcegenerated-flexipage_<dev name>_<object>__view_js…";
 * SOQL DeveloperName comparisons ignore case. Returns { page, id, component, label } or null.
 */
export async function loadFlexiPageComponent(session, flexipageTag, componentId, objects = []) {
  const m = /^forcegenerated-flexipage_(.+?)__view/.exec(flexipageTag || '');
  if (!m || !/^[A-Za-z0-9_]+$/.test(m[1]) || !/^[A-Za-z0-9_]+$/.test(componentId || '')) return null;
  const names = [m[1]];
  for (const o of objects) {
    const sfx = '_' + o.toLowerCase();
    if (m[1].endsWith(sfx)) names.unshift(m[1].slice(0, -sfx.length));
  }
  for (const name of names) {
    const key = `${session.host}|${name}`;
    let hit = flexiCache.get(key);
    if (!hit || Date.now() - hit.at > CACHE_TTL_MS) {
      hit = { at: Date.now(), promise: queryAll(session, `SELECT DeveloperName, MasterLabel, Metadata FROM FlexiPage WHERE DeveloperName = '${name}' LIMIT 1`, { tooling: true }) };
      flexiCache.set(key, hit);
      hit.promise.catch(() => flexiCache.delete(key));
    }
    const page = (await hit.promise)[0];
    if (!page) continue;
    // A tab's page element is "flexipage_tab2Tab" for the component "flexipage_tab2" (UAT2, Nov 2026).
    const ids = /Tab$/.test(componentId) ? [componentId, componentId.slice(0, -3)] : [componentId];
    for (const id of ids) {
      for (const region of page.Metadata?.flexiPageRegions || []) {
        for (const item of region.itemInstances || []) {
          const ci = item.componentInstance;
          if (ci?.identifier !== id) continue;
          const props = Object.fromEntries((ci.componentInstanceProperties || []).filter((p) => p.name).map((p) => [p.name, p.value ?? null]));
          // The property that holds the shown text depends on the component (label, relatedListLabel, title).
          const prop = PAGE_COMPONENT_KINDS[ci.componentName]?.prop || 'label';
          const label = props[prop] ?? props.label ?? props.title ?? null;
          return { page: page.MasterLabel || page.DeveloperName, id, component: ci.componentName, label, props };
        }
      }
    }
    return null;
  }
  return null;
}

/**
 * The nearest of the pointed element's component ids (nearest first) that the page metadata knows.
 * content.js keeps every identifier-shaped name, since a page deployed from metadata can use any
 * identifier (dev org: sftl_tab_greetingTab, sftl_tabset). One FlexiPage query, cached.
 * `kind` (optional RegExp on componentName): components of another kind are skipped, so a nearer one
 * (e.g. the tab set around a field section) does not hide the one the text belongs to.
 */
export async function loadNearestFlexiPageComponent(session, flexipageTag, componentIds = [], objects = [], kind = null) {
  for (const id of componentIds.slice(0, 5)) {
    const pc = await loadFlexiPageComponent(session, flexipageTag, id, objects);
    if (pc && (!kind || kind.test(pc.component || ''))) return pc;
  }
  return null;
}

const flowCache = new Map();

/**
 * The screens of a flow's active version (else its latest), for the screen text you point at. Tooling
 * FlowDefinition → Flow.Metadata (one row at a time). Dev org, checked live: screens[] { name, label,
 * fields[] { name, fieldType DisplayText|InputField|RegionContainer…, fieldText, helpText, fields[] } }.
 * Returns { name, label, version, screens: [{ name, label, fields: [{ name, fieldType, fieldText, helpText }], buttonLabels }] } or null.
 */
export function loadFlowScreens(session, flowName) {
  const m = /^(?:([A-Za-z0-9]+)__)?([A-Za-z0-9_]+)$/.exec(flowName || '');
  if (!m) return Promise.resolve(null);
  const key = `${session.host}|${flowName}`;
  const hit = flowCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const [, ns, dev] = m;
  const promise = (async () => {
    // No namespace: the org's own flow, not a packaged flow with the same DeveloperName.
    const def = await queryAll(session, `SELECT ActiveVersionId, LatestVersionId FROM FlowDefinition WHERE DeveloperName = '${dev}' AND NamespacePrefix = ${ns ? `'${ns}'` : 'null'} LIMIT 1`, { tooling: true });
    const id = def[0]?.ActiveVersionId || def[0]?.LatestVersionId;
    if (!/^[a-zA-Z0-9]{15,18}$/.test(id || '')) return null;
    const v = (await queryAll(session, `SELECT MasterLabel, VersionNumber, Metadata FROM Flow WHERE Id = '${id}'`, { tooling: true }))[0];
    if (!v) return null;
    // Sections hold their fields in columns: fields[].fields[] (any depth).
    const flat = (fields) => (fields || []).flatMap((f) => [{ name: f.name, fieldType: f.fieldType, fieldText: f.fieldText ?? null, helpText: f.helpText ?? null }, ...flat(f.fields)]);
    return {
      name: flowName,
      label: v.MasterLabel || flowName,
      version: v.VersionNumber ?? null,
      screens: (v.Metadata?.screens || []).map((s) => ({
        name: s.name,
        label: s.label || s.name,
        fields: flat(s.fields),
        // The screen's own labels for its navigation buttons, when set (else Salesforce's Next, Previous…).
        buttonLabels: [s.backButtonLabel, s.nextOrFinishButtonLabel, s.pauseButtonLabel].filter((l) => typeof l === 'string' && l.trim()),
      })),
    };
  })().catch(() => null);
  flowCache.set(key, { at: Date.now(), promise });
  return promise;
}

const valueSetCache = new Map();

/**
 * Picklist values from field or value set metadata, inactive ones included. Tooling names the value
 * valueName (DV2 keys: color, default, description, isActive, label, urls, valueName); the Metadata API
 * names it fullName. Either can be URL-encoded. Active values come back with isActive null.
 */
function valueList(raw) {
  const decode = (s) => {
    try {
      return decodeURIComponent(String(s ?? ''));
    } catch {
      return String(s ?? '');
    }
  };
  return (raw || [])
    .map((v) => ({ v, name: v?.valueName ?? v?.fullName }))
    .filter(({ name }) => name)
    .map(({ v, name }) => ({ value: decode(name), label: v.label ?? decode(name), active: v.isActive !== false }));
}

// Standard picklists whose StandardValueSet name is not "<Object><Field>" or "<Field>".
const STANDARD_VALUE_SET_NAMES = { 'Opportunity.StageName': 'OpportunityStage', 'Lead.Rating': 'AccountRating' };

/**
 * A standard picklist's values from its StandardValueSet (DV2, checked live: MasterLabel 'LeadSource',
 * Metadata.standardValue[] with valueName, label, isActive). Names tried in order: known name,
 * "<Object><Field>" (AccountType, CaseStatus), the field name (LeadSource, Industry).
 * Returns { name: null, values } or null.
 */
async function loadStandardValueSet(session, objectName, fieldName) {
  const names = [...new Set([STANDARD_VALUE_SET_NAMES[`${objectName}.${fieldName}`], objectName + fieldName, fieldName].filter(Boolean))];
  const rows = await queryAll(session, `SELECT MasterLabel FROM StandardValueSet WHERE MasterLabel IN ('${names.join("','")}')`, { tooling: true });
  const name = names.find((n) => rows.some((r) => r.MasterLabel === n));
  if (!name) return null;
  // Read Metadata by MasterLabel, not by Id: DV2 (checked live, v62.0) returns the placeholder Id
  // '000000000000000AAA' for every StandardValueSet, and `WHERE Id = ...` fails with MALFORMED_QUERY
  // "filtered column Id not found". `name` is one of `names`, which are [A-Za-z0-9_] only.
  const full = await queryAll(session, `SELECT Metadata FROM StandardValueSet WHERE MasterLabel = '${name}'`, { tooling: true });
  const values = valueList(full[0]?.Metadata?.standardValue);
  return values.length ? { name: null, values } : null;
}

/**
 * The Global Value Set a custom picklist field uses, or null (REST describe does not say).
 * Tooling CustomField Metadata can only be read one row at a time, so: find the Id, then read it.
 * Checked in UAT2 (Nov 2026): Account.Market_Unit_MST__c → valueSetName "Market_Unit_LST" (label "Market Unit").
 * Returns { name, label, namespace }, { name: null, values } (the field's own values, or a standard
 * picklist's StandardValueSet values) or null.
 */
export function loadValueSet(session, objectName, fieldName) {
  if (!/^[A-Za-z0-9_]+$/.test(objectName || '') || !/^[A-Za-z0-9_]+$/.test(fieldName || '')) return Promise.resolve(null);
  const m = /^(?:([A-Za-z0-9]+)__)?([A-Za-z0-9_]+?)__c$/.exec(fieldName);
  const key = `${session.host}|${objectName}.${fieldName}`;
  const hit = valueSetCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  if (!m) {
    if (fieldName.includes('__')) return Promise.resolve(null);
    const promise = loadStandardValueSet(session, objectName, fieldName).catch(() => null);
    valueSetCache.set(key, { at: Date.now(), promise });
    return promise;
  }
  const [, ns, dev] = m;
  const promise = (async () => {
    const nsWhere = ns ? `NamespacePrefix = '${ns}'` : 'NamespacePrefix = null';
    const rows = await queryAll(
      session,
      `SELECT Id FROM CustomField WHERE EntityDefinition.QualifiedApiName = '${objectName}' AND DeveloperName = '${dev}' AND ${nsWhere} LIMIT 1`,
      { tooling: true }
    );
    if (!rows[0]?.Id) return null;
    const full = await queryAll(session, `SELECT Metadata FROM CustomField WHERE Id = '${rows[0].Id}'`, { tooling: true });
    const meta = full[0]?.Metadata?.valueSet;
    const name = meta?.valueSetName;
    if (!name) {
      // The field's own values, inactive ones included (REST describe lists active values only;
      // DV2: an inactive Contact picklist value).
      const values = valueList(meta?.valueSetDefinition?.value);
      return values.length ? { name: null, values } : null;
    }
    if (!/^[A-Za-z0-9_]+$/.test(name)) return null;
    const vsNs = namespaceOf(name);
    const dn = vsNs ? name.slice(vsNs.length + 2) : name;
    const gvs = await queryAll(session, `SELECT MasterLabel, NamespacePrefix FROM GlobalValueSet WHERE DeveloperName = '${dn}' LIMIT 1`, { tooling: true }).catch(() => []);
    return { name, label: gvs[0]?.MasterLabel || name, namespace: gvs[0]?.NamespacePrefix || vsNs || null };
  })().catch(() => null);
  valueSetCache.set(key, { at: Date.now(), promise });
  return promise;
}

const recordTypeCache = new Map();

/**
 * RecordTypeId of one record: an Id, null (no record type), or undefined when it could not be read.
 * Paths belong to one record type, so the open record's type decides which path the page shows.
 */
export function loadRecordTypeId(session, objectName, recordId, { refresh = false } = {}) {
  if (!/^[A-Za-z0-9_]+$/.test(objectName || '') || !/^[a-zA-Z0-9]{15,18}$/.test(recordId || '')) return Promise.resolve(undefined);
  const key = `${session.host}|${objectName}/${recordId}`;
  const hit = recordTypeCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = sfFetch(session, `/services/data/${API_VERSION}/sobjects/${objectName}/${recordId}?fields=RecordTypeId`)
    .then((r) => r?.RecordTypeId ?? null)
    .catch(() => undefined);
  recordTypeCache.set(key, { at: Date.now(), promise });
  return promise;
}

/** Describe + quick actions for one object. Returns null if the object is not visible. */
export function loadDescribe(session, objectName, { refresh = false } = {}) {
  const key = `${session.host}|${objectName}`;
  const hit = describeCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = (async () => {
    const base = `/services/data/${API_VERSION}/sobjects/${encodeURIComponent(objectName)}`;
    const [d, qa] = await Promise.all([
      sfFetch(session, `${base}/describe`),
      sfFetch(session, `${base}/quickActions`).catch(() => []),
    ]);
    return {
      name: d.name,
      label: d.label,
      labelPlural: d.labelPlural,
      custom: d.custom,
      fields: d.fields.map((f) => ({
        name: f.name,
        label: f.label,
        custom: f.custom,
        type: f.type,
        calculated: !!f.calculated, // formula field: its value is computed, not typed
        autoNumber: !!f.autoNumber, // auto-number: Salesforce generates the value
        inlineHelpText: f.inlineHelpText,
        picklistValues: (f.picklistValues || []).map((p) => ({ label: p.label, value: p.value, active: p.active })),
      })),
      recordTypeInfos: (d.recordTypeInfos || []).map((rt) => ({ name: rt.name, developerName: rt.developerName, master: rt.master, recordTypeId: rt.recordTypeId })),
      quickActions: (Array.isArray(qa) ? qa : []).map((a) => ({ label: a.label, name: a.name, type: a.type })),
      // Related lists name a child relationship (relatedListApiName): which child object and lookup field.
      childRelationships: (d.childRelationships || [])
        .filter((c) => c.relationshipName && c.childSObject && c.field)
        .map((c) => ({ childSObject: c.childSObject, field: c.field, relationshipName: c.relationshipName })),
      // Org-built translation objects, e.g. Product_Translations__c (not the standard *DataTranslation).
      translationChildren: (d.childRelationships || [])
        .filter((c) => c.relationshipName && /__c$/.test(c.childSObject) && /translat/i.test(c.childSObject))
        .map((c) => ({ object: c.childSObject, relationship: c.relationshipName, label: null })),
    };
  })().catch(() => null);
  describeCache.set(key, { at: Date.now(), promise });
  return promise;
}
