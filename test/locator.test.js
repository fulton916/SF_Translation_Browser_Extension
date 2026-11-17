import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, normalize, matchType, contextObjects, parseSelectionName, buildGotoUrl, namespaceOf, isSetupPage, SOURCE } from '../src/locator.js';

const org = {
  userLanguage: 'en_US',
  defaultLanguage: 'en_US',
  customLabels: [
    { Id: '101000000000001', Name: 'Welcome_Message', MasterLabel: 'Welcome', NamespacePrefix: null, Value: 'Welcome to the portal', Language: 'en_US' },
    { Id: '101000000000002', Name: 'Submit_Btn', MasterLabel: 'Submit', NamespacePrefix: 'acme', Value: 'Submit request', Language: 'en_US' },
  ],
  labelTranslations: [{ ExternalStringId: '101000000000001', Language: 'es', Value: 'Bienvenido al portal' }],
  objects: [
    { name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false },
    { name: 'AccountHistory', label: 'Account History', labelPlural: 'Account History', custom: false },
    { name: 'Invoice__c', label: 'Invoice', labelPlural: 'Invoices', custom: true },
    // Internal objects with no tab: must never show up (from real screenshots)
    { name: 'Name', label: 'Name', labelPlural: 'Names', custom: false },
    { name: 'LeadStatus', label: 'Lead Status Value', labelPlural: 'Lead Status Values', custom: false },
    { name: 'ChatterActivity', label: 'Chatter Activity', labelPlural: 'Chatter Activities', custom: false },
    { name: 'OpenActivity', label: 'Open Activity', labelPlural: 'Open Activities', custom: false },
    { name: 'Lead', label: 'Lead', labelPlural: 'Leads', custom: false },
  ],
  tabs: [
    { Name: 'Invoice__c', Label: 'Invoices', IsCustom: true, SobjectName: 'Invoice__c' },
    { Name: 'standard-Lead', Label: 'Leads', IsCustom: false, SobjectName: 'Lead' },
    { Name: 'standard-home', Label: 'Home', IsCustom: false, SobjectName: null },
    { Name: 'Training_Portal', Label: 'Training Portal', IsCustom: true, SobjectName: null },
    { Name: 'standard-Account', Label: 'Accounts', IsCustom: false, SobjectName: 'Account' },
  ],
  apps: [
    { Label: 'Sales', Name: 'Sales', NamespacePrefix: 'standard', Type: 'TabSet' },
    { Label: 'Billing Console', Name: 'Billing_Console', NamespacePrefix: null, Type: 'TabSet' },
  ],
  validationRules: [
    { Id: '03d1', ValidationName: 'Amount_Positive', ErrorMessage: 'Amount must be greater than zero', EntityDefinition: { QualifiedApiName: 'Invoice__c' } },
  ],
};

const accountDescribe = {
  name: 'Account',
  label: 'Account',
  custom: false,
  fields: [
    {
      name: 'Industry',
      label: 'Industry',
      custom: false,
      type: 'picklist',
      inlineHelpText: null,
      picklistValues: [{ label: 'Banking', value: 'Banking', active: true }],
    },
    { name: 'Region__c', label: 'Sales Region', custom: true, type: 'picklist', inlineHelpText: 'Pick the territory that owns this account', picklistValues: [] },
  ],
  recordTypeInfos: [
    { name: 'Partner Account', developerName: 'Partner', master: false },
    { name: 'Master', developerName: 'Master', master: true },
  ],
  quickActions: [{ label: 'Log a Call', name: 'LogACall', type: 'LogACall' }],
};

const run = (text, extra = {}) => locate({ text, org, describes: [accountDescribe], ...extra });
const first = (text, extra) => run(text, extra).results[0];

test('normalize strips asterisks, colons, whitespace, case', () => {
  assert.equal(normalize('  *Industry:  '), 'industry');
  assert.equal(normalize('Account  Name'), 'account name');
});

