// Org-wide search (#24): page layout sections and buttons of every object, from the org index
// (src/orgIndex.js). Fake data in the shape loadOrgIndex returns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, needsOrgWideSearch, SOURCE } from '../src/locator.js';

const account = { name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, quickActions: [], recordTypeInfos: [], fields: [{ name: 'Name', label: 'Account Name', type: 'string', picklistValues: [] }] };
const orgIndex = {
  at: Date.now() - 3 * 3600 * 1000,
  warnings: [],
  layouts: [
    { object: 'Account', layout: 'Account Layout', sections: ['Account Information', 'System Information'] },
    { object: 'Account', layout: 'Account (Sales) Layout', sections: ['Account Information', 'System Information'] },
    { object: 'SFTL_Widget__c', layout: 'Widget Layout', sections: ['Widget Basics', 'System Information'] },
  ],
  // Shape of loadOrgIndex's flows (dev org SFTL_Widget_Intake, read with readMetadata).
  flows: [
    {
      name: 'SFTL_Widget_Intake',
      label: 'SFTL Widget Intake',
      screens: [
        {
          name: 'Intake_Screen',
          label: 'Widget Intake',
          fields: [
            { name: 'Intro_Text', fieldType: 'DisplayText', fieldText: '<p>Tell us about the widget.</p>', helpText: null },
            { name: 'Widget_Nickname', fieldType: 'InputField', fieldText: 'Widget Nickname', helpText: null },
          ],
          buttonLabels: [],
        },
      ],
    },
  ],
  buttons: [
    { name: 'Ship_It', label: 'Ship It', object: 'SFTL_Widget__c', namespace: null },
    { name: 'Map_It', label: 'Map It', object: 'Account', namespace: 'maps' },
  ],
};
const org = {
  userLanguage: 'en_US',
  defaultLanguage: 'en_US',
  customLabels: [],
  labelTranslations: [],
  objects: [
    { name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false },
    { name: 'SFTL_Widget__c', label: 'Widget', labelPlural: 'Widgets', custom: true },
  ],
  orgIndex,
};
const headerHints = { tags: ['span', 'button', 'h3', 'records-record-layout-section', 'records-record-layout-block'] };
const run = (text, hints = {}, o = org) => locate({ text, hints, org: o, describes: [account], pageUrls: ['https://x.lightning.force.com/lightning/r/Account/001000000000001AAA/view'] });

test('a section header from another object gets that object\'s Layout Section location', () => {
  const out = run('Widget Basics', headerHints);
  assert.equal(out.results.some((r) => r.key === 'area:layoutSection'), false, 'the card for this page\'s object is replaced');
  const r = out.results[0];
  assert.equal(r.key, 'section:SFTL_Widget__c.Widget Basics');
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.source, SOURCE.WORKBENCH);
  assert.equal(r.subtitle, 'In the Widget page layout Widget Layout');
  assert.ok(r.steps.includes('Setup Component: Layout Section'));
  assert.ok(r.steps.includes('Object: Widget'));
  assert.deepEqual([r.goto.component, r.goto.object, r.goto.rows], ['LayoutSection', 'SFTL_Widget__c', ['Widget Basics']]);
  assert.equal(r.notes[0], 'This section is not in the Account page layouts.');
});

test('a section header of this page\'s object keeps its card and names its layouts', () => {
  const out = run('Account Information', headerHints);
  const r = out.results.find((x) => x.key === 'area:layoutSection');
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.goto.object, 'Account');
  assert.equal(r.notes[0], 'In the Account page layouts: Account Layout, Account (Sales) Layout.');
  assert.equal(out.results.some((x) => x.key.startsWith('section:')), false);
});

test('a section name in several objects\' layouts: one card per object, none confirmed', () => {
  const out = run('System Information', { tags: ['span', 'c-some-component'] });
  const cards = out.results.filter((x) => x.key.startsWith('section:'));
  assert.deepEqual(cards.map((c) => [c.goto.object, c.confidence]), [['Account', 'exact'], ['SFTL_Widget__c', 'exact']]);
  assert.match(cards[0].notes.join(' '), /Each layout has its own copy/);
});

test('a header with the same name on two other objects is not confirmed', () => {
  const two = { ...org, orgIndex: { ...orgIndex, layouts: [...orgIndex.layouts, { object: 'Case', layout: 'Case Layout', sections: ['Widget Basics'] }] } };
  const cards = run('Widget Basics', headerHints, two).results.filter((x) => x.key.startsWith('section:'));
  assert.deepEqual(cards.map((c) => c.confidence), ['exact', 'exact']);
});

test('a confirmed section card makes same-text custom labels partial', () => {
  const withLabel = { ...org, customLabels: [{ Id: '101000000000001AAA', Name: 'Widget_Basics', MasterLabel: 'Widget Basics', NamespacePrefix: null, Value: 'Widget Basics', Language: 'en_US' }] };
  const out = run('Widget Basics', headerHints, withLabel);
  const label = [...out.results, ...out.more].find((x) => x.source === SOURCE.CUSTOM_LABEL);
  assert.equal(label.confidence, 'partial');
});

test('a button label anywhere in the org gets its Button and Link Label location', () => {
  const r = run('Ship It').results.find((x) => x.key === 'btn:SFTL_Widget__c.Ship_It');
  assert.equal(r.confidence, 'exact');
  assert.deepEqual([r.goto.component, r.goto.object, r.goto.rows], ['WebLink', 'SFTL_Widget__c', ['Ship_It', 'Ship It']]);
  assert.ok(r.steps.includes('Find the row: Ship It (Ship_It)'));
});

