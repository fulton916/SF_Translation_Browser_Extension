import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, normalize, matchType, contextObjects, parseSelectionName, buildGotoUrl, namespaceOf, isSetupPage, SOURCE, htmlLines, htmlToText, pathStepMatch, pathOfStep } from '../src/locator.js';

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
  // Renamed standard apps are listed in Translation Workbench → App (e.g. LightningSales "Acme Sales").
  assert.equal(first('Sales').source, SOURCE.WORKBENCH);
  assert.ok(first('Sales').steps.includes('Setup Component: App'));
  assert.match(first('Sales').notes.join(' '), /Standard app: if it was renamed/);
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

// Bug (Nov 2026): right-clicking the "Business Unit" section header showed the Account field
// "Business Unit" first, because the section card ranked below every exact match.
const layoutHeaderHints = { tags: ['span', 'button', 'h3', 'records-record-layout-section', 'records-record-layout-block'] };
const withBusinessUnitField = { ...accountDescribe, fields: [...accountDescribe.fields, { name: 'Business_Unit__c', label: 'Business Unit', custom: true, type: 'picklist', picklistValues: [] }] };
const runSection = (extra = {}) => locate({ text: 'Business Unit', hints: layoutHeaderHints, org, describes: [withBusinessUnitField], ...extra });

test('section header click ranks the layout section above a field with the same name', () => {
  const out = runSection();
  assert.equal(out.results[0].key, 'area:layoutSection');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(out.results.some((r) => r.key.includes('Business_Unit__c')), 'field still listed lower down');
});

test('section header goto has no parent, so auto-fill opens every layout', () => {
  const r = runSection().results[0];
  assert.equal(r.goto.parent, null);
  assert.deepEqual(r.goto.rows, ['Business Unit']);
  assert.ok(r.notes.some((n) => /several page layouts/.test(n)));
});

test('blank space inside a section (no heading in the path) is not promoted over an exact match', () => {
  const out = locate({ text: 'Business Unit', hints: { tags: ['div', 'records-record-layout-section'] }, org, describes: [withBusinessUnitField] });
  const r = out.results.find((x) => x.key === 'area:layoutSection');
  assert.equal(r.confidence, 'context');
  assert.notEqual(out.results[0].key, 'area:layoutSection');
});

