// Large test sandbox sweep (Nov 2026): one test per confirmed finding, using the failing example with
// made-up names and Ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, pathsForRecord, buildGotoUrl, renameFieldCandidates, contextObjects, SOURCE } from '../src/locator.js';
import { loadValueSet } from '../src/sfApi.js';

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

// ---------- SB-06 / SB-09: inactive values and values that are not in the picklist ----------

const contactTeam = {
  name: 'Contact', label: 'Contact', labelPlural: 'Contacts', custom: false, recordTypeInfos: [], quickActions: [],
  fields: [
    { name: 'Demo_Team__c', label: 'Demo Team', custom: true, type: 'picklist', picklistValues: [{ label: 'Example Unit North', value: 'EX_NORTH', active: true }] },
    { name: 'LeadSource', label: 'Lead Source', custom: false, type: 'picklist', picklistValues: [{ label: 'Web', value: 'Web', active: true }] },
    { name: 'Demo_Colors__c', label: 'Demo Colors', custom: true, type: 'multipicklist', picklistValues: [{ label: 'Blue', value: 'Blue', active: true }] },
  ],
};
const teamOrg = {
  ...baseOrg,
  valueSets: {
    'Contact.Demo_Team__c': {
      name: null,
      values: [{ value: 'EX_NORTH', label: 'Example Unit North', active: true }, { value: 'EX_WEST', label: 'Example Unit WEST', active: false }],
    },
  },
};
const contactField = (name, fieldPart = 'value') => ({ selectionNames: [`sfdc:RecordField.Contact.${name}`], fieldPart });

test('SB-06: an inactive picklist value on a record → TW Picklist Value, marked inactive, confirmed', () => {
  const out = locate({ text: 'Example Unit WEST', org: teamOrg, describes: [contactTeam], hints: contactField('Demo_Team__c') });
  const r = out.results[0];
  assert.equal(r.key, 'picklist:Contact.Demo_Team__c.EX_WEST');
  assert.equal(r.confidence, 'confirmed');
  assert.ok(r.notes.includes('This value is inactive.'));
  assert.ok(r.steps.includes('Setup Component: Picklist Value'));
  assert.ok(!out.results.some((x) => x.key.startsWith('value:')));
});

test('SB-09: a value that is in no picklist list is flagged as record data', () => {
  // Standard field, only active values known: not an active value (could still be inactive).
  const std = locate({ text: 'Example Referral', org: teamOrg, describes: [contactTeam], hints: contactField('LeadSource') }).results[0];
  assert.equal(std.key, 'value:Contact.LeadSource');
  assert.equal(std.source, SOURCE.NOT_TRANSLATABLE);
  assert.equal(std.confidence, 'exact');
  assert.match(std.title, /^Not an active value of the picklist Contact → Lead Source/);
  // Custom field with every value known (inactive ones too): confirmed.
  const custom = locate({ text: 'Imported Unit', org: teamOrg, describes: [contactTeam], hints: contactField('Demo_Team__c') }).results[0];
  assert.equal(custom.key, 'value:Contact.Demo_Team__c');
  assert.equal(custom.confidence, 'confirmed');
  assert.match(custom.steps[0], /not a value of this picklist/);
  // Multi-select: unchanged, no record-data card.
  const multi = locate({ text: 'Blue; Green', org: teamOrg, describes: [contactTeam], hints: contactField('Demo_Colors__c') }).results;
  assert.ok(!multi.some((x) => x.key.startsWith('value:')));
});

test('SB-06: loadValueSet returns the local values of a field, inactive ones included', async () => {
  globalThis.fetch = async (u) => {
    const url = decodeURIComponent(u);
    const records = /SELECT Id FROM CustomField/.test(url)
      ? [{ Id: '00N000000000001AAA' }]
      : [{ Metadata: { valueSet: { valueSetName: null, valueSetDefinition: { value: [
          { fullName: 'EX_NORTH', label: 'Example Unit North', isActive: null },
          { fullName: 'EX%20WEST', label: null, isActive: false },
        ] } } } }];
    return { ok: true, json: async () => ({ done: true, records }) };
  };
  const vs = await loadValueSet({ host: 'sandbox-test.my.salesforce.com', sid: 's' }, 'Contact', 'Demo_Team__c');
  assert.deepEqual(vs, { name: null, values: [{ value: 'EX_NORTH', label: 'Example Unit North', active: true }, { value: 'EX WEST', label: 'EX WEST', active: false }] });
});

