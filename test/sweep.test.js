// Account / Opportunity page sweep (Nov 2026): one test per confirmed finding, with the hints and metadata
// in the shape Salesforce returns, and made-up names, texts and Ids.
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
    lbl('101S00000000001', 'Pkg_Phone', 'Phone', 'acme'),
    lbl('101S00000000002', 'Pkg_Description', 'Description', 'acme'),
    lbl('101S00000000003', 'Demo_Account_Owner', 'Account Owner'),
    lbl('101S00000000004', 'Demo_Information', 'Opportunity Information'),
    lbl('101S00000000005', 'Demo_Gadgets', 'Demo Gadgets'),
    lbl('101S00000000006', 'Workshop', 'Workshop', 'acme'),
    lbl('101S00000000007', 'Workshop', 'Workshop'),
    lbl('101S00000000008', 'Pkg_Workshop_Name', 'Workshop', 'acme'),
    lbl('101S00000000009', 'Workshop_Tab', 'Workshop', 'exns'),
    lbl('101S0000000000A', 'Pkg_Accounts', 'Accounts', 'acme'),
  ],
};

const account = {
  name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false,
  fields: [
    { name: 'Phone', label: 'Account Phone', custom: false, type: 'phone', picklistValues: [] },
    { name: 'Description', label: 'Account Description', custom: false, type: 'textarea', picklistValues: [] },
    { name: 'OwnerId', label: 'Owner ID', custom: false, type: 'reference', picklistValues: [] },
    { name: 'CreatedById', label: 'Created By ID', custom: false, type: 'reference', picklistValues: [] },
    { name: 'Demo_Backup_Phone__c', label: 'Backup Phone Number', custom: true, type: 'phone', picklistValues: [] },
    { name: 'CurrencyIsoCode', label: 'Account Currency', custom: false, type: 'picklist', picklistValues: [{ label: 'U.S. Dollar', value: 'USD', active: true }] },
    { name: 'Demo_Report_Link__c', label: 'Demo Report Link', custom: true, type: 'string', calculated: true, picklistValues: [] },
    { name: 'Name', label: 'Account Name', custom: false, type: 'string', picklistValues: [] },
  ],
  recordTypeInfos: [],
  quickActions: [
    { label: 'Demo Service Task', name: 'Demo_Service_Task', type: 'Create' },
    { label: 'New Case', name: 'Account.Demo_New_Case', type: 'Create' },
  ],
};

const run = (text, extra = {}) => locate({ text, org: baseOrg, describes: [account], ...extra });
const field = (name, fieldPart) => ({ selectionNames: [`sfdc:RecordField.Account.${name}`], ...(fieldPart ? { fieldPart } : {}) });
const sectionHints = {
  tags: ['span', 'h3', 'flexipage-field-section2', 'flexipage-component2', 'flexipage-tab2', 'flexipage-tabset2', 'forcegenerated-flexipage_demo_opportunity_record_page_opportunity__view_js___lmt___1'],
  tabRole: 'tabpanel',
  componentIds: ['flexipage_fieldSection1'],
  flexipage: 'forcegenerated-flexipage_demo_opportunity_record_page_opportunity__view_js___lmt___1',
};

test('M-01: section label @@@SFDC...SFDC@@@ is a Salesforce standard name; the same-text label is a coincidence', () => {
  const pc = { page: 'Demo Opportunity Record Page', id: 'flexipage_fieldSection1', component: 'flexipage:fieldSection', label: '@@@SFDCOpportunity_InformationSFDC@@@' };
  const out = run('Opportunity Information', { hints: sectionHints, pageComponent: pc });
  const r = out.results[0];
  assert.equal(r.source, SOURCE.SALESFORCE);
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.title, 'Salesforce text');
  assert.match(r.subtitle, /"Opportunity Information"/);
  assert.match(r.steps[0], /Admins cannot change or translate it/);
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
  const out = run('Backup', { hints: field('Demo_Backup_Phone__c') });
  const r = out.results.find((x) => x.key === 'field:Account.Demo_Backup_Phone__c');
  assert.ok(r, 'field card kept');
  assert.equal(r.confidence, 'context');
  assert.match(r.notes[0], /You pointed inside this field/);
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
  assert.equal(cb.source, SOURCE.SALESFORCE);
  assert.equal(cb.title, 'Salesforce text');
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
  assert.equal(normalize('Demo Gadgets (0)'), 'demo gadgets');
  assert.equal(normalize('Cases (10+)'), 'cases');
  assert.equal(normalize('Step (1) of 3'), 'step (1) of 3');
  const r = run('Demo Gadgets (0)').results[0];
  assert.equal(r.key, 'label:101S00000000005');
  assert.equal(r.confidence, 'exact');
});

