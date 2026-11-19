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
    // Checked live (v62.0): every StandardValueSet row carries this placeholder Id, and a Metadata
    // query filtered by Id fails with MALFORMED_QUERY.
    if (/FROM StandardValueSet WHERE Id/.test(url)) return { ok: false, status: 400, text: async () => '[{"message":"StandardValueSet: filtered column Id not found","errorCode":"MALFORMED_QUERY"}]' };
    const records = /SELECT (Id, )?MasterLabel FROM StandardValueSet/.test(url)
      ? [{ attributes: {}, Id: '000000000000000AAA', MasterLabel: 'LeadSource' }]
      : [{ attributes: {}, Metadata: { sorted: false, standardValue: [
          { valueName: 'Web', label: 'Web', isActive: null, default: false },
          { valueName: 'Old%20Fair', label: 'Old Fair', isActive: false, default: false },
        ] } }];
    return { ok: true, json: async () => ({ done: true, records }) };
  };
  const vs = await loadValueSet({ host: 'sandbox-std.my.salesforce.com', sid: 's' }, 'Opportunity', 'LeadSource');
  assert.deepEqual(vs, { name: null, values: [{ value: 'Web', label: 'Web', active: true }, { value: 'Old Fair', label: 'Old Fair', active: false }] });
  assert.match(urls[0], /\/tooling\/query\/.*WHERE MasterLabel IN \('OpportunityLeadSource','LeadSource'\)/);
  assert.match(urls[1], /SELECT Metadata FROM StandardValueSet WHERE MasterLabel = 'LeadSource'/);
  assert.ok(!urls.some((u) => /StandardValueSet WHERE Id/.test(u)), 'never filters StandardValueSet Metadata by Id');
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

// ---------- RANK-01: a custom label holding a URL or path is not a similar text ----------

