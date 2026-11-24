// Missing-translations report (#14): which items have no translation. The XML is shaped as Salesforce
// returns readMetadata (dev org, checked live): an untranslated element holds only a comment with the master text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slot,
  metadataRecords,
  parseObjectTranslation,
  parseTranslations,
  parseValueSetTranslation,
  labelItems,
  objectItems,
  tabItems,
  valueSetItems,
  summarize,
  masterItems,
  ITEM_TYPE,
} from '../src/report.js';
import { reportObjects, editedLayoutObjects, loadMissingTranslations } from '../src/reportApi.js';
import { buildGotoUrl } from '../src/locator.js';

const envelope = (records) =>
  '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
  `<soapenv:Body><readMetadataResponse><result>${records.join('')}</result></readMetadataResponse></soapenv:Body></soapenv:Envelope>`;
const record = (type, body) => `<records xsi:type="${type}">${body}</records>`;

const gadgetMaster = record(
  'CustomObjectTranslation',
  '<fullName>Demo_Gadget__c-en_US</fullName>' +
    '<caseValues><plural>false</plural><value>Gadget</value></caseValues><caseValues><plural>true</plural><value>Gadgets</value></caseValues>' +
    '<fields><label><!-- Gadget Owner --></label><name>Demo_Owner__c</name><relationshipLabel><!-- Owned Gadgets --></relationshipLabel></fields>' +
    '<fields><label><!-- Coat Color --></label><name>Demo_Color__c</name></fields>' +
    '<fields><label><!-- Stage --></label><name>Demo_Stage__c</name><picklistValues><masterLabel>Draft</masterLabel><translation><!-- Draft --></translation></picklistValues><picklistValues><masterLabel>Shipped &amp; Done</masterLabel><translation><!-- Shipped &amp; Done --></translation></picklistValues></fields>' +
    '<recordTypes><label><!-- Big Gadget --></label><name>Demo_Big</name></recordTypes>'
);
const gadgetFr = record(
  'CustomObjectTranslation',
  '<fullName>Demo_Gadget__c-fr</fullName>' +
    '<caseValues><plural>false</plural><value><!-- Gadget --></value></caseValues><caseValues><plural>true</plural><value><!-- Gadget --></value></caseValues>' +
    '<fields><label><!-- Gadget Owner --></label><name>Demo_Owner__c</name><relationshipLabel>Gadgets possédés</relationshipLabel></fields>' +
    '<fields><help><!-- Pick one. --></help><label>Couleur</label><name>Demo_Color__c</name></fields>' +
    '<fields><label>Étape</label><name>Demo_Stage__c</name><picklistValues><masterLabel>Draft</masterLabel><translation>Brouillon</translation></picklistValues><picklistValues><masterLabel>Shipped &amp; Done</masterLabel><translation><!-- Shipped &amp; Done --></translation></picklistValues></fields>' +
    '<fields><label><!-- Packaged --></label><name>acme__Packaged__c</name></fields>' +
    '<recordTypes><label><!-- Big Gadget --></label><name>Demo_Big</name></recordTypes>'
);

test('slot: a comment-only element is untranslated and names the master text; text is a translation; absent is null', () => {
  assert.deepEqual(slot('<label><!-- Coat Color --></label>', 'label'), { translation: null, master: 'Coat Color' });
  assert.deepEqual(slot('<label>Couleur &amp; teinte</label>', 'label'), { translation: 'Couleur & teinte', master: null });
  assert.deepEqual(slot('<label></label>', 'label'), { translation: null, master: null });
  assert.deepEqual(slot('<label/>', 'label'), { translation: null, master: null });
  assert.equal(slot('<name>X</name>', 'label'), null);
});

test('metadataRecords: one entry per record, by its own fullName', () => {
  const recs = metadataRecords(envelope([gadgetMaster, gadgetFr, record('CustomObjectTranslation', '<fullName>Nope__c-fr</fullName>')]));
  assert.deepEqual(Object.keys(recs), ['Demo_Gadget__c-en_US', 'Demo_Gadget__c-fr', 'Nope__c-fr']);
});

