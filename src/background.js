import { getSession, loadOrgData, loadUserLanguage, loadDescribe, loadDataTranslation, loadLabelTranslations, loadFlexiPageComponent, loadNearestFlexiPageComponent, loadFlowScreens, loadValueSet, loadRecordTypeId, loadMasterDescribe, loadObjectTranslation } from './sfApi.js';
import { locate, contextObjects, buildGotoUrl, normalize, matchType, detectAreas } from './locator.js';
import { addEntry, getEntries, formatEntries } from './logStore.js';

// ---------- test log (viewer: click the toolbar icon) ----------
const pathOf = (url) => {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return '';
  }
};
function log(level, where, message, extra = {}) {
  return addEntry({ level, where, message, ...extra });
}
self.addEventListener('error', (e) => log('error', 'background', e.message || 'Script error', { stack: e.error?.stack }));
self.addEventListener('unhandledrejection', (e) =>
  log('error', 'background', e.reason?.message || String(e.reason), { stack: e.reason?.stack })
);
// Next to the tab it was opened from, in that tab's window (not the last-focused window).
const openLog = (fromTab) =>
  chrome.tabs.create({
    url: chrome.runtime.getURL('src/log.html'),
    ...(fromTab?.windowId != null ? { windowId: fromTab.windowId } : {}),
    ...(fromTab?.index != null ? { index: fromTab.index + 1 } : {}),
  });
chrome.action.onClicked.addListener(openLog);

const MENU_SELECTION = 'sftl-selection';
const MENU_ELEMENT = 'sftl-element';
const SF_PAGES = ['https://*.force.com/*', 'https://*.my.salesforce.com/*', 'https://*.my.salesforce-setup.com/*'];

