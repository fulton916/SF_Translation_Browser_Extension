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