test('object items: field labels, related list labels, picklist values, record types and the tab, with master texts', () => {
  const recs = metadataRecords(envelope([gadgetMaster, gadgetFr]));
  const items = objectItems({
    object: 'Demo_Gadget__c',
    objectLabel: 'Gadget',
    language: 'fr',
    translation: parseObjectTranslation(recs['Demo_Gadget__c-fr']),
    master: parseObjectTranslation(recs['Demo_Gadget__c-en_US']),
    hasTab: true,
  });
  assert.deepEqual(
    items.map((i) => [i.type, i.name, i.master, i.translated]),
    [
      [ITEM_TYPE.FIELD_LABEL, 'Demo_Gadget__c.Demo_Owner__c', 'Gadget Owner', false],
      [ITEM_TYPE.RELATED_LIST_LABEL, 'Demo_Gadget__c.Demo_Owner__c', 'Owned Gadgets', true],
      [ITEM_TYPE.FIELD_LABEL, 'Demo_Gadget__c.Demo_Color__c', 'Coat Color', true],
      [ITEM_TYPE.HELP_TEXT, 'Demo_Gadget__c.Demo_Color__c', 'Pick one.', false],
      [ITEM_TYPE.FIELD_LABEL, 'Demo_Gadget__c.Demo_Stage__c', 'Stage', true],
      [ITEM_TYPE.PICKLIST_VALUE, 'Demo_Gadget__c.Demo_Stage__c: Draft', 'Draft', true],
      [ITEM_TYPE.PICKLIST_VALUE, 'Demo_Gadget__c.Demo_Stage__c: Shipped & Done', 'Shipped & Done', false],
      [ITEM_TYPE.RECORD_TYPE, 'Demo_Gadget__c.Demo_Big', 'Big Gadget', false],
      [ITEM_TYPE.TAB, 'Demo_Gadget__c', 'Gadgets', false],
    ]
  );
  assert.deepEqual(
    items.filter((i) => i.translated).map((i) => i.translation),
    ['Gadgets possédés', 'Couleur', 'Étape', 'Brouillon'],
    'translated items carry the translated text'
  );
  assert.ok(items.filter((i) => !i.translated).every((i) => i.translation === null));
  assert.ok(!items.some((i) => i.name.includes('acme__')), 'package fields are left out');
  // The field label is translated: its values still name the field by the master label (org default file).
  const pv = items.find((i) => i.name.endsWith('Shipped & Done'));
  assert.equal(pv.goto.parent, 'Stage');
  assert.equal(pv.goto.component, 'PicklistMaster');
  assert.equal(buildGotoUrl(pv.goto, 'fr').autofill.lang, 'fr');
  const rt = items.find((i) => i.type === ITEM_TYPE.RECORD_TYPE);
  assert.deepEqual(rt.goto.rows, ['Big Gadget', 'Demo_Big']);
  assert.equal(rt.goto.component, 'RecordType');
  const tab = items.find((i) => i.type === ITEM_TYPE.TAB);
  assert.equal(buildGotoUrl(tab.goto, 'fr').autofill.tabLabel, 'Gadgets');
  const rel = items.find((i) => i.type === ITEM_TYPE.RELATED_LIST_LABEL);
  assert.equal(rel.goto.aspect, 'relationshiplabel');
});