// ---------- dev only: reload after a code change (`npm run dev`, see dev/reload-server.mjs) ----------
// Off unless the dev server wrote dev.json next to manifest.json: that file is gitignored and not in
// the zip, so a normal install never polls anything.
const DEV_ALARM = 'sftl-dev-reload';
/** The dev server's port from dev.json, or null when there is no dev.json (a normal install). */
async function devPort() {
  try {
    return (await (await fetch(chrome.runtime.getURL('dev.json'), { cache: 'no-store' })).json()).port || null;
  } catch {
    return null;
  }
}
async function devVersion() {
  const port = await devPort();
  if (!port) return null;
  try {
    return (await (await fetch(`http://127.0.0.1:${port}/__version`, { cache: 'no-store' })).json()).v || null;
  } catch {
    return null;
  }
}
async function devCheck() {
  const v = await devVersion();
  // Server down but dev.json still there (it was killed, not stopped with Ctrl+C): keep checking, so a
  // restarted server works again without a manual reload. Ctrl+C removes dev.json and ends the checks.
  if (!v) return (await devPort()) ? undefined : chrome.alarms.clear(DEV_ALARM);
  const { devV } = await chrome.storage.session.get('devV');
  if (!devV) return chrome.storage.session.set({ devV: v });
  if (devV !== v) {
    await log('info', 'dev', 'Code changed on disk: reloading the extension');
    chrome.runtime.reload();
  }
}
// Alarms survive the worker going idle (a timer would not). Minimum period is 30 s.
devPort().then(async (port) => {
  if (port && !(await chrome.alarms.get(DEV_ALARM))) chrome.alarms.create(DEV_ALARM, { periodInMinutes: 0.5 });
});
chrome.alarms.onAlarm.addListener((a) => a.name === DEV_ALARM && devCheck());
// After a reload: remember the loaded version, and give open Salesforce tabs the new content script
// without refreshing them (a refresh could lose what someone typed). content.js skips a live copy.
async function devAfterReload() {
  const v = await devVersion();
  if (!v) return;
  await chrome.storage.session.set({ devV: v });
  for (const t of await chrome.tabs.query({ url: SF_PAGES })) {
    chrome.scripting
      .executeScript({ target: { tabId: t.id, allFrames: true }, files: ['src/pointerTarget.js', 'src/waitUntil.js', 'src/content.js'] })
      .catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(() => {
  devAfterReload();
  // Callbacks read lastError so a failure is logged, not listed as "Unchecked runtime.lastError".
  const checked = (what) => () => {
    const err = chrome.runtime.lastError;
    if (err) log('error', 'setup', `${what}: ${err.message}`);
  };
  chrome.contextMenus.removeAll(() => {
    checked('Clear menus')();
    chrome.contextMenus.create(
      { id: MENU_SELECTION, title: 'Find Salesforce translation for "%s"', contexts: ['selection'], documentUrlPatterns: SF_PAGES },
      checked('Create selection menu')
    );
    chrome.contextMenus.create(
      { id: MENU_ELEMENT, title: 'Find Salesforce translation for this text', contexts: ['page', 'link', 'image', 'editable'], documentUrlPatterns: SF_PAGES },
      checked('Create element menu')
    );
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id || ![MENU_SELECTION, MENU_ELEMENT].includes(info.menuItemId)) return;
  findTranslation(tab, info.frameId ?? 0, info.selectionText, info.frameUrl);
});

// Alt+Shift+T in the page (content.js): same lookup as the right-click menu.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'sftl:shortcut' && sender.tab?.id) findTranslation(sender.tab, sender.frameId ?? 0, msg.selectionText, sender.url);
});

async function findTranslation(tab, frameId, selectionText, frameUrl) {
  const target = (await sendToFrame(tab.id, frameId, { type: 'sftl:getTarget' })) || {};
  const text = (selectionText || target.text || '').trim();

  if (!text) {
    log('warn', 'lookup', 'No text found under the right-click', { page: pathOf(tab.url) });
    await showPanel(tab.id, { state: 'error', text: '', message: 'No text found. Highlight a word or phrase and try again.' });
    return;
  }
  await showPanel(tab.id, { state: 'loading', text });
  try {
    const result = await lookup({ text, hints: target.hints || {}, urls: [tab.url, frameUrl, target.url] });
    logLookup(text, tab.url, target.hints, result);
    await showPanel(tab.id, { state: 'results', text, ...result });
  } catch (e) {
    log('error', 'lookup', e.message || String(e), { page: pathOf(tab.url), details: { text, hints: target.hints }, stack: e.stack });
    await showPanel(tab.id, { state: 'error', text, message: e.message || String(e) });
  }
}

// ---------- "Go to translation": open the exact page, then content.js auto-fills it ----------

// Long enough to click "Go to translation", switch to another tab, and come back later.
const PENDING_TTL_MS = 30 * 60 * 1000;
const pendingKey = (tabId) => `pending:${tabId}`;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'sftl:goto' && sender.tab) {
    openTranslation(msg, sender.tab).then(sendResponse, (e) => {
      log('error', 'go-to-translation', e.message, { page: pathOf(sender.tab.url), details: { goto: msg.goto, lang: msg.lang }, stack: e.stack });
      sendResponse({ error: e.message });
    });
    return true;
  }
  if (msg?.type === 'sftl:log') {
    log(msg.level, msg.where || 'page', msg.message, { page: pathOf(sender.url || sender.tab?.url), details: msg.details, stack: msg.stack });
    return;
  }
  if (msg?.type === 'sftl:getLog') {
    getEntries().then((all) => sendResponse({ text: formatEntries(all.slice(-(msg.limit || 15)), chrome.runtime.getManifest().version) }));
    return true;
  }
  if (msg?.type === 'sftl:openLog') {
    openLog(sender.tab);
    return;
  }
  if (msg?.type === 'sftl:pending' && sender.tab) {
    const key = pendingKey(sender.tab.id);
    chrome.storage.session.get(key).then((r) => {
      const p = r[key];
      sendResponse(p && Date.now() - p.created < PENDING_TTL_MS ? p : null);
    });
    return true;
  }
  if (msg?.type === 'sftl:pendingUpdate' && sender.tab) {
    const key = pendingKey(sender.tab.id);
    chrome.storage.session.get(key).then((r) => {
      const next = msg.done ? null : { ...(r[key] || {}), ...msg.patch };
      (next ? chrome.storage.session.set({ [key]: next }) : chrome.storage.session.remove(key)).then(() => sendResponse({ ok: true }));
    });
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(pendingKey(tabId)));