test('matchType: exact, partial, word-boundary', () => {
  assert.equal(matchType('industry', 'Industry'), 'exact');
  assert.equal(matchType('welcome', 'Welcome to the portal'), 'partial');
  assert.equal(matchType('edit industry', 'Industry'), 'partial');
  assert.equal(matchType('industrysector', 'Industry'), null);
});

test('custom label master value → Custom Labels with deep link', () => {
  const r = first('Welcome to the portal');
  assert.equal(r.source, SOURCE.CUSTOM_LABEL);
  assert.equal(r.confidence, 'exact');
  assert.match(r.url, /ExternalStrings\/page\?address=%2F101000000000001/);
  assert.equal(r.copy, '$Label.c.Welcome_Message');
});

test('custom label translated value is found too', () => {
  const r = first('Bienvenido al portal');
  assert.equal(r.source, SOURCE.CUSTOM_LABEL);
  assert.ok(r.notes.some((n) => n.includes('Spanish translation')));
});

test('managed label gets namespace and override note', () => {
  const r = first('Submit request');
  assert.equal(r.title, 'Custom label acme__Submit_Btn');
  assert.ok(r.notes.some((n) => n.includes('override')));
});

test('standard object name → Rename Tabs and Labels; history objects ignored', () => {
  const rs = run('Accounts').results;
  assert.equal(rs[0].source, SOURCE.RENAME_TABS);
  assert.equal(rs[0].key, 'object:Account');
  assert.ok(!rs.some((r) => r.key === 'object:AccountHistory'));
  assert.ok(!rs.some((r) => r.key === 'tab:standard-Account'), 'object tab not duplicated');
});

test('custom object name → Rename Tabs (Custom Tabs) plus Object Manager note in default language', () => {
  const r = first('Invoice');
  assert.equal(r.source, SOURCE.RENAME_TABS);
  assert.ok(r.steps.some((s) => s.includes('Custom Tabs')));
  assert.ok(r.notes.some((n) => n.includes('Object Manager')));
});

test('standard field label → Rename Tabs step 2', () => {
  const r = first('Industry');
  assert.equal(r.source, SOURCE.RENAME_TABS);
  assert.equal(r.key, 'field:Account.Industry');
});

test('custom field label → Workbench Custom Field / Field Label', () => {
  const r = first('Sales Region');
  assert.equal(r.source, SOURCE.WORKBENCH);
  assert.ok(r.steps.includes('Setup Component: Custom Field'));
  assert.ok(r.steps.includes('Aspect: Field Label'));
});

test('help text → Workbench Help Text', () => {
  const r = first('Pick the territory that owns this account');
  assert.ok(r.steps.includes('Aspect: Help Text'));
});

test('picklist, record type, quick action, validation, app, web tab', () => {
  assert.ok(first('Banking').steps.includes('Setup Component: Picklist Value'));
  assert.ok(first('Partner Account').steps.includes('Setup Component: Record Type'));
  assert.ok(first('Log a Call').steps.includes('Setup Component: Action'));
  const vr = first('Amount must be greater than zero');
  assert.ok(vr.steps.includes('Setup Component: Validation Error Message'));
  assert.ok(vr.steps.includes('Object: Invoice'));
  assert.ok(first('Billing Console').steps.includes('Setup Component: App'));
  assert.ok(first('Training Portal').steps.includes('Setup Component: Web Tab'));
  assert.equal(first('Sales').source, SOURCE.NOT_TRANSLATABLE);
  assert.equal(first('Home').source, SOURCE.RENAME_TABS);
});

test('master record type is skipped', () => {
  assert.ok(!run('Master').results.some((r) => r.key.startsWith('rt:')));
});

test('non-default language: language step names the viewing language', () => {
  const r = locate({ text: 'Industry', org: { ...org, userLanguage: 'fr' }, describes: [accountDescribe] }).results[0];
  assert.ok(r.steps.some((s) => s.includes('French')));
});

