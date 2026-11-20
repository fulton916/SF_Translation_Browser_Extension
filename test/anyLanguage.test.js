// Issue #13: Salesforce's own text is found by its page marker, so it is found in any language.
// French text and hints were captured live in the dev org (user language French, Nov 2026). The org has no
// Polish, so the Polish strings are illustrative: the checks read only page markers, never the words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, detectAreas, SOURCE } from '../src/locator.js';

const org = (extra = {}) => ({
  userLanguage: 'fr', defaultLanguage: 'en_US', customLabels: [], labelTranslations: [], objects: [], tabs: [], apps: [], validationRules: [], paths: [], ...extra,
});
const pl = (extra = {}) => org({ userLanguage: 'pl', ...extra });

// Opportunity as the French describe shows it: IsClosed is "Fermée", the same word as the path's Closed step.
const opp = (stage = 'Étape', closed = 'Fermée', subStage = 'Sous-étape') => ({
  name: 'Opportunity', label: 'Opportunité', labelPlural: 'Opportunités', custom: false, quickActions: [], recordTypeInfos: [],
  fields: [
    { name: 'StageName', label: stage, custom: false, type: 'picklist', picklistValues: [{ label: 'Prospection', value: 'Prospecting', active: true }] },
    { name: 'Sub_Stage__c', label: subStage, custom: true, type: 'picklist', picklistValues: [{ label: 'Connecter', value: 'CONNECT', active: true }] },
    { name: 'IsClosed', label: closed, custom: false, type: 'boolean', picklistValues: [] },
  ],
});
const oppPl = () => opp('Etap', 'Zamknięta', 'Podetap');

const PATH_AURA = ['runtime_sales_pathassistantCollapsibleDrawer', 'runtime_sales_pathassistantPathAssistant'];
// span.title < a < li[data-target-selection-name=closedPathTab] (live, French "Fermée").
const closedStep = {
  tags: ['span', 'a', 'li', 'ul', 'div', 'article'],
  auraClasses: ['runtime_sales_pathassistantPathAssistantTab', 'uiScroller', 'runtime_sales_pathassistantPathAssistantTabSet', ...PATH_AURA],
  componentIds: ['closedPathTab', 'runtime_sales_pathassistant_pathAssistant'],
  sfComponents: ['runtime_sales_pathassistant_pathAssistant'],
};
// span < button.slds-path__mark-complete < div < div[runtime_sales_pathassistantPathAssistantHeader] (live).
const stepButton = {
  tags: ['span', 'button', 'div', 'article'],
  auraClasses: ['uiOutputText', 'uiButton', 'runtime_sales_pathassistantPathAssistantHeader', ...PATH_AURA],
  componentIds: ['runtime_sales_pathassistant_pathAssistant'],
  sfComponents: ['runtime_sales_pathassistant_pathAssistant'],
};
// p < h2.slds-path__coach-title < div[…PathAssistantInfo] (live, French "Guide de réussite"); Key Fields: h2 in …Fields.
const heading = (block) => ({
  tags: ['p', 'h2', 'div', 'section', 'span'],
  auraClasses: [`runtime_sales_pathassistantPathAssistant${block}`, 'runtime_sales_pathassistantPathAssistantBody', ...PATH_AURA],
});
// span.name < label < div < li[calendarListItem]: the item's input#calendarToggle-03A0000000000000001 (live).
const calendarItem = (calendarId) => ({
  tags: ['span', 'label', 'div', 'li', 'ol', 'section'],
  auraClasses: ['uiLabel', 'calendarListItem', 'calendarListPanel', 'forceCalendar', 'calendarHome'],
  calendarId,
});
// h2.panelTitle < div[oneUtilityBarPanel], which holds the To Do List component (live).
const todoPanel = {
  tags: ['h2', 'div', 'section'],
  auraClasses: ['oneUtilityBarPanel', 'oneUtilityBarContainer', 'flexipagePage'],
  utilityPanelComponent: 'runtime_sales_todo_listUnifiedToDoListAuraWrapper',
};

