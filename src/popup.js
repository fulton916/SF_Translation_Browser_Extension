// Toolbar popup: the missing-translations report for the org in this tab, and the test log.

import { reportPath } from './report.js';

const $ = (id) => document.getElementById(id);

/** Opens an extension page next to `tab`, in its window. */
const openNext = (path, tab) =>
  chrome.tabs.create({
    url: chrome.runtime.getURL(path),
    ...(tab?.windowId != null ? { windowId: tab.windowId } : {}),
    ...(tab?.index != null ? { index: tab.index + 1 } : {}),
  });

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const path = reportPath(tab?.url);
if (path) {
  $('report').addEventListener('click', () => openNext(path, tab).then(() => window.close()));
} else {
  $('report').disabled = true;
  $('report-note').textContent = 'Open a Salesforce tab of the org first.';
}
$('log').addEventListener('click', () => openNext('src/log.html', tab).then(() => window.close()));
