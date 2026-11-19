// Developer Edition sweep (Nov 2026, tester A): one test per confirmed finding, using the failing example
// with made-up names and Ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, SOURCE } from '../src/locator.js';
import { loadNearestFlexiPageComponent } from '../src/sfApi.js';

const baseOrg = {
  userLanguage: 'en_US',
  defaultLanguage: 'en_US',
  labelTranslations: [],
  objects: [
    { name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false },
    { name: 'Demo_Gadget__c', label: 'Gadget', labelPlural: 'Gadgets', custom: true },
  ],
  tabs: [
    { Name: 'standard-Account', Label: 'Accounts', IsCustom: false, SobjectName: 'Account' },
    { Name: 'Demo_Gadget__c', Label: 'Gadgets', IsCustom: true, SobjectName: 'Demo_Gadget__c' },
  ],
  apps: [],
  validationRules: [],
  customLabels: [],
};
const gadget = {
  name: 'Demo_Gadget__c', label: 'Gadget', labelPlural: 'Gadgets', custom: true, quickActions: [], recordTypeInfos: [],
  fields: [{ name: 'Demo_Color__c', label: 'Coat Color', custom: true, type: 'string', picklistValues: [] }],
};

test('A-26: the error message under a field is its validation rule, not the field', () => {
  const org = {
    ...baseOrg,
    validationRules: [{ Id: '03d000000000001AAA', ValidationName: 'Demo_Color_Required', ErrorMessage: 'Shipped gadgets need a coat color.', EntityDefinition: { QualifiedApiName: 'Demo_Gadget__c' } }],
  };
  const hints = { selectionNames: ['sfdc:RecordField.Demo_Gadget__c.Demo_Color__c'], fieldPart: 'error' };
  const rs = locate({ text: 'Shipped gadgets need a coat color.', org, describes: [gadget], hints }).results;
  assert.equal(rs[0].key, 'vr:03d000000000001AAA');
  assert.equal(rs[0].confidence, 'confirmed');
  assert.equal(rs[0].notes[0], 'You pointed at the error message shown under the field Coat Color.');
  assert.ok(!rs.some((r) => r.key.startsWith('value:')), 'not "Record data"');
});

test('A-16: text in a Lightning App Builder Rich Text component → Admin work required', () => {
  const hints = {
    tags: ['p', 'div', 'div', 'div', 'flexipage-aura-wrapper', 'slot', 'flexipage-component2', 'flexipage-tab2'],
    auraClasses: ['uiOutputRichText', 'flexipageRichText'],
    componentIds: ['demo_richText'],
    tabRole: 'tabpanel',
  };
  const out = locate({ text: 'Ask the lead before shipping.', org: baseOrg, describes: [gadget], hints });
  assert.ok(out.areas.includes('richText'));
  const r = out.results[0];
  assert.equal(r.key, 'area:richText');
  assert.equal(r.source, SOURCE.NOT_TRANSLATABLE);
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.title, 'Rich text typed in Lightning App Builder');
  assert.ok(!out.results.some((x) => x.key === 'area:lightningPageTab'));
});

test('A-23 / B-10: a list in the standard Related Lists component names the child lookup field and object', () => {
  const account = { name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, fields: [], recordTypeInfos: [], quickActions: [] };
  // As background.js builds it from the title link (.../related/Demo_Gadgets__r/view) and the describes.
  const pc = {
    page: null, id: null, component: 'force:relatedListSingleContainer', label: null, props: { relatedListApiName: 'Demo_Gadgets__r' },
    child: { childSObject: 'Demo_Gadget__c', field: 'Demo_Account__c', relationshipName: 'Demo_Gadgets__r', fieldLabel: 'Gadget Account', objectLabel: 'Gadget' },
  };
  const hints = {
    tags: ['span', 'a', 'h2', 'div', 'lst-list-view-manager-header', 'lst-related-list-view-manager', 'article', 'lst-related-list-single-container', 'lst-related-list-container', 'flexipage-component2'],
    listHeader: true, componentIds: ['force_relatedListContainer'], relatedListApi: 'Demo_Gadgets__r',
  };
  const out = locate({ text: 'Account Gadgets (1)', org: baseOrg, describes: [account], hints, pageComponent: pc });
  const r = out.results[0];
  assert.equal(r.key, 'rellist:Demo_Gadget__c.Demo_Account__c');
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.subtitle, 'Demo_Gadgets__r in the Related Lists component');
  assert.equal(r.goto.object, 'Demo_Gadget__c', 'the child object, not the parent Account');
  assert.equal(r.goto.aspect, 'relationshiplabel');
  assert.ok(!out.results.some((x) => x.key === 'area:relatedList'));
  // Without the child: the generic card names no object and leaves auto-fill's Object alone.
  const generic = locate({ text: 'Account Gadgets', org: baseOrg, describes: [account], hints }).results.find((x) => x.key === 'area:relatedList');
  assert.ok(generic.steps.includes('Object: the child object'));
  assert.equal(generic.goto.objectLabel, null);
});

