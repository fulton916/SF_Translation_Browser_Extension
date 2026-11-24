// Issue #13: Salesforce's own text is found by its page marker, so it is found in any language.
// French text and hints were captured live in the dev org (user language French, Nov 2026). The org has no
// Polish, so the Polish strings are illustrative: the checks read only page markers, never the words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, detectAreas, buildGotoUrl, SOURCE } from '../src/locator.js';

const org = (extra = {}) => ({
  userLanguage: 'fr', defaultLanguage: 'en_US', customLabels: [], labelTranslations: [], objects: [], tabs: [], apps: [], validationRules: [], paths: [], ...extra,
});
const pl = (extra = {}) => org({ userLanguage: 'pl', ...extra });

// Opportunity as the French describe shows it: IsClosed is "Fermée", the same word as the path's Closed step.
const opp = (stage = 'Étape', closed = 'Fermée', subStage = 'Mi-étape') => ({
  name: 'Opportunity', label: 'Opportunité', labelPlural: 'Opportunités', custom: false, quickActions: [], recordTypeInfos: [],
  fields: [
    { name: 'StageName', label: stage, custom: false, type: 'picklist', picklistValues: [{ label: 'Prospection', value: 'Prospecting', active: true }] },
    { name: 'Demo_Mid_Stage__c', label: subStage, custom: true, type: 'picklist', picklistValues: [{ label: 'Esquisser', value: 'SKETCH', active: true }] },
    { name: 'IsClosed', label: closed, custom: false, type: 'boolean', picklistValues: [] },
  ],
});
const oppPl = () => opp('Etap', 'Zamknięta', 'Półetap');

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
  const paths = [{ SobjectType: 'Opportunity', SobjectProcessField: 'Demo_Mid_Stage__c', IsActive: true }];
  for (const [o, text, d, label] of [
    [org(), 'Marquer Étape comme terminé(e)', opp(), 'StageName'],
    [org(), 'Marquer comme Mi-étape actuel(le)', opp(), 'Demo_Mid_Stage__c'],
    [pl(), 'Oznacz Etap jako ukończony', oppPl(), 'StageName'],
  ]) {
    const out = locate({ text, org: o, describes: [d], hints: stepButton });
    assert.equal(out.results[0].key, 'sfdctext:path', text);
    assert.equal(out.results[0].confidence, 'confirmed', text);
    assert.ok(out.results.some((r) => r.key === `field:Opportunity.${label}` && r.confidence === 'context'), `${text}: names ${label}`);
  }
  // Both labels are in "Marquer Mi-étape …" ("étape" is inside "mi-étape"): the record's path field wins…
  const withPath = locate({ text: 'Marquer Mi-étape comme terminé(e)', org: org({ paths }), describes: [opp()], hints: stepButton }).results;
  assert.ok(withPath.some((r) => r.key === 'field:Opportunity.Demo_Mid_Stage__c' && r.confidence === 'context'));
  assert.ok(!withPath.some((r) => r.key === 'field:Opportunity.StageName' && r.confidence === 'context'));
  // …and with no path data, the longer label.
  const noPath = locate({ text: 'Marquer Mi-étape comme terminé(e)', org: org({ paths: undefined }), describes: [opp()], hints: stepButton }).results;
  assert.ok(noPath.some((r) => r.key === 'field:Opportunity.Demo_Mid_Stage__c' && r.confidence === 'context'));
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
  const pipelineMetrics = [{ Id: '0Xm000000000001', DeveloperName: 'LostDeals', MasterLabel: 'Lost Deals', Metric: 'ClosedLost' }];
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

test('#13 review: a lightning-path (no path assistant marker) keeps the English words', () => {
  const lwc = { tags: ['span', 'button', 'lightning-path', 'div'], auraClasses: [] };
  assert.ok(detectAreas(lwc).has('pathNoMarker'));
  const en = org({ userLanguage: 'en_US' });
  for (const text of ['Mark Stage as Complete', 'Guidance for Success', 'Closed']) {
    const out = locate({ text, org: en, describes: [opp('Stage', 'Closed')], hints: lwc }).results;
    assert.ok(out.some((r) => r.key.startsWith('sfdctext:path') && r.confidence === 'confirmed'), text);
  }
  // The Aura path assistant has markers: no English fallback there.
  assert.ok(!detectAreas(stepButton).has('pathNoMarker'));
});

