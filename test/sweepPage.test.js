// Page metadata and page-area fixes from the UAT2 Account / Opportunity sweep (Nov 2026).
// FlexiPage shapes and DOM ids are copied from the real Buying Account record page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, buildGotoUrl, SOURCE } from '../src/locator.js';
import { loadFlexiPageComponent, loadValueSet } from '../src/sfApi.js';

const lbl = (Id, Name, Value, NamespacePrefix = null) => ({ Id, Name, MasterLabel: Name, NamespacePrefix, Value, Language: 'en_US' });
const org = {
  userLanguage: 'en_US',
  defaultLanguage: 'en_US',
  labelTranslations: [],
  objects: [
    { name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false },
    { name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', custom: false },
  ],
  tabs: [
    { Name: 'standard-Account', Label: 'Accounts', IsCustom: false, SobjectName: 'Account' },
    { Name: 'standard-Opportunity', Label: 'Opportunities', IsCustom: false, SobjectName: 'Opportunity' },
  ],
  apps: [],
  validationRules: [],
  customLabels: [
    lbl('101P00000000001', 'Territory', 'Territory'),
    lbl('101P00000000002', 'MA_Territory', 'Territory', 'maps'),
    lbl('101P00000000003', 'MA_Details', 'Details', 'maps'),
    lbl('101P00000000004', 'Value_Recorder', 'Value Recorder'),
    lbl('101P00000000005', 'MA_Account', 'Account', 'maps'),
    lbl('101P00000000006', 'Account_Label', 'Account'),
    lbl('101P00000000007', 'MA_Files', 'Files', 'maps'),
  ],
};
const account = {
  name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, recordTypeInfos: [], quickActions: [],
  fields: [
    { name: 'Name', label: 'Account Name', custom: false, type: 'string', picklistValues: [] },
    { name: 'Display_Name__c', label: 'Display Name', custom: true, type: 'string', inlineHelpText: 'Name shown to customers', picklistValues: [] },
    {
      name: 'Market_Unit_MST__c', label: 'Market Unit', custom: true, type: 'multipicklist',
      picklistValues: [{ label: 'Market Unit 1', value: 'MU1', active: true }],
    },
  ],
};
const FLEXI = 'forcegenerated-flexipage_buying_account_record_page_three_column_account__view_js___lmt___1794593739000';
const page = 'Buying Account Record Page Three Column';
const run = (text, extra = {}) => locate({ text, org, describes: [account], ...extra });
const tabHints = (id) => ({ tags: ['a', 'li', 'ul', 'lightning-tab-bar', 'div', 'flexipage-tabset2', FLEXI], tabRole: 'tab', componentIds: [id, 'flexipage_tabset'], flexipage: FLEXI });
const listHints = (id, header = true) => ({
  tags: ['span', 'a', 'h2', 'div', 'lst-list-view-manager-header', 'lst-related-list-view-manager', 'lst-dynamic-related-list', 'lst-related-list-single-container', 'flexipage-component2', FLEXI],
  listHeader: header, componentIds: [id], flexipage: FLEXI,
});

// ---------- sfApi: FlexiPage reader ----------

const flexiFetch = (urls) => async (u) => {
  urls.push(decodeURIComponent(u));
  const ci = (identifier, componentName, props) => ({ componentInstance: { identifier, componentName, componentInstanceProperties: Object.entries(props).map(([name, value]) => ({ name, value })) } });
  return {
    ok: true,
    json: async () => ({
      done: true,
      records: [{
        DeveloperName: 'Buying_Account_Record_Page_Three_Column', MasterLabel: page,
        Metadata: { flexiPageRegions: [{ itemInstances: [
          ci('flexipage_tab2', 'flexipage:tab', { body: 'Facet-52bb', title: 'Standard.Tab.detail' }),
          ci('flexipage_tab', 'flexipage:tab', { body: 'Facet-9574', title: '{!$Label.Territory}' }),
          ci('lst_dynamicRelatedList16', 'lst:dynamicRelatedList', { parentFieldApiName: 'Account.Id', relatedListApiName: 'Value_Recorders__r', relatedListLabel: 'Value Recorder' }),
          ci('force_relatedListSingleContainer15', 'force:relatedListSingleContainer', { parentFieldApiName: 'Account.Id', relatedListApiName: 'AttachedContentDocuments', relatedListComponentOverride: 'NONE' }),
        ] }] },
      }],
    }),
  };
};

test('M-03/M-09: FlexiPage reader returns the shown text per component kind, and finds tabs by their page id', async () => {
  const urls = [];
  globalThis.fetch = flexiFetch(urls);
  const s = { host: 'flexi-test.my.salesforce.com', sid: 's' };
  const tab = await loadFlexiPageComponent(s, FLEXI, 'flexipage_tab2Tab', ['Account']);
  assert.deepEqual([tab.id, tab.component, tab.label], ['flexipage_tab2', 'flexipage:tab', 'Standard.Tab.detail']);
  const rl = await loadFlexiPageComponent(s, FLEXI, 'lst_dynamicRelatedList16', ['Account']);
  assert.equal(rl.label, 'Value Recorder');
  assert.equal(rl.props.relatedListApiName, 'Value_Recorders__r');
  const files = await loadFlexiPageComponent(s, FLEXI, 'force_relatedListSingleContainer15', ['Account']);
  assert.equal(files.label, null);
  assert.equal(files.props.relatedListApiName, 'AttachedContentDocuments');
});

// ---------- locator: page components ----------

test('M-09: standard tab title Standard.Tab.detail → Salesforce standard tab name, above same-text managed labels', () => {
  const pc = { page, id: 'flexipage_tab2', component: 'flexipage:tab', label: 'Standard.Tab.detail', props: {} };
  const out = run('Details', { hints: tabHints('flexipage_tab2Tab'), pageComponent: pc });
  assert.equal(out.results[0].title, 'Salesforce text');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(!out.results.some((r) => r.key === 'area:lightningPageTab'), 'no contradictory generic tab card');
});

test('M-09: tab title {!$Label.Territory} confirms the unmanaged Territory label; plain text is App Builder text', () => {
  const pc = { page, id: 'flexipage_tab', component: 'flexipage:tab', label: '{!$Label.Territory}', props: {} };
  const out = run('Territory', { hints: tabHints('flexipage_tabTab'), pageComponent: pc });
  assert.equal(out.results[0].key, 'label:101P00000000001');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(!out.results.some((r) => r.key === 'area:lightningPageTab'));
  const plain = run('Additional Attributes', { hints: tabHints('flexipage_tab3Tab'), pageComponent: { page, id: 'flexipage_tab3', component: 'flexipage:tab', label: 'Additional Attributes', props: {} } });
  assert.equal(plain.results[0].title, 'Tab label typed in Lightning App Builder');
  assert.match(plain.results[0].steps[2], /click the tab → set Label to/);
});

test('M-03: related list label typed in App Builder (Value Recorder) → not translatable, no misleading TW card', () => {
  const pc = { page, id: 'lst_dynamicRelatedList16', component: 'lst:dynamicRelatedList', label: 'Value Recorder', props: { relatedListApiName: 'Value_Recorders__r', relatedListLabel: 'Value Recorder' } };
  const out = run('Value Recorder (3)', { hints: listHints('lst_dynamicRelatedList16'), pageComponent: pc });
  assert.equal(out.results[0].title, 'Related list label typed in Lightning App Builder');
  assert.equal(out.results[0].copy, '{!$Label.c.Value_Recorder}');
  assert.match(out.results[0].steps[2], /click the related list → set Related List Label to \{!\$Label\.c\.Value_Recorder\}/);
  assert.ok(!out.results.some((r) => r.key === 'area:relatedList'));
});

test('M-12: standard related list without a label (Files) → Salesforce standard related list', () => {
  const pc = { page, id: 'force_relatedListSingleContainer15', component: 'force:relatedListSingleContainer', label: null, props: { relatedListApiName: 'AttachedContentDocuments' } };
  const out = run('Files', { hints: listHints('force_relatedListSingleContainer15'), pageComponent: pc });
  assert.equal(out.results[0].title, 'Salesforce text');
  assert.match(out.results[0].subtitle, /AttachedContentDocuments/);
  assert.ok(!out.results.some((r) => r.key === 'area:relatedList'));
  // Object-backed standard list: the object's plural name.
  const opp = run('Opportunities', { hints: listHints('lst_dynamicRelatedList15'), pageComponent: { page, id: 'lst_dynamicRelatedList15', component: 'lst:dynamicRelatedList', label: null, props: { relatedListApiName: 'Opportunities' } } });
  assert.equal(opp.results[0].key, 'object:Opportunity');
  assert.equal(opp.results[0].confidence, 'confirmed');
});

test('M-12: a click inside related list rows is not treated as the list title', () => {
  const out = run('Sales Representative', { hints: listHints('lst_dynamicRelatedList9', false) });
  assert.ok(!out.results.some((r) => r.key === 'area:relatedList'));
  assert.ok(out.areas.includes('relatedListRow'));
  // Older content.js (no listHeader): unchanged.
  const old = run('Contacts', { hints: { tags: ['span', 'lst-related-list-single-container'] } });
  assert.ok(old.results.some((r) => r.key === 'area:relatedList'));
});

test('M-06: help (i) icon → the field help text, confirmed; the label card drops to page area', () => {
  const hints = { tags: ['svg', 'button', 'lightning-helptext', 'div', 'records-record-layout-item'], helpIcon: true, selectionNames: ['sfdc:RecordField.Account.Display_Name__c'] };
  const out = run('Display Name', { hints });
  assert.equal(out.results[0].key, 'help:Account.Display_Name__c');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(out.results[0].steps.includes('Aspect: Help Text'));
  assert.equal(out.results.find((r) => r.key === 'field:Account.Display_Name__c').confidence, 'context');
  // No field in the path: the field with this label and help text, same text only.
  const noField = run('Display Name', { hints: { tags: ['lightning-helptext'], helpIcon: true } });
  assert.equal(noField.results.find((r) => r.key === 'help:Account.Display_Name__c').confidence, 'exact');
});

test('M-11: object name above the record name in the highlights panel → Rename Tabs object, not labels', () => {
  const out = run('Account', { hints: { tags: ['span', 'div', 'records-highlights2', 'records-lwc-highlights-panel'] } });
  assert.equal(out.results[0].key, 'object:Account');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(!out.results.some((r) => r.source === SOURCE.CUSTOM_LABEL));
});

test('M-13: the record name in the highlights panel is record data', () => {
  const out = run('Example Buying Account', {
    hints: { tags: ['lightning-formatted-text', 'records-highlights2', 'records-lwc-highlights-panel'], recordTitle: true },
    record: { object: 'Account', id: '001000000000001AAA' },
  });
  assert.equal(out.results[0].key, 'value:Account.Name');
  assert.ok(out.results[0].notes.some((n) => /record name/.test(n)));
});

test('M-02: picklist field on a Global Value Set → TW Global Value Set tree under the value set label', () => {
  const vsOrg = { ...org, valueSets: { 'Account.Market_Unit_MST__c': { name: 'Market_Unit_LST', label: 'Market Unit', namespace: null } } };
  const r = locate({ text: 'Market Unit 1', org: vsOrg, describes: [account], hints: { selectionNames: ['sfdc:RecordField.Account.Market_Unit_MST__c'] } }).results[0];
  assert.equal(r.key, 'picklist:Account.Market_Unit_MST__c.MU1');
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.title, 'Global value set Market Unit: picklist value');
  assert.ok(r.steps.includes('Setup Component: Global Value Set'));
  assert.ok(!r.steps.some((s) => s.startsWith('Object:')));
  assert.equal(r.goto.component, 'SharedPicklistDefinition');
  assert.equal(r.goto.parent, 'Market Unit');
  assert.deepEqual(r.goto.rows, ['Market Unit 1', 'MU1']);
  // Without value set data: unchanged Picklist Value card.
  const plain = run('Market Unit 1').results[0];
  assert.ok(plain.steps.includes('Setup Component: Picklist Value'));
});