test('M-08: a quick action without an object prefix is global', () => {
  const g = run('Demo Service Task').results.find((x) => x.key === 'qa:Demo_Service_Task');
  assert.ok(g.steps.includes('Object: Global'));
  // TW → Action lists an Object option "Global" (value Global), checked live.
  assert.equal(g.goto.object, 'Global');
  const o = run('New Case').results.find((x) => x.key === 'qa:Account.Demo_New_Case');
  assert.ok(o.steps.includes('Object: Account'));
  assert.equal(o.goto.object, 'Account');
});

test('M-10: the org\'s own label ranks before managed labels with the same text', () => {
  const titles = run('Workshop').results.filter((x) => x.source === SOURCE.CUSTOM_LABEL).map((x) => x.title);
  assert.equal(titles[0], 'Custom label Workshop');
  assert.ok(titles.slice(1).every((t) => /__/.test(t)), titles.join(', '));
});

test('M-10: same-text managed labels rank after object answers and fold when the page confirms another answer', () => {
  const rs = run('Accounts').results;
  assert.equal(rs[0].key, 'object:Account');
  assert.equal(rs.at(-1).key, 'label:101S0000000000A');
  const pc = { page: 'Demo Account Record Page', id: 'flexipage_tab3', component: 'flexipage:tab', label: '{!$Label.Workshop}' };
  const out = run('Workshop', { hints: { tags: ['a', 'lightning-tab-bar'], tabRole: 'tab' }, pageComponent: pc });
  assert.equal(out.results[0].key, 'label:101S00000000007');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.equal(out.results.filter((x) => x.source === SOURCE.CUSTOM_LABEL && x.pkg).length, 2);
  assert.equal(out.hiddenManaged, 1);
});

test('M-11: a nav bar item is the object tab, not a same-text custom label', () => {
  const org = { ...baseOrg, customLabels: [...baseOrg.customLabels, lbl('101S0000000000B', 'Demo_Accounts', 'Accounts')] };
  const out = locate({ text: 'Accounts', org, describes: [], hints: { tags: ['span', 'a', 'one-app-nav-bar-item-root', 'one-app-nav-bar'] } });
  assert.equal(out.results[0].key, 'object:Account');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(!out.results.some((x) => x.source === SOURCE.CUSTOM_LABEL));
  assert.equal(out.droppedPartial, 2);
});

test('M-13: pointing at a value: record data, formula output and currency name come first', () => {
  const v = run('Acme Gadgets Ltd', { hints: field('Name', 'value') }).results;
  assert.equal(v[0].key, 'value:Account.Name');
  assert.match(v[0].title, /^Record data: a value typed on the record/);
  assert.ok(v.some((x) => x.key === 'field:Account.Name' && x.confidence === 'context'), 'label card still listed');
  assert.match(run('Open report', { hints: field('Demo_Report_Link__c', 'value') }).results[0].title, /^Formula output/);
  assert.equal(run('USD - U.S. Dollar', { hints: field('CurrencyIsoCode', 'value') }).results[0].title, 'Salesforce text');
  // A picklist value is still the picklist answer.
  assert.ok(run('U.S. Dollar', { hints: field('CurrencyIsoCode', 'value') }).results[0].key.startsWith('picklist:Account.CurrencyIsoCode.'));
});

// Path data in the shape Salesforce returns (Opportunity, Design Path on Demo_Mid_Stage__c); made-up texts and Ids.
const PATH_INFO =
  '<ol><li><u>Plan the gadget sketch</u><ol><li>Who draws the first sketch?</li><li>How will you share it with your Team?</li>' +
  '<li>When is the review for your Teams?  </li><li>Who else reviews the sketch?</li></ol></li></ol><p><br></p>';
const pathOrg = {
  ...baseOrg,
  customLabels: [lbl('101S0000000000C', 'Pkg_Sketch', 'Sketch', 'acme'), lbl('101S0000000000D', 'Dropped', 'Dropped')],
  pathSteps: [{ Id: '1CF000000000001', DeveloperName: 'X11111111111111_01J000000000001AAA_012000000000002AAA_Opportunity_Demo_Mid_Stage', Language: 'en_US', Info: PATH_INFO }],
  paths: [
    { DeveloperName: 'Default_Opportunity', MasterLabel: 'Default', SobjectType: 'Opportunity', SobjectProcessField: 'StageName', RecordTypeId: null, IsActive: false },
    { DeveloperName: 'Retail_Path', MasterLabel: 'Retail Path', SobjectType: 'Opportunity', SobjectProcessField: 'StageName', RecordTypeId: '012000000000001AAA', IsActive: true },
    { DeveloperName: 'Design_Path', MasterLabel: 'Design Path', SobjectType: 'Opportunity', SobjectProcessField: 'Demo_Mid_Stage__c', RecordTypeId: '012000000000002AAA', IsActive: true },
  ],
};
const oppPath = {
  name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', custom: false, recordTypeInfos: [], quickActions: [],
  fields: [{ name: 'Demo_Mid_Stage__c', label: 'Mid Stage', custom: true, type: 'picklist', picklistValues: [{ label: 'Sketch', value: 'SKETCH', active: true }, { label: 'Dropped', value: 'DROPPED', active: true }] }],
};
const guidanceHints = { tags: ['li', 'ol', 'div'], auraClasses: ['uiOutputRichText', 'runtime_sales_pathassistantPathAssistantInfo', 'runtime_sales_pathassistantPathAssistant'] };