// Shaped as the dev org returns it: a translated action names its aspect, a button's comment is its API name.
const moreTypes = (lang) =>
  `<fullName>Demo_Gadget__c-${lang}</fullName>` +
  (lang === 'fr'
    ? '<fields><help>Choisir.</help><label>Couleur</label><name>Demo_Color__c</name></fields><fields><help>Aide</help><name>Industry</name></fields>'
    : '<fields><help><!-- Pick one. --></help><label><!-- Coat Color --></label><name>Demo_Color__c</name></fields>') +
  '<layouts><layout>Gadget (Sales) Layout</layout><sections><label>' + (lang === 'fr' ? 'Bases' : '<!-- Basics -->') + '</label><section>Basics</section></sections>' +
  '<sections><label><!-- A &amp; B --></label><section>A &amp; B</section></sections></layouts>' +
  '<layouts><layout>Gadget Layout</layout><sections><label><!-- Basics --></label><section>Basics</section></sections></layouts>' +
  '<layouts><layout>acme__Pkg Layout</layout><sections><label><!-- Pkg --></label><section>Pkg</section></sections></layouts>' +
  (lang === 'fr'
    ? '<quickActions><aspect>Master</aspect><label>Vérifier</label><name>Demo_Check</name></quickActions><quickActions><aspect>InfoMessage</aspect><label>Fait</label><name>Demo_Check</name></quickActions>'
    : '<quickActions><label><!-- Check It --></label><name>Demo_Check</name></quickActions>') +
  '<quickActions><label><!-- LogACall --></label><name>LogACall</name></quickActions>' +
  '<validationRules><errorMessage>' + (lang === 'fr' ? 'Il faut une couleur.' : '<!-- Needs a color. -->') + '</errorMessage><name>Demo_Need_Color</name></validationRules>' +
  '<validationRules><errorMessage><!-- Pkg --></errorMessage><name>acme__Rule</name></validationRules><validationRules><errorMessage><!-- Off --></errorMessage><name>Demo_Off</name></validationRules>' +
  '<webLinks><label><!-- Demo_Docs --></label><name>Demo_Docs</name></webLinks>';

test('object items: help texts, validation messages, layout sections, quick actions, buttons and links', () => {
  const items = objectItems({
    object: 'Demo_Gadget__c',
    objectLabel: 'Gadget',
    language: 'fr',
    translation: parseObjectTranslation(moreTypes('fr')),
    master: parseObjectTranslation(moreTypes('en_US')),
    activeRules: new Set(['Demo_Gadget__c.Demo_Need_Color']),
    actions: new Map([['Demo_Gadget__c.Demo_Check', 'Check It']]),
    buttonLabels: new Map([['Demo_Gadget__c.Demo_Docs', 'Open Docs']]),
  }).filter((i) => i.type !== ITEM_TYPE.FIELD_LABEL);
  assert.deepEqual(
    items.map((i) => [i.type, i.name, i.master, i.translation]),
    [
      [ITEM_TYPE.HELP_TEXT, 'Demo_Gadget__c.Demo_Color__c', 'Pick one.', 'Choisir.'],
      [ITEM_TYPE.VALIDATION_MESSAGE, 'Demo_Gadget__c.Demo_Need_Color', 'Needs a color.', 'Il faut une couleur.'],
      [ITEM_TYPE.LAYOUT_SECTION, 'Demo_Gadget__c.Gadget (Sales) Layout: Basics', 'Basics', 'Bases'],
      [ITEM_TYPE.LAYOUT_SECTION, 'Demo_Gadget__c.Gadget (Sales) Layout: A & B', 'A & B', null],
      [ITEM_TYPE.LAYOUT_SECTION, 'Demo_Gadget__c.Gadget Layout: Basics', 'Basics', null],
      [ITEM_TYPE.QUICK_ACTION, 'Demo_Gadget__c.Demo_Check', 'Check It', 'Vérifier'],
      [ITEM_TYPE.BUTTON_LINK, 'Demo_Gadget__c.Demo_Docs', 'Open Docs', null],
    ],
    'standard labels, package items and standard fields are left out; a section is one item per layout'
  );
  const go = (type) => buildGotoUrl(items.find((i) => i.type === type).goto, 'fr').autofill;
  assert.deepEqual([go(ITEM_TYPE.HELP_TEXT).component, go(ITEM_TYPE.HELP_TEXT).aspect, go(ITEM_TYPE.HELP_TEXT).rows], ['CustomFieldDefinition', 'help', ['Coat Color', 'Demo_Color__c']]);
  assert.deepEqual([go(ITEM_TYPE.VALIDATION_MESSAGE).component, go(ITEM_TYPE.VALIDATION_MESSAGE).rows], ['ValidationFormula', ['Demo_Need_Color']]);
  assert.deepEqual([go(ITEM_TYPE.LAYOUT_SECTION).component, go(ITEM_TYPE.LAYOUT_SECTION).parent, go(ITEM_TYPE.LAYOUT_SECTION).rows], ['LayoutSection', 'Gadget (Sales) Layout', ['Basics']]);
  // The first row text picks the action in the Workbench Quick Action list.
  assert.deepEqual([go(ITEM_TYPE.QUICK_ACTION).component, go(ITEM_TYPE.QUICK_ACTION).rows], ['QuickActionDefinition', ['Check It', 'Demo_Check']]);
  assert.deepEqual([go(ITEM_TYPE.BUTTON_LINK).component, go(ITEM_TYPE.BUTTON_LINK).rows], ['WebLink', ['Demo_Docs']]);
});

