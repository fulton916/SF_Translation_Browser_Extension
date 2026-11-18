// Large test sandbox sweep (Nov 2026): one test per confirmed finding, using the failing example with
// made-up names and Ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, pathsForRecord, buildGotoUrl, renameFieldCandidates, contextObjects, SOURCE } from '../src/locator.js';

const lbl = (Id, Name, Value, NamespacePrefix = null) => ({ Id, Name, MasterLabel: Name, NamespacePrefix, Value, Language: 'en_US' });

const RT_RETAIL = '012000000000001AAA';
const RT_DESIGN = '012000000000002AAA';
const baseOrg = {
  userLanguage: 'en_US',
  defaultLanguage: 'en_US',
  labelTranslations: [],
  objects: [
    { name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false },
    { name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', custom: false },
    { name: 'Contact', label: 'Contact', labelPlural: 'Contacts', custom: false },
  ],
  tabs: [
    { Name: 'standard-Account', Label: 'Accounts', IsCustom: false, SobjectName: 'Account' },
    { Name: 'standard-Opportunity', Label: 'Opportunities', IsCustom: false, SobjectName: 'Opportunity' },
    { Name: 'standard-Contact', Label: 'Contacts', IsCustom: false, SobjectName: 'Contact' },
  ],
  apps: [],
  validationRules: [],
  customLabels: [],
};

// ---------- SB-01: paths belong to one record type ----------

const GUIDE_LINE = 'Review the opportunity information with the team';
const pathOrg = {
  ...baseOrg,
  customLabels: [lbl('101D00000000001', 'MA_Connect', 'Sketch', 'acme')],
  pathSteps: [
    { Id: '1CF000000000011', DeveloperName: `X11111111111111_01J000000000001AAA_${RT_RETAIL}_Opportunity_StageName`, Language: 'en_US', Info: `<ol><li>${GUIDE_LINE}</li><li>Pick the next date</li></ol>` },
    { Id: '1CF000000000012', DeveloperName: `X22222222222222_01J000000000002AAA_${RT_DESIGN}_Opportunity_Demo_Mid_Stage`, Language: 'en_US', Info: `<ol><li>${GUIDE_LINE}</li><li>List the designers</li></ol>` },
  ],
  paths: [
    { DeveloperName: 'Default_Opportunity', MasterLabel: 'Default', SobjectType: 'Opportunity', SobjectProcessField: 'StageName', RecordTypeId: null, IsActive: false },
    { DeveloperName: 'Retail_Path', MasterLabel: 'Retail Path', SobjectType: 'Opportunity', SobjectProcessField: 'StageName', RecordTypeId: RT_RETAIL, IsActive: true },
    { DeveloperName: 'Design_Path', MasterLabel: 'Design Path', SobjectType: 'Opportunity', SobjectProcessField: 'Demo_Mid_Stage__c', RecordTypeId: RT_DESIGN, IsActive: true },
  ],
};
const opp = {
  name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', custom: false, quickActions: [],
  recordTypeInfos: [
    { name: 'Retail', developerName: 'Retail', master: false, recordTypeId: RT_RETAIL },
    { name: 'Design', developerName: 'Design', master: false, recordTypeId: RT_DESIGN },
  ],
  fields: [
    { name: 'StageName', label: 'Stage', custom: false, type: 'picklist', picklistValues: [{ label: 'Sketch', value: 'Sketch', active: true }, { label: 'Closed Won', value: 'Closed Won', active: true }] },
    { name: 'Demo_Mid_Stage__c', label: 'Mid Stage', custom: true, type: 'picklist', picklistValues: [{ label: 'Sketch', value: 'SKETCH', active: true }] },
  ],
};
const chevron = { tags: ['span', 'a', 'li', 'ul', 'div'], auraClasses: ['runtime_sales_pathassistantPathAssistantTabSet', 'runtime_sales_pathassistantPathAssistant'] };
const guidance = { tags: ['li', 'ol', 'div'], auraClasses: ['uiOutputRichText', 'runtime_sales_pathassistantPathAssistantInfo', 'runtime_sales_pathassistantPathAssistant'] };
const oppRecord = (recordTypeId) => ({ object: 'Opportunity', id: '006000000000001AAA', recordTypeId });
const runOpp = (text, hints, record) => locate({ text, org: pathOrg, describes: [opp], hints, record }).results;

test('SB-01: pathsForRecord picks the record type\'s own path', () => {
  const names = (rt) => pathsForRecord(pathOrg.paths, 'Opportunity', oppRecord(rt)).map((p) => p.DeveloperName);
  assert.deepEqual(names(RT_DESIGN), ['Design_Path']);
  assert.deepEqual(names(RT_RETAIL.slice(0, 15)), ['Retail_Path']);
  assert.deepEqual(names(undefined), ['Retail_Path', 'Design_Path'], 'record type not known: every active path');
  assert.deepEqual(names('012000000000003AAA'), [], 'record type without a path, and no master path');
});

test('SB-01: a chevron on a Design Opportunity confirms Mid Stage only, not StageName', () => {
  const rs = runOpp('Sketch', chevron, oppRecord(RT_DESIGN));
  assert.equal(rs[0].key, 'picklist:Opportunity.Demo_Mid_Stage__c.SKETCH');
  assert.equal(rs[0].confidence, 'confirmed');
  assert.equal(rs.find((r) => r.key === 'picklist:Opportunity.StageName.Sketch').confidence, 'exact');
  // A Retail Opportunity: the other way round.
  const sales = runOpp('Sketch', chevron, oppRecord(RT_RETAIL));
  assert.equal(sales[0].key, 'picklist:Opportunity.StageName.Sketch');
  assert.equal(sales.find((r) => r.key === 'picklist:Opportunity.Demo_Mid_Stage__c.SKETCH').confidence, 'exact');
});

test('SB-01: record type not known and two paths match → neither is confirmed', () => {
  const rs = runOpp('Sketch', chevron, { object: 'Opportunity', id: '006000000000001AAA' });
  assert.ok(!rs.some((r) => r.confidence === 'confirmed'));
  assert.ok(rs.find((r) => r.key === 'picklist:Opportunity.Demo_Mid_Stage__c.SKETCH').notes[0].includes('if this record shows that path'));
});

test('SB-01: guidance of another record type\'s path is not confirmed', () => {
  const rs = runOpp('opportunity information', guidance, oppRecord(RT_RETAIL));
  const sales = rs.find((r) => r.key === 'path:1CF000000000011');
  const spec = rs.find((r) => r.key === 'path:1CF000000000012');
  assert.equal(sales.confidence, 'confirmed');
  assert.equal(rs[0], sales);
  assert.ok(!spec || spec.confidence !== 'confirmed');
  const full = runOpp(GUIDE_LINE, guidance, oppRecord(RT_RETAIL));
  const spec2 = full.find((r) => r.key === 'path:1CF000000000012');
  assert.equal(spec2.confidence, 'exact');
  assert.match(spec2.notes[0], /record type Design, not this record/);
});

// ---------- SB-02: Rename Tabs Step 2 shows the master label, not the renamed one ----------

test('SB-02: Go to translation for a renamed standard field also looks for its master label on Step 2', () => {
  const account = {
    name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, recordTypeInfos: [], quickActions: [],
    fields: [
      { name: 'BillingAddress', label: 'Billing Address/Main Address', custom: false, type: 'address', picklistValues: [] },
      { name: 'ParentId', label: 'Parent Account ID', custom: false, type: 'reference', picklistValues: [] },
    ],
  };
  const r = locate({ text: 'Billing Address/Main Address', org: baseOrg, describes: [account] }).results.find((x) => x.key === 'field:Account.BillingAddress');
  const b = buildGotoUrl(r.goto, 'de', 'en_US');
  assert.equal(b.autofill.page, 'renameStage');
  assert.deepEqual(b.autofill.candidates, ['Billing Address/Main Address', 'BillingAddress', 'Billing Address', 'Main Address']);
  // Step 2's first column says "Billing Address": one of the candidates equals it.
  assert.ok(b.autofill.candidates.some((c) => c.toLowerCase() === 'billing address'));
  assert.deepEqual(renameFieldCandidates('Parent Account ID', 'ParentId'), ['Parent Account ID', 'ParentId', 'Parent Id', 'Parent']);
  assert.deepEqual(renameFieldCandidates('Account Number', 'AccountNumber'), ['Account Number', 'AccountNumber']);
});

// ---------- SB-03: field labels and values in the highlights panel (compact layout) ----------

const hlAccount = {
  name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, recordTypeInfos: [], quickActions: [],
  fields: [
    { name: 'AccountNumber', label: 'Account Number', custom: false, type: 'string', picklistValues: [] },
    { name: 'BillingAddress', label: 'Billing Address/Main Address', custom: false, type: 'address', picklistValues: [] },
  ],
};
const hlOrg = { ...baseOrg, customLabels: [lbl('101D00000000002', 'Account_Number', 'Account Number'), lbl('101D00000000003', 'Billing_Address', 'Billing Address')] };
// Real composed path: p.slds-text-title > div > records-highlights-details-item > … records-highlights2.
const hlHints = (fieldPart, highlightsLabel) => ({
  tags: ['p', 'div', 'records-highlights-details-item', 'slot', 'div', 'records-highlights2', 'records-lwc-highlights-panel'],
  fieldPart, highlightsLabel,
});
const hlRecord = { object: 'Account', id: '001000000000001AAA' };

test('SB-03: a highlights panel field label is the field, not the same-text custom label', () => {
  const out = locate({ text: 'Account Number', org: hlOrg, describes: [hlAccount], hints: hlHints('label', 'Account Number'), record: hlRecord });
  assert.ok(out.areas.includes('highlightsField') && !out.areas.includes('highlights'));
  assert.equal(out.results[0].key, 'field:Account.AccountNumber');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.equal(out.results.find((r) => r.key === 'label:101D00000000002').confidence, 'exact');
  // Partial highlight of a renamed label: the item's label still names the field.
  const part = locate({ text: 'Billing Address', org: hlOrg, describes: [hlAccount], hints: hlHints('label', 'Billing Address/Main Address'), record: hlRecord });
  assert.equal(part.results[0].key, 'field:Account.BillingAddress');
  assert.equal(part.results[0].confidence, 'confirmed');
});

test('SB-03: a highlights panel value is record data of that field', () => {
  const out = locate({ text: 'A-100200', org: hlOrg, describes: [hlAccount], hints: hlHints('value', 'Account Number'), record: hlRecord });
  assert.equal(out.results[0].key, 'value:Account.AccountNumber');
  assert.equal(out.results[0].source, SOURCE.NOT_TRANSLATABLE);
});

// ---------- SB-04 / SB-10: quick actions from page metadata ----------

const contact = {
  name: 'Contact', label: 'Contact', labelPlural: 'Contacts', custom: false, recordTypeInfos: [], fields: [],
  quickActions: [
    { label: 'New Contact', name: 'NewContact', type: 'Create' },
    { label: 'Log a Visit', name: 'Contact.Demo_Log_Visit', type: 'Create' },
  ],
};

test('SB-04: a FeedItem action (New Note) is a Salesforce standard action, not a TW Action', () => {
  const hints = { selectionNames: ['sfdc:QuickAction.FeedItem.ContentNote'], objectApiNames: ['Contact'] };
  assert.deepEqual(contextObjects([], hints), ['Contact']);
  const out = locate({ text: 'New Note', org: baseOrg, describes: [contact], hints });
  assert.equal(out.results[0].key, 'stdaction:FeedItem.ContentNote');
  assert.equal(out.results[0].source, SOURCE.NOT_TRANSLATABLE);
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(!out.results.some((r) => r.key.startsWith('qa:')));
  assert.deepEqual(contextObjects([], { selectionNames: ['sfdc:QuickAction.Global.NewContact'] }), []);
});

test('SB-04: an object action missing from the loaded action list is not confirmed', () => {
  const out = locate({ text: 'Send Demo Note', org: baseOrg, describes: [contact], hints: { selectionNames: ['sfdc:QuickAction.Contact.Demo_Send_Note'] } });
  const r = out.results.find((x) => x.key === 'qa:Contact.Demo_Send_Note');
  assert.equal(r.confidence, 'exact');
  const listed = locate({ text: 'Log a Visit', org: baseOrg, describes: [contact], hints: { selectionNames: ['sfdc:QuickAction.Contact.Demo_Log_Visit'] } });
  assert.equal(listed.results[0].key, 'qa:Contact.Demo_Log_Visit');
  assert.equal(listed.results[0].confidence, 'confirmed');
});

test('SB-10: a global action shows once (Global.NewContact and NewContact are the same action)', () => {
  const out = locate({ text: 'New Contact', org: baseOrg, describes: [contact], hints: { selectionNames: ['sfdc:QuickAction.Global.NewContact'] } });
  const qas = out.results.filter((r) => r.key.startsWith('qa:'));
  assert.equal(qas.length, 1);
  assert.equal(qas[0].confidence, 'confirmed');
  assert.equal(qas[0].goto.object, 'Global');
});

// ---------- SB-05: the path's generic "Closed" step ----------

test('SB-05: the Closed chevron is Salesforce path text; same-word labels, fields and record types drop', () => {
  const org = { ...pathOrg, customLabels: [lbl('101D00000000004', 'Demo_Closed', 'Closed'), lbl('101D00000000005', 'MA_Closed', 'Closed', 'acme')] };
  const o = {
    ...opp,
    recordTypeInfos: [...opp.recordTypeInfos, { name: 'Closed', developerName: 'Closed', master: false, recordTypeId: '012000000000009AAA' }],
    fields: [
      ...opp.fields,
      { name: 'IsClosed', label: 'Closed', custom: false, type: 'boolean', picklistValues: [] },
      { name: 'ForecastCategory', label: 'Forecast Category', custom: false, type: 'picklist', picklistValues: [{ label: 'Closed', value: 'Closed', active: true }] },
    ],
  };
  const rs = locate({ text: 'Closed', org, describes: [o], hints: chevron, record: oppRecord(RT_RETAIL) }).results;
  assert.equal(rs[0].key, 'sfdctext:pathClosed');
  assert.equal(rs[0].confidence, 'confirmed');
  assert.equal(rs[0].source, SOURCE.NOT_TRANSLATABLE);
  assert.ok(!rs.some((r) => r.source === SOURCE.CUSTOM_LABEL || r.key.startsWith('rt:') || r.key === 'field:Opportunity.IsClosed'), 'coincidences hidden');
  // A path whose field really has a "Closed" value: that value is the step.
  const withValue = { ...o, fields: o.fields.map((f) => (f.name === 'StageName' ? { ...f, picklistValues: [...f.picklistValues, { label: 'Closed', value: 'Closed', active: true }] } : f)) };
  const rv = locate({ text: 'Closed', org, describes: [withValue], hints: chevron, record: oppRecord(RT_RETAIL) }).results;
  assert.equal(rv[0].key, 'picklist:Opportunity.StageName.Closed');
  assert.equal(rv[0].confidence, 'confirmed');
  assert.ok(!rv.some((r) => r.key === 'sfdctext:pathClosed'));
});
