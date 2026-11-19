// DV2 live run 2 (Nov 2026): one test per confirmed finding, using the failing example with
// made-up names and Ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { locate, matchType, SOURCE } from '../src/locator.js';
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
    { name: 'Region_LST__c', label: 'Region', custom: true, type: 'picklist', picklistValues: [{ label: 'North', value: 'North', active: true }] },
  ],
};
const valueHints = (f) => ({ selectionNames: [`sfdc:RecordField.Opportunity.${f}`], fieldPart: 'value' });

test('ISS-01: not-a-value and user calendar cards never say "as-is" or "(not translatable)"', () => {
  const org = { ...baseOrg, valueSets: { 'Opportunity.Region_LST__c': { name: null, values: [{ value: 'North', label: 'North', active: true }] } } };
  const cards = [
    ...locate({ text: 'Example Referral', org, describes: [oppLeadSource], hints: valueHints('LeadSource') }).results,
    ...locate({ text: 'Example Region', org, describes: [oppLeadSource], hints: valueHints('Region_LST__c') }).results,
    ...locate({
      text: 'Example Team Visits',
      org,
      describes: [],
      hints: { tags: ['label', 'div', 'li', 'ol', 'div'], auraClasses: ['uiLabel', 'calendarListItem', 'calendarListPanel', 'forceCalendar', 'calendarHome'] },
      pageUrls: ['https://example.lightning.force.com/lightning/o/Event/home'],
    }).results,
  ];
  assert.ok(cards.some((r) => r.key === 'value:Opportunity.LeadSource'));
  assert.ok(cards.some((r) => r.key === 'value:Opportunity.Region_LST__c'));
  const cal = cards.find((r) => r.key === 'sfdctext:calendarName');
  assert.equal(cal.title, 'Calendar name created by a user');
  assert.equal(cal.source, SOURCE.NOT_TRANSLATABLE);
  for (const r of cards) for (const t of texts(r)) assert.doesNotMatch(t, BANNED, `${r.key}: ${t}`);
  // No other user-facing string in the locator uses it either.
  assert.doesNotMatch(readFileSync(new URL('../src/locator.js', import.meta.url), 'utf8'), /as-is|\(not translatable\)/);
});

// ---------- ISS-02: standard picklists read their StandardValueSet ----------

test('ISS-02: loadValueSet reads a standard picklist from its StandardValueSet (real DV2 shape)', async () => {
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
  const vs = await loadValueSet({ host: 'live2-std.my.salesforce.com', sid: 's' }, 'Opportunity', 'LeadSource');
  assert.deepEqual(vs, { name: null, values: [{ value: 'Web', label: 'Web', active: true }, { value: 'Old Fair', label: 'Old Fair', active: false }] });
  assert.match(urls[0], /\/tooling\/query\/.*WHERE MasterLabel IN \('OpportunityLeadSource','LeadSource'\)/);
  assert.match(urls[1], /SELECT Metadata FROM StandardValueSet WHERE Id = '0s8000000000001AAA'/);
  // Known names first: StageName is in the OpportunityStage set.
  await loadValueSet({ host: 'live2-std.my.salesforce.com', sid: 's' }, 'Opportunity', 'StageName');
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

// ---------- ISS-03: one "Salesforce text" card, not a second bare page-area card ----------

test('ISS-03: Chatter "Post" gives exactly one Salesforce text card (the feed action)', () => {
  const contact = {
    name: 'Contact', label: 'Contact', labelPlural: 'Contacts', custom: false, recordTypeInfos: [], fields: [],
    quickActions: [{ label: 'Post', name: 'FeedItem.TextPost', type: 'Post' }],
  };
  const org = { ...baseOrg, customLabels: [lbl('101D00000000071', 'Example_Post', 'Post', 'exns')] };
  for (const selectionNames of [['sfdc:QuickAction.FeedItem.TextPost'], []]) {
    const out = locate({ text: 'Post', org, describes: [contact], hints: { selectionNames, sfComponents: ['forceChatter_exampleFeedPublisher'], tags: ['span', 'a', 'li'] } });
    const sf = [...out.results, ...out.more].filter((r) => r.title === 'Salesforce text');
    assert.equal(sf.length, 1, JSON.stringify(sf.map((r) => r.key)));
    assert.equal(sf[0].key, 'stdaction:FeedItem.TextPost');
    assert.equal(sf[0].subtitle, 'Standard feed action FeedItem.TextPost');
  }
  // Text in the feed that matched nothing else still gets the page-area card.
  const other = locate({ text: 'updated this record.', org, describes: [contact], hints: { sfComponents: ['forceChatter_exampleFeedPublisher'] } }).results;
  assert.equal(other[0].key, 'sfdctext:feed');
});

// ---------- ISS-04: part of a picklist value highlighted ----------

test('ISS-04: highlighting "ANZ" in the value "EX ANZ" puts that value card first, ahead of similar labels', () => {
  const account = {
    name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, recordTypeInfos: [], quickActions: [],
    fields: [{ name: 'Business_Unit_LST__c', label: 'Business Unit', custom: true, type: 'picklist', picklistValues: [{ label: 'EX NORTH', value: 'EX NORTH', active: true }] }],
  };
  const org = {
    ...baseOrg,
    customLabels: Array.from({ length: 30 }, (_, i) => lbl(`101D0000000${String(100 + i)}`, `Example_${i}`, `Example ganz text ${i}`)),
    valueSets: { 'Account.Business_Unit_LST__c': { name: null, values: [{ value: 'EX NORTH', label: 'EX NORTH', active: true }, { value: 'EX ANZ', label: 'EX ANZ', active: false }] } },
  };
  const out = locate({ text: 'ANZ', org, describes: [account], hints: { selectionNames: ['sfdc:RecordField.Account.Business_Unit_LST__c'], fieldPart: 'value' } });
  const r = out.results[0];
  assert.equal(r.key, 'picklist:Account.Business_Unit_LST__c.EX ANZ');
  assert.equal(r.confidence, 'context');
  assert.equal(r.notes[0], 'You highlighted part of this value.');
  assert.ok(!out.results.some((x) => x.source === SOURCE.CUSTOM_LABEL), 'similar labels stay behind "Show more"');
  assert.ok(!out.results.some((x) => x.key.startsWith('value:')));
});

test('ISS-04: a highlight under 5 characters matches whole words only', () => {
  assert.equal(matchType('anz', 'EX ANZ'), 'partial');
  assert.equal(matchType('anz', 'Ganz anz'), 'partial');
  assert.equal(matchType('anz', 'Example ganz text'), null);
  assert.equal(matchType('emea', 'EX EMEA (old)'), 'partial');
  assert.equal(matchType('portal', 'Welcome to the portals'), 'partial', '5+ characters still match inside words');
});
