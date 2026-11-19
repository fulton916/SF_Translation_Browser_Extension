// Large test sandbox, run 2 (Nov 2026): one test per confirmed finding, using the failing example with
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

test('ISS-04: highlighting "OLD" in the value "EX OLD" puts that value card first, ahead of similar labels', () => {
  const account = {
    name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, recordTypeInfos: [], quickActions: [],
    fields: [{ name: 'Demo_Team__c', label: 'Demo Team', custom: true, type: 'picklist', picklistValues: [{ label: 'EX NORTH', value: 'EX NORTH', active: true }] }],
  };
  const org = {
    ...baseOrg,
    customLabels: Array.from({ length: 30 }, (_, i) => lbl(`101D0000000${String(100 + i)}`, `Example_${i}`, `Example gold text ${i}`)),
    valueSets: { 'Account.Demo_Team__c': { name: null, values: [{ value: 'EX NORTH', label: 'EX NORTH', active: true }, { value: 'EX OLD', label: 'EX OLD', active: false }] } },
  };
  const out = locate({ text: 'OLD', org, describes: [account], hints: { selectionNames: ['sfdc:RecordField.Account.Demo_Team__c'], fieldPart: 'value' } });
  const r = out.results[0];
  assert.equal(r.key, 'picklist:Account.Demo_Team__c.EX OLD');
  assert.equal(r.confidence, 'context');
  assert.equal(r.notes[0], 'You highlighted part of this value.');
  assert.ok(!out.results.some((x) => x.source === SOURCE.CUSTOM_LABEL), 'similar labels stay behind "Show more"');
  assert.ok(!out.results.some((x) => x.key.startsWith('value:')));
});

test('ISS-04: a highlight under 5 characters matches whole words only', () => {
  assert.equal(matchType('old', 'EX OLD'), 'partial');
  assert.equal(matchType('old', 'Gold old'), 'partial');
  assert.equal(matchType('old', 'Example gold text'), null);
  assert.equal(matchType('west', 'EX WEST (new)'), 'partial');
  assert.equal(matchType('portal', 'Welcome to the portals'), 'partial', '5+ characters still match inside words');
});

// ---------- ISS-06: Aura (page layout) section header ----------

test('ISS-06: an Aura record layout section header is the Layout Section, not a same-text custom label', () => {
  // Real path (Event Details): span < button < h3 < legend < fieldset[forcePageBlockSection] < div[forcePageBlock].
  const header = { tags: ['span', 'button', 'h3', 'legend', 'fieldset', 'div'], auraClasses: ['forcePageBlockSection', 'forcePageBlock', 'force_detailPanel'] };
  const event = { name: 'Event', label: 'Event', labelPlural: 'Events', custom: false, recordTypeInfos: [], quickActions: [], fields: [] };
  const org = { ...baseOrg, customLabels: [lbl('101D00000000081', 'Example_Visit_Info', 'Visit Information')] };
  const out = locate({ text: 'Visit Information', org, describes: [event], hints: header, record: { object: 'Event', id: '00U000000000001AAA' } });
  assert.ok(out.areas.includes('layoutSection'));
  assert.equal(out.results[0].key, 'area:layoutSection');
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.equal(out.results[0].goto.component, 'LayoutSection');
  assert.ok(!out.results.some((r) => r.source === SOURCE.CUSTOM_LABEL), 'same-text label is behind "Show more"');
  // A field inside the section is not the section header.
  const field = { tags: ['span', 'div', 'h3', 'legend', 'fieldset'], auraClasses: ['forcePageBlockItem', 'forcePageBlockSectionRow', 'forcePageBlockSection'] };
  assert.ok(!locate({ text: 'Visit Information', org, describes: [event], hints: field }).areas.includes('layoutSection'));
  // Blank space in the section (no heading in the path) is not the header either.
  assert.ok(!locate({ text: 'Visit Information', org, describes: [event], hints: { tags: ['div', 'fieldset'], auraClasses: ['forcePageBlockSection'] } }).areas.includes('layoutSection'));
});
