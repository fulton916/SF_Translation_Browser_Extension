// Developer Edition sweep (Nov 2026, tester A): one test per confirmed finding, using the failing example
// with made-up names and Ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, SOURCE } from '../src/locator.js';
import { loadNearestFlexiPageComponent, loadFlowScreens, withObjectIds } from '../src/sfApi.js';

const baseOrg = {
  userLanguage: 'en_US',
  defaultLanguage: 'en_US',
  labelTranslations: [],
  objects: [
    { name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false },
    { name: 'Demo_Gadget__c', label: 'Gadget', labelPlural: 'Gadgets', custom: true },
  ],
  tabs: [
    { Name: 'standard-Account', Label: 'Accounts', IsCustom: false, SobjectName: 'Account' },
    { Name: 'Demo_Gadget__c', Label: 'Gadgets', IsCustom: true, SobjectName: 'Demo_Gadget__c' },
  ],
  apps: [],
  validationRules: [],
  customLabels: [],
};
const gadget = {
  name: 'Demo_Gadget__c', label: 'Gadget', labelPlural: 'Gadgets', custom: true, quickActions: [], recordTypeInfos: [],
  fields: [{ name: 'Demo_Color__c', label: 'Coat Color', custom: true, type: 'string', picklistValues: [] }],
};

test('A-26: the error message under a field is its validation rule, not the field', () => {
  const org = {
    ...baseOrg,
    validationRules: [{ Id: '03d000000000001AAA', ValidationName: 'Demo_Color_Required', ErrorMessage: 'Shipped gadgets need a coat color.', EntityDefinition: { QualifiedApiName: 'Demo_Gadget__c' } }],
  };
  const hints = { selectionNames: ['sfdc:RecordField.Demo_Gadget__c.Demo_Color__c'], fieldPart: 'error' };
  const rs = locate({ text: 'Shipped gadgets need a coat color.', org, describes: [gadget], hints }).results;
  assert.equal(rs[0].key, 'vr:03d000000000001AAA');
  assert.equal(rs[0].confidence, 'confirmed');
  assert.equal(rs[0].notes[0], 'You pointed at the error message shown under the field Coat Color.');
  assert.ok(!rs.some((r) => r.key.startsWith('value:')), 'not "Record data"');
});

test('A-16: text in a Lightning App Builder Rich Text component → Admin work required', () => {
  const hints = {
    tags: ['p', 'div', 'div', 'div', 'flexipage-aura-wrapper', 'slot', 'flexipage-component2', 'flexipage-tab2'],
    auraClasses: ['uiOutputRichText', 'flexipageRichText'],
    componentIds: ['demo_richText'],
    tabRole: 'tabpanel',
  };
  const out = locate({ text: 'Ask the lead before shipping.', org: baseOrg, describes: [gadget], hints });
  assert.ok(out.areas.includes('richText'));
  const r = out.results[0];
  assert.equal(r.key, 'area:richText');
  assert.equal(r.source, SOURCE.NOT_TRANSLATABLE);
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.title, 'Rich text typed in Lightning App Builder');
  assert.ok(!out.results.some((x) => x.key === 'area:lightningPageTab'));
});

test('A-23 / B-10: a list in the standard Related Lists component names the child lookup field and object', () => {
  const account = { name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, fields: [], recordTypeInfos: [], quickActions: [] };
  // As background.js builds it from the title link (.../related/Demo_Gadgets__r/view) and the describes.
  const pc = {
    page: null, id: null, component: 'force:relatedListSingleContainer', label: null, props: { relatedListApiName: 'Demo_Gadgets__r' },
    child: { childSObject: 'Demo_Gadget__c', field: 'Demo_Account__c', relationshipName: 'Demo_Gadgets__r', fieldLabel: 'Gadget Account', objectLabel: 'Gadget' },
  };
  const hints = {
    tags: ['span', 'a', 'h2', 'div', 'lst-list-view-manager-header', 'lst-related-list-view-manager', 'article', 'lst-related-list-single-container', 'lst-related-list-container', 'flexipage-component2'],
    listHeader: true, componentIds: ['force_relatedListContainer'], relatedListApi: 'Demo_Gadgets__r',
  };
  const out = locate({ text: 'Account Gadgets (1)', org: baseOrg, describes: [account], hints, pageComponent: pc });
  const r = out.results[0];
  assert.equal(r.key, 'rellist:Demo_Gadget__c.Demo_Account__c');
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.subtitle, 'Demo_Gadgets__r in the Related Lists component');
  assert.equal(r.goto.object, 'Demo_Gadget__c', 'the child object, not the parent Account');
  assert.equal(r.goto.aspect, 'relationshiplabel');
  assert.ok(!out.results.some((x) => x.key === 'area:relatedList'));
  // Without the child: the generic card names no object and leaves auto-fill's Object alone.
  const generic = locate({ text: 'Account Gadgets', org: baseOrg, describes: [account], hints }).results.find((x) => x.key === 'area:relatedList');
  assert.ok(generic.steps.includes('Object: the child object'));
  assert.equal(generic.goto.objectLabel, null);
});

