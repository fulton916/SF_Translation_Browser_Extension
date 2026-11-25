// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

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
  const fr = 'Les gadgets expédiés ont besoin d\'une couleur.';
  // The rule's French translation (CustomObjectTranslation) is that text: confirmed.
  const org = { ...vrOrg('fr'), validationTranslations: [{ name: 'Demo_Color_Required', errorMessage: fr }] };
  const rs = locate({ text: fr, org, describes: [gadget], hints: errorHints }).results;
  assert.equal(rs[0].key, 'vr:03d000000000001AAA');
  assert.equal(rs[0].confidence, 'confirmed');
  assert.equal(rs[0].source, SOURCE.WORKBENCH);
  assert.equal(rs[0].subtitle, '"Les gadgets expédiés ont besoin d\'une couleur."');
  assert.match(rs[0].notes[0], /^You pointed at the error message shown under the field Couleur du gadget: this rule's French translation\./);
  assert.match(rs[0].notes[1], /master text is "Shipped gadgets need a coat color\."/);
  // Without the translation (it could not be read), the text can also be Salesforce's own required-field
  // message in French, so the field's rule is listed from the page area, not confirmed.
  const plain = locate({ text: 'Complétez ce champ.', org: vrOrg('fr'), describes: [gadget], hints: errorHints }).results;
  assert.equal(plain[0].key, 'vr:03d000000000001AAA');
  assert.equal(plain[0].confidence, 'context');
  assert.match(plain[0].notes[0], /^You pointed at an error message shown under the field Couleur du gadget\. This active rule shows its message there\./);
  // Tooling ErrorDisplayField holds the field's label in the user's language (dev org: "Couleur de peinture").
  const byLabel = vrOrg('fr');
  byLabel.validationRules = byLabel.validationRules.map((v) => (v.ValidationName === 'Demo_Color_Required' ? { ...v, ErrorDisplayField: 'Couleur du gadget' } : v));
  const rl = locate({ text: fr, org: { ...byLabel, validationTranslations: org.validationTranslations }, describes: [gadget], hints: errorHints }).results;
  assert.equal(rl[0].key, 'vr:03d000000000001AAA');
  assert.equal(rl[0].confidence, 'confirmed');
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

// ---------- 5: viewing another language, rows are found by their master label ----------
import { parseSoapDescribe, parseSectionTranslations, loadMasterDescribe } from '../src/sfApi.js';
import { languageName } from '../src/locator.js';
const EN = languageName('en_US');

const SOAP_DESCRIBE = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>
<describeSObjectResponse><result><actionOverrides><name>View</name></actionOverrides>
<childRelationships><childSObject>Demo_Part__c</childSObject><field>Demo_Gadget__c</field><relationshipName>Parts__r</relationshipName></childRelationships>
<custom>true</custom>
<fields><label>Coat Color</label><name>Demo_Color__c</name><type>string</type></fields>
<fields><label>Gadget Status</label><name>Demo_Status__c</name>
<picklistValues><active>true</active><defaultValue>false</defaultValue><label>Drafting</label><value>Drafting</value></picklistValues>
<picklistValues><active>true</active><defaultValue>false</defaultValue><label>Sent &amp; Done</label><value>Shipped</value></picklistValues>
<type>picklist</type></fields>
<keyPrefix>a00</keyPrefix><label>Gadget</label><labelPlural>Gadgets</labelPlural><name>Demo_Gadget__c</name>
<recordTypeInfos><active>true</active><developerName>Demo_Standard</developerName><master>false</master><name>Standard Gadget</name><recordTypeId>012000000000001AAA</recordTypeId></recordTypeInfos>
<supportedScopes><label>All gadgets</label><name>everything</name></supportedScopes>
</result></describeSObjectResponse></soapenv:Body></soapenv:Envelope>`;

test('5: the SOAP describe in the default language gives master labels', async () => {
  const d = parseSoapDescribe(SOAP_DESCRIBE);
  assert.deepEqual([d.name, d.label, d.labelPlural], ['Demo_Gadget__c', 'Gadget', 'Gadgets']);
  assert.deepEqual(d.fields.map((f) => [f.name, f.label]), [['Demo_Color__c', 'Coat Color'], ['Demo_Status__c', 'Gadget Status']]);
  assert.deepEqual(d.fields[1].picklistValues, [{ label: 'Drafting', value: 'Drafting' }, { label: 'Sent & Done', value: 'Shipped' }]);
  assert.deepEqual(d.recordTypeInfos, [{ developerName: 'Demo_Standard', name: 'Standard Gadget' }]);
  // The call: SOAP partner API, LocaleOptions in the org default language.
  const calls = [];
  globalThis.fetch = async (u, init) => (calls.push({ u, init }), { ok: true, text: async () => SOAP_DESCRIBE });
  const m = await loadMasterDescribe({ host: 'retest-master.my.salesforce.com', sid: '00D000000000001!x' }, 'Demo_Gadget__c', 'en_US');
  assert.equal(m.label, 'Gadget');
  assert.equal(calls[0].u, 'https://retest-master.my.salesforce.com/services/Soap/u/67.0');
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].init.body, /<s:LocaleOptions><s:language>en_US<\/s:language><\/s:LocaleOptions>/);
  assert.match(calls[0].init.body, /<s:sessionId>00D000000000001!x<\/s:sessionId>/);
  assert.match(calls[0].init.body, /<s:sObjectType>Demo_Gadget__c<\/s:sObjectType>/);
  // Not an API name: no call.
  assert.equal(await loadMasterDescribe({ host: 'retest-master.my.salesforce.com', sid: 's' }, "x'<y", 'en_US'), null);
  assert.equal(calls.length, 1);
});

test('5: section translations from CustomObjectTranslation', () => {
  const xml = `<readMetadataResponse><result><records xsi:type="CustomObjectTranslation"><fullName>Demo_Gadget__c-fr</fullName>
<fields><label>Couleur du gadget</label><name>Demo_Color__c</name></fields>
<layouts><layout>Gadget Layout</layout><sections><label>Bases du gadget</label><section>Gadget Basics</section></sections><sections><label>Système</label><section>System Information</section></sections></layouts>
</records></result></readMetadataResponse>`;
  assert.deepEqual(parseSectionTranslations(xml), [
    { layout: 'Gadget Layout', section: 'Gadget Basics', label: 'Bases du gadget' },
    { layout: 'Gadget Layout', section: 'System Information', label: 'Système' },
  ]);
});

test('5: viewing French, "Find the row" and Go to translation use the master label; the French text stays as what you pointed at', () => {
  const frGadget = {
    name: 'Demo_Gadget__c', label: 'Gadget FR', labelPlural: 'Gadgets FR', custom: true, quickActions: [],
    recordTypeInfos: [{ name: 'Gadget standard', developerName: 'Demo_Standard', master: false }],
    fields: [
      { name: 'Demo_Color__c', label: 'Couleur du gadget', custom: true, type: 'string', picklistValues: [] },
      { name: 'Demo_Status__c', label: 'Statut du gadget', custom: true, type: 'picklist', picklistValues: [{ label: 'Brouillon', value: 'Drafting', active: true }] },
    ],
  };
  const org = {
    userLanguage: 'fr', defaultLanguage: 'en_US', labelTranslations: [], customLabels: [], apps: [], tabs: [], validationRules: [],
    objects: [{ name: 'Demo_Gadget__c', label: 'Gadget FR', labelPlural: 'Gadgets FR', custom: true }],
    masterDescribes: { Demo_Gadget__c: parseSoapDescribe(SOAP_DESCRIBE) },
    sectionTranslations: [{ layout: 'Gadget Layout', section: 'Gadget Basics', label: 'Bases du gadget' }],
  };
  const find = (text, hints = {}) => locate({ text, org, describes: [frGadget], hints }).results;
  const step = (r) => r.steps.find((s) => s.startsWith('Find the row'));

  const field = find('Couleur du gadget').find((r) => r.key === 'field:Demo_Gadget__c.Demo_Color__c');
  assert.equal(field.subtitle, '"Couleur du gadget"');
  assert.equal(step(field), 'Find the row: Coat Color (Demo_Color__c)');
  assert.equal(field.goto.rows[0], 'Coat Color');
  assert.ok(field.notes.includes(`Master label (${EN}): Object Manager → Gadget (Demo_Gadget__c) → Fields → Coat Color (Demo_Color__c) → Edit.`), field.notes.join(' | '));

  const value = find('Brouillon').find((r) => r.key === 'picklist:Demo_Gadget__c.Demo_Status__c.Drafting');
  assert.equal(step(value), 'Find the row: Drafting (field: Gadget Status)');
  assert.equal(value.goto.parent, 'Gadget Status');
  assert.deepEqual(value.goto.rows, ['Drafting', 'Brouillon']);
  assert.ok(value.notes.some((n) => n.startsWith(`Master label (${EN}): Object Manager → Gadget (Demo_Gadget__c) → Fields → Gadget Status (Demo_Status__c) → Values → Edit.`)));

  const rt = find('Gadget standard').find((r) => r.key === 'rt:Demo_Gadget__c.Demo_Standard');
  assert.equal(rt.subtitle, '"Gadget standard"');
  assert.equal(step(rt), 'Find the row: Standard Gadget (Demo_Standard)');

  const section = find('Bases du gadget', { tags: ['span', 'h3', 'records-record-layout-section'] }).find((r) => r.key === 'area:layoutSection');
  assert.equal(step(section), 'Find the row: Gadget Basics');
  assert.deepEqual(section.goto.rows, ['Gadget Basics', 'Bases du gadget']);

  // The object name keeps its master-label note too.
  const obj = find('Gadget FR').find((r) => r.key === 'object:Demo_Gadget__c');
  assert.ok(obj.notes.includes(`Master label (${EN}): Object Manager → Gadget (Demo_Gadget__c) → Edit.`));
  for (const r of [field, value, rt, section, obj]) assertWording([r]);

  // Master labels not read: the shown text with its API name, and the note with API names.
  const bare = locate({ text: 'Couleur du gadget', org: { ...org, masterDescribes: null }, describes: [frGadget] }).results.find((r) => r.key === 'field:Demo_Gadget__c.Demo_Color__c');
  assert.equal(step(bare), 'Find the row: Couleur du gadget (Demo_Color__c)');
  assert.ok(bare.notes.includes(`Master label (${EN}): Object Manager → Demo_Gadget__c → Fields → Demo_Color__c → Edit.`));
});

// ---------- 7: the heading of the save error popup ----------
test('7: "We hit a snag." in the save error popup is Salesforce text; its list items are looked up as usual', () => {
  const org = { userLanguage: 'en_US', defaultLanguage: 'en_US', labelTranslations: [], customLabels: [], apps: [], tabs: [], validationRules: [], objects: [] };
  const out = locate({ text: 'We hit a snag.', org, describes: [gadget], hints: { tags: ['h2', 'div', 'header', 'section', 'records-record-edit-error'], errorPopover: 'header' } });
  assert.ok(out.areas.includes('errorPopoverHeader'));
  assert.equal(out.results[0].source, SOURCE.SALESFORCE);
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.equal(out.notFoundHelp, null);
  assertWording(out.results);
  const body = locate({ text: 'Couleur du gadget', org, describes: [gadget], hints: { tags: ['a', 'li', 'ul', 'section'], errorPopover: 'body' } });
  assert.ok(!body.results.some((r) => r.key === 'sfdctext:errorPopover'));
  assert.ok(body.results.some((r) => r.key === 'field:Demo_Gadget__c.Demo_Color__c'));
});

test('3: validation rule messages from CustomObjectTranslation', async () => {
  const { parseValidationTranslations } = await import('../src/sfApi.js');
  const xml = '<result><layouts><layout>Gadget Layout</layout><sections><label>Bases</label><section>Basics</section></sections></layouts><validationRules><errorMessage>Les gadgets exp&#233;di&#233;s ont besoin d&apos;une couleur.</errorMessage><name>Demo_Color_Required</name></validationRules><validationRules><name>Demo_Untranslated</name></validationRules></result>';
  const out = parseValidationTranslations(xml);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Demo_Color_Required');
  assert.match(out[0].errorMessage, /^Les gadgets/);
});
