// Pipeline Inspection (/lightning/o/Opportunity/pipelineInspection, checked live Nov 2026): Salesforce's
// own page. Paths below are the real element paths with made-up names and Ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, detectAreas, SOURCE } from '../src/locator.js';

const lbl = (Id, Name, Value, NamespacePrefix = null) => ({ Id, Name, MasterLabel: Name, NamespacePrefix, Value, Language: 'en_US' });

const org = {
  userLanguage: 'en_US',
  defaultLanguage: 'en_US',
  labelTranslations: [],
  objects: [{ name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', custom: false }],
  tabs: [{ Name: 'standard-Opportunity', Label: 'Opportunities', IsCustom: false, SobjectName: 'Opportunity' }],
  apps: [],
  validationRules: [],
  customLabels: [
    lbl('101D00000000050', 'Example_Won', 'Won', 'acme'),
    lbl('101D00000000051', 'Example_Opportunities', 'Opportunities'),
    lbl('101D00000000052', 'Example_Close_Date', 'Close Date'),
  ],
};
const opp = {
  name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', custom: false, recordTypeInfos: [],
  quickActions: [{ label: 'New', name: 'NewOpportunity', type: 'Create' }],
  fields: [
    { name: 'CloseDate', label: 'Close Date', custom: false, type: 'date' },
    { name: 'Demo_Team__c', label: 'Demo Team', custom: true, type: 'picklist', picklistValues: [{ label: 'Blue', value: 'Blue', active: true }] },
  ],
};
const HOME = 'runtime_pipeline_inspectorPipelineInspectorHome';
const run = (text, hints) =>
  locate({ text, org, describes: [opp], hints, pageUrls: ['https://example.lightning.force.com/lightning/o/Opportunity/pipelineInspection?filterName=00B000000000001'] });

// p < div < div < button < div[tsn=<id>ChangeWon] < div < runtime_pipeline_inspector-kpi-panel < ... < div[HOME]
const kpi = { tags: ['p', 'div', 'button', 'runtime_pipeline_inspector-kpi-panel'], auraClasses: ['runtime_pipeline_inspectorKpiPanelWrapper', HOME, 'lafPageHost'] };
const filter = { tags: ['div'], auraClasses: ['runtime_pipeline_inspectorHighlightPanel', HOME] };
const button = { tags: ['button', 'lightning-button', 'lightning-button-group', 'div'], auraClasses: ['runtime_pipeline_inspectorPipelineInspectorRecordsView', HOME] };
const viewName = { tags: ['span', 'button', 'lst-list-view-picker', 'lst-list-view-picker-wrapper', 'div'], auraClasses: [HOME] };
const objectName = { tags: ['h1', 'div'], auraClasses: [HOME] };

test('Pipeline Inspection: metric tiles, filters, tabs and buttons are Salesforce text', () => {
  for (const [text, hints] of [['Moved In', kpi], ['Open Pipeline', kpi], ['Changes Since', filter], ['Analyze with Grid', button], ['Inspection', { tags: ['a', 'li', 'ul'], auraClasses: [HOME] }]]) {
    const out = locate({ text, org, describes: [opp], hints });
    assert.ok(out.areas.includes('pipelineInspection'), text);
    assert.equal(out.results[0].key, 'sfdctext:pipelineInspection', text);
    assert.equal(out.results[0].source, SOURCE.SALESFORCE, text);
    assert.equal(out.results[0].confidence, 'confirmed', text);
  }
});

test('Pipeline Inspection: a same-text custom label on a metric tile drops to similar text', () => {
  const out = run('Won', kpi);
  assert.equal(out.results[0].key, 'sfdctext:pipelineInspection');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(!out.results.some((r) => r.source === SOURCE.CUSTOM_LABEL), 'same-text label is partial and hidden');
});

test('Pipeline Inspection: the "New" button is Salesforce text, not the New Opportunity quick action', () => {
  const out = run('New', button);
  assert.equal(out.results[0].key, 'sfdctext:pipelineInspection');
  assert.ok(!out.results.some((r) => r.key.startsWith('qa:')), 'the quick action is partial and hidden');
});

test('Pipeline Inspection: a filter named like a field still lists the field label, and the card stays below it', () => {
  const out = run('Close Date', filter);
  assert.ok(out.results.some((r) => r.key === 'field:Opportunity.CloseDate'));
  const card = out.results.find((r) => r.key === 'sfdctext:pipelineInspection');
  assert.equal(card.confidence, 'context');
});

test('Pipeline Inspection: the view name is a list view name, not translatable', () => {
  const out = run('Example Team Summary', viewName);
  assert.ok(out.areas.includes('pipelineView'));
  assert.equal(out.results[0].key, 'sfdctext:pipelineView');
  assert.equal(out.results[0].source, SOURCE.NOT_TRANSLATABLE);
  assert.ok(!out.results.some((r) => r.key === 'sfdctext:pipelineInspection'));
});

test('Pipeline Inspection: the heading above the view name is the object name (Rename Tabs and Labels)', () => {
  const out = run('Opportunities', objectName);
  assert.ok(out.areas.includes('pipelineObjectName'));
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(/^(object|tab):/.test(out.results[0].key), out.results[0].key);
  assert.ok(!out.results.some((r) => r.key === 'sfdctext:pipelineInspection'));
  assert.ok(!out.results.some((r) => r.source === SOURCE.CUSTOM_LABEL), 'same-text label is partial and hidden');
});

test('Pipeline Inspection: a list column header is the field label; rows get no Salesforce text card', () => {
  const header = run('Demo Team', { tags: ['span', 'div', 'th', 'tr', 'thead', 'table', 'lightning-datatable', 'div'], auraClasses: ['runtime_pipeline_inspectorPipelineInspectorRecordsView', HOME] });
  assert.ok(header.areas.includes('pipelineGrid'));
  assert.equal(header.results[0].key, 'field:Opportunity.Demo_Team__c');
  assert.equal(header.results[0].confidence, 'confirmed');
  const cell = run('Example Deal 42', { tags: ['span', 'div', 'td', 'tr', 'tbody', 'table', 'lightning-datatable'], auraClasses: ['runtime_pipeline_inspectorPipelineInspectorRecordsView', HOME] });
  assert.ok(!cell.results.some((r) => r.key === 'sfdctext:pipelineInspection'));
});

test('Pipeline Inspection: the list status line is Salesforce text with org filter names', () => {
  const out = run('0 items • Filtered by Close Date, My Team, Open Pipeline - Demo Team', { tags: ['span', 'force-list-view-manager-status-info', 'div'], auraClasses: ['runtime_pipeline_inspectorPipelineInspectorRecordsView', HOME] });
  const card = out.results.find((r) => r.key === 'sfdctext:pipelineInspection');
  assert.ok(card);
  assert.equal(card.confidence, 'context');
});

test('Pipeline Inspection is not detected elsewhere', () => {
  assert.ok(!detectAreas({ tags: ['span', 'button', 'lst-list-view-picker'], auraClasses: ['forceListViewManager'] }).has('pipelineInspection'));
});

test('Pipeline Inspection: a metric tile says where an admin-set metric name is translated', () => {
  const r = run('Moved In', kpi).results[0];
  assert.ok(r.notes.some((n) => n.includes('Pipeline Inspection Metric Configuration')));
});