async function openTranslation({ goto, lang, orgDefault }, fromTab) {
  const built = buildGotoUrl(goto, lang, orgDefault);
  if (!built) throw new Error('No direct page for this result.');
  const origin = new URL(fromTab.url).origin;
  const tab = await chrome.tabs.create({ url: origin + built.path, index: fromTab.index + 1, openerTabId: fromTab.id });
  if (built.autofill) {
    await chrome.storage.session.set({ [pendingKey(tab.id)]: { ...built.autofill, created: Date.now() } });
  }
  log('info', 'go-to-translation', `Opened ${built.path.split('?')[0]}${built.autofill ? ' (auto-fill: ' + built.autofill.page + ')' : ''}`, {
    page: pathOf(fromTab.url),
    details: { goto, lang: lang || null, autofill: built.autofill },
  });
  return {
    ok: true,
    note: built.masterEdit ? 'This is the label\'s own language, so this opens the label itself. Click Edit to change its Value (the original text).' : null,
  };
}

// Panel "Refresh" button re-runs the lookup without the cache.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'sftl:refresh' || !sender.tab?.id) return;
  const tabId = sender.tab.id;
  showPanel(tabId, { state: 'loading', text: msg.text });
  lookup({ text: msg.text, hints: msg.hints || {}, urls: [sender.tab.url], refresh: true })
    .then((r) => {
      logLookup(msg.text, sender.tab.url, msg.hints, r);
      return showPanel(tabId, { state: 'results', text: msg.text, ...r });
    })
    .catch((e) => {
      log('error', 'lookup', e.message, { page: pathOf(sender.tab.url), details: { text: msg.text, refresh: true }, stack: e.stack });
      return showPanel(tabId, { state: 'error', text: msg.text, message: e.message });
    });
  sendResponse({ ok: true });
});

function logLookup(text, url, hints, result) {
  const top = (result.results || []).slice(0, 5).map((r) => `${r.confidence} | ${r.source} | ${r.title}`);
  log(result.results?.length ? 'info' : 'warn', 'lookup', `"${text}": ${result.results?.length || 0} result(s)`, {
    page: pathOf(url),
    details: { objects: result.contextObjects, selectionNames: hints?.selectionNames, top, hidden: result.droppedPartial || 0 },
  });
  for (const w of result.warnings || []) log('warn', 'lookup', w, { page: pathOf(url) });
}

