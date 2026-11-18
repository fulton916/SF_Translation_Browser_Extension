import { getSession, loadOrgData, loadDescribe, loadDataTranslation, loadLabelTranslations, loadFlexiPageComponent } from './sfApi.js';
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
const openLog = () => chrome.tabs.create({ url: chrome.runtime.getURL('src/log.html') });
chrome.action.onClicked.addListener(openLog);

const MENU_SELECTION = 'sftl-selection';
const MENU_ELEMENT = 'sftl-element';
const SF_PAGES = ['https://*.force.com/*', 'https://*.my.salesforce.com/*', 'https://*.my.salesforce-setup.com/*'];

chrome.runtime.onInstalled.addListener(() => {
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
    openLog();
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
  const [org, ...describes] = await Promise.all([
    loadOrgData(session, { refresh }),
    ...objects.map((o) => loadDescribe(session, o, { refresh })),
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
    labelTranslations = await loadLabelTranslations(session, text, labelIds).catch((e) => {
      warnings.push(`Custom label translations not searched: ${e.message || e}`);
      return null;
    });
  }
  const record = rec ? { object: rec[1], id: rec[2] } : null;
  // Dynamic Forms field section: read its label from the Lightning page metadata.
  let pageComponent = null;
  if (detectAreas(hints).has('fieldSection') && hints.flexipage && hints.componentIds?.length) {
    pageComponent = await loadFlexiPageComponent(session, hints.flexipage, hints.componentIds[0], objects).catch((e) => {
      warnings.push(`Lightning page not read: ${e.message}`);
      return null;
    });
  }
  const located = locate({ text, hints, org: { ...org, labelTranslations }, describes: describes.filter(Boolean), dataTranslations, record, pageUrls: urls, pageComponent });
  return {
    ...located,
    hints,
    contextObjects: objects,
    warnings,
    language: { user: org.userLanguage, orgDefault: org.defaultLanguage },
  };
}

async function sendToFrame(tabId, frameId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId });
  } catch {
    // Tab was open before the extension loaded: inject the content script now.
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['src/content.js'] });
      return await chrome.tabs.sendMessage(tabId, msg, { frameId });
    } catch {
      return null;
    }
  }
}

function showPanel(tabId, payload) {
  return sendToFrame(tabId, 0, { type: 'sftl:showPanel', payload });
}