// ---------- SB-07 / SB-08: related lists of custom lookups, and labels inside their rows ----------

const FLEXI = 'forcegenerated-flexipage_example_record_page_opportunity__view_js___lmt___1';
const listHints = (id, header) => ({
  tags: header ? ['span', 'a', 'h2', 'div', 'lst-related-list-view-manager', 'lst-dynamic-related-list', 'flexipage-component2', FLEXI] : ['dt', 'article', 'lst-related-preview-card', 'lst-related-list-view-manager', 'lst-dynamic-related-list', 'flexipage-component2', FLEXI],
  listHeader: header, componentIds: [id], flexipage: FLEXI,
});

test('SB-07: a custom lookup related list title → TW Custom Field, Related List Label of the child field', () => {
  const org = { ...baseOrg, objects: [...baseOrg.objects, { name: 'Contract', label: 'Contract', labelPlural: 'Contracts', custom: false }], tabs: [...baseOrg.tabs, { Name: 'standard-Contract', Label: 'Contracts', IsCustom: false, SobjectName: 'Contract' }] };
  const pc = {
    page: 'Example Record Page', id: 'lst_dynamicRelatedList3', component: 'lst:dynamicRelatedList', label: null,
    props: { relatedListApiName: 'Demo_Contracts__r' },
    child: { childSObject: 'Contract', field: 'Demo_Opportunity__c', relationshipName: 'Demo_Contracts__r', fieldLabel: 'Demo Opportunity', objectLabel: 'Contract' },
  };
  const out = locate({ text: 'Contracts (0)', org, describes: [opp], hints: listHints('lst_dynamicRelatedList3', true), pageComponent: pc });
  const r = out.results[0];
  assert.equal(r.key, 'rellist:Contract.Demo_Opportunity__c');
  assert.equal(r.confidence, 'confirmed');
  assert.ok(r.steps.includes('Aspect: Related List Label'));
  assert.equal(r.goto.object, 'Contract');
  assert.equal(r.goto.aspect, 'relationshiplabel');
  assert.deepEqual(r.goto.rows, ['Demo Opportunity', 'Demo_Opportunity__c']);
  assert.ok(!out.results.some((x) => x.key === 'area:relatedList'));
  assert.equal(out.results.find((x) => x.key === 'object:Contract').confidence, 'exact');
  // Without the child relationship (older background): the generic card as before.
  const old = locate({ text: 'Contracts (0)', org, describes: [opp], hints: listHints('lst_dynamicRelatedList3', true), pageComponent: { ...pc, child: undefined } });
  assert.ok(old.results.some((x) => x.key === 'area:relatedList'));
});

test('SB-08: "Stage:" in an Opportunities related list row on an Account → Opportunity.StageName', () => {
  const account = { name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, recordTypeInfos: [], quickActions: [], fields: [] };
  const org = { ...baseOrg, validationRules: [{ Id: '03d000000000001', ValidationName: 'Example_Stage_Rule', ErrorMessage: 'Stage cannot go back once the opportunity is won', EntityDefinition: { QualifiedApiName: 'Opportunity' } }] };
  const out = locate({ text: 'Stage:', org, describes: [account, opp], hints: listHints('lst_dynamicRelatedList15', false), listObject: 'Opportunity', record: { object: 'Account', id: '001000000000001AAA' } });
  assert.ok(out.areas.includes('relatedListRow'));
  assert.equal(out.results[0].key, 'field:Opportunity.StageName');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(!out.results.some((r) => r.key.startsWith('vr:')));
});

// ---------- SB-11: nav bar Home ----------