test('A-10 / A-13: a custom object\'s standard fields never get a Rename Tabs and Labels card', () => {
  const g = {
    ...gadget,
    recordTypeInfos: [{ name: 'Standard Gadget', developerName: 'Standard_Gadget', master: false, recordTypeId: '012000000000001AAA' }],
    fields: [
      { name: 'RecordTypeId', label: 'Record Type ID', custom: false, type: 'reference', picklistValues: [] },
      { name: 'OwnerId', label: 'Owner ID', custom: false, type: 'reference', picklistValues: [] },
      { name: 'IsDeleted', label: 'Deleted', custom: false, type: 'boolean', picklistValues: [] },
    ],
  };
  const hints = { selectionNames: ['sfdc:RecordField.Demo_Gadget__c.RecordTypeId'], fieldPart: 'value' };
  const out = locate({ text: 'Standard Gadget', org: baseOrg, describes: [g], hints });
  assert.equal(out.results[0].key, 'rt:Demo_Gadget__c.Standard_Gadget');
  for (const text of ['Record Type ID', 'Owner', 'Deleted']) {
    const all = [...locate({ text, org: baseOrg, describes: [g] }).results, ...out.results];
    assert.ok(!all.some((r) => r.source === SOURCE.RENAME_TABS && r.key.startsWith('field:')), text);
  }
  const owner = locate({ text: 'Owner ID', org: baseOrg, describes: [g] }).results.find((r) => r.key === 'field:Demo_Gadget__c.OwnerId');
  assert.equal(owner.source, SOURCE.SALESFORCE);
  assert.equal(owner.subtitle, 'Standard field Demo_Gadget__c.OwnerId');
});

test('A-03 / A-24 / A-12 / A-27: wording of picklist, button and Object Manager cards', () => {
  const g = {
    ...gadget,
    fields: [{ name: 'Demo_Status__c', label: 'Gadget Status', custom: true, type: 'picklist', picklistValues: [{ label: 'Drafting', value: 'Drafting', active: true }] }],
  };
  const known = { ...baseOrg, valueSets: { 'Demo_Gadget__c.Demo_Status__c': { name: null, values: [{ value: 'Drafting', label: 'Drafting', active: true }] } } };
  const gvsNote = (r) => r.notes.some((n) => /Global Value Set/.test(n));
  assert.ok(!gvsNote(locate({ text: 'Drafting', org: known, describes: [g] }).results[0]), 'value set read: no note');
  assert.ok(gvsNote(locate({ text: 'Drafting', org: baseOrg, describes: [g] }).results[0]), 'value set not read: note stays');
  const std = { ...gadget, name: 'Account', label: 'Account', custom: false, fields: [{ name: 'Rating', label: 'Rating', custom: false, type: 'picklist', picklistValues: [{ label: 'Warm', value: 'Warm', active: true }] }] };
  assert.ok(!gvsNote(locate({ text: 'Warm', org: baseOrg, describes: [std] }).results[0]), 'standard picklist: no note');

  const btn = locate({ text: 'Open Gadget Docs', org: baseOrg, describes: [gadget], hints: { selectionNames: ['sfdc:CustomButton.Demo_Gadget__c.Demo_Open_Docs'] } }).results[0];
  assert.ok(btn.steps.includes('Find the row: Open Gadget Docs (Demo_Open_Docs)'));

  const om = locate({ text: 'Coat Color', org: baseOrg, describes: [gadget], pageUrls: ['https://x.my.salesforce-setup.com/lightning/setup/ObjectManager/Demo_Gadget__c/FieldsAndRelationships/view'] });
  assert.equal(om.results[0].key, 'field:Demo_Gadget__c.Demo_Color__c');
  assert.ok(!om.results.some((r) => r.source === SOURCE.SALESFORCE));
  // A Setup heading that matches nothing of the object is still Salesforce text.
  const heading = locate({ text: 'Fields & Relationships', org: baseOrg, describes: [gadget], pageUrls: ['https://x.my.salesforce-setup.com/lightning/setup/ObjectManager/Demo_Gadget__c/FieldsAndRelationships/view'] });
  assert.equal(heading.results[0].source, SOURCE.SALESFORCE);
});

