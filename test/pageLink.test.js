import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { locate, pageLinkText, SETUP, SOURCE, buildGotoUrl } from '../src/locator.js';

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

test('every page the cards link to has a named button', () => {
  for (const [name, page] of Object.entries(SETUP)) {
    const url = typeof page === 'function' ? page('Account', '001000000000001AAA') : page;
    assert.match(pageLinkText({ url }) || '', /^Open \S/, `SETUP.${name}`);
  }
  assert.equal(pageLinkText({ url: SETUP.customLabels }), 'Open Custom Labels');
  assert.equal(pageLinkText({ url: SETUP.customLabel('101000000000001') }), 'Open custom label');
  assert.equal(pageLinkText({ url: SETUP.renameTabs }), 'Open Rename Tabs and Labels');
  assert.equal(pageLinkText({ url: SETUP.objectFields('Account') }), 'Open Object Manager');
  assert.equal(pageLinkText({ url: SETUP.appManager }), 'Open App Manager');
  assert.equal(pageLinkText({ url: '/lightning/r/Product2/01t000000000001AAA/related/Product_Translations__r/view' }), 'Open related list');
});

test('every url written out in locator.js has a named button', () => {
  const urls = [...src('locator.js').matchAll(/\burl(?::| =)[^\n]*?['`](\/lightning\/[^'`]+)['`]/g)].map((m) => m[1]);
  assert.ok(urls.length >= 2);
  for (const url of urls) assert.ok(pageLinkText({ url: url.replace(/\$\{[^}]+\}/g, 'x') }), url);
  assert.doesNotMatch(src('content.js'), /'Open page'/);
});

test('no page link next to Go to translation, except on a custom label', () => {
  assert.equal(pageLinkText({ url: SETUP.workbench, goto: { page: 'workbench' } }), null);
  assert.equal(pageLinkText({ url: SETUP.override, goto: { page: 'override' } }), null);
  assert.equal(pageLinkText({ url: SETUP.renameTabs, goto: { page: 'rename' } }), null);
  assert.equal(pageLinkText({ url: SETUP.record('Product2', '01t'), goto: { page: 'dataTranslation' } }), null);
  assert.equal(pageLinkText({ url: SETUP.customLabel('101'), goto: { page: 'label' } }), 'Open custom label');
  assert.equal(pageLinkText({ url: null }), null);
});

test('Go to translation opens the screen of the link it replaces', () => {
  assert.equal(buildGotoUrl({ page: 'workbench' }, 'fr').path, SETUP.workbench);
  assert.equal(buildGotoUrl({ page: 'override' }, 'fr').path, SETUP.override);
  assert.equal(buildGotoUrl({ page: 'dataTranslation', object: 'Product2', recordId: '01t' }, 'fr').path, SETUP.record('Product2', '01t'));
  assert.match(buildGotoUrl({ page: 'rename', object: 'Account', custom: false }, 'fr').path, /\/setup\/RenameTab\//);
});

test('locate sets the link text on its cards', () => {
  const org = {
    userLanguage: 'en_US',
    defaultLanguage: 'en_US',
    customLabels: [{ Id: '101000000000001', Name: 'Delivery', MasterLabel: 'Delivery', NamespacePrefix: null, Value: 'Delivery Status', Language: 'en_US' }],
    labelTranslations: [],
    objects: [],
    tabs: [],
  };
  const describes = [{ name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', fields: [{ name: 'DeliveryStatus__c', label: 'Delivery Status', custom: true, type: 'string' }] }];
  const { results } = locate({ text: 'Delivery Status', org, describes });
  const label = results.find((r) => r.source === SOURCE.CUSTOM_LABEL);
  const field = results.find((r) => r.key === 'field:Opportunity.DeliveryStatus__c');
  assert.equal(label.linkText, 'Open custom label');
  assert.equal(field.goto.page, 'workbench');
  assert.equal(field.linkText, null);
  const richText = locate({ text: 'Hello', hints: { tags: ['flexipage-rich-text'] }, org, describes }).results.find((r) => r.key === 'area:richText');
  assert.equal(richText.confidence, 'confirmed');
  assert.equal(richText.goto, undefined);
  assert.equal(richText.linkText, 'Open Custom Labels');
});

