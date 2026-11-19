// Page metadata and page-area fixes from the Account / Opportunity sweep (Nov 2026).
// FlexiPage shapes and element paths as Salesforce returns them, with made-up names and Ids.
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
    lbl('101P00000000001', 'Workshop', 'Workshop'),
    lbl('101P00000000002', 'MA_Workshop', 'Workshop', 'acme'),
    lbl('101P00000000003', 'MA_Details', 'Details', 'acme'),
    lbl('101P00000000004', 'Demo_Recorder', 'Demo Recorder'),
    lbl('101P00000000005', 'MA_Account', 'Account', 'acme'),
    lbl('101P00000000006', 'Account_Label', 'Account'),
    lbl('101P00000000007', 'MA_Files', 'Files', 'acme'),
  ],
};
const account = {
  name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, recordTypeInfos: [], quickActions: [],
  fields: [
    { name: 'Name', label: 'Account Name', custom: false, type: 'string', picklistValues: [] },
    { name: 'Demo_Title__c', label: 'Demo Title', custom: true, type: 'string', inlineHelpText: 'Title shown on the page', picklistValues: [] },
    {
      name: 'Demo_Markets__c', label: 'Demo Market', custom: true, type: 'multipicklist',
      picklistValues: [{ label: 'Demo Market 1', value: 'DM1', active: true }],
    },
  ],
};
const FLEXI = 'forcegenerated-flexipage_demo_account_record_page_account__view_js___lmt___1';
const page = 'Demo Account Record Page';
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
        DeveloperName: 'Demo_Account_Record_Page', MasterLabel: page,
        Metadata: { flexiPageRegions: [{ itemInstances: [
          ci('flexipage_tab2', 'flexipage:tab', { body: 'Facet-1', title: 'Standard.Tab.detail' }),
          ci('flexipage_tab', 'flexipage:tab', { body: 'Facet-2', title: '{!$Label.Workshop}' }),
          ci('lst_dynamicRelatedList16', 'lst:dynamicRelatedList', { parentFieldApiName: 'Account.Id', relatedListApiName: 'Demo_Recorders__r', relatedListLabel: 'Demo Recorder' }),
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
  assert.equal(rl.label, 'Demo Recorder');
  assert.equal(rl.props.relatedListApiName, 'Demo_Recorders__r');
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

test('M-09: tab title {!$Label.Workshop} confirms the unmanaged Workshop label; plain text is App Builder text', () => {
  const pc = { page, id: 'flexipage_tab', component: 'flexipage:tab', label: '{!$Label.Workshop}', props: {} };
  const out = run('Workshop', { hints: tabHints('flexipage_tabTab'), pageComponent: pc });
  assert.equal(out.results[0].key, 'label:101P00000000001');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(!out.results.some((r) => r.key === 'area:lightningPageTab'));
  const plain = run('Extra Facts', { hints: tabHints('flexipage_tab3Tab'), pageComponent: { page, id: 'flexipage_tab3', component: 'flexipage:tab', label: 'Extra Facts', props: {} } });
  assert.equal(plain.results[0].title, 'Tab label typed in Lightning App Builder');
  assert.match(plain.results[0].steps[2], /click the tab → set Label to/);
});

test('M-03: related list label typed in App Builder (Demo Recorder) → not translatable, no misleading TW card', () => {
  const pc = { page, id: 'lst_dynamicRelatedList16', component: 'lst:dynamicRelatedList', label: 'Demo Recorder', props: { relatedListApiName: 'Demo_Recorders__r', relatedListLabel: 'Demo Recorder' } };
  const out = run('Demo Recorder (3)', { hints: listHints('lst_dynamicRelatedList16'), pageComponent: pc });
  assert.equal(out.results[0].title, 'Related list label typed in Lightning App Builder');
  assert.equal(out.results[0].copy, '{!$Label.c.Demo_Recorder}');
  assert.match(out.results[0].steps[2], /click the related list → set Related List Label to \{!\$Label\.c\.Demo_Recorder\}/);
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
  const out = run('Example Role', { hints: listHints('lst_dynamicRelatedList9', false) });
  assert.ok(!out.results.some((r) => r.key === 'area:relatedList'));
  assert.ok(out.areas.includes('relatedListRow'));
  // Older content.js (no listHeader): unchanged.
  const old = run('Contacts', { hints: { tags: ['span', 'lst-related-list-single-container'] } });
  assert.ok(old.results.some((r) => r.key === 'area:relatedList'));
});

test('M-06: help (i) icon → the field help text, confirmed; the label card drops to page area', () => {
  const hints = { tags: ['svg', 'button', 'lightning-helptext', 'div', 'records-record-layout-item'], helpIcon: true, selectionNames: ['sfdc:RecordField.Account.Demo_Title__c'] };
  const out = run('Demo Title', { hints });
  assert.equal(out.results[0].key, 'help:Account.Demo_Title__c');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(out.results[0].steps.includes('Aspect: Help Text'));
  assert.equal(out.results.find((r) => r.key === 'field:Account.Demo_Title__c').confidence, 'context');
  // No field in the path: the field with this label and help text, same text only.
  const noField = run('Demo Title', { hints: { tags: ['lightning-helptext'], helpIcon: true } });
  assert.equal(noField.results.find((r) => r.key === 'help:Account.Demo_Title__c').confidence, 'exact');
});

test('M-11: object name above the record name in the highlights panel → Rename Tabs object, not labels', () => {
  const out = run('Account', { hints: { tags: ['span', 'div', 'records-highlights2', 'records-lwc-highlights-panel'] } });
  assert.equal(out.results[0].key, 'object:Account');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(!out.results.some((r) => r.source === SOURCE.CUSTOM_LABEL));
});

test('M-13: the record name in the highlights panel is record data', () => {
  const out = run('Example Account 42', {
    hints: { tags: ['lightning-formatted-text', 'records-highlights2', 'records-lwc-highlights-panel'], recordTitle: true },
    record: { object: 'Account', id: '001000000000001AAA' },
  });
  assert.equal(out.results[0].key, 'value:Account.Name');
  assert.ok(out.results[0].notes.some((n) => /record name/.test(n)));
});

test('M-02: picklist field on a Global Value Set → TW Global Value Set tree under the value set label', () => {
  const vsOrg = { ...org, valueSets: { 'Account.Demo_Markets__c': { name: 'Demo_Market_List', label: 'Demo Market', namespace: null } } };
  const r = locate({ text: 'Demo Market 1', org: vsOrg, describes: [account], hints: { selectionNames: ['sfdc:RecordField.Account.Demo_Markets__c'] } }).results[0];
  assert.equal(r.key, 'picklist:Account.Demo_Markets__c.DM1');
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.title, 'Global value set Demo Market: picklist value');
  assert.ok(r.steps.includes('Setup Component: Global Value Set'));
  assert.ok(!r.steps.some((s) => s.startsWith('Object:')));
  assert.equal(r.goto.component, 'SharedPicklistDefinition');
  assert.equal(r.goto.parent, 'Demo Market');
  assert.deepEqual(r.goto.rows, ['Demo Market 1', 'DM1']);
  // Without value set data: unchanged Picklist Value card.
  const plain = run('Demo Market 1').results[0];
  assert.ok(plain.steps.includes('Setup Component: Picklist Value'));
});

test('M-02: loadValueSet reads CustomField Metadata one row at a time, then the value set label', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    const url = decodeURIComponent(u);
    urls.push(url);
    const records = /SELECT Id FROM CustomField/.test(url)
      ? [{ Id: '00N000000000001AAA' }]
      : /SELECT Metadata FROM CustomField/.test(url)
        ? [{ Metadata: { valueSet: { valueSetName: 'Demo_Market_List', restricted: true } } }]
        : [{ MasterLabel: 'Demo Market', NamespacePrefix: null }];
    return { ok: true, json: async () => ({ done: true, records }) };
  };
  const vs = await loadValueSet({ host: 'vs-test.my.salesforce.com', sid: 's' }, 'Account', 'Demo_Markets__c');
  assert.deepEqual(vs, { name: 'Demo_Market_List', label: 'Demo Market', namespace: null });
  assert.match(urls[0], /EntityDefinition\.QualifiedApiName = 'Account' AND DeveloperName = 'Demo_Markets' AND NamespacePrefix = null/);
  assert.match(urls[1], /WHERE Id = '00N000000000001AAA'/);
  assert.match(urls[2], /FROM GlobalValueSet WHERE DeveloperName = 'Demo_Market_List'/);
  assert.equal(await loadValueSet({ host: 'vs-test.my.salesforce.com', sid: 's' }, 'Account', 'Industry'), null, 'standard fields are skipped');
});

test('M-18: object name goto marks Plural or Singular on Step 1', () => {
  const plural = run('Accounts').results.find((r) => r.key === 'object:Account');
  assert.deepEqual(buildGotoUrl(plural.goto, 'fr', 'en_US').autofill, { page: 'renameStage', lang: 'fr', fieldLabel: null, plural: true });
  const single = run('Account').results.find((r) => r.key === 'object:Account');
  assert.equal(buildGotoUrl(single.goto, 'fr', 'en_US').autofill.plural, false);
});
