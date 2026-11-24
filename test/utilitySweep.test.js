// Test sandbox checks (Nov 2026): Team Role in Add Opportunity Team Members, the To Do List utility, the Files upload
// area. Paths below are the real element paths with made-up names and Ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, detectAreas, objectFromTitle, SOURCE } from '../src/locator.js';

const lbl = (Id, Name, Value, NamespacePrefix = null) => ({ Id, Name, MasterLabel: Name, NamespacePrefix, Value, Language: 'en_US' });
const objects = [
  { name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', custom: false },
  { name: 'OpportunityTeamMember', label: 'Opportunity Team Member', labelPlural: 'Opportunity Team Members', custom: false },
  { name: 'Demo_Part__c', label: 'Demo Part', labelPlural: 'Demo Parts', custom: true },
];
const org = {
  userLanguage: 'en_US', defaultLanguage: 'en_US', labelTranslations: [], objects, tabs: [], apps: [], validationRules: [],
  customLabels: [lbl('101D00000000060', 'Pkg_Upload', 'Upload Files', 'acme'), lbl('101D00000000061', 'Pkg_List', 'List', 'acme')],
};

test('objectFromTitle: a dialog title names its object, the longest label wins', () => {
  assert.equal(objectFromTitle('Add Opportunity Team Members', objects), 'OpportunityTeamMember');
  assert.equal(objectFromTitle('New Opportunity: Retail', objects), 'Opportunity');
  assert.equal(objectFromTitle('New Demo Part', objects), 'Demo_Part__c');
  assert.equal(objectFromTitle('Edit Example Deal 42', objects), null);
});

test('Team Role option in Add Opportunity Team Members: Workbench picklist value of Opportunity Team Member', () => {
  const otm = {
    name: 'OpportunityTeamMember', label: 'Opportunity Team Member', labelPlural: 'Opportunity Team Members', custom: false, recordTypeInfos: [], quickActions: [],
    fields: [{ name: 'TeamMemberRole', label: 'Team Role', custom: false, type: 'picklist', picklistValues: [{ label: 'Example Role Manager', value: 'Example Role Manager', active: true }] }],
  };
  // a[role=option] < li[uiMenuItem] < ul < div[role=listbox] < div[uiPopupTarget]: outside the dialog.
  const hints = { tags: ['a', 'li', 'ul', 'div'], auraClasses: ['uiMenuItem', 'uiPopupTarget'], dialogTitle: 'Add Opportunity Team Members' };
  const r = locate({ text: 'Example Role Manager', org, describes: [otm], hints }).results[0];
  assert.equal(r.key.startsWith('picklist:OpportunityTeamMember.TeamMemberRole'), true, r.key);
  assert.equal(r.source, SOURCE.WORKBENCH);
  assert.ok(r.steps.some((s) => s === 'Object: Opportunity Team Member'));
});

// span.itemTitle < button < div[oneUtilityBarItem] < div[flexipageComponent][tsn=runtime_sales_todo_list_…] < ul …
const todoItem = {
  tags: ['span', 'button', 'div', 'ul', 'div', 'section'],
  auraClasses: ['uiButton', 'oneUtilityBarItem', 'flexipageComponent', 'oneUtilityBarContent', 'oneUtilityBarContainer', 'flexipagePage'],
  sfComponents: ['runtime_sales_todo_list_unifiedToDoListAuraWrapper'],
  componentIds: ['runtime_sales_todo_list_unifiedToDoListAuraWrapper'],
};

test('To Do List in the utility bar is Salesforce text, not the "List" labels', () => {
  const out = locate({ text: 'To Do List', org, describes: [], hints: todoItem });
  assert.ok(out.areas.includes('utilityBar'));
  assert.equal(out.results[0].key, 'sfdctext:utilityBar');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(!out.results.some((r) => r.source === SOURCE.CUSTOM_LABEL));
  // The open panel's title: h2.panelTitle < div < div < div[oneUtilityBarPanel], which holds the To Do component.
  const panel = locate({ text: 'To Do List', org, describes: [], hints: { tags: ['h2', 'div', 'div', 'div', 'section'], auraClasses: ['oneUtilityBarPanel', 'oneUtilityBarContainer', 'flexipagePage'], utilityPanelComponent: 'runtime_sales_todo_listUnifiedToDoListAuraWrapper' } });
  assert.equal(panel.results[0].key, 'sfdctext:utilityBar');
});

test('Another utility item: its label is set in App Manager', () => {
  const hints = { ...todoItem, sfComponents: [], componentIds: ['example_notes_utility'] };
  const r = locate({ text: 'Example Notes', org, describes: [], hints }).results[0];
  assert.equal(r.key, 'area:utilityItem');
  // Records listed inside an open utility panel are not its label.
  assert.ok(!detectAreas({ tags: ['span', 'a', 'li', 'ul', 'div', 'div', 'div'], auraClasses: ['oneUtilityBarPanel'] }).has('utilityBar'));
});

test('Files related list: Upload Files and Or drop files are Salesforce text', () => {
  // span < label < slot < lightning-primitive-file-droppable-zone < lightning-primitive-input-file < lightning-input <
  // div[forceContentFileDroppableZone] < div[forceRelatedListPreview] < article[forceRelatedListCardDesktop] …
  const hints = {
    tags: ['span', 'label', 'slot', 'lightning-primitive-file-droppable-zone', 'lightning-primitive-input-file', 'lightning-input', 'div', 'article', 'lst-related-list-single-aura-wrapper', 'flexipage-component2'],
    auraClasses: ['forceContentFileDroppableZone', 'forceRelatedListPreview', 'forceRelatedListCardDesktop', 'forceRelatedListSingleContainer'],
    componentIds: ['force_relatedListSingleContainer7'],
    listHeader: false,
  };
  for (const text of ['Upload Files', 'Or drop files']) {
    const out = locate({ text, org, describes: [], hints });
    assert.equal(out.results[0].key, 'sfdctext:fileUpload', text);
    assert.equal(out.results[0].confidence, 'confirmed', text);
    assert.ok(!out.results.some((r) => r.source === SOURCE.CUSTOM_LABEL), text);
  }
});

// Utility bars read from the org (sfApi loadUtilityBar; dev org Sales app, checked live): the "label" decorator is
// the label typed in App Manager, an item without one shows the name Salesforce gives its component.
const salesBar = {
  app: 'Sales', page: 'Sales App Utility Bar', current: true,
  items: [
    { id: 'runtime_sales_todo_list_unifiedToDoListAuraWrapper', component: 'runtime_sales_todo_list:unifiedToDoListAuraWrapper', label: null },
    { id: 'flexipage_richText', component: 'flexipage:richText', label: 'Example Tips' },
    { id: 'console_history', component: 'console:history', label: null },
  ],
};
const itemHints = (id) => ({ ...todoItem, sfComponents: [], componentIds: [id] });

test('Utility item with a label typed in App Manager: confirmed, names the app and the item', () => {
  const orgBars = { ...org, utilityBars: [salesBar], customLabels: [...org.customLabels, lbl('101D00000000062', 'Example_Tips', 'Example Tips')] };
  const out = locate({ text: 'Example Tips', org: orgBars, describes: [], hints: itemHints('flexipage_richText') });
  const r = out.results[0];
  assert.equal(r.key, 'utility:flexipage_richText');
  assert.equal(r.source, SOURCE.NOT_TRANSLATABLE);
  assert.equal(r.confidence, 'confirmed');
  assert.match(r.subtitle, /"Example Tips" utility item in the Sales app/);
  assert.ok(r.steps.some((s) => s === 'To change it: Setup → App Manager → Sales → Edit → Utility Items (Desktop Only) → Example Tips → Label.'));
  assert.ok(!out.results.some((x) => x.source === SOURCE.CUSTOM_LABEL), 'same-text label is partial and hidden');
  assert.ok(!out.results.some((x) => x.key === 'area:utilityItem'));
});

test('Utility item label found in another app bar when the component id is not on the element', () => {
  const other = { app: 'Example Console', page: 'Example Console Utility Bar', current: false, items: [{ id: 'example_notes', component: 'c:exampleNotes', label: 'Example Notes' }] };
  const r = locate({ text: 'Example Notes', org: { ...org, utilityBars: [salesBar, other] }, describes: [], hints: itemHints('unknown_item') }).results[0];
  assert.equal(r.key, 'utility:example_notes');
  assert.match(r.subtitle, /Example Console app/);
});

test('Utility item without a label of its own: the name Salesforce gives it', () => {
  const r = locate({ text: 'History', org: { ...org, utilityBars: [salesBar] }, describes: [], hints: itemHints('console_history') }).results[0];
  assert.equal(r.key, 'sfdctext:utilityBar');
  assert.equal(r.source, SOURCE.SALESFORCE);
  assert.equal(r.confidence, 'confirmed');
  assert.match(r.subtitle, /console:history utility item \(Sales app\)/);
});

test('To Do List stays Salesforce text with the utility bar read; an unknown item keeps the App Manager card', () => {
  const todo = locate({ text: 'To Do List', org: { ...org, utilityBars: [salesBar] }, describes: [], hints: todoItem }).results[0];
  assert.equal(todo.key, 'sfdctext:utilityBar');
  assert.equal(todo.subtitle, 'Label of the To Do List utility');
  const unknown = locate({ text: 'Example Chat', org: { ...org, utilityBars: [salesBar] }, describes: [], hints: itemHints('example_chat') }).results[0];
  assert.equal(unknown.key, 'area:utilityItem');
});