test('M-02: loadValueSet reads CustomField Metadata one row at a time, then the value set label', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    const url = decodeURIComponent(u);
    urls.push(url);
    const records = /SELECT Id FROM CustomField/.test(url)
      ? [{ Id: '00NVD000005T0kP2AS' }]
      : /SELECT Metadata FROM CustomField/.test(url)
        ? [{ Metadata: { valueSet: { valueSetName: 'Market_Unit_LST', restricted: true } } }]
        : [{ MasterLabel: 'Market Unit', NamespacePrefix: null }];
    return { ok: true, json: async () => ({ done: true, records }) };
  };
  const vs = await loadValueSet({ host: 'vs-test.my.salesforce.com', sid: 's' }, 'Account', 'Market_Unit_MST__c');
  assert.deepEqual(vs, { name: 'Market_Unit_LST', label: 'Market Unit', namespace: null });
  assert.match(urls[0], /EntityDefinition\.QualifiedApiName = 'Account' AND DeveloperName = 'Market_Unit_MST' AND NamespacePrefix = null/);
  assert.match(urls[1], /WHERE Id = '00NVD000005T0kP2AS'/);
  assert.match(urls[2], /FROM GlobalValueSet WHERE DeveloperName = 'Market_Unit_LST'/);
  assert.equal(await loadValueSet({ host: 'vs-test.my.salesforce.com', sid: 's' }, 'Account', 'Industry'), null, 'standard fields are skipped');
});

test('M-18: object name goto marks Plural or Singular on Step 1', () => {
  const plural = run('Accounts').results.find((r) => r.key === 'object:Account');
  assert.deepEqual(buildGotoUrl(plural.goto, 'fr', 'en_US').autofill, { page: 'renameStage', lang: 'fr', fieldLabel: null, plural: true });
  const single = run('Account').results.find((r) => r.key === 'object:Account');
  assert.equal(buildGotoUrl(single.goto, 'fr', 'en_US').autofill.plural, false);
});
