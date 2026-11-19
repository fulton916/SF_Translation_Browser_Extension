// Dev org re-test of v0.2.5 (Nov 2026): one test per fix, with made-up names and zero-padded fake Ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../src/pointerTarget.js');
const { visibleText } = globalThis.sftlPointer;

// Fake element: innerText as Chrome gives it (the absolutely positioned assistive span on its own line).
const fakeEl = (innerText, assistive = []) => ({
  innerText,
  querySelectorAll: (sel) => (/slds-assistive-text/.test(sel) ? assistive.map((t) => ({ innerText: t })) : []),
});

test('1: an error message under a field gives its message, not the assistive field label before it', () => {
  const err = fakeEl('Coat Color\nShipped gadgets need a coat color.', ['Coat Color']);
  assert.equal(visibleText(err).split('\n')[0], 'Shipped gadgets need a coat color.');
  // Same line (no line break from innerText): the label prefix is dropped.
  assert.equal(visibleText(fakeEl('Coat Color Shipped gadgets need a coat color.', ['Coat Color'])), 'Shipped gadgets need a coat color.');
  // Only assistive text in the element (the (i) icon's "Help <label>"): kept.
  assert.equal(visibleText(fakeEl('Help Coat Color', ['Help Coat Color'])), 'Help Coat Color');
  // No assistive text: unchanged.
  assert.equal(visibleText(fakeEl('  Gadget Basics  ')), 'Gadget Basics');
  assert.equal(visibleText(null), '');
});

// ---------- 2: a change of the user's language is seen on the next lookup ----------
import { loadOrgData, loadUserLanguage, loadDescribe } from '../src/sfApi.js';

test('2: the user language is read every 15 s; on a change only the language-dependent org data is read again', async () => {
  let lang = 'en_US';
  const urls = [];
  globalThis.fetch = async (u) => {
    const url = decodeURIComponent(u);
    urls.push(url);
    const json = (body) => ({ ok: true, json: async () => body });
    if (url.includes('/userinfo')) return json({ language: lang });
    if (url.endsWith('/sobjects')) return json({ sobjects: [{ name: 'Demo_Gadget__c', label: lang === 'fr' ? 'Gadget FR' : 'Gadget', labelPlural: 'Gadgets', custom: true }] });
    if (url.endsWith('/describe')) return json({ name: 'Demo_Gadget__c', label: lang === 'fr' ? 'Gadget FR' : 'Gadget', fields: [] });
    if (url.endsWith('/quickActions')) return json([]);
    return json({ records: [], done: true });
  };
  const s = { host: 'retest-lang.my.salesforce.com', sid: 's' };
  const en = await loadOrgData(s, { language: await loadUserLanguage(s) });
  assert.equal(en.userLanguage, 'en_US');
  assert.equal(en.objects[0].label, 'Gadget');
  const d1 = await loadDescribe(s, 'Demo_Gadget__c', { language: 'en_US' });
  assert.equal(d1.label, 'Gadget');

  // The user switches to French. Within 15 s the cached language is used; a refresh reads it again.
  lang = 'fr';
  urls.length = 0;
  assert.equal(await loadUserLanguage(s), 'en_US');
  assert.equal(urls.length, 0);
  const now = await loadUserLanguage(s, { refresh: true });
  assert.equal(now, 'fr');
  urls.length = 0;
  const fr = await loadOrgData(s, { language: now });
  assert.equal(fr.userLanguage, 'fr');
  assert.equal(fr.objects[0].label, 'Gadget FR');
  // Object names, tabs and apps only: custom labels, validation rules and paths are kept.
  assert.equal(urls.length, 3);
  assert.ok(urls.some((u) => u.endsWith('/sobjects')));
  assert.ok(urls.some((u) => /FROM TabDefinition/.test(u)));
  assert.ok(urls.some((u) => /FROM AppMenuItem/.test(u)));
  assert.ok(!urls.some((u) => /ExternalString|ValidationRule|PathAssistant/.test(u)));
  // Same language again: nothing read.
  urls.length = 0;
  assert.equal((await loadOrgData(s, { language: 'fr' })).userLanguage, 'fr');
  assert.equal(urls.length, 0);
  // Describes are kept per language: the French one is read, the English one stays cached.
  const d2 = await loadDescribe(s, 'Demo_Gadget__c', { language: 'fr' });
  assert.equal(d2.label, 'Gadget FR');
  assert.equal((await loadDescribe(s, 'Demo_Gadget__c', { language: 'en_US' })).label, 'Gadget');
});

// ---------- 4: "Translated into" lists every language of a label matched through a translation ----------
import { loadLabelTranslations } from '../src/sfApi.js';

test('4: a label found by its French text also gets its German translation, in one more query', async () => {
  const urls = [];
  const rows = {
    fr: { attributes: {}, Id: '0B0000000000001AAA', ExternalStringId: '101000000000001AAA', Language: 'fr', Value: 'Bienvenue au gadget' },
    de: { attributes: {}, Id: '0B0000000000002AAA', ExternalStringId: '101000000000001AAA', Language: 'de', Value: 'Willkommen beim Gadget' },
  };
  globalThis.fetch = async (u) => {
    const url = decodeURIComponent(u);
    urls.push(url);
    const records = /Value LIKE/.test(url) ? [rows.fr] : [rows.fr, rows.de];
    return { ok: true, json: async () => ({ done: true, records }) };
  };
  const out = await loadLabelTranslations({ host: 'retest-labels.my.salesforce.com', sid: 's' }, 'Bienvenue au gadget', []);
  assert.deepEqual(out.map((r) => r.Language), ['fr', 'de']);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /WHERE ExternalStringId IN \('101000000000001AAA'\) LIMIT 2000$/);
  // Label already matched by its master value (its Id was passed): one query, as before.
  urls.length = 0;
  await loadLabelTranslations({ host: 'retest-labels.my.salesforce.com', sid: 's' }, 'Bienvenue au gadget', ['101000000000001AAA']);
  assert.equal(urls.length, 1);
  // Shown on the card.
  const org = {
    userLanguage: 'fr', defaultLanguage: 'en_US', objects: [], tabs: [], apps: [], validationRules: [],
    customLabels: [{ Id: '101000000000001AAA', Name: 'Demo_Greeting', MasterLabel: 'Demo Greeting', NamespacePrefix: null, Value: 'Welcome to the gadget', Language: 'en_US' }],
    labelTranslations: out,
  };
  const r = locate({ text: 'Bienvenue au gadget', org, describes: [] }).results[0];
  assert.ok(r.notes.includes('Translated into: French, German'), r.notes.join(' | '));
});

