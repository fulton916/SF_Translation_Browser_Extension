import { LOG_KEY, getEntries, clearEntries, formatEntries } from './logStore.js';

const $ = (id) => document.getElementById(id);
const version = chrome.runtime.getManifest().version;
let entries = [];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function visible() {
  return $('only-problems').checked ? entries.filter((e) => e.level !== 'info') : entries;
}

function render() {
  const list = $('list');
  const shown = visible();
  const n = (lvl) => entries.filter((e) => e.level === lvl).length;
  $('counts').textContent = `${n('error')} errors · ${n('warn')} warnings · ${n('info')} info`;
  if (!shown.length) {
    list.replaceChildren(el('div', 'empty', entries.length ? 'No errors or warnings.' : 'Nothing logged yet. Right-click text in Salesforce to start.'));
    return;
  }
  list.replaceChildren(
    ...[...shown].reverse().map((e) => {
      const card = el('div', `entry ${e.level}`);
      const top = el('div', 'top');
      top.append(
        el('span', `lvl ${e.level}`, e.level),
        el('span', 'time', new Date(e.at).toLocaleString()),
        el('span', 'where', e.where),
        el('span', 'msg', e.message)
      );
      card.append(top);
      if (e.page) card.append(el('div', 'page', e.page));
      if (e.details) card.append(el('pre', '', pretty(e.details)));
      if (e.stack) card.append(el('pre', '', e.stack));
      return card;
    })
  );
}

function pretty(s) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function flash(msg) {
  $('status').textContent = msg;
  setTimeout(() => ($('status').textContent = ''), 2500);
}

async function load() {
  entries = await getEntries();
  render();
}

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(formatEntries(visible(), version));
  flash(`Copied ${visible().length} entries.`);
});

$('download').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ version, exported: new Date().toISOString(), entries }, null, 2)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sf-translation-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Delete all log entries?')) return;
  await clearEntries();
  await load();
  flash('Cleared.');
});

$('only-problems').addEventListener('change', render);

// Live update while you test in another tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[LOG_KEY]) load();
});

load();