test('#13: the path Closed step is Salesforce text in French and Polish; the same-word field drops', () => {
  for (const [o, text, field] of [[org(), 'Fermée', opp()], [pl(), 'Zamknięta', oppPl()]]) {
    const out = locate({ text, org: o, describes: [field], hints: closedStep });
    assert.ok(out.areas.includes('pathClosed'), text);
    assert.equal(out.results[0].key, 'sfdctext:pathClosed', text);
    assert.equal(out.results[0].confidence, 'confirmed', text);
    assert.equal(out.results[0].source, SOURCE.SALESFORCE);
    const isClosed = out.results.find((r) => r.key === 'field:Opportunity.IsClosed');
    assert.ok(!isClosed || isClosed.confidence === 'partial', `${text}: IsClosed is a coincidence`);
  }
});

test('#13: a closed record shows its value on the closedPathTab step: that is the picklist value, not Salesforce text', () => {
  const o = opp();
  o.fields[0].picklistValues.push({ label: 'Fermée gagnée', value: 'Closed Won', active: true });
  const paths = [{ SobjectType: 'Opportunity', SobjectProcessField: 'StageName', IsActive: true }];
  const out = locate({ text: 'Fermée gagnée', org: org({ paths }), describes: [o], hints: closedStep });
  assert.ok(!out.results.some((r) => r.key === 'sfdctext:pathClosed'));
  assert.ok(out.results.some((r) => r.key === 'picklist:Opportunity.StageName.Closed Won'));
});

test('#13: the step button is Salesforce text in French and Polish and names the path field', () => {
  const paths = [{ SobjectType: 'Opportunity', SobjectProcessField: 'Sub_Stage__c', IsActive: true }];
  for (const [o, text, d, label] of [
    [org(), 'Marquer Étape comme terminé(e)', opp(), 'StageName'],
    [org(), 'Marquer comme Sous-étape actuel(le)', opp(), 'Sub_Stage__c'],
    [pl(), 'Oznacz Etap jako ukończony', oppPl(), 'StageName'],
  ]) {
    const out = locate({ text, org: o, describes: [d], hints: stepButton });
    assert.equal(out.results[0].key, 'sfdctext:path', text);
    assert.equal(out.results[0].confidence, 'confirmed', text);
    assert.ok(out.results.some((r) => r.key === `field:Opportunity.${label}` && r.confidence === 'context'), `${text}: names ${label}`);
  }
  // Both labels are in "Marquer Sous-étape …" ("étape" is inside "sous-étape"): the record's path field wins…
  const withPath = locate({ text: 'Marquer Sous-étape comme terminé(e)', org: org({ paths }), describes: [opp()], hints: stepButton }).results;
  assert.ok(withPath.some((r) => r.key === 'field:Opportunity.Sub_Stage__c' && r.confidence === 'context'));
  assert.ok(!withPath.some((r) => r.key === 'field:Opportunity.StageName' && r.confidence === 'context'));
  // …and with no path data, the longer label.
  const noPath = locate({ text: 'Marquer Sous-étape comme terminé(e)', org: org({ paths: undefined }), describes: [opp()], hints: stepButton }).results;
  assert.ok(noPath.some((r) => r.key === 'field:Opportunity.Sub_Stage__c' && r.confidence === 'context'));
  assert.ok(!noPath.some((r) => r.key === 'field:Opportunity.StageName' && r.confidence === 'context'));
});