test('page metadata confirms a field match', () => {
  const r = first('Industry', { hints: { selectionNames: ['sfdc:RecordField.Account.Industry'] } });
  assert.equal(r.confidence, 'confirmed');
});

test('custom button, standard button, layout section, custom component from page metadata', () => {
  const rs = run('Do Something', {
    hints: {
      selectionNames: ['sfdc:CustomButton.Account.Do_Something', 'sfdc:StandardButton.Account.Edit'],
      tags: ['span', 'records-record-layout-section', 'c-my-widget'],
    },
  }).results;
  const keys = rs.map((r) => r.key);
  assert.ok(keys.includes('btn:Account.Do_Something'));
  assert.ok(keys.includes('stdbtn:Account.Edit'));
  assert.ok(keys.includes('area:layoutSection'));
  assert.ok(keys.includes('area:customComponent'));
  assert.equal(rs.find((r) => r.key === 'btn:Account.Do_Something').source, SOURCE.WORKBENCH);
});

test('nothing found → help text', () => {
  const out = run('zzqx nothing here');
  assert.equal(out.results.length, 0);
  assert.ok(out.notFoundHelp.length > 0);
});

test('contextObjects reads URL and hints, ignores record Ids', () => {
  assert.deepEqual(contextObjects(['https://x.lightning.force.com/lightning/r/Account/001xx0000000001AAA/view']), ['Account']);
  assert.deepEqual(contextObjects(['https://x.lightning.force.com/lightning/o/Invoice__c/list?filterName=Recent']), ['Invoice__c']);
  assert.deepEqual(
    contextObjects(['https://x.my.salesforce-setup.com/lightning/setup/ObjectManager/Contact/Details/view'], {
      selectionNames: ['sfdc:RecordField.Account.Industry'],
    }),
    ['Account', 'Contact']
  );
  assert.deepEqual(contextObjects(['https://x.lightning.force.com/lightning/page/home']), []);
});

const leadDescribe = {
  name: 'Lead',
  label: 'Lead',
  labelPlural: 'Leads',
  custom: false,
  fields: [
    { name: 'Name', label: 'Full Name', custom: false, type: 'string', picklistValues: [] },
    { name: 'LastActivityDate', label: 'Last Activity', custom: false, type: 'date', picklistValues: [] },
  ],
  recordTypeInfos: [],
  quickActions: [],
};
const runLead = (text, hints) => locate({ text, hints, org, describes: [leadDescribe] });

test('screenshot 1: "Name" on a Lead never points to the internal Name object', () => {
  const out = runLead('Name');
  assert.ok(!out.results.some((r) => r.key === 'object:Name'));
});

test('screenshot 1: clicking inside Lead.Name uses the field from page metadata', () => {
  const out = runLead('Name', { selectionNames: ['sfdc:RecordField.Lead.Name'] });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].key, 'field:Lead.Name');
  assert.equal(out.results[0].source, SOURCE.RENAME_TABS);
  assert.ok(out.results[0].steps.some((s) => s.includes('"Leads" row')));
});

test('screenshot 2: objects without a tab (LeadStatus) are skipped', () => {
  assert.ok(!runLead('Lead Status Value').results.some((r) => r.key === 'object:LeadStatus'));
});

test('screenshot 3: "Activity" on a Lightning page tab shows one answer, partials hidden', () => {
  const out = runLead('Activity', { tags: ['a', 'lightning-tab-bar', 'flexipage-tab2'] });
  assert.deepEqual(out.results.map((r) => r.key), ['area:lightningPageTab']);
  assert.equal(out.droppedPartial, 1); // "Last Activity" field label
});

test('only partials → at most 3 shown', () => {
  const many = { ...org, customLabels: Array.from({ length: 8 }, (_, i) => ({ Id: `l${i}`, Name: `L${i}`, Value: `Activity ${i}`, Language: 'en_US' })) };
  const out = locate({ text: 'Activity', org: many, describes: [] });
  assert.equal(out.results.length, 3);
  assert.equal(out.droppedPartial, 5);
});

