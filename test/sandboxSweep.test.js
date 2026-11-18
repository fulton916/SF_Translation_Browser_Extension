// Large test sandbox sweep (Nov 2026): one test per confirmed finding, using the failing example with
// made-up names and Ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, pathsForRecord, SOURCE } from '../src/locator.js';

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
