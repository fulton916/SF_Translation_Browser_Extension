// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeLanguages, reportPath } from '../src/report.js';
import { loadActiveLanguages } from '../src/reportApi.js';

const session = { host: 'x.my.salesforce.com', sid: 's' };
const reply = (records) => ({ ok: true, json: async () => ({ records, done: true }) });

test('active languages: active Workbench languages only, without the org default, sorted by name', () => {
  const rows = [
    { Language: 'fr', IsActive: true },
    { Language: 'es', IsActive: false },
    { Language: 'de', IsActive: true },
    { Language: 'en_US', IsActive: true },
    { Language: 'de', IsActive: true },
    { Language: null, IsActive: true },
  ];
  assert.deepEqual(activeLanguages(rows, 'en_US'), [
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
  ]);
  assert.deepEqual(activeLanguages(null, 'en_US'), []);
});

test('active languages are read from the Translation object and the org default', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    const q = decodeURIComponent(u);
    urls.push(q);
    return reply(/FROM Organization/.test(q) ? [{ LanguageLocaleKey: 'en_US' }] : [{ Language: 'fr', IsActive: true }, { Language: 'en_US', IsActive: true }]);
  };
  const out = await loadActiveLanguages(session);
  assert.deepEqual(out, { orgDefault: 'en_US', languages: [{ code: 'fr', name: 'French' }] });
  assert.ok(urls.some((u) => /\/query\/\?q=SELECT Language, IsActive FROM Translation$/.test(u)));
  assert.ok(urls.every((u) => !/\/tooling\//.test(u)), 'REST queries, not Tooling');
});

test('active languages: no Translation object: the error names the Workbench setting', async () => {
  globalThis.fetch = async (u) =>
    /FROM\+Translation|FROM%20Translation/.test(u)
      ? { ok: false, status: 400, text: async () => JSON.stringify([{ message: "sObject type 'Translation' is not supported." }]) }
      : reply([{ LanguageLocaleKey: 'en_US' }]);
  await assert.rejects(loadActiveLanguages(session), /Translation Workbench languages not read: sObject type 'Translation' is not supported\. The report needs Translation Workbench on/);
});

test('report page path: the Salesforce origin of the tab, or null for another page', () => {
  assert.equal(
    reportPath('https://orgfarm-1-dev-ed.develop.lightning.force.com/lightning/r/Account/001/view'),
    'src/report.html?org=https%3A%2F%2Forgfarm-1-dev-ed.develop.lightning.force.com'
  );
  assert.equal(reportPath('https://x.my.salesforce-setup.com/lightning/setup/Home'), 'src/report.html?org=https%3A%2F%2Fx.my.salesforce-setup.com');
  assert.equal(reportPath('https://example.com/force.com'), null);
  assert.equal(reportPath('http://x.my.salesforce.com/'), null);
  assert.equal(reportPath(''), null);
  assert.equal(reportPath(undefined), null);
});