test('A-10 / A-13: a custom object\'s standard fields never get a Rename Tabs and Labels card', () => {
  const g = {
    ...gadget,
    recordTypeInfos: [{ name: 'Standard Gadget', developerName: 'Standard_Gadget', master: false, recordTypeId: '012000000000001AAA' }],
    fields: [
      { name: 'RecordTypeId', label: 'Record Type ID', custom: false, type: 'reference', picklistValues: [] },
      { name: 'OwnerId', label: 'Owner ID', custom: false, type: 'reference', picklistValues: [] },
      { name: 'IsDeleted', label: 'Deleted', custom: false, type: 'boolean', picklistValues: [] },
    ],
  };
  const hints = { selectionNames: ['sfdc:RecordField.Demo_Gadget__c.RecordTypeId'], fieldPart: 'value' };
  const out = locate({ text: 'Standard Gadget', org: baseOrg, describes: [g], hints });
  assert.equal(out.results[0].key, 'rt:Demo_Gadget__c.Standard_Gadget');
  for (const text of ['Record Type ID', 'Owner', 'Deleted']) {
    const all = [...locate({ text, org: baseOrg, describes: [g] }).results, ...out.results];
    assert.ok(!all.some((r) => r.source === SOURCE.RENAME_TABS && r.key.startsWith('field:')), text);
  }
  const owner = locate({ text: 'Owner ID', org: baseOrg, describes: [g] }).results.find((r) => r.key === 'field:Demo_Gadget__c.OwnerId');
  assert.equal(owner.source, SOURCE.SALESFORCE);
  assert.equal(owner.subtitle, 'Standard field Demo_Gadget__c.OwnerId');
});

test('A-03 / A-24 / A-12 / A-27: wording of picklist, button and Object Manager cards', () => {
  const g = {
    ...gadget,
    fields: [{ name: 'Demo_Status__c', label: 'Gadget Status', custom: true, type: 'picklist', picklistValues: [{ label: 'Drafting', value: 'Drafting', active: true }] }],
  };
  const known = { ...baseOrg, valueSets: { 'Demo_Gadget__c.Demo_Status__c': { name: null, values: [{ value: 'Drafting', label: 'Drafting', active: true }] } } };
  const gvsNote = (r) => r.notes.some((n) => /Global Value Set/.test(n));
  assert.ok(!gvsNote(locate({ text: 'Drafting', org: known, describes: [g] }).results[0]), 'value set read: no note');
  assert.ok(gvsNote(locate({ text: 'Drafting', org: baseOrg, describes: [g] }).results[0]), 'value set not read: note stays');
  const std = { ...gadget, name: 'Account', label: 'Account', custom: false, fields: [{ name: 'Rating', label: 'Rating', custom: false, type: 'picklist', picklistValues: [{ label: 'Warm', value: 'Warm', active: true }] }] };
  assert.ok(!gvsNote(locate({ text: 'Warm', org: baseOrg, describes: [std] }).results[0]), 'standard picklist: no note');

  const btn = locate({ text: 'Open Gadget Docs', org: baseOrg, describes: [gadget], hints: { selectionNames: ['sfdc:CustomButton.Demo_Gadget__c.Demo_Open_Docs'] } }).results[0];
  assert.ok(btn.steps.includes('Find the row: Open Gadget Docs (Demo_Open_Docs)'));

  const om = locate({ text: 'Coat Color', org: baseOrg, describes: [gadget], pageUrls: ['https://x.my.salesforce-setup.com/lightning/setup/ObjectManager/Demo_Gadget__c/FieldsAndRelationships/view'] });
  assert.equal(om.results[0].key, 'field:Demo_Gadget__c.Demo_Color__c');
  assert.ok(!om.results.some((r) => r.source === SOURCE.SALESFORCE));
  // A Setup heading that matches nothing of the object is still Salesforce text.
  const heading = locate({ text: 'Fields & Relationships', org: baseOrg, describes: [gadget], pageUrls: ['https://x.my.salesforce-setup.com/lightning/setup/ObjectManager/Demo_Gadget__c/FieldsAndRelationships/view'] });
  assert.equal(heading.results[0].source, SOURCE.SALESFORCE);
});