test('Rename Tabs steps name the real row on the page', () => {
  const r = first('Accounts');
  assert.ok(r.steps.some((s) => s === 'In the Standard Tabs list, find the "Accounts" row and click Edit'));
});

// ---------- "Go to translation" targets (values verified against a real org) ----------

test('custom field goto uses real Translate dropdown values', () => {
  const g = first('Sales Region').goto;
  assert.deepEqual(
    { page: g.page, component: g.component, object: g.object, aspect: g.aspect, rows: g.rows },
    { page: 'workbench', component: 'CustomFieldDefinition', object: 'Account', aspect: 'master', rows: ['Sales Region'] }
  );
});

test('help text, picklist, record type, action, validation, app gotos', () => {
  assert.equal(first('Pick the territory that owns this account').goto.aspect, 'help');
  const pk = first('Banking').goto;
  assert.equal(pk.component, 'PicklistMaster');
  assert.equal(pk.aspect, null);
  assert.equal(first('Partner Account').goto.component, 'RecordType');
  assert.equal(first('Log a Call').goto.component, 'QuickActionDefinition');
  assert.ok(first('Log a Call').steps.includes('Setup Component: Action'));
  const vr = first('Amount must be greater than zero').goto;
  assert.equal(vr.component, 'ValidationFormula');
  assert.equal(vr.object, 'Invoice__c');
  assert.equal(first('Billing Console').goto.component, 'TabSet');
  assert.ok(first('Billing Console').steps.includes('Setup Component: App'));
});

test('buildGotoUrl: standard field → Rename edit page + Step 2 auto-fill', () => {
  const g = first('Industry').goto;
  const b = buildGotoUrl(g, 'de', 'en_US');
  assert.equal(
    decodeURIComponent(b.path),
    '/lightning/setup/RenameTab/page?address=/_ui/common/i18n/RenameTabStageManager?id=Account&l=de&setupid=RenameTab'
  );
  assert.deepEqual(b.autofill, { page: 'renameStage', lang: 'de', fieldLabel: 'Industry', fieldName: 'Industry' });
});

test('buildGotoUrl: no language chosen → rename uses org default', () => {
  assert.match(decodeURIComponent(buildGotoUrl(first('Accounts').goto, '', 'en_US').path), /l=en_US/);
});

test('buildGotoUrl: custom object → Rename list, auto-click Edit', () => {
  const b = buildGotoUrl(first('Invoice').goto, 'fr', 'en_US');
  assert.equal(b.path, '/lightning/setup/RenameTab/home');
  assert.equal(b.autofill.page, 'renameHome');
  assert.equal(b.autofill.tabLabel, 'Invoices');
});

test('buildGotoUrl: custom label → New translation, or Edit when one exists', () => {
  const orgWithIds = { ...org, labelTranslations: [{ Id: '01j000000000001', ExternalStringId: '101000000000001', Language: 'es', Value: 'Bienvenido al portal' }] };
  const g = locate({ text: 'Welcome to the portal', org: orgWithIds, describes: [] }).results[0].goto;
  assert.equal(decodeURIComponent(buildGotoUrl(g, 'fr').path), '/lightning/setup/ExternalStrings/page?address=/01j/e?Parent=101000000000001');
  assert.deepEqual(buildGotoUrl(g, 'fr').autofill, { page: 'labelNew', lang: 'fr' });
  assert.equal(decodeURIComponent(buildGotoUrl(g, 'es').path), '/lightning/setup/ExternalStrings/page?address=/01j000000000001/e');
});

test('buildGotoUrl: workbench carries filters for auto-fill', () => {
  const b = buildGotoUrl(first('Sales Region').goto, 'de');
  assert.equal(b.path, '/lightning/setup/LabelWorkbenchTranslate/home');
  assert.equal(b.autofill.lang, 'de');
  assert.equal(b.autofill.component, 'CustomFieldDefinition');
});

