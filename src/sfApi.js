import { PAGE_COMPONENT_KINDS, namespaceOf } from './locator.js';

// Salesforce API access from the extension service worker.
// Session: reuse the browser's existing login (sid cookie), the same approach
// Salesforce Inspector uses. Nothing is stored outside memory.

export const API_VERSION = 'v60.0';
const CACHE_TTL_MS = 5 * 60 * 1000;
const orgCache = new Map();
const describeCache = new Map();

export class SfError extends Error {
  /** `code`: Salesforce's errorCode (e.g. INVALID_TYPE), when the reply has one. */
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
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
  if (!res.ok) throw await sfErrorFrom(res);
  return res.json();
}

/**
 * POST / PATCH / DELETE with the same session as sfFetch. `body` is sent as JSON.
 * Returns the reply JSON (POST: { id, success, errors }), or null for 204 No Content (PATCH, DELETE).
 */
export async function sfWrite(session, method, path, body = null) {
  if (!['POST', 'PATCH', 'DELETE'].includes(method)) throw new Error(`sfWrite: ${method} is not a write method.`);
  const headers = { Authorization: `Bearer ${session.sid}`, Accept: 'application/json' };
  if (body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`https://${session.host}${path}`, { method, headers, ...(body != null ? { body: JSON.stringify(body) } : {}) });
  if (!res.ok) throw await sfErrorFrom(res);
  if (res.status === 204) return null;
  const text = await res.text().catch(() => '');
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null; // written; the reply just is not JSON
  }
}

/** An SfError from a failed reply: Salesforce sends [{ message, errorCode, fields }]. */
async function sfErrorFrom(res) {
  const body = await res.text().catch(() => '');
  let msg = body;
  let code = null;
  try {
    const first = JSON.parse(body)[0];
    msg = first?.message || body;
    code = first?.errorCode || null;
  } catch {}
  if (res.status === 401) msg = 'Session expired or API access is off for your user (needs "API Enabled"). Reload Salesforce and retry.';
  return new SfError(res.status, String(msg).slice(0, 300), code);
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
    // ErrorDisplayField: the field the message shows under (empty: top of the page). A translated message
    // is never in ErrorMessage, so the field is what ties a message under a field to its rules.
    // Without that column (older API, other access): the rules without it.
    load: (s) => {
      const q = (cols) => queryAll(s, `SELECT Id, ValidationName, ErrorMessage, ${cols}NamespacePrefix, EntityDefinition.QualifiedApiName FROM ValidationRule WHERE Active = true`, { tooling: true });
      return q('ErrorDisplayField, ').catch((e) => (e?.status === 401 ? Promise.reject(e) : q('')));
    },
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

// Sources whose labels come back in the user's language (sobjects, TabDefinition and AppMenuItem labels).
// Custom labels, validation messages, path guidance and metadata come back in the master language.
const LANGUAGE_SOURCES = ['objects', 'tabs', 'apps'];

async function loadSources(session, keys, org) {
  const settled = await Promise.allSettled(keys.map((k) => ORG_SOURCES[k].load(session)));
  const whats = keys.map((k) => ORG_SOURCES[k].what);
  org.warnings = (org.warnings || []).filter((w) => !whats.some((what) => w.startsWith(`${what} not searched:`)));
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
}

/**
 * Org data, cached 5 minutes. `language`: the user's language now (loadUserLanguage). When it differs from
 * the language the cached data was read in, only the language-dependent sources are read again (dev org:
 * after a switch to French the panel said "Viewing in English" and missed "Brouillon" for 5 minutes).
 */
export function loadOrgData(session, { refresh = false, language = null } = {}) {
  const hit = orgCache.get(session.host);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    if (!language) return hit.promise;
    return hit.promise.then((org) => {
      if (!org.userLanguage) org.userLanguage = language; // userinfo failed in the full load
      if (org.userLanguage === language) return org;
      const now = orgCache.get(session.host);
      if (now !== hit) return now ? now.promise : loadOrgData(session, { language });
      // The other sources keep their own expiry time.
      const promise = loadSources(session, LANGUAGE_SOURCES, { ...org, warnings: [...(org.warnings || [])], userLanguage: language });
      orgCache.set(session.host, { at: hit.at, promise });
      promise.catch(() => orgCache.delete(session.host));
      return promise;
    });
  }
  const promise = loadSources(session, Object.keys(ORG_SOURCES), { warnings: [] });
  orgCache.set(session.host, { at: Date.now(), promise });
  promise.catch(() => orgCache.delete(session.host));
  return promise;
}