test('#13 review: the step button names only the record object\'s fields', () => {
  const quote = { name: 'Quote', label: 'Devis', labelPlural: 'Devis', custom: false, quickActions: [], recordTypeInfos: [],
    fields: [{ name: 'Status', label: 'Étape', custom: false, type: 'picklist', picklistValues: [] }] };
  const record = { object: 'Opportunity', recordTypeId: null };
  const out = locate({ text: 'Marquer Étape comme terminé(e)', org: org(), describes: [opp(), quote], hints: stepButton, record }).results;
  assert.ok(out.some((r) => r.key === 'field:Opportunity.StageName' && r.confidence === 'context'));
  assert.ok(!out.some((r) => r.key === 'field:Quote.Status'));
});

test('#13 review: a heading with deeper inline markup is still a heading', () => {
  const deep = { ...heading('Fields'), tags: ['span', 'span', 'p', 'h2', 'div', 'section'] };
  assert.ok(detectAreas(deep).has('pathHeading'));
});

test('#13 review: a metric row in the language you view is no other-language translation', () => {
  const tile = { tags: ['span', 'div', 'runtime_pipeline_inspector-kpi-panel', 'div'], auraClasses: ['runtime_pipeline_inspectorPipelineInspectorHome'] };
  const pipelineMetrics = [{ Id: '0Xm000000000002', DeveloperName: 'OpenFr', MasterLabel: 'Pipeline à moi', Language: 'fr', Metric: 'OpenPipeline' }];
  const out = locate({ text: 'Pipeline ouvert', org: org({ pipelineMetrics }), describes: [], hints: tile }).results;
  assert.equal(out.find((r) => r.key === 'sfdctext:pipelineInspection').confidence, 'confirmed');
  assert.ok(!out.some((r) => r.key === 'pipelineMetric:0Xm000000000002'));
});

// Issue #23: the last English-only checks. French page text was captured live in the dev org (user language
// French, Nov 2026); the German strings are illustrative.
const widget = (label, help) => ({
  name: 'SFTL_Widget__c', label: 'Widget', labelPlural: 'Widgets', custom: true, quickActions: [], recordTypeInfos: [],
  fields: [
    { name: 'SFTL_Color__c', label, custom: true, type: 'string', inlineHelpText: help, picklistValues: [] },
    { name: 'SFTL_Notes__c', label: 'Notes', custom: true, type: 'string', picklistValues: [] },
  ],
});
const fr = widget('Couleur de peinture', 'Choisissez la couleur de peinture du client.');
const de = widget('Lackfarbe', 'Wählen Sie die Lackfarbe des Kunden.');
// lightning-primitive-icon < button < lightning-button-icon < div < lightning-helptext < div < div[RecordField]
const helpTags = ['lightning-primitive-icon', 'button', 'lightning-button-icon', 'div', 'lightning-helptext', 'div', 'div', 'records-record-layout-item'];

test('#23: the help (i) icon in French or German gives the help text card, with or without the field in the path', () => {
  for (const [d, o, label] of [[fr, org(), 'Couleur de peinture'], [de, org({ userLanguage: 'de' }), 'Lackfarbe']]) {
    const help = d.fields[0].inlineHelpText;
    const inField = { tags: helpTags, helpIcon: true, helpLabel: label, selectionNames: ['sfdc:RecordField.SFTL_Widget__c.SFTL_Color__c'] };
    const a = locate({ text: help, org: o, describes: [d], hints: inField }).results;
    assert.equal(a[0].key, 'help:SFTL_Widget__c.SFTL_Color__c', label);
    assert.equal(a[0].confidence, 'confirmed', label);
    // No field in the path: the help text the icon holds names the field.
    const b = locate({ text: help, org: o, describes: [d], hints: { tags: helpTags, helpIcon: true, helpLabel: label } }).results;
    assert.equal(b[0].key, 'help:SFTL_Widget__c.SFTL_Color__c', label);
    assert.equal(b[0].confidence, 'exact', label);
    // No help text on the icon (older markup): the label beside the icon names the field.
    const c = locate({ text: label, org: o, describes: [d], hints: { tags: helpTags, helpIcon: true, helpLabel: label } }).results;
    assert.ok(c.some((r) => r.key === 'help:SFTL_Widget__c.SFTL_Color__c' && r.confidence === 'exact'), label);
  }
});

