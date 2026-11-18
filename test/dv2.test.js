// DV2 sandbox sweep (Nov 2026): one test per confirmed finding, using the failing example with
// made-up names and Ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, pathsForRecord, buildGotoUrl, renameFieldCandidates, contextObjects, SOURCE } from '../src/locator.js';
import { loadValueSet } from '../src/sfApi.js';

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

// ---------- DV2-03: field labels and values in the highlights panel (compact layout) ----------

const hlAccount = {
  name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, recordTypeInfos: [], quickActions: [],
  fields: [
    { name: 'AccountNumber', label: 'Account Number', custom: false, type: 'string', picklistValues: [] },
    { name: 'BillingAddress', label: 'Billing Address/Account Address', custom: false, type: 'address', picklistValues: [] },
  ],
};
const hlOrg = { ...baseOrg, customLabels: [lbl('101D00000000002', 'Account_Number', 'Account Number'), lbl('101D00000000003', 'Billing_Address', 'Billing Address')] };
// Real composed path (DV2): p.slds-text-title > div > records-highlights-details-item > … records-highlights2.
const hlHints = (fieldPart, highlightsLabel) => ({
  tags: ['p', 'div', 'records-highlights-details-item', 'slot', 'div', 'records-highlights2', 'records-lwc-highlights-panel'],
  fieldPart, highlightsLabel,
});
const hlRecord = { object: 'Account', id: '001000000000001AAA' };

test('DV2-03: a highlights panel field label is the field, not the same-text custom label', () => {
  const out = locate({ text: 'Account Number', org: hlOrg, describes: [hlAccount], hints: hlHints('label', 'Account Number'), record: hlRecord });
  assert.ok(out.areas.includes('highlightsField') && !out.areas.includes('highlights'));
  assert.equal(out.results[0].key, 'field:Account.AccountNumber');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.equal(out.results.find((r) => r.key === 'label:101D00000000002').confidence, 'exact');
  // Partial highlight of a renamed label: the item's label still names the field.
  const part = locate({ text: 'Billing Address', org: hlOrg, describes: [hlAccount], hints: hlHints('label', 'Billing Address/Account Address'), record: hlRecord });
  assert.equal(part.results[0].key, 'field:Account.BillingAddress');
  assert.equal(part.results[0].confidence, 'confirmed');
});

test('DV2-03: a highlights panel value is record data of that field', () => {
  const out = locate({ text: 'A-100200', org: hlOrg, describes: [hlAccount], hints: hlHints('value', 'Account Number'), record: hlRecord });
  assert.equal(out.results[0].key, 'value:Account.AccountNumber');
  assert.equal(out.results[0].source, SOURCE.NOT_TRANSLATABLE);
});

// ---------- DV2-04 / DV2-10: quick actions from page metadata ----------

const contact = {
  name: 'Contact', label: 'Contact', labelPlural: 'Contacts', custom: false, recordTypeInfos: [], fields: [],
  quickActions: [
    { label: 'New Contact', name: 'NewContact', type: 'Create' },
    { label: 'Log a Visit', name: 'Contact.Log_Visit', type: 'Create' },
  ],
};

test('DV2-04: a FeedItem action (New Note) is a Salesforce standard action, not a TW Action', () => {
  const hints = { selectionNames: ['sfdc:QuickAction.FeedItem.ContentNote'], objectApiNames: ['Contact'] };
  assert.deepEqual(contextObjects([], hints), ['Contact']);
  const out = locate({ text: 'New Note', org: baseOrg, describes: [contact], hints });
  assert.equal(out.results[0].key, 'stdaction:FeedItem.ContentNote');
  assert.equal(out.results[0].source, SOURCE.NOT_TRANSLATABLE);
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(!out.results.some((r) => r.key.startsWith('qa:')));
  assert.deepEqual(contextObjects([], { selectionNames: ['sfdc:QuickAction.Global.NewContact'] }), []);
});

test('DV2-04: an object action missing from the loaded action list is not confirmed', () => {
  const out = locate({ text: 'Send Survey', org: baseOrg, describes: [contact], hints: { selectionNames: ['sfdc:QuickAction.Contact.Send_Survey'] } });
  const r = out.results.find((x) => x.key === 'qa:Contact.Send_Survey');
  assert.equal(r.confidence, 'exact');
  const listed = locate({ text: 'Log a Visit', org: baseOrg, describes: [contact], hints: { selectionNames: ['sfdc:QuickAction.Contact.Log_Visit'] } });
  assert.equal(listed.results[0].key, 'qa:Contact.Log_Visit');
  assert.equal(listed.results[0].confidence, 'confirmed');
});

test('DV2-10: a global action shows once (Global.NewContact and NewContact are the same action)', () => {
  const out = locate({ text: 'New Contact', org: baseOrg, describes: [contact], hints: { selectionNames: ['sfdc:QuickAction.Global.NewContact'] } });
  const qas = out.results.filter((r) => r.key.startsWith('qa:'));
  assert.equal(qas.length, 1);
  assert.equal(qas[0].confidence, 'confirmed');
  assert.equal(qas[0].goto.object, 'Global');
});

// ---------- DV2-05: the path's generic "Closed" step ----------

