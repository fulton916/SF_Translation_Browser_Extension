// Missing-translations report page (issue #14), opened from the toolbar popup with ?org=<Salesforce origin>.
// Reads only (reportApi.js). "Go to translation" opens the same screens as the panel button (buildGotoUrl),
// and content.js auto-fills them from the same pending entry background.js writes.

import { getSession } from './sfApi.js';
import { buildGotoUrl } from './locator.js';
import { loadMissingTranslations } from './reportApi.js';
import { ITEM_TYPES } from './report.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 500;
const PENDING_PREFIX = 'pending:'; // background.js pendingKey(tabId): `pending:${tabId}`

const origin = (() => {
  try {
    const o = new URL(new URLSearchParams(location.search).get('org') || '').origin;
    return /^https:\/\/[^/]+\.(force\.com|salesforce\.com|salesforce-setup\.com)$/.test(o) ? o : null;
  } catch {
    return null;
  }
})();

let report = null;
let shownCount = PAGE_SIZE;

const log = (level, message, details) => chrome.runtime.sendMessage({ type: 'sftl:log', level, where: 'report', message, details }).catch(() => {});

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function notice(level, text) {
  $('notices').append(el('div', `notice ${level}`, text));
}

async function run() {
  $('run').disabled = true;
  $('notices').replaceChildren();
  $('langs').replaceChildren();
  $('filters').hidden = true;
  $('table-wrap').hidden = true;
  report = null;
  const started = Date.now();
  try {
    const session = await getSession(origin + '/');
    $('org').textContent = `${session.host} · Reads only: nothing in the org changes.`;
    report = await loadMissingTranslations(session, { onProgress: (t) => ($('status').textContent = t) });
    const secs = Math.round((Date.now() - started) / 1000);
    $('status').textContent = `Read in ${secs} s, ${new Date().toLocaleTimeString()}.`;
    log(report.warnings.length ? 'warn' : 'info', `Report: ${report.languages.map((l) => `${l.code} ${l.missing} of ${l.checked} missing`).join(', ') || 'no active languages'}`, {
      seconds: secs,
      warnings: report.warnings,
    });
    render();
  } catch (e) {
    $('status').textContent = '';
    notice('error', e.message || String(e));
    log('error', e.message || String(e));
  } finally {
    $('run').disabled = false;
  }
}

function render() {
  for (const w of report.warnings) notice('warn', w);
  if (!report.languages.length) {
    notice('warn', 'No active languages besides the org default. Setup → Translation Language Settings adds and activates them.');
    return;
  }
  $('langs').replaceChildren(
    ...report.languages.map((l) => {
      const card = el('div', 'lang');
      card.append(el('h2', null, `${l.name} (${l.code})`));
      const big = el('div', `big${l.missing ? '' : ' done'}`, l.missing ? `${l.missing} missing` : 'All translated');
      card.append(big, el('div', 'status', `${l.checked - l.missing} of ${l.checked} items translated`));
      const ul = el('ul');
      for (const t of ITEM_TYPES) if (l.byType[t]) ul.append(el('li', null, `${t}: ${l.byType[t]}`));
      card.append(ul);
      return card;
    })
  );
  if (!report.missing.length) return;
  const langSel = $('f-lang');
  langSel.replaceChildren(new Option('All languages', ''), ...report.languages.filter((l) => l.missing).map((l) => new Option(l.name, l.code)));
  const types = ITEM_TYPES.filter((t) => report.missing.some((i) => i.type === t));
  $('f-type').replaceChildren(new Option('All types', ''), ...types.map((t) => new Option(t, t)));
  $('filters').hidden = false;
  $('table-wrap').hidden = false;
  shownCount = PAGE_SIZE;
  renderRows();
}

function filtered() {
  const lang = $('f-lang').value;
  const type = $('f-type').value;
  const q = $('f-text').value.trim().toLowerCase();
  return report.missing.filter(
    (i) =>
      (!lang || i.language === lang) &&
      (!type || i.type === type) &&
      (!q || [i.objectLabel, i.object, i.name, i.master].some((v) => String(v || '').toLowerCase().includes(q)))
  );
}

function renderRows() {
  const items = filtered();
  const names = new Map(report.languages.map((l) => [l.code, l.name]));
  const page = items.slice(0, shownCount);
  $('shown').textContent = items.length === report.missing.length ? `${items.length} missing` : `${items.length} of ${report.missing.length} missing`;
  $('rows').replaceChildren(
    ...page.map((i) => {
      const tr = el('tr');
      tr.append(
        el('td', null, names.get(i.language) || i.language),
        el('td', null, i.type),
        el('td', null, i.objectLabel || ''),
        el('td', 'api', i.name),
        el('td', 'master', i.master)
      );
      const go = el('button', null, 'Go to translation');
      go.title = buildGotoUrl(i.goto, i.language, report.orgDefault) ? 'Opens the translation screen and fills in what it can' : '';
      go.addEventListener('click', () => goTo(i, go));
      const td = el('td', 'go');
      td.append(go);
      tr.append(td);
      return tr;
    })
  );
  const more = $('more-wrap');
  more.replaceChildren();
  if (!items.length) more.append(el('div', 'empty', 'Nothing matches the filter.'));
  else if (items.length > page.length) {
    const b = el('button', 'more', `Show ${Math.min(PAGE_SIZE, items.length - page.length)} more (${items.length - page.length} not shown)`);
    b.addEventListener('click', () => {
      shownCount += PAGE_SIZE;
      renderRows();
    });
    more.append(b);
  }
}

/** Same as background.js openTranslation, from this page: open the screen next to this tab and leave the auto-fill entry. */
async function goTo(item, button) {
  const built = buildGotoUrl(item.goto, item.language, report.orgDefault);
  if (!built) return;
  button.disabled = true;
  try {
    const me = await chrome.tabs.getCurrent();
    const tab = await chrome.tabs.create({ url: origin + built.path, ...(me ? { index: me.index + 1, openerTabId: me.id } : {}) });
    if (built.autofill) await chrome.storage.session.set({ [PENDING_PREFIX + tab.id]: { ...built.autofill, created: Date.now() } });
    log('info', `Report: opened ${built.path.split('?')[0]}${built.autofill ? ` (auto-fill: ${built.autofill.page})` : ''}`, { type: item.type, name: item.name, lang: item.language });
  } catch (e) {
    notice('error', `Go to translation: ${e.message || e}`);
    log('error', `Go to translation: ${e.message || e}`, { type: item.type, name: item.name });
  } finally {
    button.disabled = false;
  }
}

$('run').addEventListener('click', run);
for (const id of ['f-lang', 'f-type']) $(id).addEventListener('change', () => ((shownCount = PAGE_SIZE), renderRows()));
$('f-text').addEventListener('input', () => ((shownCount = PAGE_SIZE), renderRows()));

if (origin) run();
else notice('error', 'Open this report from the extension button on a Salesforce tab.');