test('#23: a custom label with the same words as the help text drops to same words only', () => {
  const lbl = { Id: '101000000000001', Name: 'Pick_Color', MasterLabel: 'Pick_Color', NamespacePrefix: null, Value: fr.fields[0].inlineHelpText, Language: 'en_US' };
  const hints = { tags: helpTags, helpIcon: true, helpLabel: 'Couleur de peinture', selectionNames: ['sfdc:RecordField.SFTL_Widget__c.SFTL_Color__c'] };
  const out = locate({ text: lbl.Value, org: org({ customLabels: [lbl] }), describes: [fr], hints }).results;
  assert.equal(out[0].key, 'help:SFTL_Widget__c.SFTL_Color__c');
  const l = out.find((r) => r.source === SOURCE.CUSTOM_LABEL);
  assert.ok(l, 'the label is still listed');
  assert.notEqual(l.confidence, 'confirmed');
  assert.match(l.notes[0], /help text/);
});

const tile = { tags: ['span', 'div', 'runtime_pipeline_inspector-kpi-panel', 'div'], auraClasses: ['runtime_pipeline_inspectorPipelineInspectorHome'] };
const metrics = [
  { Id: '0Xm000000000011', DeveloperName: 'LostDeals', MasterLabel: 'Lost Deals', Language: 'en_US', Metric: 'ClosedLost' },
  { Id: '0Xm000000000012', DeveloperName: 'OpenDeals', MasterLabel: 'Open Deals', Language: 'en_US', Metric: 'OpenPipeline' },
];

test('#23: a renamed Pipeline metric tile in French or German is its one metric, confirmed', () => {
  for (const [lang, text, other] of [['fr', 'Affaires perdues', 'Affaires ouvertes'], ['de', 'Verlorene Geschäfte', 'Offene Geschäfte']]) {
    const pipelineMetricTranslations = [{ name: 'LostDeals', label: text }, { name: 'OpenDeals', label: other }];
    const out = locate({ text, org: org({ userLanguage: lang, pipelineMetrics: metrics, pipelineMetricTranslations }), describes: [], hints: tile }).results;
    assert.equal(out[0].key, 'pipelineMetric:0Xm000000000011', lang);
    assert.equal(out[0].confidence, 'confirmed', lang);
    assert.match(out[0].notes[0], /translation from this row/, lang);
    assert.equal(out.filter((r) => r.key.startsWith('pipelineMetric:')).length, 1, lang);
    assert.ok(!out.some((r) => r.key === 'sfdctext:pipelineInspection'), lang);
  }
});

test('#23: with the translations read, a tile that is none of them is Salesforce text, confirmed', () => {
  const pipelineMetricTranslations = [{ name: 'LostDeals', label: 'Affaires perdues' }];
  const out = locate({ text: 'Pipeline ouvert', org: org({ pipelineMetrics: metrics, pipelineMetricTranslations }), describes: [], hints: tile }).results;
  assert.equal(out[0].key, 'sfdctext:pipelineInspection');
  assert.equal(out[0].confidence, 'confirmed');
  assert.ok(!out.some((r) => r.key.startsWith('pipelineMetric:')));
});

test('#23: Go to translation for record data passes the record object to the Translations tab auto-fill', () => {
  const g = buildGotoUrl({ page: 'dataTranslation', object: 'Product2', recordId: '01t000000000001AAA' }, 'fr', 'en_US');
  assert.equal(g.autofill.page, 'dataTranslation');
  assert.equal(g.autofill.object, 'Product2');
});
