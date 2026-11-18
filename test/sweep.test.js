// Account / Opportunity page sweep (UAT2, Nov 2026): one test per confirmed finding, using the real
// failing example (text, hints and metadata as read from the org).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, normalize, pathStepMatch, SOURCE } from '../src/locator.js';

const lbl = (Id, Name, Value, NamespacePrefix = null) => ({ Id, Name, MasterLabel: Name, NamespacePrefix, Value, Language: 'en_US' });

const baseOrg = {
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
    lbl('101S00000000001', 'MA_Phone', 'Phone', 'maps'),
    lbl('101S00000000002', 'MA_Description', 'Description', 'maps'),
    lbl('101S00000000003', 'Account_Owner', 'Account Owner'),
    lbl('101S00000000004', 'Opportunity_Information', 'Opportunity Information'),
    lbl('101S00000000005', 'Active_Relationships', 'Active Relationships'),
    lbl('101S00000000006', 'Territory', 'Territory', 'maps'),
    lbl('101S00000000007', 'Territory', 'Territory'),
    lbl('101S00000000008', 'MA_Territory_Name', 'Territory', 'maps'),
    lbl('101S00000000009', 'Territory_Tab', 'Territory', 'genesysps'),
    lbl('101S0000000000A', 'MA_Accounts', 'Accounts', 'maps'),
  ],
};

const account = {
  name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false,
  fields: [
    { name: 'Phone', label: 'Account Phone', custom: false, type: 'phone', picklistValues: [] },
    { name: 'Description', label: 'Account Description', custom: false, type: 'textarea', picklistValues: [] },
    { name: 'OwnerId', label: 'Owner ID', custom: false, type: 'reference', picklistValues: [] },
    { name: 'CreatedById', label: 'Created By ID', custom: false, type: 'reference', picklistValues: [] },
    { name: 'MobilePhone__c', label: 'Mobile Phone Number', custom: true, type: 'phone', picklistValues: [] },
    { name: 'CurrencyIsoCode', label: 'Account Currency', custom: false, type: 'picklist', picklistValues: [{ label: 'U.S. Dollar', value: 'USD', active: true }] },
    { name: 'Traffic_Customer_Reports_FOR__c', label: 'Traffic Customer Reports', custom: true, type: 'string', calculated: true, picklistValues: [] },
    { name: 'Name', label: 'Account Name', custom: false, type: 'string', picklistValues: [] },
  ],
  recordTypeInfos: [],
  quickActions: [
    { label: 'Service Task', name: 'NewTaskServiceACEMEAANZ', type: 'Create' },
    { label: 'New Case', name: 'Account.New_Case', type: 'Create' },
  ],
};

const run = (text, extra = {}) => locate({ text, org: baseOrg, describes: [account], ...extra });
const field = (name, fieldPart) => ({ selectionNames: [`sfdc:RecordField.Account.${name}`], ...(fieldPart ? { fieldPart } : {}) });
const sectionHints = {
  tags: ['span', 'h3', 'flexipage-field-section2', 'flexipage-component2', 'flexipage-tab2', 'flexipage-tabset2', 'forcegenerated-flexipage_opportunity_record_page_opportunity__view_js___lmt___1'],
  tabRole: 'tabpanel',
  componentIds: ['flexipage_fieldSection1'],
  flexipage: 'forcegenerated-flexipage_opportunity_record_page_opportunity__view_js___lmt___1',
};

test('M-01: section label @@@SFDC...SFDC@@@ is a Salesforce standard name; the same-text label is a coincidence', () => {
  const pc = { page: 'Opportunity Record Page', id: 'flexipage_fieldSection1', component: 'flexipage:fieldSection', label: '@@@SFDCOpportunity_InformationSFDC@@@' };
  const out = run('Opportunity Information', { hints: sectionHints, pageComponent: pc });
  const r = out.results[0];
  assert.equal(r.source, SOURCE.NOT_TRANSLATABLE);
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.title, 'Salesforce standard section name (translated by Salesforce)');
  assert.match(r.subtitle, /"Opportunity Information"/);
  assert.match(r.steps[0], /No action needed/);
  assert.ok(!out.results.some((x) => /typed in Lightning App Builder/.test(x.title)));
  const label = out.results.find((x) => x.key === 'label:101S00000000004');
  assert.equal(label.confidence, 'exact');
  assert.match(label.notes[0], /^Same words only/);
});

test('M-04: hinted standard field "Phone" / "Description" (describe "Account Phone" / "Account Description") is the top answer', () => {
  const out = run('Phone', { hints: field('Phone') });
  assert.equal(out.results[0].key, 'field:Account.Phone');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.equal(run('Description', { hints: field('Description') }).results[0].key, 'field:Account.Description');
});

test('M-04: a partial card for the hinted field is replaced by the clicked-field card, not dropped', () => {
  const out = run('Mobile', { hints: field('MobilePhone__c') });
  const r = out.results.find((x) => x.key === 'field:Account.MobilePhone__c');
  assert.ok(r, 'field card kept');
  assert.equal(r.confidence, 'context');
  assert.match(r.notes[0], /You clicked inside this field/);
});