test('a packaged button goes to Override, named with its namespace', () => {
  const r = run('Map It').results.find((x) => x.key === 'btn:Account.maps__Map_It');
  assert.equal(r.source, SOURCE.OVERRIDE);
  assert.equal(r.goto.package, 'maps');
});

test('the button you pointed at keeps its confirmed page-metadata card', () => {
  const out = run('Ship It', { selectionNames: ['sfdc:CustomButton.SFTL_Widget__c.Ship_It'] });
  const cards = out.results.filter((x) => x.key === 'btn:SFTL_Widget__c.Ship_It');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].confidence, 'confirmed');
});

test('no org-wide data: no org-wide cards, and the help names Layout Section and buttons', () => {
  assert.equal(run('Widget Basics', {}, { ...org, orgIndex: null }).results.some((x) => x.key.startsWith('section:')), false);
  const out = run('zzqx nothing here', {}, { ...org, orgIndex: null });
  assert.match(out.notFoundHelp[1], /Layout Section, Flow, Lookup Filter, Button and Link Label/);
});

test('org-wide data searched and nothing found: the help says so', () => {
  const out = run('zzqx nothing here');
  assert.equal(out.results.length, 0);
  assert.match(out.notFoundHelp[0], /path guidance, or the page layout sections, custom buttons and screen flows of the whole org\.$/);
  assert.equal(out.notFoundHelp[1], 'Other places to check in Translation Workbench: Lookup Filter, Report, Dashboard.');
});

test('needsOrgWideSearch: nothing confirmed, or a layout section header', () => {
  assert.equal(needsOrgWideSearch({ results: [{ confidence: 'exact' }], areas: [] }, 'Ship It'), true);
  assert.equal(needsOrgWideSearch({ results: [{ confidence: 'confirmed' }], areas: [] }, 'Ship It'), false);
  assert.equal(needsOrgWideSearch({ results: [{ confidence: 'confirmed' }], areas: ['layoutSection'] }, 'Widget Basics'), true);
  assert.equal(needsOrgWideSearch({ results: [], areas: [] }, '  '), false);
});

test("this object's layouts not read: its card stays, other objects are listed next to it", () => {
  const noAccount = { ...org, orgIndex: { ...orgIndex, layouts: orgIndex.layouts.filter((l) => l.object !== 'Account') } };
  const out = run('Widget Basics', headerHints, noAccount);
  assert.equal(out.results.find((x) => x.key === 'area:layoutSection').confidence, 'confirmed');
  assert.equal(out.results.find((x) => x.key === 'section:SFTL_Widget__c.Widget Basics').confidence, 'exact');
});

test('layouts not read: the help does not say they were searched', () => {
  const out = run('zzqx nothing here', {}, { ...org, orgIndex: { ...orgIndex, layouts: null } });
  assert.match(out.notFoundHelp[1], /Layout Section/);
});

const flowHints = { tags: ['p', 'lightning-formatted-rich-text', 'flowruntime-display-text-lwc', 'flowruntime-screen-field', 'flowruntime-flow'] };

test('flow screen text from a flow that is not on a Lightning page gets its Flow location', () => {
  const out = run('Tell us about the widget.', flowHints);
  assert.equal(out.results.some((r) => r.key === 'area:flow'), false, 'the generic flow card is replaced');
  const r = out.results[0];
  assert.equal(r.key, 'flow:SFTL_Widget_Intake.Intake_Screen.Intro_Text');
  assert.equal(r.confidence, 'confirmed');
  assert.ok(r.steps.includes('Setup Component: Flow'));
  assert.ok(r.steps.includes('Flow: SFTL Widget Intake'));
  assert.ok(r.steps.includes('Screen Component: Intro_Text'));
  assert.ok(r.steps.includes('Aspect: Description'));
  assert.deepEqual([r.goto.component, r.goto.flow.name, r.goto.flow.screen], ['FlowDefinition', 'SFTL_Widget_Intake', 'Widget Intake']);
  assert.equal(r.notes[0], 'This text is the display text of the screen component Intro_Text in the flow SFTL Widget Intake.');
});

test('a flow input label found anywhere in the org is an exact match', () => {
  const r = run('Widget Nickname').results.find((x) => x.key === 'flow:SFTL_Widget_Intake.Intake_Screen.Widget_Nickname');
  assert.equal(r.confidence, 'exact');
  assert.ok(r.steps.includes('Aspect: Label'));
});

test('a few words of a flow text are not matched org-wide', () => {
  assert.equal(run('about the widget').results.some((x) => x.key.startsWith('flow:')), false);
});

test('the flow on this page already explained the text: no org-wide flow cards', () => {
  const pageFlow = { page: 'P', id: 'c1', component: 'flowruntime:interview', props: { flowName: 'SFTL_Widget_Intake' }, flow: orgIndex.flows[0] };
  const out = locate({ text: 'Widget Nickname', hints: flowHints, org, describes: [account], pageComponent: pageFlow });
  const cards = out.results.filter((x) => x.key.startsWith('flow:'));
  assert.equal(cards.length, 1);
  assert.match(cards[0].notes[0], /^The flow on this page is SFTL Widget Intake/);
});