const LANGUAGE_TTL_MS = 15 * 1000;
const languageCache = new Map();

/** The user's language now (userinfo), cached 15 s: a change in personal settings shows on the next lookup. */
export function loadUserLanguage(session, { refresh = false } = {}) {
  const hit = languageCache.get(session.host);
  if (!refresh && hit && Date.now() - hit.at < LANGUAGE_TTL_MS) return hit.promise;
  const promise = sfFetch(session, '/services/oauth2/userinfo')
    .then((u) => u.language || null)
    .catch(() => null);
  languageCache.set(session.host, { at: Date.now(), promise });
  return promise;
}

/** Escapes text for a SOQL string literal used with LIKE. */
export function soqlLike(text) {
  return String(text).replace(/[\\'%_]/g, (c) => '\\' + c);
}

/**
 * Custom label translations, searched per lookup. Big orgs have 100k+ of these
 * (one per label per language), so they are never loaded in full.
 * Returns translations of the given labels plus any translation whose value contains the text, and every
 * translation of a label found through one of its translations (dev org: "Bienvenue À L'atelier" listed
 * French only, the label has German too).
 */
export async function loadLabelTranslations(session, text, labelIds = []) {
  const term = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const where = [];
  if (term.length >= 3) where.push(`Value LIKE '%${soqlLike(term)}%'`);
  else if (term) where.push(`Value = '${soqlLike(term).replace(/\\([%_])/g, '$1')}'`);
  const validId = (id) => /^[a-zA-Z0-9]{15,18}$/.test(id || '');
  const ids = labelIds.filter(validId).slice(0, 300);
  if (ids.length) where.push(`ExternalStringId IN ('${ids.join("','")}')`);
  if (!where.length) return [];
  const query = (w) => queryAll(session, `SELECT Id, ExternalStringId, Language, Value FROM ExternalStringLocalization WHERE ${w} LIMIT 2000`, { tooling: true });
  const rows = await query(where.join(' OR '));
  // Labels found by a translation's text: their other languages, in one more query.
  const more = [...new Set(rows.map((r) => r.ExternalStringId))].filter((id) => validId(id) && !ids.includes(id)).slice(0, 300);
  if (!more.length) return rows;
  const extra = await query(`ExternalStringId IN ('${more.join("','")}')`).catch(() => []);
  const seen = new Set(rows.map((r) => r.Id));
  return [...rows, ...extra.filter((r) => !seen.has(r.Id))];
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

/** The FlexiPage DeveloperNames a generated page tag can stand for (with the object suffix dropped first). */
function flexiPageNames(flexipageTag, objects = []) {
  const m = /^forcegenerated-flexipage_(.+?)__(?:view|create|edit|clone)(?:_|$)/.exec(flexipageTag || '');
  if (!m || !/^[A-Za-z0-9_]+$/.test(m[1])) return [];
  const names = [m[1]];
  for (const o of objects) {
    const sfx = '_' + String(o).toLowerCase();
    if (m[1].endsWith(sfx)) names.unshift(m[1].slice(0, -sfx.length));
  }
  return names;
}

/** One FlexiPage with its Metadata (Tooling API), cached 5 minutes; null when there is none by that name. */
async function loadFlexiPage(session, name) {
  const key = `${session.host}|${name}`;
  let hit = flexiCache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_TTL_MS) {
    hit = { at: Date.now(), promise: queryAll(session, `SELECT DeveloperName, MasterLabel, Metadata FROM FlexiPage WHERE DeveloperName = '${name}' LIMIT 1`, { tooling: true }) };
    flexiCache.set(key, hit);
    hit.promise.catch(() => flexiCache.delete(key));
  }
  return (await hit.promise)[0] || null;
}

/**
 * Reads one Lightning App Builder component (e.g. a Dynamic Forms field section) from a record
 * page's metadata. The page's generated tag is "forcegenerated-flexipage_<dev name>_<object>__view_js…", and
 * "…__create_js…" on the New form of a Dynamic Forms page (UAT2 New Involved Party, Nov 2026);
 * SOQL DeveloperName comparisons ignore case. Returns { page, id, component, label } or null.
 */
export async function loadFlexiPageComponent(session, flexipageTag, componentId, objects = []) {
  if (!/^[A-Za-z0-9_]+$/.test(componentId || '')) return null;
  for (const name of flexiPageNames(flexipageTag, objects)) {
    const page = await loadFlexiPage(session, name);
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

/** A cached promise per key (5 minutes); a failed load is dropped so the next lookup tries again. */
function cached(cache, key, refresh, load) {
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = load();
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

/** The items of one utility bar FlexiPage: label = the "label" decorator typed in App Manager (null: Salesforce's own name). */
export function utilityItems(page) {
  const items = [];
  for (const region of page?.Metadata?.flexiPageRegions || []) {
    for (const item of region.itemInstances || []) {
      const ci = item.componentInstance;
      if (!ci?.identifier) continue;
      const decorators = (ci.componentInstanceProperties || []).filter((p) => p.type === 'decorator' && p.name);
      const label = decorators.find((p) => p.name === 'label')?.value ?? null;
      items.push({ id: ci.identifier, component: ci.componentName || null, label: label || null });
    }
  }
  return items;
}

const utilityAppsCache = new Map();
const utilityBarCache = new Map();

/**
 * The apps that have a utility bar, the user's current app first (UserAppInfo holds the app the user last
 * opened; dev org, checked live). AppDefinition.UtilityBar is the FlexiPage name, "ns__Name" for a package
 * (dev org: devedapp__Developer_Edition_UtilityBar). Returns [{ appId, app, bar, current }].
 */
export function loadUtilityApps(session, { refresh = false } = {}) {
  return cached(utilityAppsCache, session.host, refresh, async () => {
    const user = await sfFetch(session, '/services/oauth2/userinfo').catch(() => null);
    const userId = /^[a-zA-Z0-9]{15,18}$/.test(user?.user_id || '') ? user.user_id : null;
    const [apps, recent] = await Promise.all([
      queryAll(session, 'SELECT DurableId, Label, UtilityBar FROM AppDefinition WHERE UtilityBar != null'),
      userId ? queryAll(session, `SELECT AppDefinitionId FROM UserAppInfo WHERE UserId = '${userId}' AND FormFactor = 'Large' LIMIT 1`).catch(() => []) : [],
    ]);
    const currentId = recent[0]?.AppDefinitionId || null;
    return apps
      .map((a) => ({ appId: a.DurableId, app: a.Label, bar: a.UtilityBar, current: !!currentId && a.DurableId === currentId }))
      .sort((a, b) => Number(b.current) - Number(a.current));
  });
}

/** One app's utility bar: { app, page, current, items: [{ id, component, label }] } or null. One Tooling query, cached. */
export function loadUtilityBar(session, appEntry, { refresh = false } = {}) {
  const m = /^(?:([A-Za-z0-9]+)__)?([A-Za-z0-9_]+)$/.exec(appEntry?.bar || '');
  if (!m) return Promise.resolve(null);
  const [, ns, name] = m;
  const where = `DeveloperName = '${name}' AND NamespacePrefix = ${ns ? `'${ns}'` : 'null'}`;
  return cached(utilityBarCache, `${session.host}|${appEntry.bar}`, refresh, () =>
    queryAll(session, `SELECT DeveloperName, MasterLabel, Metadata FROM FlexiPage WHERE ${where} LIMIT 1`, { tooling: true })
  ).then((rows) => (rows[0] ? { app: appEntry.app, page: rows[0].MasterLabel || rows[0].DeveloperName, current: appEntry.current, items: utilityItems(rows[0]) } : null));
}

const metricCache = new Map();

/**
 * Pipeline Inspection metric names an admin set (Pipeline Settings → Metrics Settings): one PipelineInspMetricConfig
 * row per renamed metric, MasterLabel = the name on the tile, Metric = which tile (OpenPipeline, ClosedWon…).
 * UAT2 and DV2, checked live: REST and Tooling both answer. An org without Pipeline Inspection has no such
 * object (dev org: "not supported"): that is an empty list, not an error.
 */
export function loadPipelineMetrics(session, { refresh = false } = {}) {
  return cached(metricCache, session.host, refresh, () =>
    queryAll(session, 'SELECT Id, DeveloperName, MasterLabel, Language, Metric FROM PipelineInspMetricConfig').catch((e) => {
      if (e?.status === 401) throw e;
      if (/not supported|INVALID_TYPE/i.test(e?.message || '')) return [];
      throw e;
    })
  );
}

/**
 * readMetadata Translations response → the renamed Pipeline Inspection metric names in that language:
 * [{ name (DeveloperName), label }]. Translations.pipelineInspMetricConfigs { name, label, description }
 * (Metadata API describeValueType, dev org, Nov 2026). A row with no translation has a comment as its
 * label (<label><!-- Name --></label>) and is left out.
 */
export function parsePipelineMetricTranslations(xml) {
  return xmlBlocks(xml, 'pipelineInspMetricConfigs')
    .map((b) => ({ name: xmlValue(b, 'name'), label: (xmlValue(b, 'label') || '').trim() }))
    .filter((t) => t.name && t.label);
}

const metricTranslationCache = new Map();

/**
 * The renamed metric names translated into `language` (Translation Workbench → Pipeline Inspection Metric
 * Configuration), from the Metadata API readMetadata Translations "<language>". Cached; a failed read is not.
 */
export function loadPipelineMetricTranslations(session, language, { refresh = false } = {}) {
  if (!/^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,4})?$/.test(language || '')) return Promise.resolve(null);
  return cached(metricTranslationCache, `${session.host}|${language}`, refresh, () =>
    soapCall(session, 'metadata', '', `<s:readMetadata><s:type>Translations</s:type><s:fullNames>${language}</s:fullNames></s:readMetadata>`).then(parsePipelineMetricTranslations)
  );
}

/**
 * Identifiers of a record page's tabs that are the Translations tab: the standard title key
 * Standard.Tab.translations, or a title an admin typed as "Translations" (the same text in every language). Pure.
 */
export function translationsTabIds(page) {
  const ids = [];
  for (const region of page?.Metadata?.flexiPageRegions || []) {
    for (const item of region.itemInstances || []) {
      const ci = item.componentInstance;
      if (ci?.componentName !== 'flexipage:tab' || !ci.identifier) continue;
      const title = (ci.componentInstanceProperties || []).find((p) => p.name === 'title')?.value;
      if (title === 'Standard.Tab.translations' || /^\s*translations?\s*$/i.test(title || '')) ids.push(ci.identifier);
    }
  }
  return ids;
}

/**
 * The Translations tab of a record page, by its App Builder identifier (the tab element's data-tab-value).
 * Lightning shows the tab title Standard.Tab.translations in the user's language (dev org, French:
 * "Traductions", a[data-tab-value=flexipage_tab2]), so only the page metadata names it in every language.
 */
export async function loadTranslationsTabIds(session, flexipageTag, objects = []) {
  for (const name of flexiPageNames(flexipageTag, objects)) {
    const page = await loadFlexiPage(session, name);
    if (page) return translationsTabIds(page);
  }
  return [];
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

// ---------- master-language labels (the Translation Workbench lists rows by them) ----------

const XML_ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decodeXml = (s) =>
  String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return XML_ENT[e.toLowerCase()] ?? m;
    const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
const escapeXml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const tagRe = (tag, flags) => new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, flags);
const xmlBlocks = (xml, tag) => [...String(xml || '').matchAll(tagRe(tag, 'g'))].map((m) => m[1]);
const dropBlocks = (xml, tags) => tags.reduce((x, t) => x.replace(tagRe(t, 'g'), ''), String(xml || ''));
function xmlValue(xml, tag) {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:[\\w-]+:)?${tag}>`).exec(String(xml || ''));
  return m ? decodeXml(m[1]) : null;
}

/** One SOAP call (partner API, or the Metadata API with kind 'metadata'). Returns the response XML. */
export async function soapCall(session, kind, header, body) {
  const v = API_VERSION.slice(1);
  const [path, ns] = kind === 'metadata' ? [`/services/Soap/m/${v}`, 'http://soap.sforce.com/2006/04/metadata'] : [`/services/Soap/u/${v}`, 'urn:partner.soap.sforce.com'];
  const envelope =
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:s="${ns}">` +
    `<env:Header><s:SessionHeader><s:sessionId>${escapeXml(session.sid)}</s:sessionId></s:SessionHeader>${header}</env:Header>` +
    `<env:Body>${body}</env:Body></env:Envelope>`;
  const res = await fetch(`https://${session.host}${path}`, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '""' }, body: envelope });
  const text = await res.text();
  if (!res.ok) throw new SfError(res.status, (xmlValue(text, 'faultstring') || text).slice(0, 300));
  return text;
}