async function lookup({ text, hints, urls, refresh = false }) {
  const session = await getSession(urls[0]);
  const objects = contextObjects(urls, hints);
  // The user's language now (one small call, cached 15 s): labels read in another language are read again.
  const language = await loadUserLanguage(session, { refresh });
  const [org, ...describes] = await Promise.all([
    loadOrgData(session, { refresh, language }),
    ...objects.map((o) => loadDescribe(session, o, { refresh, language })),
  ]);
  // Record page (/lightning/r/Product2/01t.../view): check Data Translation for that record.
  const rec = urls.map((u) => /\/lightning\/r\/([A-Za-z0-9_]+)\/([a-zA-Z0-9]{15,18})\//.exec(u || '')).find(Boolean);
  const dataTranslations = (
    await Promise.all(
      objects.map((o) => loadDataTranslation(session, org, o, rec && rec[1] === o ? rec[2] : null).catch(() => null))
    )
  ).filter(Boolean);
  // Label translations are searched per lookup (too many to cache in big orgs).
  const needle = normalize(text);
  const labelIds = (org.customLabels || []).filter((l) => matchType(needle, l.Value)).map((l) => l.Id);
  let labelTranslations = null;
  const warnings = [...(org.warnings || [])];
  if (org.customLabels) {
    // Drop a card's record count ("Demo Gadgets (0)"), as normalize() does.
    labelTranslations = await loadLabelTranslations(session, text.replace(/\s*\(\d+\+?\)\s*$/, ''), labelIds).catch((e) => {
      warnings.push(`Custom label translations not searched: ${e.message || e}`);
      return null;
    });
  }
  const record = rec ? { object: rec[1], id: rec[2] } : null;
  // Paths belong to one record type: read the record's type only when it can matter (one REST call, cached).
  if (record && (org.paths || []).some((p) => p.IsActive !== false && p.SobjectType === record.object && p.RecordTypeId)) {
    record.recordTypeId = await loadRecordTypeId(session, record.object, record.id, { refresh });
  }
  // Lightning App Builder text read from the page metadata: a Dynamic Forms field section label, a
  // related list title (header only, not its rows), or a record page tab title. The nearest component
  // id is the clicked one (content.js lists them nearest first).
  let pageComponent = null;
  const areas = detectAreas(hints);
  // A flow on a Lightning page: the Flow component names the flow (flowruntime:interview, prop flowName).
  const wantsPage = areas.has('fieldSection') || areas.has('relatedList') || areas.has('lightningPageTab') || areas.has('flow');
  if (wantsPage && hints.flexipage && hints.componentIds?.length) {
    // A component of another kind (e.g. the tab set around a field section) says nothing about this text:
    // skip it and keep looking further out.
    const expect = areas.has('flow')
      ? /^flowruntime:interview$/
      : areas.has('fieldSection')
        ? /^flexipage:fieldSection$/
        : areas.has('relatedList')
          ? /^(lst:dynamicRelatedList|force:relatedListSingleContainer)$/
          : /^flexipage:tab$/;
    pageComponent = await loadNearestFlexiPageComponent(session, hints.flexipage, hints.componentIds, objects, expect).catch((e) => {
      warnings.push(`Lightning page not read: ${e.message}`);
      return null;
    });
    // The flow's screens (active version), so the card can name the screen and component of this text.
    if (pageComponent?.props?.flowName) pageComponent = { ...pageComponent, flow: await loadFlowScreens(session, pageComponent.props.flowName) };
  }
  // The standard Related Lists component (force:relatedListContainer, one card per page layout related list)
  // holds no list of its own in the page metadata: the title's link names the relationship (content.js).
  if (areas.has('relatedList') && !pageComponent && /^[A-Za-z0-9_]+$/.test(hints.relatedListApi || '')) {
    pageComponent = { page: null, id: null, component: 'force:relatedListSingleContainer', label: null, props: { relatedListApiName: hints.relatedListApi } };
  }
  const liveDescribes = describes.filter(Boolean);
  const parentDescribe = liveDescribes.find((d) => d.name === record?.object) || liveDescribes[0];
  // Custom related list title (relatedListApiName …__r, no label of its own): its Related List Label is on
  // the child object's lookup field (e.g. Demo_Contracts__r → Contract.Demo_Opportunity__c).
  const api = pageComponent?.props?.relatedListApiName;
  if (areas.has('relatedList') && !String(pageComponent?.label ?? '').trim() && /__r$/.test(api || '')) {
    const child = await relatedChild(session, parentDescribe, api, refresh, language);
    if (child) pageComponent = { ...pageComponent, child: { ...child.rel, fieldLabel: child.field?.label || null, objectLabel: child.describe?.label || null } };
  }
  // Inside related list rows ("Stage:" in Opportunities on an Account): the rows are the child
  // object's records, so its field labels are searched too.
  let listObject = null;
  const listComponentId = (hints.componentIds || []).find((c) => /^(lst_|force_relatedList)/.test(c));
  if (areas.has('relatedListRow') && hints.flexipage && listComponentId) {
    const pc = await loadFlexiPageComponent(session, hints.flexipage, listComponentId, objects).catch(() => null);
    const child = pc?.props?.relatedListApiName ? await relatedChild(session, parentDescribe, pc.props.relatedListApiName, refresh, language) : null;
    if (child?.describe) {
      listObject = child.describe.name;
      if (!liveDescribes.some((d) => d.name === listObject)) liveDescribes.push(child.describe);
    }
  }
  // Global Value Sets: only for the custom picklists this text can be about (each costs 2-3 Tooling queries).
  // A standard picklist the user pointed at: its StandardValueSet (all values, inactive ones too), so a value
  // that is in no list is confirmed (R-07: Opportunity Lead Source "Example Referral").
  const valueSets = {};
  const hinted = new Set((hints.selectionNames || []).map((s) => /^sfdc:RecordField\.(.+)$/.exec(s)?.[1]).filter(Boolean));
  const picklistFields = [];
  for (const d of liveDescribes) {
    for (const f of d.fields || []) {
      if (!/picklist/.test(f.type || '') || f.name === 'CurrencyIsoCode') continue;
      const isHinted = hinted.has(`${d.name}.${f.name}`);
      if (!f.custom && !isHinted) continue;
      if (isHinted || (f.picklistValues || []).some((pv) => matchType(needle, pv.label) === 'exact')) picklistFields.push([d.name, f.name]);
    }
  }
  // Pointed-at fields first, so the 4-field cap never drops them.
  picklistFields.sort((a, b) => Number(!hinted.has(a.join('.'))) - Number(!hinted.has(b.join('.'))));
  await Promise.all(
    picklistFields.slice(0, 4).map(([o, f]) =>
      loadValueSet(session, o, f).then((vs) => {
        if (vs) valueSets[`${o}.${f}`] = vs;
      })
    )
  );
  // Viewing another language than the org default: describes hold translated labels, but Translation
  // Workbench lists its rows by the master label (dev org, French: "Find the row: Couleur de peinture" for the
  // row Paint Color). Read the master labels of the objects in play, and the page layout section names.
  let masterDescribes = null;
  let sectionTranslations = null;
  let validationTranslations = null;
  if (org.userLanguage && org.defaultLanguage && org.userLanguage !== org.defaultLanguage) {
    const names = [...new Set([...liveDescribes.map((d) => d.name), pageComponent?.child?.childSObject].filter(Boolean))].slice(0, 4);
    const [masters, sections] = await Promise.all([
      Promise.all(names.map((n) => loadMasterDescribe(session, n, org.defaultLanguage))),
      (areas.has('layoutSection') || hints.fieldPart === 'error') && objects[0] ? loadObjectTranslation(session, objects[0], org.userLanguage) : null,
    ]);
    masterDescribes = Object.fromEntries(names.map((n, i) => [n, masters[i]]).filter(([, m]) => m));
    sectionTranslations = sections?.sections || null;
    validationTranslations = sections?.validationRules || null;
  }
  const located = locate({ text, hints, org: { ...org, labelTranslations, valueSets, masterDescribes, sectionTranslations, validationTranslations }, describes: liveDescribes, dataTranslations, record, pageUrls: urls, pageComponent, listObject });
  return {
    ...located,
    hints,
    contextObjects: listObject && !objects.includes(listObject) ? [...objects, listObject] : objects,
    warnings,
    language: { user: org.userLanguage, orgDefault: org.defaultLanguage },
  };
}

/** The child relationship a related list shows (relationshipName = relatedListApiName), with the child describe. */
async function relatedChild(session, parent, relationshipName, refresh, language) {
  const rel = (parent?.childRelationships || []).find((c) => c.relationshipName === relationshipName);
  if (!rel) return null;
  const describe = await loadDescribe(session, rel.childSObject, { refresh, language });
  return { rel, describe, field: describe?.fields?.find((f) => f.name === rel.field) || null };
}

async function sendToFrame(tabId, frameId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId });
  } catch {
    // Tab was open before the extension loaded: inject the content script now.
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['src/pointerTarget.js', 'src/waitUntil.js', 'src/content.js'] });
      return await chrome.tabs.sendMessage(tabId, msg, { frameId });
    } catch {
      return null;
    }
  }
}

function showPanel(tabId, payload) {
  return sendToFrame(tabId, 0, { type: 'sftl:showPanel', payload });
}