test('a field inside a section is not treated as the section header', () => {
  const out = locate({ text: 'Business Unit', hints: { tags: ['span', 'records-record-layout-item', 'records-record-layout-section'] }, org, describes: [withBusinessUnitField] });
  assert.ok(!out.results.some((r) => r.key === 'area:layoutSection'));
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

// ---------- Org-built translation objects (found in a real org: Product_Translations__c) ----------

const productWithCustom = {
  ...productDescribe,
  translationChildren: [{ object: 'Product_Translations__c', relationship: 'Product_Translations__r', label: null }],
};
const orgWithCustom = { ...org, objects: [...(org.objects || []), { name: 'Product_Translations__c', label: 'Product Translation', labelPlural: 'Product Translations', custom: true }] };
const runCustom = (text, hints) =>
  locate({ text, hints, org: orgWithCustom, describes: [productWithCustom], dataTranslations: [dt], record: { object: 'Product2', id: '01t000000000001AAA' } });

test('record value also lists the org-built translation object with a related-list link', () => {
  const r = runCustom('Widget Pro', { selectionNames: ['sfdc:RecordField.Product2.Name'] }).results;
  assert.equal(r[0].source, SOURCE.DATA);
  const c = r.find((x) => x.source === SOURCE.CUSTOM_OBJECT);
  assert.ok(c, 'custom translation object result');
  assert.match(c.title, /Product Translations/);
  assert.equal(c.url, '/lightning/r/Product2/01t000000000001AAA/related/Product_Translations__r/view');
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

// ---------- Setup pages show Salesforce's own text (bug: "Export" heading matched maps__MA_Export) ----------

const SETUP_URLS = [
  'https://acme--uat.sandbox.my.salesforce-setup.com/lightning/setup/LabelWorkbenchExport/home',
  'https://acme--uat.sandbox.my.salesforce-setup.com/i18n/TranslationWorkbenchExport.apexp',
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

// ---------- Findings from a real Workbench export (Nov 2026) ----------

test('picklist goto names its field, because Picklist Value is a tree on the Translate page', () => {
  const d = { name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, recordTypeInfos: [], quickActions: [],
    fields: [{ name: 'Segmentation_LST__c', label: 'Segmentation', custom: true, type: 'picklist', picklistValues: [{ label: 'Mid - Tier', value: 'Mid - Tier', active: true }] }] };
  const r = locate({ text: 'Mid - Tier', org, describes: [d] }).results[0];
  assert.equal(r.goto.component, 'PicklistMaster');
  assert.equal(r.goto.parent, 'Segmentation');
  assert.equal(buildGotoUrl(r.goto, 'de').autofill.parent, 'Segmentation');
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

// ---------- Dynamic Forms field section (bug: "Business Unit" header on an Account page) ----------
// Real path: flexipage-field-section2 > flexipage-component2[flexipage_fieldSection6] > flexipage-tab2[role=tabpanel] ...
const sectionHints = {
  tags: ['span', 'h3', 'flexipage-field-section2', 'flexipage-component2', 'flexipage-tab2', 'flexipage-tabset2', 'forcegenerated-flexipage_prospect_record_page_three_column_account__view_js___lmt___1'],
  tabRole: 'tabpanel',
  componentIds: ['flexipage_fieldSection6', 'flexipage_tabset'],
  flexipage: 'forcegenerated-flexipage_prospect_record_page_three_column_account__view_js___lmt___1',
};
const orgBU = { ...org, customLabels: [...org.customLabels, { Id: '101000000000009', Name: 'Business_Unit', MasterLabel: 'Business Unit', NamespacePrefix: null, Value: 'Business Unit', Language: 'en_US' }] };

test('field section header: no false "Lightning page tab label" card, section area detected', () => {
  const out = locate({ text: 'Business Unit', hints: sectionHints, org: orgBU });
  assert.ok(!out.results.some((r) => r.key === 'area:lightningPageTab'));
  assert.ok(out.areas.includes('fieldSection'));
});

test('field section whose label is {!$Label.Business_Unit} → that custom label, confirmed', () => {
  const pc = { page: 'Prospect Record Page Three Column', id: 'flexipage_fieldSection6', component: 'flexipage:fieldSection', label: '{!$Label.Business_Unit}' };
  const r = locate({ text: 'Business Unit', hints: sectionHints, org: orgBU, pageComponent: pc }).results[0];
  assert.equal(r.source, SOURCE.CUSTOM_LABEL);
  assert.equal(r.confidence, 'confirmed');
  assert.match(r.notes[0], /Lightning App Builder is \{!\$Label\.Business_Unit\}/);
});

test('field section label typed as text → not translatable, suggests the matching label', () => {
  const pc = { page: 'Prospect Record Page', id: 'flexipage_fieldSection2', component: 'flexipage:fieldSection', label: 'Business Unit' };
  const r = locate({ text: 'Business Unit', hints: sectionHints, org: orgBU, pageComponent: pc }).results[0];
  assert.equal(r.source, SOURCE.NOT_TRANSLATABLE);
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.copy, '{!$Label.c.Business_Unit}');
});

test('tab label itself (role=tab) is still the Lightning page tab card', () => {
  const out = locate({ text: 'Territory', hints: { tags: ['a', 'li', 'lightning-tab-bar', 'flexipage-tabset2'], tabRole: 'tab' }, org });
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
  const out = locate({ text: 'Business Unit', hints: sectionHints, org: orgBU });
  assert.ok(!out.results.some((r) => r.key === 'area:fieldSection'));
  const r = out.results.find((x) => x.source === SOURCE.CUSTOM_LABEL);
  assert.match(r.notes[0], /Likely the source/);
});

test('field section, page not readable, no label matched → the section card explains', () => {
  const out = locate({ text: 'Unmatched Header Text', hints: sectionHints, org: orgBU });
  assert.ok(out.results.some((r) => r.key === 'area:fieldSection'));
});

// ---------- Path guidance ("Guidance for Success" → Translation Workbench → Path Step Rich Text) ----------
// Real UAT2 data (Nov 2026): PathAssistantStepInfo.Info is rich text HTML; DeveloperName carries the
// picklist value Id, record type Id, object and field. The Workbench grid shows Info as raw HTML.

const PATH_INFO =
  '<ol><li><u>Build network of influencers</u><ol><li>Who needs to be contacted?</li><li>How will you connect with your Client?</li>' +
  '<li>What is your timescale for contacting your Clients?  </li><li>Who else needs to be contacted?</li></ol></li></ol><p><br></p>';
const pathOrg = {
  ...org,
  objects: [...org.objects, { name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', custom: false }],
  pathSteps: [
    { Id: '1CF000000000001', DeveloperName: 'X80069814330387_01JVD00000Ed5rF2AR_012VD000008OBM4YAO_Opportunity_Sub_Stage_LST', MasterLabel: 'X80069814330387_01JVD00000Ed5rF2AR_012VD000008OBM4YAO_Opportunity_Sub_Stage_LST', Language: 'en_US', Info: PATH_INFO },
    { Id: '1CF000000000002', DeveloperName: 'Lead_null_Status_01JD00000080e3FMAQ_810225277674347', MasterLabel: 'x', Language: 'en_US', Info: '<p>Call within 24 hours &amp; log the outcome</p>' },
  ],
  paths: [
    { DeveloperName: 'Default_Opportunity', MasterLabel: 'Default', SobjectType: 'Opportunity', SobjectProcessField: 'StageName', RecordTypeId: null, IsActive: false },
    { DeveloperName: 'Open_Opportunity', MasterLabel: 'Open Opportunity', SobjectType: 'Opportunity', SobjectProcessField: 'StageName', RecordTypeId: '012Ui000004aO4kIAE', IsActive: true },
    { DeveloperName: 'Specification_Path', MasterLabel: 'Specification Path', SobjectType: 'Opportunity', SobjectProcessField: 'Sub_Stage_LST__c', RecordTypeId: '012VD000008OBM4YAO', IsActive: true },
    { DeveloperName: 'Lead_Path', MasterLabel: 'Lead Path', SobjectType: 'Lead', SobjectProcessField: 'Status', RecordTypeId: null, IsActive: true },
  ],
};
const oppDescribe = {
  name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', custom: false,
  fields: [{ name: 'Sub_Stage_LST__c', label: 'Sub Stage', custom: true, type: 'picklist', picklistValues: [] }],
  recordTypeInfos: [], quickActions: [],
};
// Real path from the record page: the guidance is Aura divs, found by data-aura-class.
const guidanceHints = {
  tags: ['li', 'ol', 'div', 'section', 'span', 'flexipage-aura-wrapper', 'forcegenerated-flexipage_opportunity_specification_record_page_three_column_opportunity__view_js___lmt___1'],
  auraClasses: ['uiOutputRichText', 'runtime_sales_pathassistantPathAssistantInfo', 'runtime_sales_pathassistantPathAssistantBody', 'runtime_sales_pathassistantCollapsibleDrawer', 'runtime_sales_pathassistantPathAssistant'],
};
const runPath = (text, extra = {}) => locate({ text, org: pathOrg, describes: [oppDescribe], ...extra });
const pathHit = (out) => out.results.find((r) => r.key.startsWith('path:'));

test('htmlLines strips tags, decodes entities, one line per list item', () => {
  assert.deepEqual(htmlLines(PATH_INFO), [
    'Build network of influencers',
    'Who needs to be contacted?',
    'How will you connect with your Client?',
    'What is your timescale for contacting your Clients?',
    'Who else needs to be contacted?',
  ]);
  assert.equal(htmlToText('<p>A &amp; B&nbsp;&#8211; C&#x21;\u200B</p><p><br></p>'), 'A & B – C!');
  assert.equal(htmlToText('<ol><li>Cut off here<o'), 'Cut off here');
});

test('pathStepMatch: a list line is exact, a phrase is partial, short words never match', () => {
  assert.equal(pathStepMatch(normalize('Who needs to be contacted?'), PATH_INFO), 'exact');
  assert.equal(pathStepMatch(normalize('Build network of influencers'), PATH_INFO), 'exact');
  assert.equal(pathStepMatch(normalize('connect with your Client'), PATH_INFO), 'partial');
  for (const t of ['a', 'Who', 'your', 'Client', 'contacted', 'Clients?']) assert.equal(pathStepMatch(normalize(t), PATH_INFO), null, t);
  // Highlighted across list items: lines join with a space.
  assert.equal(pathStepMatch(normalize('Who needs to be contacted?\nHow will you connect'), PATH_INFO), 'partial');
});

test('pathOfStep reads both real DeveloperName shapes', () => {
  const steps = pathOrg.pathSteps;
  assert.equal(pathOfStep(steps[0].DeveloperName, pathOrg.paths).path.DeveloperName, 'Specification_Path');
  assert.equal(pathOfStep('X653945998243627_01J3i00000BITICEA5_null_Opportunity_StageName', pathOrg.paths).path.DeveloperName, 'Default_Opportunity');
  assert.equal(pathOfStep(steps[1].DeveloperName, pathOrg.paths).path.DeveloperName, 'Lead_Path');
  // No path data: object and field still come from the name.
  assert.deepEqual(pathOfStep(steps[0].DeveloperName, null, pathOrg.objects), { path: null, object: 'Opportunity', field: 'Sub_Stage_LST' });
  assert.deepEqual(pathOfStep(steps[1].DeveloperName, []), { path: null, object: 'Lead', field: 'Status' });
});

test('guidance line in the path guidance area → Workbench Path Step Rich Text, confirmed', () => {
  const out = runPath('Who needs to be contacted?', { hints: guidanceHints });
  assert.ok(out.areas.includes('path') && out.areas.includes('pathGuidance'));
  const r = out.results[0];
  assert.equal(r.key, 'path:1CF000000000001');
  assert.equal(r.source, SOURCE.WORKBENCH);
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.title, 'Path guidance: Specification Path (Opportunity › Sub Stage)');
  assert.ok(r.steps.includes('Setup Component: Path Step Rich Text'));
  assert.ok(r.steps.some((s) => s.startsWith('Find the row that starts with "<ol><li><u>Build network')));
  assert.ok(r.steps.some((s) => /one translation: keep its formatting/.test(s)));
  assert.ok(!r.steps.some((s) => /^(Object|Aspect):/.test(s)));
  assert.equal(r.goto.component, 'PathAssistantStepInfo');
  assert.equal(r.goto.object, null);
  assert.equal(r.goto.aspect, null);
  assert.equal(r.goto.rows[0], PATH_INFO, 'raw HTML first: the grid cell equals Info exactly');
  assert.equal(r.goto.rowMatch, 'richText');
  assert.equal(r.goto.rowLabel, 'Build network of influencers');
  const b = buildGotoUrl(r.goto, 'fr');
  assert.equal(b.path, '/lightning/setup/LabelWorkbenchTranslate/home');
  assert.equal(b.autofill.page, 'workbench');
  assert.equal(b.autofill.component, 'PathAssistantStepInfo');
  assert.equal(b.autofill.componentLabel, 'Path Step Rich Text');
  assert.equal(b.autofill.lang, 'fr');
});

test('guidance line outside the path area is same text, a phrase is a guess', () => {
  assert.equal(pathHit(runPath('Who needs to be contacted?')).confidence, 'exact');
  assert.equal(pathHit(runPath('connect with your Client')).confidence, 'partial');
  // Path chevrons are in the path area but not the guidance: a phrase there is not confirmed.
  const chevron = { tags: ['a', 'li'], auraClasses: ['runtime_sales_pathassistantCollapsibleDrawer'] };
  assert.equal(pathHit(runPath('connect with your Client', { hints: chevron })).confidence, 'partial');
  assert.equal(pathHit(runPath('Who needs to be contacted?', { hints: chevron })).confidence, 'confirmed');
});

test('short words never produce a path guidance card', () => {
  for (const t of ['Who', 'Client', 'a']) assert.equal(pathHit(runPath(t, { hints: guidanceHints })), undefined, t);
});

test('guidance from another object on the page is never confirmed', () => {
  const r = pathHit(runPath('Call within 24 hours & log the outcome', { hints: guidanceHints }));
  assert.equal(r.title, 'Path guidance: Lead Path (Lead › Status)');
  assert.equal(r.confidence, 'partial');
});

test('path guidance still works without PathAssistant data (query failed)', () => {
  const out = locate({ text: 'Who needs to be contacted?', hints: guidanceHints, org: { ...pathOrg, paths: null }, describes: [oppDescribe] });
  const r = out.results[0];
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.title, 'Path guidance: unknown path (Opportunity › Sub Stage)');
  assert.equal(r.goto.component, 'PathAssistantStepInfo');
});

test('no path guidance loaded → no path card, no crash', () => {
  const out = locate({ text: 'Who needs to be contacted?', hints: guidanceHints, org: { ...pathOrg, pathSteps: null, paths: null }, describes: [oppDescribe] });
  assert.equal(pathHit(out), undefined);
});

test('older content.js without auraClasses: tags only, still same text', () => {
  const r = pathHit(runPath('Who needs to be contacted?', { hints: { tags: ['li', 'ol', 'div'] } }));
  assert.equal(r.confidence, 'exact');
});