test('A-17 / B-13: flow screen text names the flow, screen, screen component and aspect', () => {
  const pc = {
    page: 'Demo Gadget Record Page', id: 'demo_flow', component: 'flowruntime:interview', label: null, props: { flowName: 'Demo_Gadget_Intake' },
    flow: {
      name: 'Demo_Gadget_Intake', label: 'Demo Gadget Intake', version: 1,
      screens: [{ name: 'Intake_Screen', label: 'Gadget Intake', fields: [
        { name: 'Intro_Text', fieldType: 'DisplayText', fieldText: '<p>Tell us about the gadget.</p>', helpText: null },
        { name: 'Gadget_Nickname', fieldType: 'InputField', fieldText: 'Gadget Nickname', helpText: null },
      ] }],
    },
  };
  const hints = { tags: ['p', 'span', 'lightning-formatted-rich-text', 'flowruntime-display-text-lwc', 'flowruntime-flow', 'flexipage-component2'], componentIds: ['demo_flow'] };
  const r = locate({ text: 'Tell us about the gadget.', org: baseOrg, describes: [gadget], hints, pageComponent: pc }).results[0];
  assert.equal(r.key, 'flow:Demo_Gadget_Intake.Intake_Screen.Intro_Text');
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.title, 'Flow screen text: Demo Gadget Intake');
  assert.deepEqual(r.steps.slice(-5), ['Flow: Demo Gadget Intake', 'Flow Component: Screen Component', 'Screen: Gadget Intake', 'Screen Component: Intro_Text', 'Aspect: Description']);
  assert.deepEqual(r.goto.flow, { label: 'Demo Gadget Intake', name: 'Demo_Gadget_Intake', component: 'Screen Component', screen: 'Gadget Intake', screenName: 'Intake_Screen', screenComponent: 'Intro_Text', aspect: 'Description' });
  assert.equal(r.goto.rows[0], '<p>Tell us about the gadget.</p>');
  assert.equal(r.goto.rowMatch, 'richText');
  const input = locate({ text: 'Gadget Nickname', org: baseOrg, describes: [gadget], hints, pageComponent: pc }).results.find((x) => x.key.startsWith('flow:'));
  assert.equal(input.goto.flow.aspect, 'Label');
  // No flow metadata: no instruction sentence is used as a row name.
  const generic = locate({ text: 'Tell us about the gadget.', org: baseOrg, describes: [gadget], hints }).results.find((x) => x.key === 'area:flow');
  assert.deepEqual(generic.goto.rows, ['Tell us about the gadget.']);
  assert.ok(!generic.steps.some((s) => /pick the flow and version/.test(s)));
});

test('A-15: a page with custom component identifiers is read; a {!$Label} tab title gets only the label card', async () => {
  const ci = (identifier, componentName, props) => ({ componentInstance: { identifier, componentName, componentInstanceProperties: Object.entries(props).map(([name, value]) => ({ name, value })) } });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      done: true,
      records: [{
        DeveloperName: 'Demo_Gadget_Record_Page', MasterLabel: 'Demo Gadget Record Page',
        Metadata: { flexiPageRegions: [
          { itemInstances: [ci('demo_tab_greeting', 'flexipage:tab', { body: 'Facet-demo', title: '{!$Label.Demo_Greeting}' })] },
          { itemInstances: [ci('demo_tabset', 'flexipage:tabset', { tabs: 'Facet-demo-tabs' })] },
        ] },
      }],
    }),
  });
  const FLEXI = 'forcegenerated-flexipage_demo_gadget_record_page_demo_gadget__c__view_js___lmt___1';
  const s = { host: 'devorg-test.my.salesforce.com', sid: 's' };
  // Nearest first, as content.js lists them: the tab's page element, then its tab set.
  const pc = await loadNearestFlexiPageComponent(s, FLEXI, ['demo_tab_greetingTab', 'demo_tabset'], ['Demo_Gadget__c']);
  assert.deepEqual([pc.id, pc.component, pc.label], ['demo_tab_greeting', 'flexipage:tab', '{!$Label.Demo_Greeting}']);

  const org = { ...baseOrg, customLabels: [{ Id: '101000000000001', Name: 'Demo_Greeting', MasterLabel: 'Demo_Greeting', NamespacePrefix: null, Value: 'Welcome To The Gadget Shop', Language: 'en_US' }] };
  const hints = { tags: ['a', 'li', 'ul', 'lightning-tab-bar', 'div', FLEXI], tabRole: 'tab', componentIds: ['demo_tab_greetingTab', 'demo_tabset'], flexipage: FLEXI };
  const out = locate({ text: 'Welcome To The Gadget Shop', org, describes: [gadget], hints, pageComponent: pc });
  assert.equal(out.results[0].key, 'label:101000000000001');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(!out.results.some((r) => r.key === 'area:lightningPageTab' || r.key.startsWith('builder:')));
});
