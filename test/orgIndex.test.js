import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { layoutName, layoutSections, parseLayoutSections, parseFlow, readMetadataRecords, childBlocks, loadOrgIndex, loadOrgSectionTranslations, clearOrgIndexMemory } from '../src/orgIndex.js';

// Shapes as read from the dev org (Nov 2026): SFTL_Widget__c-Widget Layout, SFTL_Widget_Intake.
const LAYOUT = `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
    <layoutSections>
        <customLabel>true</customLabel>
        <detailHeading>true</detailHeading>
        <editHeading>true</editHeading>
        <label>Widget Basics</label>
        <layoutColumns>
            <layoutItems><behavior>Required</behavior><field>Name</field></layoutItems>
        </layoutColumns>
        <style>TwoColumnsTopToBottom</style>
    </layoutSections>
    <layoutSections>
        <label>Owner &amp; Status</label>
        <layoutColumns/>
        <style>OneColumn</style>
    </layoutSections>
    <layoutSections>
        <customLabel>false</customLabel>
        <detailHeading>false</detailHeading>
        <editHeading>false</editHeading>
        <layoutColumns/>
        <style>CustomLinks</style>
    </layoutSections>
    <showHighlightsPanel>false</showHighlightsPanel>
</Layout>`;

const FLOW = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <label>SFTL Widget Intake</label>
    <processMetadataValues><name>BuilderType</name><value><stringValue>LightningFlowBuilder</stringValue></value></processMetadataValues>
    <processType>Flow</processType>
    <screens>
        <name>Intake_Screen</name>
        <label>Widget Intake</label>
        <allowBack>true</allowBack>
        <fields>
            <name>Intro_Text</name>
            <fieldText>&lt;p&gt;Tell us about the widget.&lt;/p&gt;</fieldText>
            <fieldType>DisplayText</fieldType>
        </fields>
        <fields>
            <name>Two_Columns</name>
            <fieldType>RegionContainer</fieldType>
            <fields>
                <name>Two_Columns_Column1</name>
                <fieldType>Region</fieldType>
                <inputParameters><name>width</name><value><stringValue>6</stringValue></value></inputParameters>
                <fields>
                    <name>Widget_Nickname</name>
                    <dataType>String</dataType>
                    <fieldText>Widget Nickname</fieldText>
                    <fieldType>InputField</fieldType>
                    <helpText>&lt;p&gt;The name your team uses.&lt;/p&gt;</helpText>
                </fields>
            </fields>
        </fields>
        <nextOrFinishButtonLabel>Send it</nextOrFinishButtonLabel>
    </screens>
    <start><connector><targetReference>Intake_Screen</targetReference></connector></start>
    <status>Active</status>
