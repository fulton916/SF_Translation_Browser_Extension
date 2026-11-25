// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Missing-translations report page (issue #14), opened from the toolbar popup with ?org=<Salesforce origin>.
// Reads only (reportApi.js). "Go to translation" opens the same screens as the panel button (buildGotoUrl),
// and content.js auto-fills them from the same pending entry background.js writes.

import { getSession } from './sfApi.js';
import { buildGotoUrl, languageName } from './locator.js';
import { loadMissingTranslations } from './reportApi.js';
import { ITEM_TYPES, masterItems, sortItems, toCsv } from './report.js';

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
let masters = []; // the org default language's rows (masterItems)
let shownCount = PAGE_SIZE;
let sort = { key: null, dir: 'asc' }; // column header clicks: A to Z, Z to A, then the report order

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
  if (!report.items.length) return;
  masters = masterItems(report.items, report.orgDefault);
  const langSel = $('f-lang');
  const keep = langSel.value;
  langSel.replaceChildren(
    new Option('All languages', ''),
    new Option(`${languageName(report.orgDefault) || report.orgDefault} (org default)`, report.orgDefault),
    ...report.languages.map((l) => new Option(l.name, l.code))
  );
  if ([...langSel.options].some((o) => o.value === keep)) langSel.value = keep;
  const types = ITEM_TYPES.filter((t) => report.items.some((i) => i.type === t));
  $('f-type').replaceChildren(new Option('All types', ''), ...types.map((t) => new Option(t, t)));
  $('filters').hidden = false;
  $('table-wrap').hidden = false;
  shownCount = PAGE_SIZE;
  renderRows();
}

/** The org default language is chosen: its rows are the master texts, so the Show filter does not apply. */
const masterChosen = () => !!report && $('f-lang').value === report.orgDefault;

function filtered() {
  const lang = $('f-lang').value;
  const type = $('f-type').value;
  const show = masterChosen() ? 'all' : $('f-show').value;
  const q = $('f-text').value.trim().toLowerCase();
  const rows = (masterChosen() ? masters : report.items).filter(
    (i) =>
      (!lang || i.language === lang) &&
      (show === 'all' || (show === 'missing') === !i.translated) &&
      (!type || i.type === type) &&
      (!q || [i.objectLabel, i.object, i.name, i.master, i.translation].some((v) => String(v || '').toLowerCase().includes(q)))
  );
  return sortItems(rows, sort.key, sort.dir, languageNames());
}

const languageNames = () => Object.fromEntries([[report.orgDefault, languageName(report.orgDefault) || report.orgDefault], ...report.languages.map((l) => [l.code, l.name])]);

/** Header buttons: show the sorted column and its direction. */
function showSort() {
  for (const b of document.querySelectorAll('th button.sort')) {
    const on = b.dataset.key === sort.key;
    b.parentElement.setAttribute('aria-sort', on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    b.dataset.arrow = on ? (sort.dir === 'asc' ? '▲' : '▼') : '';
    const col = b.textContent;
    b.title = on && sort.dir === 'asc' ? `${col}: sorted A to Z. Click for Z to A` : on ? `${col}: sorted Z to A. Click for the report order` : `Sort by ${col}, A to Z`;
  }
}

function renderRows() {
  const items = filtered();
  const names = new Map(report.languages.map((l) => [l.code, l.name]));
  names.set(report.orgDefault, languageName(report.orgDefault) || report.orgDefault);
  const page = items.slice(0, shownCount);
  const show = $('f-show');
  show.disabled = masterChosen();
  show.title = show.disabled ? 'The org default language holds the master texts: nothing is missing there.' : '';
  const missingCount = items.filter((i) => !i.translated).length;
  $('shown').textContent = `${items.length} ${items.length === 1 ? 'row' : 'rows'}${missingCount && missingCount < items.length ? `, ${missingCount} missing` : ''}`;
  $('rows').replaceChildren(
    ...page.map((i) => {
      const tr = el('tr');
      tr.append(
        el('td', null, names.get(i.language) || i.language),
        el('td', null, i.type),
        el('td', null, i.objectLabel || ''),
        el('td', 'api', i.name),
        el('td', 'master', i.master),
        i.translated ? el('td', 'master', i.translation) : el('td', 'missing', 'Missing')
      );
      const td = el('td', 'go');
      tr.append(td);
      if (!i.goto) return tr;
      const go = el('button', null, i.translated ? 'Open translation' : 'Go to translation');
      go.title = buildGotoUrl(i.goto, i.language, report.orgDefault) ? 'Opens the translation screen and fills in what it can' : '';
      go.addEventListener('click', () => goTo(i, go));
      td.append(go);
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

/** The rows that match the filter, as a CSV file (saved by the browser; nothing is sent anywhere). */
function exportCsv() {
  const items = filtered();
  const names = languageNames();
  const pageOf = (i) => {
    const built = i.goto && buildGotoUrl(i.goto, i.language, report.orgDefault);
    return built ? origin + built.path : '';
  };
  const url = URL.createObjectURL(new Blob([toCsv(items, { languageNames: names, pageOf })], { type: 'text/csv;charset=utf-8' }));
  const a = el('a');
  a.href = url;
  const prefix = !masterChosen() && $('f-show').value === 'missing' ? 'missing-translations' : 'translations';
  a.download = `${prefix}-${new URL(origin).hostname.split('.')[0]}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  log('info', `Report: exported ${items.length} rows as CSV`);
}

$('run').addEventListener('click', run);
$('csv').addEventListener('click', exportCsv);
for (const id of ['f-lang', 'f-show', 'f-type']) $(id).addEventListener('change', () => ((shownCount = PAGE_SIZE), renderRows()));
for (const b of document.querySelectorAll('th button.sort')) {
  b.addEventListener('click', () => {
    const key = b.dataset.key;
    sort = sort.key !== key ? { key, dir: 'asc' } : sort.dir === 'asc' ? { key, dir: 'desc' } : { key: null, dir: 'asc' };
    showSort();
    if (report) ((shownCount = PAGE_SIZE), renderRows());
  });
}
showSort();
$('f-text').addEventListener('input', () => ((shownCount = PAGE_SIZE), renderRows()));

if (origin) run();
else notice('error', 'Open this report from the extension button on a Salesforce tab.');