/**
 * describeSObject response → the labels the Workbench shows in its first column: object label, field
 * labels, picklist value labels and record type names. Pure, unit tested.
 */
export function parseSoapDescribe(xml) {
  const fields = xmlBlocks(xml, 'fields').map((b) => {
    const own = dropBlocks(b, ['picklistValues', 'filteredLookupInfo', 'referenceTo']);
    return {
      name: xmlValue(own, 'name'),
      label: xmlValue(own, 'label'),
      picklistValues: xmlBlocks(b, 'picklistValues').map((p) => ({ label: xmlValue(p, 'label'), value: xmlValue(p, 'value') })),
    };
  });
  const recordTypeInfos = xmlBlocks(xml, 'recordTypeInfos').map((b) => ({ developerName: xmlValue(b, 'developerName'), name: xmlValue(b, 'name') }));
  const top = dropBlocks(xml, ['fields', 'childRelationships', 'recordTypeInfos', 'supportedScopes', 'namedLayoutInfos', 'actionOverrides', 'urls']);
  const result = xmlBlocks(top, 'result')[0] ?? top;
  return { name: xmlValue(result, 'name'), label: xmlValue(result, 'label'), labelPlural: xmlValue(result, 'labelPlural'), fields: fields.filter((f) => f.name), recordTypeInfos };
}