test('DV2-05: the Closed chevron is Salesforce path text; same-word labels, fields and record types drop', () => {
  const org = { ...pathOrg, customLabels: [lbl('101D00000000004', 'Opportunity_Closed_RT', 'Closed'), lbl('101D00000000005', 'MA_Closed', 'Closed', 'maps')] };
  const o = {
    ...opp,
    recordTypeInfos: [...opp.recordTypeInfos, { name: 'Closed', developerName: 'Closed', master: false, recordTypeId: '012000000000009AAA' }],
    fields: [
      ...opp.fields,
      { name: 'IsClosed', label: 'Closed', custom: false, type: 'boolean', picklistValues: [] },
      { name: 'ForecastCategory', label: 'Forecast Category', custom: false, type: 'picklist', picklistValues: [{ label: 'Closed', value: 'Closed', active: true }] },
    ],
  };
  const rs = locate({ text: 'Closed', org, describes: [o], hints: chevron, record: oppRecord(RT_SALES) }).results;
  assert.equal(rs[0].key, 'sfdctext:pathClosed');
  assert.equal(rs[0].confidence, 'confirmed');
  assert.equal(rs[0].source, SOURCE.NOT_TRANSLATABLE);
  assert.ok(!rs.some((r) => r.source === SOURCE.CUSTOM_LABEL || r.key.startsWith('rt:') || r.key === 'field:Opportunity.IsClosed'), 'coincidences hidden');
  // A path whose field really has a "Closed" value: that value is the step.
  const withValue = { ...o, fields: o.fields.map((f) => (f.name === 'StageName' ? { ...f, picklistValues: [...f.picklistValues, { label: 'Closed', value: 'Closed', active: true }] } : f)) };
  const rv = locate({ text: 'Closed', org, describes: [withValue], hints: chevron, record: oppRecord(RT_SALES) }).results;
  assert.equal(rv[0].key, 'picklist:Opportunity.StageName.Closed');
  assert.equal(rv[0].confidence, 'confirmed');
  assert.ok(!rv.some((r) => r.key === 'sfdctext:pathClosed'));
});

// ---------- DV2-06 / DV2-09: inactive values and values that are not in the picklist ----------

const contactBu = {
  name: 'Contact', label: 'Contact', labelPlural: 'Contacts', custom: false, recordTypeInfos: [], quickActions: [],
  fields: [
    { name: 'Business_Unit_LST__c', label: 'Business Unit', custom: true, type: 'picklist', picklistValues: [{ label: 'Example Unit North', value: 'EX_NORTH', active: true }] },
    { name: 'LeadSource', label: 'Lead Source', custom: false, type: 'picklist', picklistValues: [{ label: 'Web', value: 'Web', active: true }] },
    { name: 'Interests__c', label: 'Interests', custom: true, type: 'multipicklist', picklistValues: [{ label: 'Coatings', value: 'Coatings', active: true }] },
  ],
};
const buOrg = {
  ...baseOrg,
  valueSets: {
    'Contact.Business_Unit_LST__c': {
      name: null,
      values: [{ value: 'EX_NORTH', label: 'Example Unit North', active: true }, { value: 'EX_EMEA', label: 'Example Unit EMEA', active: false }],
    },
  },
};
const contactField = (name, fieldPart = 'value') => ({ selectionNames: [`sfdc:RecordField.Contact.${name}`], fieldPart });

test('DV2-06: an inactive picklist value on a record → TW Picklist Value, marked inactive, confirmed', () => {
  const out = locate({ text: 'Example Unit EMEA', org: buOrg, describes: [contactBu], hints: contactField('Business_Unit_LST__c') });
  const r = out.results[0];
  assert.equal(r.key, 'picklist:Contact.Business_Unit_LST__c.EX_EMEA');
  assert.equal(r.confidence, 'confirmed');
  assert.ok(r.notes.includes('This value is inactive.'));
  assert.ok(r.steps.includes('Setup Component: Picklist Value'));
  assert.ok(!out.results.some((x) => x.key.startsWith('value:')));
});

test('DV2-09: a value that is in no picklist list is flagged as record data', () => {
  // Standard field, only active values known: not an active value (could still be inactive).
  const std = locate({ text: 'Partner Referral', org: buOrg, describes: [contactBu], hints: contactField('LeadSource') }).results[0];
  assert.equal(std.key, 'value:Contact.LeadSource');
  assert.equal(std.source, SOURCE.NOT_TRANSLATABLE);
  assert.equal(std.confidence, 'exact');
  assert.match(std.title, /^Not an active value of the picklist Contact → Lead Source/);
  // Custom field with every value known (inactive ones too): confirmed.
  const custom = locate({ text: 'Imported Unit', org: buOrg, describes: [contactBu], hints: contactField('Business_Unit_LST__c') }).results[0];
  assert.equal(custom.key, 'value:Contact.Business_Unit_LST__c');
  assert.equal(custom.confidence, 'confirmed');
  assert.match(custom.steps[0], /not a value of this picklist/);
  // Multi-select: unchanged, no record-data card.
  const multi = locate({ text: 'Coatings; Resins', org: buOrg, describes: [contactBu], hints: contactField('Interests__c') }).results;
  assert.ok(!multi.some((x) => x.key.startsWith('value:')));
});

test('DV2-06: loadValueSet returns the local values of a field, inactive ones included', async () => {
  globalThis.fetch = async (u) => {
    const url = decodeURIComponent(u);
    const records = /SELECT Id FROM CustomField/.test(url)
      ? [{ Id: '00N000000000001AAA' }]
      : [{ Metadata: { valueSet: { valueSetName: null, valueSetDefinition: { value: [
          { fullName: 'EX_NORTH', label: 'Example Unit North', isActive: null },
          { fullName: 'EX%20EMEA', label: null, isActive: false },
        ] } } } }];
    return { ok: true, json: async () => ({ done: true, records }) };
  };
  const vs = await loadValueSet({ host: 'dv2-test.my.salesforce.com', sid: 's' }, 'Contact', 'Business_Unit_LST__c');
  assert.deepEqual(vs, { name: null, values: [{ value: 'EX_NORTH', label: 'Example Unit North', active: true }, { value: 'EX EMEA', label: 'EX EMEA', active: false }] });
});