test('A-17 / B-13: flow screen text names the flow, screen, screen component and aspect', () => {
  const pc = {
    page: 'Demo Gadget Record Page', id: 'demo_flow', component: 'flowruntime:interview', label: null, props: { flowName: 'Demo_Gadget_Intake' },
    flow: {
      name: 'Demo_Gadget_Intake', label: 'Demo Gadget Intake', version: 1,
      screens: [{ name: 'Intake_Screen', label: 'Gadget Intake', fields: [
        { name: 'Intro_Text', fieldType: 'DisplayText', fieldText: '<p>Tell us about the gadget.</p>', helpText: null },
        { name: 'Gadget_Nickname', fieldType: 'InputField', fieldText: 'Gadget Nickname', helpText: null },
      ] }],
    },
  };
  const hints = { tags: ['p', 'span', 'lightning-formatted-rich-text', 'flowruntime-display-text-lwc', 'flowruntime-flow', 'flexipage-component2'], componentIds: ['demo_flow'] };
  const r = locate({ text: 'Tell us about the gadget.', org: baseOrg, describes: [gadget], hints, pageComponent: pc }).results[0];
  assert.equal(r.key, 'flow:Demo_Gadget_Intake.Intake_Screen.Intro_Text');
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.title, 'Flow screen text: Demo Gadget Intake');
  assert.deepEqual(r.steps.slice(-5), ['Flow: Demo Gadget Intake', 'Flow Component: Screen Component', 'Screen: Gadget Intake', 'Screen Component: Intro_Text', 'Aspect: Description']);
  assert.deepEqual(r.goto.flow, { label: 'Demo Gadget Intake', name: 'Demo_Gadget_Intake', component: 'Screen Component', screen: 'Gadget Intake', screenName: 'Intake_Screen', screenComponent: 'Intro_Text', aspect: 'Description' });
  assert.equal(r.goto.rows[0], '<p>Tell us about the gadget.</p>');
  assert.equal(r.goto.rowMatch, 'richText');
  const input = locate({ text: 'Gadget Nickname', org: baseOrg, describes: [gadget], hints, pageComponent: pc }).results.find((x) => x.key.startsWith('flow:'));
  assert.equal(input.goto.flow.aspect, 'Label');
  // No flow metadata: no instruction sentence is used as a row name.
  const generic = locate({ text: 'Tell us about the gadget.', org: baseOrg, describes: [gadget], hints }).results.find((x) => x.key === 'area:flow');
  assert.deepEqual(generic.goto.rows, ['Tell us about the gadget.']);
  assert.ok(!generic.steps.some((s) => /pick the flow and version/.test(s)));
});

test('B-04 / B-05 / B-14: tree search waits while loading and searches again until the row is there', async () => {
  await import('../src/waitUntil.js');
  const { untilFound } = globalThis.sftlWait;
  let now = 0;
  const clock = () => now;
  const pause = async (ms) => void (now += ms);
  // The node shows "loading" until 2.8 s, then the target tree replaces a stale one at 4 s.
  const busy = () => now < 2800;
  const tries = [];
  const row = await untilFound((last) => (tries.push([now, last]), now >= 4000 ? 'North Zone row' : null), { busy, clock, pause });
  assert.equal(row, 'North Zone row');
  assert.equal(tries[0][0], 2800, 'nothing searched while loading');
  assert.ok(tries.every(([, last]) => !last));
  // Never found: one last try at the time limit, told it is the last (to log the miss once).
  now = 0;
  const lasts = [];
  assert.deepEqual(await untilFound((last) => (lasts.push(last), []), { clock, pause, timeout: 3000 }), []);
  assert.deepEqual(lasts.filter(Boolean), [true]);
  assert.equal(lasts.at(-1), true);
});