test('a standard object with only one new type is read; a layout-only one without a typed section is not read per language', async () => {
  const read = [];
  globalThis.fetch = async (u, init = {}) => {
    const url = decodeURIComponent(String(u));
    if (init.method === 'POST') {
      const names = [...String(init.body).matchAll(/<s:fullNames>([^<]+)</g)].map((m) => m[1]);
      read.push(...names);
      const section = '<layouts><layout>L</layout><sections><label><!-- Facts --></label><section>Facts</section></sections></layouts>';
      const link = '<webLinks><label><!-- Docs --></label><name>Docs</name></webLinks>';
      return { ok: true, text: async () => envelope(names.map((n) => record('X', `<fullName>${n}</fullName>${/^Solution/.test(n) ? section : /^Campaign/.test(n) ? link : ''}`))) };
    }
    if (/\/sobjects$/.test(url)) return { ok: true, json: async () => ({ sobjects: ['Campaign', 'Solution', 'Event', 'Task', 'Contract', 'Idea'].map((n) => ({ name: n, label: n })) }) };
    if (/userinfo/.test(url)) return { ok: true, json: async () => ({ language: 'en_US' }) };
    let rows = [];
    if (/FROM Organization/.test(url)) rows = [{ LanguageLocaleKey: 'en_US' }];
    else if (/FROM Translation/.test(url)) rows = [{ Language: 'fr', IsActive: true }];
    else if (/FROM WebLink/.test(url)) rows = [{ Name: 'Docs', MasterLabel: 'Open Docs', PageOrSobjectType: 'Campaign', NamespacePrefix: null }];
    else if (/FROM QuickActionDefinition/.test(url)) rows = [{ DeveloperName: 'Demo_Do', MasterLabel: 'Do', SobjectType: 'Task' }];
    else if (/FROM ValidationRule/.test(url)) rows = [{ ValidationName: 'R', ErrorMessage: 'No', NamespacePrefix: null, EntityDefinition: { QualifiedApiName: 'Contract' } }];
    else if (/FROM Layout /.test(url)) rows = ['Solution', 'Event', 'Idea'].map((n) => ({ TableEnumOrId: n, EntityDefinition: { QualifiedApiName: n }, CreatedDate: '1', LastModifiedDate: n === 'Idea' ? '1' : '2' }));
    return { ok: true, json: async () => ({ records: rows, done: true }) };
  };
  const out = await loadMissingTranslations({ host: 'report2.my.salesforce.com', sid: 's' });
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.missing.map((i) => [i.type, i.name, i.master]), [
    [ITEM_TYPE.LAYOUT_SECTION, 'Solution.L: Facts', 'Facts'],
    [ITEM_TYPE.BUTTON_LINK, 'Campaign.Docs', 'Open Docs'],
  ]);
  assert.deepEqual(read.filter((n) => /-fr$/.test(n)).sort(), ['Campaign-fr', 'Contract-fr', 'Solution-fr', 'Task-fr']);
  assert.ok(read.includes('Event-en_US') && !read.includes('Idea-en_US'));
  assert.deepEqual(editedLayoutObjects([{ TableEnumOrId: 'CommunityMemberLayout', EntityDefinition: null, CreatedDate: '1', LastModifiedDate: '2' }]), ['User']);
});