test('RANK-01: a label whose value is a path does not partly match page text', () => {
  const org = {
    ...baseOrg,
    customLabels: [lbl('101D00000000090', 'Example_Redirect_URL', '/lightning/page/home'), lbl('101D00000000091', 'Example_Link', 'https://example.com/home'), lbl('101D00000000092', 'Example_Home_Title', 'Home page')],
  };
  const out = locate({ text: 'Home', org, describes: [] });
  const keys = [...out.results, ...out.more].map((r) => r.title + ' ' + (r.subtitle || '') + ' ' + r.key).join('\n');
  assert.doesNotMatch(keys, /Example_Redirect_URL|Example_Link/);
  assert.match(keys, /Example_Home_Title/);
  // The exact value still matches.
  const exact = locate({ text: '/lightning/page/home', org, describes: [] });
  assert.match(JSON.stringify(exact.results), /Example_Redirect_URL/);
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
  // UI-03: the publisher inside a page's Chatter tab (real path: the publisher's own a[role=tab] inside
  // flexipage-tab2[role=tabpanel]) is not a "Lightning page tab label".
  const inChatterTab = {
    selectionNames: ['sfdc:QuickAction.FeedItem.TextPost'],
    sfComponents: ['forceChatter_recordFeedContainer'],
    tabRole: 'tab',
    tags: ['span', 'a', 'li', 'ul', 'div', 'div', 'div', 'div', 'flexipage-aura-wrapper', 'slot', 'flexipage-component2', 'slot', 'flexipage-tab2', 'slot', 'slot', 'div', 'lightning-tabset', 'div', 'flexipage-tabset2'],
    componentIds: ['forceChatter_recordFeedContainer', 'flexipage_tabset'],
  };
  const tabOut = locate({ text: 'Post', org, describes: [contact], hints: inChatterTab });
  assert.equal(tabOut.results[0].key, 'stdaction:FeedItem.TextPost');
  assert.ok(![...tabOut.results, ...tabOut.more].some((r) => r.key === 'area:lightningPageTab'), JSON.stringify(tabOut.results.map((r) => r.key)));
  // The page tab label itself (a[role=tab] < li < ul < lightning-tab-bar < ... < flexipage-tabset2) still is.
  const tabLabel = locate({ text: 'Example Tab', org, describes: [contact], hints: { tabRole: 'tab', tags: ['a', 'li', 'ul', 'lightning-tab-bar', 'div', 'lightning-tabset', 'div', 'flexipage-tabset2'] } });
  assert.ok(tabLabel.results.some((r) => r.key === 'area:lightningPageTab'));
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

// ---------- ISS-08: path page-area cards have no subtitle ----------

test('ISS-08: the Closed path step card has no subtitle; step 2 explains the closed values', () => {
  const chevron = { tags: ['span', 'a', 'li', 'ul', 'div'], auraClasses: ['runtime_sales_pathassistantPathAssistantTabSet', 'runtime_sales_pathassistantPathAssistant'] };
  const r = locate({ text: 'Closed', org: baseOrg, describes: [], hints: chevron }).results[0];
  assert.equal(r.key, 'sfdctext:pathClosed');
  assert.equal(r.title, 'Salesforce text');
  assert.equal(r.subtitle, undefined);
  assert.equal(r.steps[0], 'Salesforce writes and translates this text. Admins cannot change or translate it.');
  assert.match(r.steps[1], /groups the closed values/);
});

// ---------- ISS-09: an event box on the Calendar page is the Event's subject ----------

test('ISS-09: an event box in the calendar week grid is record data (Event subject), confirmed', () => {
  // Real path: a.subject-link < div.eventBox < div.calendarEvent < runtime_calendar-timed-event < ... day-timed-events.
  const ev = { tags: ['a', 'div', 'div', 'runtime_calendar-timed-event', 'ul', 'runtime_calendar-day-timed-events', 'div'], auraClasses: ['forceCalendarDay', 'forceCalendarDayWeekView', 'forceCalendar', 'calendarHome'] };
  const org = { ...baseOrg, customLabels: [lbl('101D00000000091', 'Example_Visit', 'Example customer visit')] };
  const out = locate({ text: 'Example customer visit', org, describes: [], hints: ev, pageUrls: ['https://example.lightning.force.com/lightning/o/Event/home'] });
  assert.ok(out.areas.includes('calendarEvent'));
  assert.equal(out.results[0].key, 'value:Event.Subject');
  assert.equal(out.results[0].title, 'Record data: Event subject');
  assert.equal(out.results[0].source, SOURCE.NOT_TRANSLATABLE);
  assert.equal(out.results[0].confidence, 'confirmed');
  assert.ok(!out.results.some((r) => r.title === 'Salesforce text' || r.source === SOURCE.CUSTOM_LABEL));
  assert.equal(out.notFoundHelp, null);
  // The day column itself (no event box in the path) is not an event.
  assert.ok(!locate({ text: 'WED 18', org, describes: [], hints: { tags: ['ul', 'runtime_calendar-day-timed-events', 'div'], auraClasses: ['forceCalendarDay'] } }).areas.includes('calendarEvent'));
});

// ---------- ISS-05 / ISS-07: which element the shortcut describes (src/pointerTarget.js) ----------

await import('../src/pointerTarget.js');
const { shortcutPath, composedAncestors } = globalThis.sftlPointer;

// Minimal fake DOM: elements (nodeType 1), text (3), shadow roots (11, with host), document (9).
const doc = { nodeType: 9, parentNode: null, at: null, elementFromPoint() { return this.at; } };
const el = (tag, parentNode) => ({ nodeType: 1, tagName: tag.toUpperCase(), parentNode, assignedSlot: null, shadowRoot: null });
const html = el('html', doc);
const body = el('body', html);
// Path guidance text inside a shadow root.
const guidanceHost = el('runtime_sales_pathassistant-info', body);
const shadow = { nodeType: 11, host: guidanceHost, parentNode: null, elementFromPoint: () => null };
guidanceHost.shadowRoot = shadow;
const li = el('li', shadow);
const text = { nodeType: 3, parentNode: li, assignedSlot: null };
// Somewhere else on the page: calendar header buttons.
const prevBtn = el('button', body);
const todayBtn = el('button', body); // disabled: no mousemove reaches it
const selectionOf = (node, s = 'Review') => ({ rangeCount: 1, toString: () => s, getRangeAt: () => ({ commonAncestorContainer: node }) });
const noSelection = { rangeCount: 0, toString: () => '' };

test('ISS-05: composedAncestors climbs from a text node through a shadow root to the document', () => {
  assert.deepEqual(composedAncestors(text).map((n) => n.tagName), ['LI', 'RUNTIME_SALES_PATHASSISTANT-INFO', 'BODY', 'HTML']);
});

test('ISS-05: highlighted text describes the selection\'s element, not the hovered one', () => {
  doc.at = prevBtn;
  const path = shortcutPath({ doc, selection: selectionOf(text), pointerPath: [prevBtn, body, html, doc], pointerXY: [10, 10] });
  assert.equal(path[0], li);
  assert.ok(path.includes(guidanceHost));
  // Pointer on the selected text (deeper or equal): its own path is kept.
  doc.at = null;
  const onIt = shortcutPath({ doc, selection: selectionOf(text), pointerPath: [li, guidanceHost, body, html], pointerXY: null });
  assert.equal(onIt[0], li);
});

test('ISS-07: a disabled button under the pointer is found again at the pointer position', () => {
  doc.at = todayBtn;
  const path = shortcutPath({ doc, selection: noSelection, pointerPath: [prevBtn, body, html, doc], pointerXY: [40, 10] });
  assert.equal(path[0], todayBtn);
  // Same element as the last mouse event: unchanged.
  doc.at = prevBtn;
  assert.equal(shortcutPath({ doc, selection: noSelection, pointerPath: [prevBtn, body, html], pointerXY: [10, 10] })[0], prevBtn);
  // Nothing at that point: the last mouse path.
  doc.at = null;
  assert.equal(shortcutPath({ doc, selection: noSelection, pointerPath: [prevBtn, body, html], pointerXY: [10, 10] })[0], prevBtn);
});

test('disabled Today (pointer-events: none): the pointer hits the button container, the Today button inside is found', () => {
  const box = (left, top, width, height) => () => ({ left, top, right: left + width, bottom: top + height, width, height });
  const controls = { ...el('div', body), getBoundingClientRect: box(645, 162, 200, 32) };
  const prev = { ...el('button', controls), getBoundingClientRect: box(645, 162, 32, 32) };
  const next = { ...el('button', controls), getBoundingClientRect: box(677, 162, 32, 32) };
  const today = { ...el('button', controls), getBoundingClientRect: box(717, 162, 69, 32) };
  controls.children = [prev, next, today];
  doc.at = controls; // elementFromPoint skips the disabled button
  const path = shortcutPath({ doc, selection: noSelection, pointerPath: [controls, body, html], pointerXY: [751, 178] });
  assert.equal(path[0], today);
  assert.ok(path.includes(controls));
  // Pointer on Previous Week: still Previous Week.
  assert.equal(shortcutPath({ doc, selection: noSelection, pointerPath: [controls, body, html], pointerXY: [660, 178] })[0], prev);
  // Pointer on the container's gap between buttons: the container.
  assert.equal(shortcutPath({ doc, selection: noSelection, pointerPath: [controls, body, html], pointerXY: [712, 178] })[0], controls);
});

test('UI-02: the shortcut over the extension\'s own panel is recognised (it looked up the panel text)', () => {
  const { insideId } = globalThis.sftlPointer;
  const panelHost = { ...el('div', body), id: 'example-panel-host' };
  const panelShadow = { nodeType: 11, host: panelHost, parentNode: null, elementFromPoint: () => panelLine };
  panelHost.shadowRoot = panelShadow;
  const panelLine = el('div', panelShadow);
  doc.at = panelHost;
  const path = shortcutPath({ doc, selection: noSelection, pointerPath: [panelHost, body, html], pointerXY: [5, 5] });
  assert.equal(path[0], panelLine);
  assert.equal(insideId(path, 'example-panel-host'), true);
  // Anywhere else on the page: not inside it.
  doc.at = prevBtn;
  assert.equal(insideId(shortcutPath({ doc, selection: noSelection, pointerPath: [prevBtn, body, html], pointerXY: [10, 10] }), 'example-panel-host'), false);
  assert.equal(insideId([prevBtn], ''), false);
});