test('A-15: a page with custom component identifiers is read; a {!$Label} tab title gets only the label card', async () => {
  const ci = (identifier, componentName, props) => ({ componentInstance: { identifier, componentName, componentInstanceProperties: Object.entries(props).map(([name, value]) => ({ name, value })) } });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      done: true,
      records: [{
        DeveloperName: 'Demo_Gadget_Record_Page', MasterLabel: 'Demo Gadget Record Page',
        Metadata: { flexiPageRegions: [
          { itemInstances: [ci('demo_tab_greeting', 'flexipage:tab', { body: 'Facet-demo', title: '{!$Label.Demo_Greeting}' })] },
          { itemInstances: [ci('demo_tabset', 'flexipage:tabset', { tabs: 'Facet-demo-tabs' })] },
        ] },
      }],
    }),
  });
  const FLEXI = 'forcegenerated-flexipage_demo_gadget_record_page_demo_gadget__c__view_js___lmt___1';
  const s = { host: 'devorg-test.my.salesforce.com', sid: 's' };
  // Nearest first, as content.js lists them: an identifier the page metadata does not know (a custom
  // component's inner element), the tab's page element, then its tab set.
  const pc = await loadNearestFlexiPageComponent(s, FLEXI, ['demo_inner_widget', 'demo_tab_greetingTab', 'demo_tabset'], ['Demo_Gadget__c']);
  assert.deepEqual([pc.id, pc.component, pc.label], ['demo_tab_greeting', 'flexipage:tab', '{!$Label.Demo_Greeting}']);

  const org = { ...baseOrg, customLabels: [{ Id: '101000000000001', Name: 'Demo_Greeting', MasterLabel: 'Demo_Greeting', NamespacePrefix: null, Value: 'Welcome To The Gadget Shop', Language: 'en_US' }] };
  const hints = { tags: ['a', 'li', 'ul', 'lightning-tab-bar', 'div', FLEXI], tabRole: 'tab', componentIds: ['demo_inner_widget', 'demo_tab_greetingTab', 'demo_tabset'], flexipage: FLEXI };
  const out = locate({ text: 'Welcome To The Gadget Shop', org, describes: [gadget], hints, pageComponent: pc });
  assert.equal(out.results[0].key, 'label:101000000000001');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(!out.results.some((r) => r.key === 'area:lightningPageTab' || r.key.startsWith('builder:')));
});

test('A-15: a nearer component of another kind does not hide the one the text belongs to', async () => {
  const ci = (identifier, componentName, props) => ({ componentInstance: { identifier, componentName, componentInstanceProperties: Object.entries(props).map(([name, value]) => ({ name, value })) } });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      done: true,
      records: [{
        DeveloperName: 'Demo_Kind_Page', MasterLabel: 'Demo Kind Page',
        Metadata: { flexiPageRegions: [
          { itemInstances: [ci('demo_tabset', 'flexipage:tabset', { tabs: 'Facet-demo-tabs' })] },
          { itemInstances: [ci('demo_section', 'flexipage:fieldSection', { label: 'Gadget Details' })] },
        ] },
      }],
    }),
  });
  const FLEXI = 'forcegenerated-flexipage_demo_kind_page_demo_gadget__c__view_js___lmt___1';
  const s = { host: 'devorg-kind.my.salesforce.com', sid: 's' };
  const ids = ['demo_tabset', 'demo_section'];
  assert.equal((await loadNearestFlexiPageComponent(s, FLEXI, ids, ['Demo_Gadget__c'])).id, 'demo_tabset', 'no kind: the nearest');
  const pc = await loadNearestFlexiPageComponent(s, FLEXI, ids, ['Demo_Gadget__c'], /^flexipage:fieldSection$/);
  assert.deepEqual([pc.id, pc.component, pc.label], ['demo_section', 'flexipage:fieldSection', 'Gadget Details']);
  assert.equal(await loadNearestFlexiPageComponent(s, FLEXI, ids, ['Demo_Gadget__c'], /^flowruntime:interview$/), null);
});

const flowPc = (fields, screen = {}) => ({
  page: 'Demo Gadget Record Page', id: 'demo_flow', component: 'flowruntime:interview', label: null, props: { flowName: 'Demo' },
  flow: { name: 'Demo', label: 'Demo', version: 1, screens: [{ name: 'S', label: 'Intro', fields, buttonLabels: [], ...screen }] },
});
const flowHints = { tags: ['p', 'span', 'lightning-formatted-rich-text', 'flowruntime-display-text-lwc', 'flowruntime-flow', 'flexipage-component2'], componentIds: ['demo_flow'] };