test('object items: no tab item without a tab; German tab text is the Nominative plural; any translated form counts', () => {
  const de = parseObjectTranslation(
    '<fullName>Demo_Gadget__c-de</fullName>' +
      '<caseValues><caseType>Accusative</caseType><plural>true</plural><value><!-- Gadget --></value></caseValues>' +
      '<caseValues><caseType>Nominative</caseType><plural>true</plural><value>Geräte</value></caseValues>' +
      '<fields><label>Farbe</label><name>Demo_Color__c</name><caseValues><plural>false</plural><value><!-- x --></value></caseValues></fields>'
  );
  assert.equal(de.caseValues.length, 2, 'caseValues inside fields are not the object name');
  assert.deepEqual(
    objectItems({ object: 'Demo_Gadget__c', language: 'de', translation: de, master: null, hasTab: false }).map((i) => i.type),
    [ITEM_TYPE.FIELD_LABEL]
  );
  const tab = objectItems({ object: 'Demo_Gadget__c', language: 'de', translation: de, master: de, hasTab: true }).find((i) => i.type === ITEM_TYPE.TAB);
  assert.equal(tab.translated, true);
  assert.equal(tab.translation, 'Geräte');
  assert.equal(tab.master, 'Geräte');
  assert.deepEqual(objectItems({ object: 'X__c', language: 'de', translation: null }), []);
});

test('custom labels: untranslated per language; package labels and labels written in that language are left out', () => {
  const labels = [
    { Id: '101000000000001AAA', Name: 'Demo_Hello', NamespacePrefix: null, Value: 'Hello', Language: 'en_US' },
    { Id: '101000000000002AAA', Name: 'Demo_Bye', NamespacePrefix: null, Value: 'Bye', Language: 'en_US' },
    { Id: '101000000000003AAA', Name: 'Pkg_Label', NamespacePrefix: 'acme', Value: 'Pkg', Language: 'en_US' },
    { Id: '101000000000004AAA', Name: 'Demo_Bonjour', NamespacePrefix: null, Value: 'Bonjour', Language: 'fr' },
  ];
  const locs = [
    { Id: '0Ap000000000001AAA', ExternalStringId: '101000000000001AAA', Language: 'fr', Value: 'Bonjour' },
    { ExternalStringId: '101000000000002AAA', Language: 'de' },
  ];
  const fr = labelItems(labels, locs, 'fr');
  assert.deepEqual(fr.map((i) => [i.name, i.translated]), [['Demo_Hello', true], ['Demo_Bye', false]]);
  assert.deepEqual(fr.map((i) => i.translation), ['Bonjour', null]);
  // A translated label opens its translation to edit; an untranslated one the New screen.
  assert.equal(buildGotoUrl(fr[0].goto, 'fr').autofill, null);
  assert.match(buildGotoUrl(fr[0].goto, 'fr').path, /0Ap000000000001AAA/);
  const bye = fr[1];
  assert.equal(bye.master, 'Bye');
  const url = buildGotoUrl(bye.goto, 'fr');
  assert.match(url.path, /ExternalStrings\/page\?address=%2F01j%2Fe%3FParent%3D101000000000002AAA/);
  assert.equal(url.autofill.lang, 'fr');
});