test('M-14: a path chevron confirms the path field picklist value, not the same-text label', () => {
  const chevron = { tags: ['span', 'a', 'li', 'ul', 'div'], auraClasses: ['runtime_sales_pathassistantPathAssistantTabSet', 'runtime_sales_pathassistantPathAssistant'] };
  for (const [text, value] of [['Sketch', 'SKETCH'], ['Dropped', 'DROPPED']]) {
    const r = locate({ text, org: pathOrg, describes: [oppPath], hints: chevron }).results[0];
    assert.equal(r.key, `picklist:Opportunity.Demo_Mid_Stage__c.${value}`, text);
    assert.equal(r.confidence, 'confirmed');
    assert.match(r.notes[0], /path "Design Path"/);
  }
});

test('M-17: a highlight of the heading plus guidance lines finds the step', () => {
  const t = 'Guidance for Success\nPlan the gadget sketch\nWho draws the first sketch?';
  const r = locate({ text: t, org: pathOrg, describes: [oppPath], hints: guidanceHints }).results.find((x) => x.key.startsWith('path:'));
  assert.ok(r, 'found');
  assert.equal(r.confidence, 'confirmed');
  assert.equal(pathStepMatch(normalize(t), PATH_INFO, t), 'exact');
  assert.equal(pathStepMatch(normalize('Guidance for Success Who draws the first sketch?'), PATH_INFO), 'exact');
  assert.equal(pathStepMatch(normalize('Guidance for Success'), PATH_INFO, 'Guidance for Success'), null);
  const some = 'Who draws the first sketch?\nHow will you share it with your Team?\nSomething else entirely';
  assert.equal(pathStepMatch(normalize(some), PATH_INFO, some), 'partial');
});

test('M-15: path heading and step buttons are Salesforce text; the button names the path field', () => {
  const pathArea = { tags: ['span', 'button', 'div'], auraClasses: ['runtime_sales_pathassistantPathAssistantHeader', 'runtime_sales_pathassistantPathAssistant'] };
  // The heading: p < h2.slds-path__coach-title < div[…PathAssistantInfo] (dev org, checked live).
  const headingArea = { tags: ['p', 'h2', 'div', 'section'], auraClasses: ['runtime_sales_pathassistantPathAssistantInfo', 'runtime_sales_pathassistantPathAssistantBody', 'runtime_sales_pathassistantPathAssistant'] };
  const h = locate({ text: 'Guidance for Success', org: pathOrg, describes: [oppPath], hints: headingArea });
  assert.equal(h.results[0].title, 'Salesforce text');
  assert.equal(h.notFoundHelp, null);
  const b = locate({ text: 'Mark Mid Stage as Complete', org: pathOrg, describes: [oppPath], hints: pathArea }).results;
  assert.equal(b[0].title, 'Salesforce text');
  assert.ok(b.some((r) => r.key === 'field:Opportunity.Demo_Mid_Stage__c' && r.confidence === 'context'));
  assert.ok(locate({ text: 'Mark as Current Mid Stage', org: pathOrg, describes: [oppPath], hints: pathArea }).results.some((r) => r.key === 'field:Opportunity.Demo_Mid_Stage__c'));
});

test('M-15: activity timeline, duplicates and feed text → Salesforce text first, same-text labels hidden', () => {
  const org = { ...baseOrg, customLabels: [...baseOrg.customLabels, lbl('101S0000000000E', 'Pkg_Upcoming', 'Upcoming & Overdue', 'acme')] };
  const out = locate({ text: 'Upcoming & Overdue', org, describes: [account], hints: { tags: ['span', 'div'], sfComponents: ['runtime_sales_activities_activityPanel'] } });
  assert.equal(out.results[0].title, 'Salesforce text');
  assert.ok(!out.results.some((r) => r.source === SOURCE.CUSTOM_LABEL));
  assert.equal(locate({ text: 'updated this record.', org, describes: [], hints: { sfComponents: ['forceChatter_recordFeedContainer'] } }).results[0].title, 'Salesforce text');
  assert.equal(locate({ text: 'View Duplicates', org, describes: [], hints: { sfComponents: ['runtime_sales_merge_mergeCandidatesPreviewCard2'] } }).results[0].title, 'Salesforce text');
  // A field label inside the timeline is still found.
  assert.ok(locate({ text: 'Account Owner', org, describes: [account], hints: { sfComponents: ['runtime_sales_activities_activityPanel'] } }).results.some((r) => r.key === 'field:Account.OwnerId'));
});