test('A-17: a phrase inside a display text line is similar text; a whole line is confirmed', () => {
  const pc = flowPc([{ name: 'Intro', fieldType: 'DisplayText', fieldText: '<p>Click Next to continue.</p><ul><li>Bring the gadget box.</li></ul>', helpText: null }]);
  const find = (text) => locate({ text, org: baseOrg, describes: [gadget], hints: flowHints, pageComponent: pc }).results.find((r) => r.key.startsWith('flow:'));
  const phrase = find('Next to continue');
  assert.equal(phrase.key, 'flow:Demo.S.Intro');
  assert.equal(phrase.confidence, 'partial');
  assert.ok(!/this text is the display text/.test(phrase.notes[0]));
  assert.equal(find('Bring the gadget box.').confidence, 'confirmed', 'one whole list item');
  assert.equal(find('Click Next to continue.').confidence, 'confirmed', 'one whole paragraph');
  assert.equal(find('Click Next to continue. Bring the gadget box.').confidence, 'confirmed', 'the whole text');
  // An input label: only the same text is confirmed.
  const input = flowPc([{ name: 'Nick', fieldType: 'InputField', fieldText: 'Gadget Nickname', helpText: null }]);
  const r = locate({ text: 'Nickname', org: baseOrg, describes: [gadget], hints: flowHints, pageComponent: input }).results.find((x) => x.key.startsWith('flow:'));
  assert.equal(r.confidence, 'partial');
});

test('A-17: the flow navigation bar buttons are Salesforce text, not the display text', () => {
  const pc = flowPc([{ name: 'Intro', fieldType: 'DisplayText', fieldText: '<p>Click Next to continue.</p>', helpText: null }]);
  const hints = { tags: ['span', 'button', 'lightning-button', 'div', 'flowruntime-navigation-bar', 'flowruntime-lwc-body', 'flowruntime-flow', 'flexipage-component2'], componentIds: ['demo_flow'] };
  for (const text of ['Next', 'Previous', 'Finish', 'Pause']) {
    const out = locate({ text, org: baseOrg, describes: [gadget], hints, pageComponent: pc });
    assert.ok(!out.results.some((r) => r.key.startsWith('flow:')), text);
    const r = out.results.find((x) => x.key === 'sfdctext:flowNavigation');
    assert.equal(r.source, SOURCE.SALESFORCE, text);
    assert.equal(r.confidence, 'confirmed', text);
  }
  // The flow's screens were not read: a custom button label cannot be ruled out, so not confirmed.
  const unread = locate({ text: 'Send Gadget', org: baseOrg, describes: [gadget], hints, pageComponent: { ...pc, flow: null } }).results.find((x) => x.key === 'sfdctext:flowNavigation');
  assert.equal(unread.confidence, 'context');
  // A screen with its own button label: not Salesforce text.
  const own = flowPc([], { buttonLabels: ['Send Gadget'] });
  const out = locate({ text: 'Send Gadget', org: baseOrg, describes: [gadget], hints, pageComponent: own });
  assert.ok(!out.results.some((r) => r.key === 'sfdctext:flowNavigation'));
});

test('B-04: a tree hit counts only once the Object list shows the target object', async () => {
  await import('../src/waitUntil.js');
  const { untilFound } = globalThis.sftlWait;
  let now = 0;
  const clock = () => now;
  const pause = async (ms) => void (now += ms);
  // The previous object's tree has "System Information" too; the target object is shown from 3 s.
  const ready = () => now >= 3000;
  const tries = [];
  const hits = await untilFound(() => (tries.push(now), [{ row: now >= 3000 ? 'target' : 'previous' }]), { ready, clock, pause });
  assert.equal(hits[0].row, 'target');
  assert.ok(tries.every((t) => t >= 3000), 'nothing searched before the object is shown');
  // A hit while a node starts loading after the search is searched again.
  now = 0;
  let loading = false;
  const rows = [];
  const row = await untilFound(() => {
    rows.push(now);
    loading = rows.length === 1;
    return rows.length === 1 ? 'stale row' : 'row';
  }, { busy: () => (loading ? ((loading = false), true) : false), clock, pause });
  assert.equal(row, 'row');
  // The object never shown: no hit, even on the last try.
  now = 0;
  assert.equal(await untilFound(() => 'previous', { ready: () => false, clock, pause, timeout: 2000 }), null);
  assert.deepEqual(await untilFound(() => [{ row: 'previous' }], { ready: () => false, clock, pause, timeout: 2000 }), []);
});

