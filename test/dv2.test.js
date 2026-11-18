// DV2 sandbox sweep (Nov 2026): one test per confirmed finding, using the failing example with
// made-up names and Ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, pathsForRecord, buildGotoUrl, renameFieldCandidates, SOURCE } from '../src/locator.js';

const lbl = (Id, Name, Value, NamespacePrefix = null) => ({ Id, Name, MasterLabel: Name, NamespacePrefix, Value, Language: 'en_US' });

const RT_SALES = '012000000000001AAA';
const RT_SPEC = '012000000000002AAA';
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

// ---------- DV2-01: paths belong to one record type ----------

const GUIDE_LINE = 'Review the opportunity information with the buyer';
const pathOrg = {
  ...baseOrg,
  customLabels: [lbl('101D00000000001', 'MA_Connect', 'Connect', 'maps')],
  pathSteps: [
    { Id: '1CF000000000011', DeveloperName: `X11111111111111_01J000000000001AAA_${RT_SALES}_Opportunity_StageName`, Language: 'en_US', Info: `<ol><li>${GUIDE_LINE}</li><li>Agree the next meeting</li></ol>` },
    { Id: '1CF000000000012', DeveloperName: `X22222222222222_01J000000000002AAA_${RT_SPEC}_Opportunity_Sub_Stage_LST`, Language: 'en_US', Info: `<ol><li>${GUIDE_LINE}</li><li>List the specifiers</li></ol>` },
  ],
  paths: [
    { DeveloperName: 'Default_Opportunity', MasterLabel: 'Default', SobjectType: 'Opportunity', SobjectProcessField: 'StageName', RecordTypeId: null, IsActive: false },
    { DeveloperName: 'Open_Opportunity', MasterLabel: 'Open Opportunity', SobjectType: 'Opportunity', SobjectProcessField: 'StageName', RecordTypeId: RT_SALES, IsActive: true },
    { DeveloperName: 'Specification_Path', MasterLabel: 'Specification Path', SobjectType: 'Opportunity', SobjectProcessField: 'Sub_Stage_LST__c', RecordTypeId: RT_SPEC, IsActive: true },
  ],
};
const opp = {
  name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', custom: false, quickActions: [],
  recordTypeInfos: [
    { name: 'Sales', developerName: 'Sales', master: false, recordTypeId: RT_SALES },
    { name: 'Specification', developerName: 'Specification', master: false, recordTypeId: RT_SPEC },
  ],
  fields: [
    { name: 'StageName', label: 'Stage', custom: false, type: 'picklist', picklistValues: [{ label: 'Connect', value: 'Connect', active: true }, { label: 'Closed Won', value: 'Closed Won', active: true }] },
    { name: 'Sub_Stage_LST__c', label: 'Sub Stage', custom: true, type: 'picklist', picklistValues: [{ label: 'Connect', value: 'CONNECT', active: true }] },
  ],
};
const chevron = { tags: ['span', 'a', 'li', 'ul', 'div'], auraClasses: ['runtime_sales_pathassistantPathAssistantTabSet', 'runtime_sales_pathassistantPathAssistant'] };
const guidance = { tags: ['li', 'ol', 'div'], auraClasses: ['uiOutputRichText', 'runtime_sales_pathassistantPathAssistantInfo', 'runtime_sales_pathassistantPathAssistant'] };
const oppRecord = (recordTypeId) => ({ object: 'Opportunity', id: '006000000000001AAA', recordTypeId });
const runOpp = (text, hints, record) => locate({ text, org: pathOrg, describes: [opp], hints, record }).results;

test('DV2-01: pathsForRecord picks the record type\'s own path', () => {
  const names = (rt) => pathsForRecord(pathOrg.paths, 'Opportunity', oppRecord(rt)).map((p) => p.DeveloperName);
  assert.deepEqual(names(RT_SPEC), ['Specification_Path']);
  assert.deepEqual(names(RT_SALES.slice(0, 15)), ['Open_Opportunity']);
  assert.deepEqual(names(undefined), ['Open_Opportunity', 'Specification_Path'], 'record type not known: every active path');
  assert.deepEqual(names('012000000000003AAA'), [], 'record type without a path, and no master path');
});

test('DV2-01: a chevron on a Specification Opportunity confirms Sub Stage only, not StageName', () => {
  const rs = runOpp('Connect', chevron, oppRecord(RT_SPEC));
  assert.equal(rs[0].key, 'picklist:Opportunity.Sub_Stage_LST__c.CONNECT');
  assert.equal(rs[0].confidence, 'confirmed');
  assert.equal(rs.find((r) => r.key === 'picklist:Opportunity.StageName.Connect').confidence, 'exact');
  // A Sales Opportunity: the other way round.
  const sales = runOpp('Connect', chevron, oppRecord(RT_SALES));
  assert.equal(sales[0].key, 'picklist:Opportunity.StageName.Connect');
  assert.equal(sales.find((r) => r.key === 'picklist:Opportunity.Sub_Stage_LST__c.CONNECT').confidence, 'exact');
});

test('DV2-01: record type not known and two paths match → neither is confirmed', () => {
  const rs = runOpp('Connect', chevron, { object: 'Opportunity', id: '006000000000001AAA' });
  assert.ok(!rs.some((r) => r.confidence === 'confirmed'));
  assert.ok(rs.find((r) => r.key === 'picklist:Opportunity.Sub_Stage_LST__c.CONNECT').notes[0].includes('if this record shows that path'));
});

test('DV2-01: guidance of another record type\'s path is not confirmed', () => {
  const rs = runOpp('opportunity information', guidance, oppRecord(RT_SALES));
  const sales = rs.find((r) => r.key === 'path:1CF000000000011');
  const spec = rs.find((r) => r.key === 'path:1CF000000000012');
  assert.equal(sales.confidence, 'confirmed');
  assert.equal(rs[0], sales);
  assert.ok(!spec || spec.confidence !== 'confirmed');
  const full = runOpp(GUIDE_LINE, guidance, oppRecord(RT_SALES));
  const spec2 = full.find((r) => r.key === 'path:1CF000000000012');
  assert.equal(spec2.confidence, 'exact');
  assert.match(spec2.notes[0], /record type Specification, not this record/);
});

// ---------- DV2-02: Rename Tabs Step 2 shows the master label, not the renamed one ----------

test('DV2-02: Go to translation for a renamed standard field also looks for its master label on Step 2', () => {
  const account = {
    name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, recordTypeInfos: [], quickActions: [],
    fields: [
      { name: 'BillingAddress', label: 'Billing Address/Account Address', custom: false, type: 'address', picklistValues: [] },
      { name: 'ParentId', label: 'Parent Account ID', custom: false, type: 'reference', picklistValues: [] },
    ],
  };
  const r = locate({ text: 'Billing Address/Account Address', org: baseOrg, describes: [account] }).results.find((x) => x.key === 'field:Account.BillingAddress');
  const b = buildGotoUrl(r.goto, 'de', 'en_US');
  assert.equal(b.autofill.page, 'renameStage');
  assert.deepEqual(b.autofill.candidates, ['Billing Address/Account Address', 'BillingAddress', 'Billing Address', 'Account Address']);
  // Step 2's first column says "Billing Address": one of the candidates equals it.
  assert.ok(b.autofill.candidates.some((c) => c.toLowerCase() === 'billing address'));
  assert.deepEqual(renameFieldCandidates('Parent Account ID', 'ParentId'), ['Parent Account ID', 'ParentId', 'Parent Id', 'Parent']);
  assert.deepEqual(renameFieldCandidates('Account Number', 'AccountNumber'), ['Account Number', 'AccountNumber']);
});