// ---------- 3: a translated validation message under a field ----------
import { locate, SOURCE } from '../src/locator.js';

const BANNED = /\b(weaker|probably|may be|might|hidden|as-is)\b/i;
const assertWording = (rs) => {
  for (const r of rs) for (const n of [r.title, r.subtitle, ...(r.steps || []), ...(r.notes || [])]) assert.doesNotMatch(String(n ?? ''), BANNED);
};
const gadget = {
  name: 'Demo_Gadget__c', label: 'Gadget', labelPlural: 'Gadgets', custom: true, quickActions: [], recordTypeInfos: [],
  fields: [{ name: 'Demo_Color__c', label: 'Couleur du gadget', custom: true, type: 'string', picklistValues: [] }],
};
const vrOrg = (userLanguage) => ({
  userLanguage, defaultLanguage: 'en_US', labelTranslations: [], customLabels: [], apps: [], tabs: [],
  objects: [{ name: 'Demo_Gadget__c', label: 'Gadget', labelPlural: 'Gadgets', custom: true }],
  validationRules: [
    { Id: '03d000000000001AAA', ValidationName: 'Demo_Color_Required', ErrorMessage: 'Shipped gadgets need a coat color.', ErrorDisplayField: 'Demo_Color__c', EntityDefinition: { QualifiedApiName: 'Demo_Gadget__c' } },
    { Id: '03d000000000002AAA', ValidationName: 'Demo_Top_Rule', ErrorMessage: 'Something else.', ErrorDisplayField: null, EntityDefinition: { QualifiedApiName: 'Demo_Gadget__c' } },
  ],
});
const errorHints = { selectionNames: ['sfdc:RecordField.Demo_Gadget__c.Demo_Color__c'], fieldPart: 'error' };

test('3: viewing French, the message under a field is that field\'s validation rule, not the field label', () => {
  const rs = locate({ text: 'Les gadgets expédiés ont besoin d\'une couleur.', org: vrOrg('fr'), describes: [gadget], hints: errorHints }).results;
  assert.equal(rs[0].key, 'vr:03d000000000001AAA');
  assert.equal(rs[0].confidence, 'confirmed');
  assert.equal(rs[0].source, SOURCE.WORKBENCH);
  assert.equal(rs[0].subtitle, '"Les gadgets expédiés ont besoin d\'une couleur."');
  assert.match(rs[0].notes[0], /^You pointed at the error message shown under the field Couleur du gadget\. This is the active rule/);
  assert.match(rs[0].notes[1], /master text is "Shipped gadgets need a coat color\."/);
  assert.ok(!rs.some((r) => r.key === 'vr:03d000000000002AAA'), 'a rule shown at the top of the page is not offered');
  assert.ok(!rs.some((r) => r.key === 'field:Demo_Gadget__c.Demo_Color__c'), 'no "You pointed inside this field" card');
  assertWording(rs);
});

test('3: validation rules are read with their error display field, and without it when that column fails', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    const url = decodeURIComponent(u);
    urls.push(url);
    if (/ErrorDisplayField/.test(url)) return { ok: false, status: 400, text: async () => '[{"message":"No such column"}]' };
    if (/FROM ValidationRule/.test(url)) return { ok: true, json: async () => ({ done: true, records: [{ Id: '03d000000000001AAA', ValidationName: 'Demo_Rule' }] }) };
    if (url.includes('/userinfo')) return { ok: true, json: async () => ({ language: 'en_US' }) };
    if (url.endsWith('/sobjects')) return { ok: true, json: async () => ({ sobjects: [] }) };
    return { ok: true, json: async () => ({ records: [], done: true }) };
  };
  const org = await loadOrgData({ host: 'retest-vr.my.salesforce.com', sid: 's' }, { refresh: true });
  assert.equal(org.validationRules.length, 1);
  assert.ok(!org.warnings.some((w) => w.startsWith('Validation messages')));
  assert.ok(urls.some((u) => /SELECT Id, ValidationName, ErrorMessage, ErrorDisplayField, NamespacePrefix/.test(u)));
});

test('3: in the default language a message that is no rule\'s text is not tied to the rule', () => {
  const rs = locate({ text: 'Complete this field.', org: vrOrg('en_US'), describes: [gadget], hints: errorHints }).results;
  assert.ok(!rs.some((r) => r.key.startsWith('vr:') && r.confidence === 'confirmed'));
  const field = rs.find((r) => r.key === 'field:Demo_Gadget__c.Demo_Color__c');
  assert.match(field.notes[0], /^You pointed at an error message under this field\./);
  // Its master text still confirms it, as before.
  const en = locate({ text: 'Shipped gadgets need a coat color.', org: vrOrg('en_US'), describes: [gadget], hints: errorHints }).results;
  assert.equal(en[0].key, 'vr:03d000000000001AAA');
  assert.equal(en[0].confidence, 'confirmed');
});