test('M-05: Lightning display labels (Account Owner, Account Name, Opportunity Name, Created By) find the field', () => {
  const out = run('Account Owner', { hints: field('OwnerId') });
  assert.equal(out.results[0].key, 'field:Account.OwnerId');
  assert.equal(out.results[0].confidence, 'confirmed');
  // Text only (e.g. the Field History list): same text as the field, not only as the label.
  assert.equal(run('Account Owner').results.find((x) => x.key === 'field:Account.OwnerId').confidence, 'exact');
  const opp = {
    name: 'Opportunity', label: 'Opportunity', custom: false, recordTypeInfos: [], quickActions: [],
    fields: [
      { name: 'AccountId', label: 'Account ID', custom: false, type: 'reference', picklistValues: [] },
      { name: 'Name', label: 'Name', custom: false, type: 'string', picklistValues: [] },
    ],
  };
  const o = locate({ text: 'Account Name', org: baseOrg, describes: [opp], hints: { selectionNames: ['sfdc:RecordField.Opportunity.AccountId'] } });
  assert.equal(o.results[0].key, 'field:Opportunity.AccountId');
  assert.equal(locate({ text: 'Opportunity Name', org: baseOrg, describes: [opp] }).results[0].key, 'field:Opportunity.Name');
  const cb = run('Created By', { hints: field('CreatedById') }).results[0];
  assert.equal(cb.key, 'field:Account.CreatedById');
  assert.equal(cb.source, SOURCE.NOT_TRANSLATABLE);
  assert.match(cb.title, /Salesforce system field/);
});

test('M-05: pointing at a field label confirms the field and demotes same-text custom labels', () => {
  const out = run('Account Owner', { hints: field('OwnerId', 'label') });
  assert.equal(out.results[0].key, 'field:Account.OwnerId');
  assert.equal(out.results[0].confidence, 'confirmed');
  const l = out.results.find((x) => x.key === 'label:101S00000000003');
  assert.equal(l.confidence, 'exact');
  assert.match(l.notes[0], /field labels come from the field/);
  // A label text that matches no known display label is still confirmed by the page.
  const odd = run('Owner of record', { hints: field('OwnerId', 'label') });
  assert.equal(odd.results[0].key, 'field:Account.OwnerId');
  assert.equal(odd.results[0].confidence, 'confirmed');
  assert.ok(!odd.results.some((x) => x.key.startsWith('data:') || x.key.startsWith('value:')));
});

test('M-07: a record count "(n)" after a card title is ignored', () => {
  assert.equal(normalize('Active Relationships (0)'), 'active relationships');
  assert.equal(normalize('Cases (10+)'), 'cases');
  assert.equal(normalize('Step (1) of 3'), 'step (1) of 3');
  const r = run('Active Relationships (0)').results[0];
  assert.equal(r.key, 'label:101S00000000005');
  assert.equal(r.confidence, 'exact');
});

test('M-08: a quick action without an object prefix is global', () => {
  const g = run('Service Task').results.find((x) => x.key === 'qa:NewTaskServiceACEMEAANZ');
  assert.ok(g.steps.includes('Object: Global'));
  assert.equal(g.goto.object, null);
  const o = run('New Case').results.find((x) => x.key === 'qa:Account.New_Case');
  assert.ok(o.steps.includes('Object: Account'));
  assert.equal(o.goto.object, 'Account');
});

test('M-10: the org\'s own label ranks before managed labels with the same text', () => {
  const titles = run('Territory').results.filter((x) => x.source === SOURCE.CUSTOM_LABEL).map((x) => x.title);
  assert.equal(titles[0], 'Custom label Territory');
  assert.ok(titles.slice(1).every((t) => /__/.test(t)), titles.join(', '));
});

test('M-10: same-text managed labels rank after object answers and fold when the page confirms another answer', () => {
  const rs = run('Accounts').results;
  assert.equal(rs[0].key, 'object:Account');
  assert.equal(rs.at(-1).key, 'label:101S0000000000A');
  const pc = { page: 'Account Record Page', id: 'flexipage_tab3', component: 'flexipage:tab', label: '{!$Label.Territory}' };
  const out = run('Territory', { hints: { tags: ['a', 'lightning-tab-bar'], tabRole: 'tab' }, pageComponent: pc });
  assert.equal(out.results[0].key, 'label:101S00000000007');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.equal(out.results.filter((x) => x.source === SOURCE.CUSTOM_LABEL && x.pkg).length, 2);
  assert.equal(out.hiddenManaged, 1);
});

test('M-11: a nav bar item is the object tab, not a same-text custom label', () => {
  const org = { ...baseOrg, customLabels: [...baseOrg.customLabels, lbl('101S0000000000B', 'AccountPlanRL_Accounts', 'Accounts')] };
  const out = locate({ text: 'Accounts', org, describes: [], hints: { tags: ['span', 'a', 'one-app-nav-bar-item-root', 'one-app-nav-bar'] } });
  assert.equal(out.results[0].key, 'object:Account');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(!out.results.some((x) => x.source === SOURCE.CUSTOM_LABEL));
  assert.equal(out.droppedPartial, 2);
});