test('web tabs and global value set values: untranslated ones, with the master text', () => {
  const tabs = tabItems({
    language: 'fr',
    translation: parseTranslations(
      '<fullName>fr</fullName><customLabels><label><!-- Demo_Hello --></label><name>Demo_Hello</name></customLabels>' +
        '<customTabs><label><!-- Help Desk --></label><name>Demo_Help</name></customTabs><customTabs><label>Accueil</label><name>Demo_Home</name></customTabs>' +
        '<customTabs><label><!-- Pkg --></label><name>acme__Tab</name></customTabs>'
    ),
    master: parseTranslations('<fullName>en_US</fullName><customTabs><label><!-- Help Desk Home --></label><name>Demo_Help</name></customTabs>'),
  });
  assert.deepEqual(tabs.map((t) => [t.name, t.master, t.translated, t.translation]), [['Demo_Help', 'Help Desk Home', false, null], ['Demo_Home', 'Demo_Home', true, 'Accueil']]);
  assert.equal(tabs[0].goto.component, 'CustomTabDefinition');

  const values = parseValueSetTranslation(
    '<fullName>Demo_Regions-de</fullName><valueTranslation><masterLabel>North</masterLabel><translation>Nord</translation></valueTranslation>' +
      '<valueTranslation><masterLabel>South</masterLabel><translation><!-- South --></translation></valueTranslation>'
  );
  const vs = valueSetItems({ language: 'de', valueSet: { name: 'Demo_Regions', label: 'Regions' }, values });
  assert.deepEqual(vs.map((v) => [v.name, v.translated, v.translation]), [['Demo_Regions: North', true, 'Nord'], ['Demo_Regions: South', false, null]]);
  assert.equal(vs[1].goto.component, 'SharedPicklistDefinition');
  assert.equal(vs[1].goto.parent, 'Regions');
});

test('summarize: counts per language and type; missing items sorted by language order, type, object, name', () => {
  const it = (language, type, objectLabel, name, translated) => ({ language, type, objectLabel, name, translated });
  const out = summarize(
    [{ code: 'fr', name: 'French' }, { code: 'de', name: 'German' }],
    [
      it('de', ITEM_TYPE.TAB, null, 'T', false),
      it('fr', ITEM_TYPE.FIELD_LABEL, 'Gadget', 'b', false),
      it('fr', ITEM_TYPE.FIELD_LABEL, 'Account', 'z', false),
      it('fr', ITEM_TYPE.CUSTOM_LABEL, null, 'L', false),
      it('fr', ITEM_TYPE.FIELD_LABEL, 'Gadget', 'a', true),
      it('es', ITEM_TYPE.TAB, null, 'not active', false),
    ]
  );
  assert.deepEqual(out.missing.map((i) => `${i.language}:${i.name}`), ['fr:L', 'fr:z', 'fr:b', 'de:T']);
  assert.deepEqual(out.items.map((i) => `${i.language}:${i.name}`), ['fr:L', 'fr:z', 'fr:a', 'fr:b', 'de:T'], 'every checked item of an active language, translated ones too');
  assert.deepEqual(out.languages.map((l) => [l.code, l.checked, l.missing]), [['fr', 4, 3], ['de', 1, 1]]);
  assert.equal(out.languages[0].byType[ITEM_TYPE.FIELD_LABEL], 2);
  assert.equal(out.languages[0].byType[ITEM_TYPE.TAB], 0);
});