test('layout section goto searches for the clicked text', () => {
  const r = run('Additional Information', { hints: { tags: ['span', 'records-record-layout-section'] } }).results.find((x) => x.key === 'area:layoutSection');
  assert.equal(r.goto.component, 'LayoutSection');
  assert.deepEqual(r.goto.rows, ['Additional Information']);
});

test('every Translation Workbench result has a goto', () => {
  for (const t of ['Sales Region', 'Banking', 'Partner Account', 'Log a Call', 'Billing Console', 'Training Portal']) {
    const r = first(t);
    assert.ok(r.goto?.component, `${t} missing goto`);
  }
});

test('parseSelectionName handles global actions', () => {
  assert.deepEqual(parseSelectionName('sfdc:QuickAction.NewTask'), { kind: 'QuickAction', object: null, name: 'NewTask', raw: 'sfdc:QuickAction.NewTask' });
});

// ---------- Override (package items) ----------

const pkgDescribe = {
  name: 'Account',
  label: 'Account',
  labelPlural: 'Accounts',
  custom: false,
  fields: [
    { name: 'acme__Tier__c', label: 'Partner Tier', custom: true, type: 'picklist', picklistValues: [{ label: 'Gold', value: 'Gold', active: true }] },
    { name: 'Tier__c', label: 'Local Tier', custom: true, type: 'string', picklistValues: [] },
  ],
  recordTypeInfos: [],
  quickActions: [{ label: 'Score It', name: 'Account.acme__Score_It', type: 'Update' }],
};
const runPkg = (text) => locate({ text, org, describes: [pkgDescribe] }).results[0];

test('namespaceOf', () => {
  assert.equal(namespaceOf('acme__Tier__c'), 'acme');
  assert.equal(namespaceOf('Tier__c'), null);
  assert.equal(namespaceOf('Account.acme__Score_It'), 'acme');
  assert.equal(namespaceOf('Industry'), null);
  assert.equal(namespaceOf('Invoice__mdt'), null);
});

test('packaged custom field → Override with package filter', () => {
  const r = runPkg('Partner Tier');
  assert.equal(r.source, SOURCE.OVERRIDE);
  assert.equal(r.goto.page, 'override');
  assert.equal(r.goto.package, 'acme');
  assert.ok(r.steps[0].includes('Override'));
  const b = buildGotoUrl(r.goto, 'de');
  assert.equal(b.path, '/lightning/setup/LabelWorkbenchOverride/home');
  assert.equal(b.autofill.page, 'workbench');
  assert.equal(b.autofill.package, 'acme');
});

test('local custom field stays on Translate', () => {
  assert.equal(runPkg('Local Tier').source, SOURCE.WORKBENCH);
});

test('packaged picklist value stays on Translate (Override has no Picklist Value) with a note', () => {
  const r = runPkg('Gold');
  assert.equal(r.source, SOURCE.WORKBENCH);
  assert.ok(r.notes[0].includes('Override does not support Picklist Value'));
});

test('packaged quick action and validation rule → Override', () => {
  assert.equal(runPkg('Score It').source, SOURCE.OVERRIDE);
  const o2 = { ...org, validationRules: [{ Id: 'v2', ValidationName: 'Need_Tier', ErrorMessage: 'Tier is required', NamespacePrefix: 'acme', EntityDefinition: { QualifiedApiName: 'Account' } }] };
  const r = locate({ text: 'Tier is required', org: o2, describes: [] }).results[0];
  assert.equal(r.source, SOURCE.OVERRIDE);
  assert.equal(r.goto.package, 'acme');
});

// ---------- Data Translation (record data) ----------