const masterDescribeCache = new Map();

/**
 * An object's labels in `language` (the org default), whatever the user's language. SOAP describeSObject with
 * the LocaleOptions header (SOAP API Developer Guide: "Specifies the language of the labels returned"); REST
 * describe only answers in the user's language. Returns null when it cannot be read.
 */
export function loadMasterDescribe(session, objectName, language) {
  if (!/^[A-Za-z0-9_]+$/.test(objectName || '') || !/^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,4})?$/.test(language || '')) return Promise.resolve(null);
  const key = `${session.host}|${language}|${objectName}`;
  const hit = masterDescribeCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = soapCall(session, 'partner', `<s:LocaleOptions><s:language>${language}</s:language></s:LocaleOptions>`, `<s:describeSObject><s:sObjectType>${objectName}</s:sObjectType></s:describeSObject>`)
    .then(parseSoapDescribe)
    .then((d) => (d.fields.length ? d : null))
    .catch(() => null);
  masterDescribeCache.set(key, { at: Date.now(), promise });
  return promise;
}

/** readMetadata CustomObjectTranslation response → layout section translations [{ layout, section (master name), label }]. */
export function parseSectionTranslations(xml) {
  return xmlBlocks(xml, 'layouts').flatMap((b) => {
    const layout = xmlValue(dropBlocks(b, ['sections']), 'layout');
    return xmlBlocks(b, 'sections')
      .map((s) => ({ layout, section: xmlValue(s, 'section'), label: xmlValue(s, 'label') }))
      .filter((s) => s.section && s.label);
  });
}

