// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Local activity/error log for testing. Stored in chrome.storage.local only; never sent anywhere.
// All writes go through the background service worker so entries are never lost to races.

export const LOG_KEY = 'sftl:log';
export const LOG_MAX = 500;
const LEVELS = new Set(['error', 'warn', 'info']);

/** Removes things that must never be stored: session ids, query strings, long blobs. */
export function sanitize(value, max = 1000) {
  let s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  s = s
    .replace(/00D[A-Za-z0-9]{12,15}![A-Za-z0-9._\-]+/g, '[session]')
    .replace(/(Bearer\s+)\S+/gi, '$1[session]')
    .replace(/(https?:\/\/[^\s"'?#]+)\?[^\s"'#]*/g, '$1?…');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Builds a stored entry from a raw one. */
export function makeEntry(raw = {}, now = Date.now()) {
  const level = LEVELS.has(raw.level) ? raw.level : 'info';
  const entry = {
    at: new Date(now).toISOString(),
    level,
    where: sanitize(raw.where || 'unknown', 80),
    message: sanitize(raw.message || '', 1000),
  };
  if (raw.page) entry.page = sanitize(raw.page, 300);
  if (raw.details !== undefined) entry.details = sanitize(raw.details, 6000);
  if (raw.stack) entry.stack = sanitize(raw.stack, 2000);
  return entry;
}

/**
 * The element path behind a lookup, kept short: tags and aura classes from the clicked element outward,
 * plus the page markers locator.js reads. With it, one log entry is enough to rebuild the case as a test.
 */
export function pathDetails(hints = {}) {
  const out = {};
  if (hints.tags?.length) out.tags = hints.tags.join(' < ');
  if (hints.auraClasses?.length) out.aura = hints.auraClasses.join(' < ');
  for (const k of ['componentIds', 'sfComponents', 'objectApiNames']) if (hints[k]?.length) out[k] = hints[k];
  for (const k of ['dialogTitle', 'flexipage', 'fieldPart', 'listHeader', 'tabRole', 'relatedListApi', 'errorPopover', 'highlightsLabel', 'helpIcon', 'helpLabel', 'recordTitle']) {
    if (hints[k] !== undefined && hints[k] !== null && hints[k] !== false) out[k] = hints[k];
  }
  return out;
}

let chain = Promise.resolve();

/** Appends one entry (serialized, newest last, capped at LOG_MAX). */
export function addEntry(raw, storage = chrome.storage.local) {
  const entry = makeEntry(raw);
  chain = chain
    .then(async () => {
      const r = await storage.get(LOG_KEY);
      const list = Array.isArray(r[LOG_KEY]) ? r[LOG_KEY] : [];
      list.push(entry);
      await storage.set({ [LOG_KEY]: list.slice(-LOG_MAX) });
    })
    .catch(() => {});
  return chain.then(() => entry);
}

export async function getEntries(storage = chrome.storage.local) {
  const r = await storage.get(LOG_KEY);
  return Array.isArray(r[LOG_KEY]) ? r[LOG_KEY] : [];
}

export function clearEntries(storage = chrome.storage.local) {
  chain = chain.then(() => storage.remove(LOG_KEY)).catch(() => {});
  return chain;
}

/** Plain-text export for pasting into a chat or ticket. */
export function formatEntries(entries, version = '') {
  const head = `SF Translation Locator log${version ? ' v' + version : ''} (${entries.length} entries)`;
  const lines = entries.map((e) => {
    const parts = [`${e.at} ${e.level.toUpperCase()} [${e.where}] ${e.message}`];
    if (e.page) parts.push(`  page: ${e.page}`);
    if (e.details) parts.push(`  details: ${e.details}`);
    if (e.stack) parts.push(`  stack: ${e.stack.split('\n').slice(0, 4).join(' | ')}`);
    return parts.join('\n');
  });
  return [head, ...lines].join('\n');
}