const productDescribe = {
  name: 'Product2', label: 'Product', labelPlural: 'Products', custom: false,
  fields: [{ name: 'Name', label: 'Product Name', custom: false, type: 'string', picklistValues: [] }],
  recordTypeInfos: [], quickActions: [],
};
const dt = {
  object: 'Product2', dtObject: 'Product2DataTranslation',
  fields: [{ name: 'Name', label: 'Product Name' }, { name: 'Description', label: 'Product Description' }],
  recordId: '01t000000000001AAA',
  parent: { Name: 'Widget Pro', Description: 'Our best widget' },
  rows: [{ Id: '0x1', Language: 'de', Name: 'Widget Profi', Description: null }],
};
const runData = (text, hints, dts = [dt]) => locate({ text, hints, org, describes: [productDescribe], dataTranslations: dts });

test('record value → Data Translation with record link', () => {
  const r = runData('Widget Pro', { selectionNames: ['sfdc:RecordField.Product2.Name'] }).results[0];
  assert.equal(r.source, SOURCE.DATA);
  assert.equal(r.confidence, 'confirmed');
  assert.ok(r.notes.some((n) => n.includes('German')));
  const b = buildGotoUrl(r.goto, 'fr');
  assert.equal(b.path, '/lightning/r/Product2/01t000000000001AAA/view');
  assert.equal(b.autofill.page, 'dataTranslation');
});

test('translated record value is found', () => {
  const r = runData('Widget Profi').results[0];
  assert.equal(r.source, SOURCE.DATA);
  assert.ok(r.notes[0].includes('existing German translation'));
});

test('product value with Data Translation off → how to enable', () => {
  const r = runData('Some Product', { selectionNames: ['sfdc:RecordField.Product2.Name'] }, []).results;
  assert.equal(r.length, 1);
  assert.equal(r[0].source, SOURCE.DATA);
  assert.match(r[0].subtitle, /turned off/);
});

test('field label on a product still goes to Rename Tabs, not Data Translation', () => {
  assert.equal(runData('Product Name').results[0].source, SOURCE.RENAME_TABS);
});

// ---------- Org-built translation objects (e.g. Demo_Translations__c) ----------

const productWithCustom = {
  ...productDescribe,
  translationChildren: [{ object: 'Demo_Translations__c', relationship: 'Demo_Translations__r', label: null }],
};
const orgWithCustom = { ...org, objects: [...(org.objects || []), { name: 'Demo_Translations__c', label: 'Demo Translation', labelPlural: 'Demo Translations', custom: true }] };
const runCustom = (text, hints) =>
  locate({ text, hints, org: orgWithCustom, describes: [productWithCustom], dataTranslations: [dt], record: { object: 'Product2', id: '01t000000000001AAA' } });

test('record value also lists the org-built translation object with a related-list link', () => {
  const r = runCustom('Widget Pro', { selectionNames: ['sfdc:RecordField.Product2.Name'] }).results;
  assert.equal(r[0].source, SOURCE.DATA);
  const c = r.find((x) => x.source === SOURCE.CUSTOM_OBJECT);
  assert.ok(c, 'custom translation object result');
  assert.match(c.title, /Demo Translations/);
  assert.equal(c.url, '/lightning/r/Product2/01t000000000001AAA/related/Demo_Translations__r/view');
});

test('field label click does not list the custom translation object', () => {
  const r = runCustom('Product Name', { selectionNames: ['sfdc:RecordField.Product2.Name'] }).results;
  assert.ok(!r.some((x) => x.source === SOURCE.CUSTOM_OBJECT));
});

test('data translation steps say Translations tab and Name-first rule', () => {
  const r = runData('Our best widget', { selectionNames: ['sfdc:RecordField.Product2.Description'] }).results[0];
  assert.ok(r.steps.includes('Click its Translations tab'));
  assert.ok(r.notes.some((n) => n.includes('Translate Name first')));
});

// ---------- Setup pages show Salesforce's own text (bug: "Export" heading matched a package label) ----------