test('SB-11: nav bar Home is Salesforce\'s own tab; same-text managed labels are hidden', () => {
  const org = { ...baseOrg, customLabels: [lbl('101D00000000006', 'Pkg_Home_Title', 'Home', 'exns'), lbl('101D00000000007', 'MA_Home', 'Home', 'acme')] };
  // Real nav item: one-app-nav-bar-item-root data-id="home" data-target-selection-name="sfdc:TabDefinition.standard-home".
  const hints = { tags: ['span', 'a', 'one-app-nav-bar-item-root', 'one-app-nav-bar'], selectionNames: ['sfdc:TabDefinition.standard-home'], attrs: { 'data-id': 'home' } };
  const out = locate({ text: 'Home', org, describes: [], hints });
  assert.equal(out.results[0].key, 'sfdctab:home');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(!out.results.some((r) => r.source === SOURCE.CUSTOM_LABEL));
  // A Home tab listed in TabDefinition stays the Rename Tabs answer.
  const listed = locate({ text: 'Home', org: { ...org, tabs: [...org.tabs, { Name: 'standard-home', Label: 'Home', IsCustom: false, SobjectName: null }] }, describes: [], hints });
  assert.equal(listed.results[0].key, 'tab:standard-home');
  assert.ok(!listed.results.some((r) => r.key === 'sfdctab:home'));
});

// ---------- SB-12: not-translatable cards: badge and wording ----------

test('SB-12: Salesforce text in standard components is confirmed when nothing from the org matches', () => {
  const tl = locate({ text: 'No activities to show.', org: baseOrg, describes: [], hints: { sfComponents: ['runtime_sales_activities_activityPanel'] } }).results[0];
  assert.equal(tl.title, 'Salesforce activity timeline text');
  assert.equal(tl.confidence, 'confirmed');
  // An org name inside it (a field label) keeps the Salesforce-text card as page context.
  const acct = { name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, recordTypeInfos: [], quickActions: [], fields: [{ name: 'AccountNumber', label: 'Account Number', custom: false, type: 'string', picklistValues: [] }] };
  const rs = locate({ text: 'Account Number', org: baseOrg, describes: [acct], hints: { sfComponents: ['runtime_sales_activities_activityPanel'] } }).results;
  assert.equal(rs.find((r) => r.key === 'sfdctext:activityTimeline').confidence, 'context');
});

test('SB-12: a report chart title is App Builder text, not Salesforce text', () => {
  const hints = { tags: ['span', 'h2', 'header', 'article', 'flexipage-component2'], componentIds: ['flexipage_reportChart2'] };
  const r = locate({ text: 'Example Pipeline by Stage', org: baseOrg, describes: [], hints }).results[0];
  assert.equal(r.key, 'sfdctext:reportChartTitle');
  assert.equal(r.confidence, 'confirmed');
  assert.ok(!r.steps.some((s) => /Admins cannot change/.test(s)));
  assert.ok(r.steps.some((s) => s.includes('{!$Label.c.Your_Label}')));
  // Same text as an unmanaged custom label: probably that label.
  const org = { ...baseOrg, customLabels: [lbl('101D00000000008', 'Pipeline_Title', 'Example Pipeline by Stage')] };
  const withLabel = locate({ text: 'Example Pipeline by Stage', org, describes: [], hints }).results;
  assert.equal(withLabel[0].key, 'label:101D00000000008');
  assert.equal(withLabel.find((x) => x.key === 'sfdctext:reportChartTitle').confidence, 'context');
});

test('SB-12: an auto-number value is generated by Salesforce, no Data Translation advice', () => {
  const o = { ...opp, fields: [...opp.fields, { name: 'Demo_Number__c', label: 'Demo Number', custom: true, type: 'string', autoNumber: true, picklistValues: [] }] };
  const r = locate({ text: 'DEMO-000123', org: pathOrg, describes: [o], hints: { selectionNames: ['sfdc:RecordField.Opportunity.Demo_Number__c'], fieldPart: 'value' } }).results[0];
  assert.equal(r.key, 'value:Opportunity.Demo_Number__c');
  assert.match(r.title, /^Auto-number: generated by Salesforce/);
  assert.ok(!r.steps.some((s) => /Data Translation|picklist/.test(s)));
});