test('loadFlowScreens: the org\'s own flow without a namespace, fields in sections flattened', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    const url = decodeURIComponent(u);
    urls.push(url);
    if (url.includes('FROM FlowDefinition')) return { ok: true, json: async () => ({ done: true, records: [{ ActiveVersionId: '301000000000001AAA', LatestVersionId: '301000000000002AAA' }] }) };
    return {
      ok: true,
      json: async () => ({
        done: true,
        records: [{
          attributes: { type: 'Flow' }, MasterLabel: 'Demo Intake', VersionNumber: 3,
          Metadata: { screens: [{
            name: 'Intro', label: 'Intro Screen', nextOrFinishButtonLabel: 'Send Gadget', backButtonLabel: null,
            fields: [
              { name: 'Welcome', fieldType: 'DisplayText', fieldText: '<p>Welcome.</p>' },
              { name: 'Section1', fieldType: 'RegionContainer', fields: [
                { name: 'Section1_Column1', fieldType: 'Region', fields: [{ name: 'Nick', fieldType: 'InputField', fieldText: 'Gadget Nickname', helpText: 'Short name' }] },
              ] },
            ],
          }] },
        }],
      }),
    };
  };
  const s = { host: 'devorg-flow.my.salesforce.com', sid: 's' };
  const flow = await loadFlowScreens(s, 'Demo_Intake');
  assert.match(urls[0], /FROM FlowDefinition WHERE DeveloperName = 'Demo_Intake' AND NamespacePrefix = null LIMIT 1/);
  assert.match(urls[1], /FROM Flow WHERE Id = '301000000000001AAA'/, 'the active version');
  assert.deepEqual([flow.name, flow.label, flow.version], ['Demo_Intake', 'Demo Intake', 3]);
  const [screen] = flow.screens;
  assert.deepEqual([screen.name, screen.label, screen.buttonLabels], ['Intro', 'Intro Screen', ['Send Gadget']]);
  assert.deepEqual(screen.fields.map((f) => f.name), ['Welcome', 'Section1', 'Section1_Column1', 'Nick']);
  assert.deepEqual(screen.fields[3], { name: 'Nick', fieldType: 'InputField', fieldText: 'Gadget Nickname', helpText: 'Short name' });
  assert.equal(screen.fields[1].fieldText, null);
  // A packaged flow: its namespace is the filter.
  urls.length = 0;
  await loadFlowScreens(s, 'demo__Packaged_Intake');
  assert.match(urls[0], /WHERE DeveloperName = 'Packaged_Intake' AND NamespacePrefix = 'demo' LIMIT 1/);
  // A name that is not an API name: no query.
  urls.length = 0;
  assert.equal(await loadFlowScreens(s, "Demo' OR Id != null"), null);
  assert.equal(urls.length, 0);
});

test('withObjectIds adds a custom object\'s Id to its paths, one query, none for standard objects', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(decodeURIComponent(u));
    return { ok: true, json: async () => ({ done: true, records: [{ attributes: {}, DurableId: '01I000000000001', QualifiedApiName: 'Demo_Gadget__c' }] }) };
  };
  const s = { host: 'devorg-ids.my.salesforce.com', sid: 's' };
  const standard = [{ Id: '0Ko000000000001AAA', SobjectType: 'Opportunity' }];
  assert.equal(await withObjectIds(s, standard), standard);
  assert.equal(urls.length, 0);
  const out = await withObjectIds(s, [
    { Id: '0Ko000000000002AAA', SobjectType: 'Demo_Gadget__c' },
    { Id: '0Ko000000000003AAA', SobjectType: 'Demo_Gadget__c' },
    { Id: '0Ko000000000004AAA', SobjectType: 'Demo_Widget__c' },
  ]);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/tooling\/query\/\?q=SELECT DurableId, QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName IN \('Demo_Gadget__c','Demo_Widget__c'\)/);
  assert.deepEqual(out.map((p) => p.SobjectId), ['01I000000000001', '01I000000000001', null]);
  // The query fails: the paths come back without Ids.
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => '[{"message":"no access"}]' });
  const failed = await withObjectIds(s, [{ Id: '0Ko000000000005AAA', SobjectType: 'Demo_Gadget__c' }]);
  assert.equal(failed[0].SobjectId, null);
});