const SETUP_URLS = [
  'https://acme--test.sandbox.my.salesforce-setup.com/lightning/setup/LabelWorkbenchExport/home',
  'https://acme--test.sandbox.my.salesforce-setup.com/i18n/TranslationWorkbenchExport.apexp',
];

test('isSetupPage: Setup yes, record pages no', () => {
  assert.equal(isSetupPage(SETUP_URLS), true);
  assert.equal(isSetupPage(['https://acme.my.salesforce.com/_ui/common/i18n/RenameTabStageManager']), true);
  assert.equal(isSetupPage(['https://acme.lightning.force.com/lightning/r/Account/001000000000001AAA/view']), false);
  assert.equal(isSetupPage([]), false);
});

test('Setup heading that equals a custom label → Salesforce text first, label hidden', () => {
  const out = locate({ text: 'Submit request', org, pageUrls: SETUP_URLS });
  assert.equal(out.results[0].title, "Salesforce's own Setup text");
  assert.equal(out.results[0].source, SOURCE.NOT_TRANSLATABLE);
  assert.ok(!out.results.some((r) => r.source === SOURCE.CUSTOM_LABEL));
  assert.equal(out.droppedPartial, 1);
});

test('same label text on a record page is still a Custom Labels result', () => {
  const r = locate({ text: 'Submit request', org, pageUrls: ['https://acme.lightning.force.com/lightning/r/Account/001000000000001AAA/view'] }).results;
  assert.equal(r[0].source, SOURCE.CUSTOM_LABEL);
  assert.ok(!r.some((x) => x.key === 'setup:builtin'));
});

test('org names on Setup pages (Object Manager) still rank above the Salesforce-text note', () => {
  const r = locate({ text: 'Invoice', org, pageUrls: ['https://acme.my.salesforce-setup.com/lightning/setup/ObjectManager/home'] }).results;
  assert.notEqual(r[0].key, 'setup:builtin');
  assert.equal(r.at(-1).key, 'setup:builtin');
});

// ---------- Findings from a Workbench export (Nov 2026) ----------

test('picklist goto names its field, because Picklist Value is a tree on the Translate page', () => {
  const d = { name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, recordTypeInfos: [], quickActions: [],
    fields: [{ name: 'Demo_Size__c', label: 'Demo Size', custom: true, type: 'picklist', picklistValues: [{ label: 'Mid - Size', value: 'Mid - Size', active: true }] }] };
  const r = locate({ text: 'Mid - Size', org, describes: [d] }).results[0];
  assert.equal(r.goto.component, 'PicklistMaster');
  assert.equal(r.goto.parent, 'Demo Size');
  assert.equal(buildGotoUrl(r.goto, 'de').autofill.parent, 'Demo Size');
});

test('country and state picklist values go to Address Country / Address State', () => {
  const d = { name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, recordTypeInfos: [], quickActions: [],
    fields: [
      { name: 'BillingCountryCode', label: 'Billing Country Code', custom: false, type: 'picklist', picklistValues: [{ label: 'Germany', value: 'DE', active: true }] },
      { name: 'ShippingCountryCode', label: 'Shipping Country Code', custom: false, type: 'picklist', picklistValues: [{ label: 'Germany', value: 'DE', active: true }] },
      { name: 'BillingStateCode', label: 'Billing State Code', custom: false, type: 'picklist', picklistValues: [{ label: 'Bavaria', value: 'BY', active: true }] },
    ] };
  const de = locate({ text: 'Germany', org, describes: [d] }).results;
  assert.equal(de.length, 1, 'one org-wide result, not one per address field');
  assert.equal(de[0].goto.component, 'AddressCountry');
  assert.equal(de[0].goto.object, null);
  assert.equal(locate({ text: 'Bavaria', org, describes: [d] }).results[0].goto.component, 'AddressState');
});