</Flow>`;

test('layoutName splits the object from the URL-encoded layout name', () => {
  assert.deepEqual(layoutName('Account-Account %28Sales%29 Layout'), { object: 'Account', layout: 'Account (Sales) Layout' });
  assert.deepEqual(layoutName('SFTL_Widget__c-Widget Layout'), { object: 'SFTL_Widget__c', layout: 'Widget Layout' });
  assert.equal(layoutName('NoDash'), null);
});

test('parseLayoutSections lists named sections in page order, entities decoded', () => {
  assert.deepEqual(parseLayoutSections(LAYOUT), ['Widget Basics', 'Owner & Status']);
});

test('childBlocks keeps nested blocks of the same tag whole', () => {
  const blocks = childBlocks('<a><x>1<x>2</x></x><x>3</x><x/><x a="b"/></a>', 'x');
  assert.deepEqual(blocks, ['1<x>2</x>', '3']);
});

test('parseFlow reads screen text at any depth, not parameter names', () => {
  const flow = parseFlow('SFTL_Widget_Intake', FLOW, 'SFTL Widget Intake');
  assert.equal(flow.label, 'SFTL Widget Intake');
  assert.equal(parseFlow('SFTL_Widget_Intake', FLOW).label, 'SFTL_Widget_Intake', 'no label: the API name, never an element label');
  assert.equal(flow.screens.length, 1);
  const s = flow.screens[0];
  assert.equal(s.name, 'Intake_Screen');
  assert.equal(s.label, 'Widget Intake');
  assert.deepEqual(s.buttonLabels, ['Send it']);
  assert.deepEqual(
    s.fields.map((f) => [f.name, f.fieldType, f.fieldText]),
    [
      ['Intro_Text', 'DisplayText', '<p>Tell us about the widget.</p>'],
      ['Two_Columns', 'RegionContainer', null],
      ['Two_Columns_Column1', 'Region', null],
      ['Widget_Nickname', 'InputField', 'Widget Nickname'],
    ]
  );
  assert.equal(s.fields[3].helpText, '<p>The name your team uses.</p>');
});

const body = (records) => `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope><soapenv:Body><readMetadataResponse><result>${records}</result></readMetadataResponse></soapenv:Body></soapenv:Envelope>`;
const record = (type, fullName, xml) => `<records xsi:type="${type}"><fullName>${fullName}</fullName>${xml.replace(/^<\?xml[^>]*>\s*<\w+[^>]*>|<\/\w+>\s*$/g, '')}</records>`;

test('readMetadataRecords splits a response into its records', () => {
  // A name that cannot be read comes back as <records xsi:nil="true"/> (UAT2).
  const recs = readMetadataRecords(body('<records xsi:nil="true"/>' + record('Layout', 'SFTL_Widget__c-Widget Layout', LAYOUT) + record('Layout', 'Account-Account %28Sales%29 Layout', '<Layout></Layout>')));
  assert.deepEqual(recs.map((r) => r.fullName), ['SFTL_Widget__c-Widget Layout', 'Account-Account %28Sales%29 Layout']);
  assert.deepEqual(parseLayoutSections(recs[0].xml), ['Widget Basics', 'Owner & Status']);
});

// ---------- loadOrgIndex: one read per org, then the cache ----------

const session = { host: 'x.my.salesforce.com', sid: '00D!s' };
let calls;
let store;
let retrieveFails;
let failOneBatch;
let listDenied;
// The Metadata API's answer to a user without Modify Metadata or Modify All Data.
const ACCESS_FAULT = '<soapenv:Fault><faultcode>sf:INSUFFICIENT_ACCESS</faultcode><faultstring>INSUFFICIENT_ACCESS: use of the Metadata API requires a user with the ModifyAllData or ModifyMetadata permissions</faultstring></soapenv:Fault>';

function fakeOrg() {
  calls = [];
  const layoutNames = Array.from({ length: 12 }, (_, i) => `Obj${i}__c-Obj${i} Layout`);
  globalThis.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(url);
    if (opts.method === 'POST') {
      const soap = String(opts.body);
      if (soap.includes('<s:listMetadata>')) {
        calls.push('listLayouts');
        if (listDenied) return { ok: false, status: 500, text: async () => ACCESS_FAULT };
        assert.match(soap, /<s:type>Layout<\/s:type>/);
        const names = ['SFTL_Widget__c-Widget Layout', ...layoutNames];
        // A managed-package layout is not read (readMetadata returns it empty).
        const managed = '<result><fullName>Account-maps__Map Layout</fullName><manageableState>installed</manageableState><namespacePrefix>maps</namespacePrefix></result>';
        return { ok: true, text: async () => `<result>${managed}${names.map((n) => `<result><fullName>${n}</fullName><manageableState>unmanaged</manageableState></result>`).join('')}</result>` };
      }
      const type = /<s:type>(\w+)<\/s:type>/.exec(soap)[1];
      const names = [...soap.matchAll(/<s:fullNames>([^<]*)<\/s:fullNames>/g)].map((m) => m[1]);
      calls.push(`read${type}:${names.length}`);
      assert.ok(names.length <= 10);
      if (type === 'Layout' && failOneBatch && names.length === 3) return { ok: false, status: 500, text: async () => '<faultstring>UNKNOWN_EXCEPTION</faultstring>' };
      if (type === 'Layout' && retrieveFails) return { ok: false, status: 500, text: async () => '<faultstring>INSUFFICIENT_ACCESS: no Modify Metadata</faultstring>' };
      if (type === 'CustomObjectTranslation') {
        const tr = '<?xml version="1.0" encoding="UTF-8"?><CustomObjectTranslation><layouts><layout>Widget Layout</layout><sections><label>Bases du widget</label><section>Widget Basics</section></sections></layouts></CustomObjectTranslation>';
        return { ok: true, text: async () => body(names.map((n) => record('CustomObjectTranslation', n, n === 'SFTL_Widget__c-fr' ? tr : '')).join('')) };
      }
      if (type === 'Flow') return { ok: true, text: async () => body(names.map((n) => record('Flow', n, FLOW)).join('')) };
      return { ok: true, text: async () => body(names.map((n) => record('Layout', n, n.startsWith('SFTL') ? LAYOUT : '<Layout></Layout>')).join('')) };
    }
    if (u.includes('FROM FlowDefinitionView')) {
      calls.push('flows');
      return { ok: true, json: async () => ({ done: true, records: [{ ApiName: 'SFTL_Widget_Intake', Label: 'SFTL Widget Intake' }] }) };
    }
    if (u.includes('FROM WebLink')) {
      calls.push('buttons');
      return { ok: true, json: async () => ({ done: true, records: [{ Name: 'Ship_It', MasterLabel: 'Ship It', NamespacePrefix: null, PageOrSobjectType: 'SFTL_Widget__c' }] }) };
    }
    throw new Error('unexpected ' + u);
  };
}

beforeEach(() => {
  clearOrgIndexMemory();
  retrieveFails = false;
  failOneBatch = false;
  listDenied = false;
  store = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (o) => Object.assign(store, o),
      },
    },
  };
  fakeOrg();
});

test('loadOrgIndex reads layouts, flows and buttons once, then serves the cache', async () => {
  const first = await loadOrgIndex(session);
  assert.deepEqual(calls.sort(), ['buttons', 'flows', 'listLayouts', 'readFlow:1', 'readLayout:10', 'readLayout:3']);
  assert.deepEqual(first.layouts.length, 1);
  assert.deepEqual(first.layouts[0].sections, ['Widget Basics', 'Owner & Status']);
  assert.equal(first.flows[0].screens[0].fields[0].name, 'Intro_Text');
  assert.deepEqual(first.buttons, [{ name: 'Ship_It', label: 'Ship It', object: 'SFTL_Widget__c', namespace: null }]);
  assert.deepEqual(first.warnings, []);
  assert.ok(Date.now() - first.at < 5000);

  calls = [];
  const second = await loadOrgIndex(session);
  assert.deepEqual(calls, [], 'second lookup in the same org does not read again');
  assert.equal(second.at, first.at);
});

test('loadOrgIndex: a new browser session reads the stored copy, refresh reads again', async () => {
  const first = await loadOrgIndex(session);
  clearOrgIndexMemory();
  calls = [];
  const stored = await loadOrgIndex(session);
  assert.deepEqual(calls, []);
  assert.equal(stored.at, first.at);

  const refreshed = await loadOrgIndex(session, { refresh: true });
  assert.deepEqual(calls.sort(), ['buttons', 'flows', 'listLayouts', 'readFlow:1', 'readLayout:10', 'readLayout:3']);
  assert.equal(refreshed.layouts.length, 1);
});

test('loadOrgIndex: a copy older than 24 hours is read again', async () => {
  store['sftl:orgIndex:' + session.host] = { at: Date.now() - 25 * 3600 * 1000, layouts: [], flows: [], buttons: [], warnings: [] };
  await loadOrgIndex(session);
  assert.ok(calls.includes('listLayouts'));
});

test('loadOrgIndex: without metadata access, buttons still load and the read is not stored', async () => {
  retrieveFails = true;
  const index = await loadOrgIndex(session);
  assert.equal(index.layouts, null);
  assert.equal(index.flows.length, 1, 'flows are read on their own');
  assert.equal(index.buttons.length, 1);
  assert.match(index.warnings[0], /^Page layout sections not searched org-wide: readMetadata Layout failed/);
  assert.deepEqual(store, {});
  calls = [];
  await loadOrgIndex(session);
  assert.deepEqual(calls, [], 'kept in memory for a few minutes');
});

test('loadOrgIndex shares one read between lookups that start together', async () => {
  const [a, b] = await Promise.all([loadOrgIndex(session), loadOrgIndex(session)]);
  assert.equal(calls.filter((c) => c === 'listLayouts').length, 1);
  assert.equal(a.at, b.at);
});

test('loadOrgIndex: one failed readMetadata call makes the read partial, not stored', async () => {
  failOneBatch = true;
  const index = await loadOrgIndex(session);
  assert.equal(index.layouts.length, 1);
  assert.deepEqual(index.warnings, ['Page layout sections partly searched org-wide: 1 of 2 readMetadata Layout calls failed']);
  assert.deepEqual(store, {});
});

test('loadOrgIndex: a refresh that fails keeps the copy read earlier', async () => {
  const first = await loadOrgIndex(session);
  retrieveFails = true;
  const refreshed = await loadOrgIndex(session, { refresh: true });
  assert.deepEqual(refreshed.layouts, first.layouts);
  assert.match(refreshed.warnings[0], /^Page layout sections not searched org-wide: .*\(searched the copy read earlier\)$/);
  assert.equal(store['sftl:orgIndex:' + session.host].at, first.at, 'the stored copy stays');
});

test('loadOrgIndex: a lookup waiting on a read that fails fails too, with no read of its own', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => (String(a[0]).includes('WebLink') ? { ok: false, status: 401, text: async () => '' } : realFetch(...a));
  const results = await Promise.allSettled([loadOrgIndex(session), loadOrgIndex(session)]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  assert.equal(calls.filter((c) => c === 'listLayouts').length, 1);
});

// ---------- #34: pseudo-object layouts, standard section names, footer buttons, access errors ----------

test('layoutName: a pseudo-object layout is named by the object Translation Workbench lists it under', () => {
  // Dev org, Nov 2026: Close Case Layout under Case, Community Member Layout under User.
  assert.deepEqual(layoutName('CaseClose-Close Case Layout'), { object: 'Case', layout: 'Close Case Layout' });
  assert.deepEqual(layoutName('CommunityMemberLayout-Community Member Layout'), { object: 'User', layout: 'Community Member Layout' });
  assert.equal(layoutName('LiveChatTranscriptActive-Chat Transcript %28In Progress%29 Layout').object, 'LiveChatTranscript');
});

test('layoutSections: Salesforce standard names (customLabel false) apart from the names an admin typed', () => {
  const xml = '<layoutSections><customLabel>false</customLabel><label>Account Information</label><layoutColumns><label>x</label></layoutColumns></layoutSections><layoutSections><customLabel>true</customLabel><label>SFTL Partner Info</label></layoutSections>';
  assert.deepEqual(layoutSections(xml), { sections: ['SFTL Partner Info'], standardSections: ['Account Information'] });
  assert.deepEqual(parseLayoutSections(xml), ['SFTL Partner Info']);
});

test('parseFlow: footer button labels with their Translation Workbench aspect, and the version read', () => {
  const flow = parseFlow('SFTL_Widget_Intake', FLOW, 'SFTL Widget Intake', 2);
  assert.equal(flow.version, 2);
  assert.deepEqual(flow.screens[0].buttons, [{ aspect: 'Next or Finish Button Label', label: 'Send it' }]);
});

test('loadOrgIndex: an access error is shown once and that source is not read again until a refresh', async () => {
  listDenied = true;
  const first = await loadOrgIndex(session);
  assert.equal(first.layouts, null);
  assert.equal(first.buttons.length, 1);
  assert.deepEqual(first.warnings, []);
  assert.equal(first.notices.length, 1);
  assert.match(first.notices[0], /^Page layout sections not searched org-wide: INSUFFICIENT_ACCESS/);
  assert.ok(store['sftl:orgIndex:' + session.host], 'the rest is kept 24 hours');
  assert.deepEqual(store['sftl:orgIndex:' + session.host].notices || [], []);

  calls = [];
  const second = await loadOrgIndex(session);
  assert.deepEqual(calls, []);
  assert.deepEqual(second.notices, [], 'the next lookup does not repeat it');

  // A day later the other sources are read again; layouts are not, and nothing is shown.
  clearOrgIndexMemory();
  store['sftl:orgIndex:' + session.host].at -= 25 * 3600 * 1000;
  calls = [];
  const later = await loadOrgIndex(session);
  assert.ok(calls.includes('buttons'));
  assert.ok(!calls.includes('listLayouts'));
  assert.equal(later.layouts, null);
  assert.deepEqual([later.warnings, later.notices || []], [[], []]);

  calls = [];
  const refreshed = await loadOrgIndex(session, { refresh: true });
  assert.ok(calls.includes('listLayouts'), 'Refresh org data asks again');
  assert.equal(refreshed.notices.length, 1);
  listDenied = false;
  const allowed = await loadOrgIndex(session, { refresh: true });
  assert.equal(allowed.layouts.length, 1);
  assert.deepEqual(allowed.denied, {});
});

test('loadOrgIndex: a copy stored in the older shape is read again', async () => {
  const first = await loadOrgIndex(session);
  clearOrgIndexMemory();
  delete store['sftl:orgIndex:' + session.host].v;
  calls = [];
  await loadOrgIndex(session);
  assert.ok(calls.includes('listLayouts'));
  assert.ok(first.at);
});

test('loadOrgSectionTranslations reads the objects with custom-named sections, once per language', async () => {
  const index = { at: 1, layouts: [{ object: 'SFTL_Widget__c', layout: 'Widget Layout', sections: ['Widget Basics'], standardSections: [] }, { object: 'Account', layout: 'Account Layout', sections: [], standardSections: ['Account Information'] }] };
  const tr = await loadOrgSectionTranslations(session, index, 'fr');
  assert.deepEqual(calls, ['readCustomObjectTranslation:1'], 'Account has standard names only');
  assert.deepEqual(tr, [{ object: 'SFTL_Widget__c', layout: 'Widget Layout', section: 'Widget Basics', label: 'Bases du widget' }]);
  calls = [];
  await loadOrgSectionTranslations(session, index, 'fr');
  assert.deepEqual(calls, []);
  assert.deepEqual(await loadOrgSectionTranslations(session, index, 'not a language'), []);
});