test('org default rows: every checked item once with its master text; labels written in another language left out', () => {
  const it = (language, type, name, master, extra = {}) => ({ language, type, objectLabel: null, name, master, translated: false, translation: null, goto: { page: 'x' }, ...extra });
  const rows = masterItems(
    [
      it('fr', ITEM_TYPE.FIELD_LABEL, 'A.b__c', 'Bee'),
      it('de', ITEM_TYPE.FIELD_LABEL, 'A.b__c', 'Bee', { translated: true, translation: 'Biene' }),
      it('de', ITEM_TYPE.CUSTOM_LABEL, 'Hello', 'Hello', { goto: { page: 'label', masterLanguage: 'en_US' } }),
      it('de', ITEM_TYPE.CUSTOM_LABEL, 'Bonjour', 'Bonjour', { goto: { page: 'label', masterLanguage: 'fr' } }),
    ],
    'en_US'
  );
  assert.deepEqual(
    rows.map((r) => [r.language, r.type, r.name, r.translated, r.translation, r.goto]),
    [
      ['en_US', ITEM_TYPE.CUSTOM_LABEL, 'Hello', true, 'Hello', null],
      ['en_US', ITEM_TYPE.FIELD_LABEL, 'A.b__c', true, 'Bee', null],
    ]
  );
});

test('report objects: own custom objects, and standard objects with own custom fields or record types', () => {
  const objects = [{ name: 'Account' }, { name: 'Case' }, { name: 'Lead' }, { name: 'Demo_Gadget__c' }, { name: 'acme__Pkg__c' }, { name: 'Demo_Setting__mdt' }];
  assert.deepEqual(reportObjects(objects, ['Account', 'Account', null, 'Ghost', 'Demo_Setting__mdt'], ['Case']), ['Account', 'Case', 'Demo_Gadget__c']);
});

test('the whole report only reads (GET queries and readMetadata) and lists the missing items per language', async () => {
  const calls = [];
  globalThis.fetch = async (u, init = {}) => {
    const url = decodeURIComponent(String(u));
    calls.push({ url, method: init.method || 'GET', body: init.body || '' });
    if (init.method === 'POST') {
      const names = [...String(init.body).matchAll(/<s:fullNames>([^<]+)<\/s:fullNames>/g)].map((m) => m[1]);
      const recs = names.map((n) => (n === 'Demo_Gadget__c-en_US' ? gadgetMaster : n === 'Demo_Gadget__c-fr' ? gadgetFr : record('X', `<fullName>${n}</fullName>`)));
      return { ok: true, text: async () => envelope(recs) };
    }
    if (/\/sobjects$/.test(url)) return { ok: true, json: async () => ({ sobjects: [{ name: 'Demo_Gadget__c', label: 'Gadget', custom: true }] }) };
    if (/userinfo/.test(url)) return { ok: true, json: async () => ({ language: 'en_US' }) };
    let rows = [];
    if (/FROM Organization/.test(url)) rows = [{ LanguageLocaleKey: 'en_US' }];
    else if (/FROM Translation/.test(url)) rows = [{ Language: 'fr', IsActive: true }, { Language: 'en_US', IsActive: true }];
    else if (/FROM ExternalString$/.test(url)) rows = [{ Id: '101000000000002AAA', Name: 'Demo_Bye', NamespacePrefix: null, Value: 'Bye', Language: 'en_US' }];
    else if (/FROM TabDefinition/.test(url)) rows = [
      { Name: 'Demo_Gadget__c', Label: 'Gadgets', IsCustom: true, SobjectName: 'Demo_Gadget__c' },
      { Name: 'Demo_Help', Label: 'Help Desk', IsCustom: true, SobjectName: null },
    ];
    return { ok: true, json: async () => ({ records: rows, done: true }) };
  };
  const steps = [];
  const out = await loadMissingTranslations({ host: 'report.my.salesforce.com', sid: 's' }, { onProgress: (s) => steps.push(s) });
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.languages.map((l) => [l.code, l.checked, l.missing]), [['fr', 10, 6]]);
  assert.deepEqual(out.missing.map((i) => i.type), [ITEM_TYPE.CUSTOM_LABEL, ITEM_TYPE.FIELD_LABEL, ITEM_TYPE.HELP_TEXT, ITEM_TYPE.PICKLIST_VALUE, ITEM_TYPE.RECORD_TYPE, ITEM_TYPE.TAB]);
  assert.ok(steps.length >= 3, 'progress lines while it reads');
  // Read-only: every POST is a readMetadata, everything else a GET.
  for (const c of calls) {
    if (c.method === 'POST') assert.match(c.body, /<s:readMetadata>/);
    else assert.equal(c.method, 'GET');
  }
  const meta = calls.filter((c) => c.method === 'POST').map((c) => c.body);
  assert.ok(meta.some((b) => /CustomObjectTranslation.*Demo_Gadget__c-en_US.*Demo_Gadget__c-fr/.test(b)));
  // The Translations file is large (every label, flow and report type): one language per call.
  const translations = meta.filter((b) => /<s:type>Translations<\/s:type>/.test(b)).map((b) => [...b.matchAll(/<s:fullNames>([^<]+)</g)].map((m) => m[1]));
  assert.deepEqual(translations.sort(), [['en_US'], ['fr']]);
});