// ---------- Dynamic Forms field section (bug: "Demo Team" header on an Account page) ----------
// Real path: flexipage-field-section2 > flexipage-component2[flexipage_fieldSection6] > flexipage-tab2[role=tabpanel] ...
const sectionHints = {
  tags: ['span', 'h3', 'flexipage-field-section2', 'flexipage-component2', 'flexipage-tab2', 'flexipage-tabset2', 'forcegenerated-flexipage_demo_account_record_page_account__view_js___lmt___1'],
  tabRole: 'tabpanel',
  componentIds: ['flexipage_fieldSection6', 'flexipage_tabset'],
  flexipage: 'forcegenerated-flexipage_demo_account_record_page_account__view_js___lmt___1',
};
const orgTeam = { ...org, customLabels: [...org.customLabels, { Id: '101000000000009', Name: 'Demo_Team', MasterLabel: 'Demo Team', NamespacePrefix: null, Value: 'Demo Team', Language: 'en_US' }] };

test('field section header: no false "Lightning page tab label" card, section area detected', () => {
  const out = locate({ text: 'Demo Team', hints: sectionHints, org: orgTeam });
  assert.ok(!out.results.some((r) => r.key === 'area:lightningPageTab'));
  assert.ok(out.areas.includes('fieldSection'));
});

test('field section whose label is {!$Label.Demo_Team} → that custom label, confirmed', () => {
  const pc = { page: 'Demo Account Record Page', id: 'flexipage_fieldSection6', component: 'flexipage:fieldSection', label: '{!$Label.Demo_Team}' };
  const r = locate({ text: 'Demo Team', hints: sectionHints, org: orgTeam, pageComponent: pc }).results[0];
  assert.equal(r.source, SOURCE.CUSTOM_LABEL);
  assert.equal(r.confidence, 'confirmed');
  assert.match(r.notes[0], /Lightning App Builder is \{!\$Label\.Demo_Team\}/);
});

test('field section label typed as text → not translatable, suggests the matching label', () => {
  const pc = { page: 'Demo Account Record Page', id: 'flexipage_fieldSection2', component: 'flexipage:fieldSection', label: 'Demo Team' };
  const r = locate({ text: 'Demo Team', hints: sectionHints, org: orgTeam, pageComponent: pc }).results[0];
  assert.equal(r.source, SOURCE.NOT_TRANSLATABLE);
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.copy, '{!$Label.c.Demo_Team}');
});

test('tab label itself (role=tab) is still the Lightning page tab card', () => {
  const out = locate({ text: 'Workshop', hints: { tags: ['a', 'li', 'lightning-tab-bar', 'flexipage-tabset2'], tabRole: 'tab' }, org });
  assert.ok(out.results.some((r) => r.key === 'area:lightningPageTab'));
});

test('label in its own master language opens the label to edit the Value, not a translation', () => {
  const r = locate({ text: 'Welcome to the portal', org }).results[0];
  const b = buildGotoUrl(r.goto, 'en_US');
  assert.equal(b.masterEdit, true);
  assert.match(b.path, /ExternalStrings\/page\?address=/);
  assert.ok(!/01j/.test(decodeURIComponent(b.path)));
  // package label: an English override is valid, keep the translation page
  const p = locate({ text: 'Submit request', org }).results[0];
  assert.ok(!buildGotoUrl(p.goto, 'en_US').masterEdit);
});

test('field section, page not readable, label matched → no extra card, label says why it is likely', () => {
  const out = locate({ text: 'Demo Team', hints: sectionHints, org: orgTeam });
  assert.ok(!out.results.some((r) => r.key === 'area:fieldSection'));
  const r = out.results.find((x) => x.source === SOURCE.CUSTOM_LABEL);
  assert.match(r.notes[0], /Likely the source/);
});

test('field section, page not readable, no label matched → the section card explains', () => {
  const out = locate({ text: 'Unmatched Header Text', hints: sectionHints, org: orgTeam });
  assert.ok(out.results.some((r) => r.key === 'area:fieldSection'));
});