test('M-13: pointing at a value: record data, formula output and currency name come first', () => {
  const v = run('Acme Paints Ltd', { hints: field('Name', 'value') }).results;
  assert.equal(v[0].key, 'value:Account.Name');
  assert.match(v[0].title, /^Record data: a value typed on the record/);
  assert.ok(v.some((x) => x.key === 'field:Account.Name' && x.confidence === 'context'), 'label card still listed');
  assert.match(run('Open report', { hints: field('Traffic_Customer_Reports_FOR__c', 'value') }).results[0].title, /^Formula output/);
  assert.equal(run('USD - U.S. Dollar', { hints: field('CurrencyIsoCode', 'value') }).results[0].title, 'Salesforce currency name');
  // A picklist value is still the picklist answer.
  assert.ok(run('U.S. Dollar', { hints: field('CurrencyIsoCode', 'value') }).results[0].key.startsWith('picklist:Account.CurrencyIsoCode.'));
});

// Real UAT2 path data (Opportunity, Specification Path on Sub_Stage_LST__c).
const PATH_INFO =
  '<ol><li><u>Build network of influencers</u><ol><li>Who needs to be contacted?</li><li>How will you connect with your Client?</li>' +
  '<li>What is your timescale for contacting your Clients?  </li><li>Who else needs to be contacted?</li></ol></li></ol><p><br></p>';
const pathOrg = {
  ...baseOrg,
  customLabels: [lbl('101S0000000000C', 'MA_Connect', 'Connect', 'maps'), lbl('101S0000000000D', 'Lost', 'Lost')],
  pathSteps: [{ Id: '1CF000000000001', DeveloperName: 'X80069814330387_01JVD00000Ed5rF2AR_012VD000008OBM4YAO_Opportunity_Sub_Stage_LST', Language: 'en_US', Info: PATH_INFO }],
  paths: [
    { DeveloperName: 'Default_Opportunity', MasterLabel: 'Default', SobjectType: 'Opportunity', SobjectProcessField: 'StageName', RecordTypeId: null, IsActive: false },
    { DeveloperName: 'Open_Opportunity', MasterLabel: 'Open Opportunity', SobjectType: 'Opportunity', SobjectProcessField: 'StageName', RecordTypeId: '012Ui000004aO4kIAE', IsActive: true },
    { DeveloperName: 'Specification_Path', MasterLabel: 'Specification Path', SobjectType: 'Opportunity', SobjectProcessField: 'Sub_Stage_LST__c', RecordTypeId: '012VD000008OBM4YAO', IsActive: true },
  ],
};
const oppPath = {
  name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', custom: false, recordTypeInfos: [], quickActions: [],
  fields: [{ name: 'Sub_Stage_LST__c', label: 'Sub Stage', custom: true, type: 'picklist', picklistValues: [{ label: 'Connect', value: 'CONNECT', active: true }, { label: 'Lost', value: 'LOST', active: true }] }],
};
const guidanceHints = { tags: ['li', 'ol', 'div'], auraClasses: ['uiOutputRichText', 'runtime_sales_pathassistantPathAssistantInfo', 'runtime_sales_pathassistantPathAssistant'] };

test('M-14: a path chevron confirms the path field picklist value, not the same-text label', () => {
  const chevron = { tags: ['span', 'a', 'li', 'ul', 'div'], auraClasses: ['runtime_sales_pathassistantPathAssistantTabSet', 'runtime_sales_pathassistantPathAssistant'] };
  for (const [text, value] of [['Connect', 'CONNECT'], ['Lost', 'LOST']]) {
    const r = locate({ text, org: pathOrg, describes: [oppPath], hints: chevron }).results[0];
    assert.equal(r.key, `picklist:Opportunity.Sub_Stage_LST__c.${value}`, text);
    assert.equal(r.confidence, 'confirmed');
    assert.match(r.notes[0], /path "Specification Path"/);
  }
});

test('M-17: a highlight of the heading plus guidance lines finds the step', () => {
  const t = 'Guidance for Success\nBuild network of influencers\nWho needs to be contacted?';
  const r = locate({ text: t, org: pathOrg, describes: [oppPath], hints: guidanceHints }).results.find((x) => x.key.startsWith('path:'));
  assert.ok(r, 'found');
  assert.equal(r.confidence, 'confirmed');
  assert.equal(pathStepMatch(normalize(t), PATH_INFO, t), 'exact');
  assert.equal(pathStepMatch(normalize('Guidance for Success Who needs to be contacted?'), PATH_INFO), 'exact');
  assert.equal(pathStepMatch(normalize('Guidance for Success'), PATH_INFO, 'Guidance for Success'), null);
  const some = 'Who needs to be contacted?\nHow will you connect with your Client?\nSomething else entirely';
  assert.equal(pathStepMatch(normalize(some), PATH_INFO, some), 'partial');
});