test('CSV: header, one row per item, quoting, formula guard, BOM and CRLF', async () => {
  const { toCsv, csvCell, CSV_COLUMNS } = await import('../src/report.js');
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a, "b"'), '"a, ""b"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('-5'), "'-5");
  assert.equal(csvCell(null), '');
  const csv = toCsv(
    [
      { language: 'fr', type: ITEM_TYPE.FIELD_LABEL, objectLabel: 'Gadget', name: 'Demo_Gadget__c.Demo_Color__c', master: 'Coat, Color', translation: 'Couleur' },
      { language: 'de', type: ITEM_TYPE.CUSTOM_LABEL, objectLabel: null, name: 'Demo_Bye', master: 'Tschüss' },
    ],
    { languageNames: { fr: 'French' }, pageOf: (i) => (i.language === 'fr' ? 'https://demo.lightning.force.com/lightning/setup/LabelWorkbenchTranslate/home' : '') }
  );
  assert.ok(csv.startsWith('\uFEFF'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.equal(lines[1], 'fr,French,Field label,Gadget,Demo_Gadget__c.Demo_Color__c,"Coat, Color",Couleur,https://demo.lightning.force.com/lightning/setup/LabelWorkbenchTranslate/home');
  assert.equal(lines[2], 'de,German,Custom label,,Demo_Bye,Tschüss,,');
  assert.equal(lines[3], '');
});

test('column sort: A to Z and Z to A, ignoring case; empty cells last both ways; ties keep the report order', async () => {
  const { sortItems } = await import('../src/report.js');
  const it = (n, language, master, translation, objectLabel = null) => ({ n, language, type: ITEM_TYPE.FIELD_LABEL, objectLabel, name: `N${n}`, master, translated: translation != null, translation });
  const items = [it(1, 'fr', 'banana', null, 'Zeta'), it(2, 'de', 'Apple', 'Apfel'), it(3, 'fr', 'cherry', 'Cerise', 'alpha'), it(4, 'de', 'apple', null), it(5, 'fr', 'Item 10', 'x'), it(6, 'fr', 'Item 9', 'y')];
  const order = (key, dir) => sortItems(items, key, dir, { fr: 'French', de: 'German' }).map((i) => i.n);
  assert.deepEqual(order('master', 'asc'), [2, 4, 1, 3, 6, 5], 'case-insensitive, numbers in number order, ties keep order');
  assert.deepEqual(order('master', 'desc'), [5, 6, 3, 1, 2, 4]);
  assert.deepEqual(order('translation', 'asc'), [2, 3, 5, 6, 1, 4], 'missing translations last');
  assert.deepEqual(order('translation', 'desc'), [6, 5, 3, 2, 1, 4], 'missing translations last Z to A too');
  assert.deepEqual(order('object', 'asc'), [3, 1, 2, 4, 5, 6]);
  assert.deepEqual(order('language', 'asc'), [1, 3, 5, 6, 2, 4], 'by language name: French before German');
  assert.deepEqual(order(null), [1, 2, 3, 4, 5, 6], 'no column: the report order');
});
