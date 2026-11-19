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
  customLabels: [lbl('101D00000000060', 'MA_Upload', 'Upload Files', 'acme'), lbl('101D00000000061', 'MA_List', 'List', 'acme')],
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
  // The open panel's title: h2.panelTitle < div < div < div[oneUtilityBarPanel].
  const panel = locate({ text: 'To Do List', org, describes: [], hints: { tags: ['h2', 'div', 'div', 'div', 'section'], auraClasses: ['oneUtilityBarPanel', 'oneUtilityBarContainer', 'flexipagePage'] } });
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
