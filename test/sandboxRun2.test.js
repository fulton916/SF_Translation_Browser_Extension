// Large test sandbox, run 2 (Nov 2026): one test per confirmed finding, using the failing example with
// made-up names and Ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { locate, SOURCE } from '../src/locator.js';
import { loadValueSet } from '../src/sfApi.js';

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
  customLabels: [],
};

const texts = (r) => [r.title, r.subtitle, r.source, ...(r.steps || []), ...(r.notes || [])].filter(Boolean);
const BANNED = /as-is|\(not translatable\)|weaker|probably|may be/i;

// ---------- ISS-01: no "as-is" / "(not translatable)" wording next to "Admin work required to translate" ----------

const oppLeadSource = {
  name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', custom: false, recordTypeInfos: [], quickActions: [],
  fields: [
    { name: 'LeadSource', label: 'Lead Source', custom: false, type: 'picklist', picklistValues: [{ label: 'Web', value: 'Web', active: true }] },
    { name: 'Demo_Region__c', label: 'Region', custom: true, type: 'picklist', picklistValues: [{ label: 'North', value: 'North', active: true }] },
  ],
};
const valueHints = (f) => ({ selectionNames: [`sfdc:RecordField.Opportunity.${f}`], fieldPart: 'value' });

test('ISS-01: not-a-value and user calendar cards never say "as-is" or "(not translatable)"', () => {
  const org = { ...baseOrg, valueSets: { 'Opportunity.Demo_Region__c': { name: null, values: [{ value: 'North', label: 'North', active: true }] } } };
  const cards = [
    ...locate({ text: 'Example Referral', org, describes: [oppLeadSource], hints: valueHints('LeadSource') }).results,
    ...locate({ text: 'Example Region', org, describes: [oppLeadSource], hints: valueHints('Demo_Region__c') }).results,
    ...locate({
      text: 'Example Team Visits',
      org,
      describes: [],
      hints: { tags: ['label', 'div', 'li', 'ol', 'div'], auraClasses: ['uiLabel', 'calendarListItem', 'calendarListPanel', 'forceCalendar', 'calendarHome'] },
      pageUrls: ['https://example.lightning.force.com/lightning/o/Event/home'],
    }).results,
  ];
  assert.ok(cards.some((r) => r.key === 'value:Opportunity.LeadSource'));
  assert.ok(cards.some((r) => r.key === 'value:Opportunity.Demo_Region__c'));
  const cal = cards.find((r) => r.key === 'sfdctext:calendarName');
  assert.equal(cal.title, 'Calendar name created by a user');
  assert.equal(cal.source, SOURCE.NOT_TRANSLATABLE);
  for (const r of cards) for (const t of texts(r)) assert.doesNotMatch(t, BANNED, `${r.key}: ${t}`);
  // No other user-facing string in the locator uses it either.
  assert.doesNotMatch(readFileSync(new URL('../src/locator.js', import.meta.url), 'utf8'), /as-is|\(not translatable\)/);
});

// ---------- ISS-02: standard picklists read their StandardValueSet ----------

test('ISS-02: loadValueSet reads a standard picklist from its StandardValueSet (real shape)', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    const url = decodeURIComponent(u);
    urls.push(url);
    const records = /SELECT Id, MasterLabel FROM StandardValueSet/.test(url)
      ? [{ attributes: {}, Id: '0s8000000000001AAA', MasterLabel: 'LeadSource' }]
      : [{ attributes: {}, Metadata: { sorted: false, standardValue: [
          { valueName: 'Web', label: 'Web', isActive: null, default: false },
          { valueName: 'Old%20Fair', label: 'Old Fair', isActive: false, default: false },
        ] } }];
    return { ok: true, json: async () => ({ done: true, records }) };
  };
  const vs = await loadValueSet({ host: 'sandbox-std.my.salesforce.com', sid: 's' }, 'Opportunity', 'LeadSource');
  assert.deepEqual(vs, { name: null, values: [{ value: 'Web', label: 'Web', active: true }, { value: 'Old Fair', label: 'Old Fair', active: false }] });
  assert.match(urls[0], /\/tooling\/query\/.*WHERE MasterLabel IN \('OpportunityLeadSource','LeadSource'\)/);
  assert.match(urls[1], /SELECT Metadata FROM StandardValueSet WHERE Id = '0s8000000000001AAA'/);
  // Known names first: StageName is in the OpportunityStage set.
  await loadValueSet({ host: 'sandbox-std.my.salesforce.com', sid: 's' }, 'Opportunity', 'StageName');
  assert.match(urls[2], /MasterLabel IN \('OpportunityStage','OpportunityStageName','StageName'\)/);
});

test('ISS-02: a standard picklist value in no value list is confirmed "Not a value"', () => {
  const org = { ...baseOrg, valueSets: { 'Opportunity.LeadSource': { name: null, values: [{ value: 'Web', label: 'Web', active: true }, { value: 'Old Fair', label: 'Old Fair', active: false }] } } };
  const r = locate({ text: 'Example Referral', org, describes: [oppLeadSource], hints: valueHints('LeadSource') }).results[0];
  assert.equal(r.key, 'value:Opportunity.LeadSource');
  assert.equal(r.confidence, 'confirmed');
  assert.equal(r.source, SOURCE.NOT_TRANSLATABLE);
  assert.match(r.title, /^Not a value of the picklist Opportunity → Lead Source/);
  // An inactive standard value is a picklist value, not "not a value".
  const inactive = locate({ text: 'Old Fair', org, describes: [oppLeadSource], hints: valueHints('LeadSource') }).results;
  assert.ok(!inactive.some((x) => x.key.startsWith('value:')));
  assert.ok(inactive.some((x) => x.key === 'picklist:Opportunity.LeadSource.Old Fair'));
});