/** Validation rule messages in a CustomObjectTranslation: [{ name, errorMessage }]. */
export function parseValidationTranslations(xml) {
  return xmlBlocks(xml, 'validationRules')
    .map((b) => ({ name: xmlValue(b, 'name'), errorMessage: xmlValue(b, 'errorMessage') }))
    .filter((v) => v.name && v.errorMessage);
}

const sectionCache = new Map();

/**
 * Page layout section names translated into `language` for one object (Metadata API readMetadata
 * CustomObjectTranslation "<Object>-<language>", as read in the dev org for SFTL_Widget__c-de). The
 * Workbench Layout Section tree lists sections by their master name. Returns [] when it cannot be read.
 */
export function loadSectionTranslations(session, objectName, language) {
  return loadObjectTranslation(session, objectName, language).then((t) => t.sections);
}

/**
 * One object's CustomObjectTranslation in `language` (Metadata API readMetadata, cached): its layout
 * section names and validation rule messages. Both are empty when it cannot be read (needs Modify Metadata
 * or Modify All Data).
 */
export function loadObjectTranslation(session, objectName, language) {
  const none = { sections: [], validationRules: [] };
  if (!/^[A-Za-z0-9_]+$/.test(objectName || '') || !/^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,4})?$/.test(language || '')) return Promise.resolve(none);
  const key = `${session.host}|${language}|${objectName}`;
  const hit = sectionCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = soapCall(session, 'metadata', '', `<s:readMetadata><s:type>CustomObjectTranslation</s:type><s:fullNames>${objectName}-${language}</s:fullNames></s:readMetadata>`)
    .then((xml) => ({ sections: parseSectionTranslations(xml), validationRules: parseValidationTranslations(xml) }))
    .catch(() => none);
  sectionCache.set(key, { at: Date.now(), promise });
  return promise;
}

/**
 * Describe + quick actions for one object. Returns null if the object is not visible.
 * Its labels are in the user's language, so the cache keeps one copy per `language`.
 */
export function loadDescribe(session, objectName, { refresh = false, language = null } = {}) {
  const key = `${session.host}|${language || ''}|${objectName}`;
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