test('#13: the Guidance for Success and Key Fields headings are Salesforce text in French and Polish', () => {
  for (const [o, text, block] of [
    [org(), 'Guide de réussite', 'Info'],
    [org(), 'Champs clés', 'Fields'],
    [pl(), 'Wskazówki dotyczące sukcesu', 'Info'],
    [pl(), 'Kluczowe pola', 'Fields'],
  ]) {
    const out = locate({ text, org: o, describes: [opp()], hints: heading(block) });
    assert.ok(out.areas.includes('pathHeading'), text);
    assert.equal(out.results[0].key, 'sfdctext:path', text);
    assert.equal(out.results[0].confidence, 'confirmed', text);
  }
  // The guidance text itself (div.uiOutputRichText) is no heading, even when it has one of its own.
  const guidance = { tags: ['h2', 'div', 'div', 'div'], auraClasses: ['uiOutputRichText', 'runtime_sales_pathassistantPathAssistantInfo', ...PATH_AURA] };
  assert.ok(!detectAreas(guidance).has('pathHeading'));
});

test('#13: My Events is Salesforce text in French and Polish; a user calendar keeps its card', () => {
  for (const [o, text] of [[org(), 'Mes événements'], [pl(), 'Moje wydarzenia']]) {
    const r = locate({ text, org: o, describes: [], hints: calendarItem('03A0000000000000001') }).results[0];
    assert.equal(r.key, 'sfdctext:calendar', text);
    assert.equal(r.confidence, 'confirmed', text);
  }
  // A calendar a user made has its own Id; English "My Events" with no Id is not taken from the words.
  for (const id of ['023000000000001', null]) {
    const r = locate({ text: 'My Events', org: org({ userLanguage: 'en_US' }), describes: [], hints: calendarItem(id) }).results[0];
    assert.equal(r.key, 'sfdctext:calendarName', String(id));
  }
});

test('#13: the open To Do List panel is Salesforce text in French and Polish', () => {
  for (const [o, text] of [[org(), 'Liste de tâches'], [pl(), 'Lista zadań do wykonania']]) {
    const out = locate({ text, org: o, describes: [], hints: todoPanel });
    assert.ok(out.areas.includes('utilityToDo'), text);
    assert.equal(out.results[0].key, 'sfdctext:utilityBar', text);
    assert.equal(out.results[0].confidence, 'confirmed', text);
  }
  // Another item's panel (no To Do component) is not To Do List, whatever its words.
  const other = locate({ text: 'To Do List', org: org(), describes: [], hints: { ...todoPanel, utilityPanelComponent: 'runtime_sales_notesNotesUtility' } });
  assert.ok(!other.areas.includes('utilityToDo'));
  assert.equal(other.results[0].key, 'area:utilityItem');
});

test('#13: viewing another language, a Pipeline metric tile lists the renamed metrics instead of confirming Salesforce text', () => {
  const tile = { tags: ['span', 'div', 'runtime_pipeline_inspector-kpi-panel', 'div'], auraClasses: ['runtime_pipeline_inspectorPipelineInspectorHome'] };
  const pipelineMetrics = [{ Id: '0Xm000000000001', DeveloperName: 'ClosedLostCumulative', MasterLabel: 'Lost Deals', Metric: 'ClosedLost' }];
  for (const [o, text] of [[org({ pipelineMetrics }), 'Affaires perdues'], [pl({ pipelineMetrics }), 'Utracone transakcje']]) {
    const out = locate({ text, org: o, describes: [], hints: tile }).results;
    assert.equal(out.find((r) => r.key === 'sfdctext:pipelineInspection').confidence, 'context', text);
    const m = out.find((r) => r.key === 'pipelineMetric:0Xm000000000001');
    assert.equal(m.confidence, 'context', text);
    assert.match(m.notes[0], /translation from this row/);
  }
  // The master language: the tile text is the MasterLabel or Salesforce's own name, as before.
  const en = org({ userLanguage: 'en_US', pipelineMetrics });
  assert.equal(locate({ text: 'Lost Deals', org: en, describes: [], hints: tile }).results[0].key, 'pipelineMetric:0Xm000000000001');
  assert.equal(locate({ text: 'Open Pipeline', org: en, describes: [], hints: tile }).results[0].confidence, 'confirmed');
});
