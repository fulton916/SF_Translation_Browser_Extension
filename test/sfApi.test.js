import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soqlLike, loadLabelTranslations, stripAttributes, loadFlexiPageComponent, loadOrgData, utilityItems, loadUtilityApps, loadUtilityBar, loadPipelineMetrics } from '../src/sfApi.js';

test('soqlLike escapes quotes, backslash, % and _', () => {
  assert.equal(soqlLike(String.raw`it's 50%_x\y`), String.raw`it\'s 50\%\_x\\y`);
});

test('label translations are searched by text and label ids, never loaded in full', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(decodeURIComponent(u));
    return { ok: true, json: async () => ({ records: [], done: true }) };
  };
  await loadLabelTranslations({ host: 'x.my.salesforce.com', sid: 's' }, "Owner's  Name", ['000000000000001AAA']);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/tooling\/query\/\?q=SELECT Id, ExternalStringId, Language, Value FROM ExternalStringLocalization WHERE /);
  assert.match(urls[0], /Value LIKE '%Owner\\'s Name%'/);
  assert.match(urls[0], /ExternalStringId IN \('000000000000001AAA'\)/);
  assert.match(urls[0], /LIMIT 2000$/);
});

test('short text uses an exact match', async () => {
  const urls = [];
  globalThis.fetch = async (u) => (urls.push(decodeURIComponent(u)), { ok: true, json: async () => ({ records: [], done: true }) });
  await loadLabelTranslations({ host: 'x', sid: 's' }, 'Ja', []);
  assert.match(urls[0], /WHERE Value = 'Ja' LIMIT/);
});

test('stripAttributes keeps nested arrays as arrays', () => {
  const out = stripAttributes({ attributes: { type: 'X' }, Metadata: { flexiPageRegions: [{ itemInstances: [{ attributes: {}, a: 1 }] }] } });
  assert.ok(Array.isArray(out.Metadata.flexiPageRegions));
  assert.ok(Array.isArray(out.Metadata.flexiPageRegions[0].itemInstances));
  assert.deepEqual(out.Metadata.flexiPageRegions[0].itemInstances[0], { a: 1 });
});

test('loadFlexiPageComponent reads a field section label (real UAT2 shape)', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(decodeURIComponent(u));
    return {
      ok: true,
      json: async () => ({
        done: true,
        records: [{
          attributes: { type: 'FlexiPage' }, DeveloperName: 'Prospect_Record_Page_Three_Column', MasterLabel: 'Prospect Record Page Three Column',
          Metadata: { flexiPageRegions: [{ itemInstances: [
            { componentInstance: { identifier: 'flexipage_tabset', componentName: 'flexipage:tabset', componentInstanceProperties: [] } },
            { componentInstance: { identifier: 'flexipage_fieldSection6', componentName: 'flexipage:fieldSection',
              componentInstanceProperties: [{ name: 'columns', value: 'Facet-1' }, { name: 'label', value: '{!$Label.Business_Unit}' }] } },
          ] }] },
        }],
      }),
    };
  };
  const pc = await loadFlexiPageComponent({ host: 'x', sid: 's' },
    'forcegenerated-flexipage_prospect_record_page_three_column_account__view_js___lmt___1', 'flexipage_fieldSection6', ['Account']);
  assert.equal(pc.label, '{!$Label.Business_Unit}');
  assert.equal(pc.page, 'Prospect Record Page Three Column');
  assert.match(urls[0], /DeveloperName = 'prospect_record_page_three_column' LIMIT 1/);
});

test('loadFlexiPageComponent reads the New form of a Dynamic Forms page (tag ends in __create_js)', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(decodeURIComponent(u));
    return {
      ok: true,
      json: async () => ({
        done: true,
        records: [{
          DeveloperName: 'Example_Party_Record_Page', MasterLabel: 'Example Party Record Page',
          Metadata: { flexiPageRegions: [{ itemInstances: [
            { componentInstance: { identifier: 'flexipage_fieldSection2', componentName: 'flexipage:fieldSection',
              componentInstanceProperties: [{ name: 'label', value: 'System Information' }] } },
          ] }] },
        }],
      }),
    };
  };
  const pc = await loadFlexiPageComponent({ host: 'create-form', sid: 's' },
    'forcegenerated-flexipage_example_party_record_page_example_party__c__create_js___lmt___1783417856000', 'flexipage_fieldSection2', ['Example_Party__c']);
  assert.equal(pc.label, 'System Information');
  assert.match(urls[0], /DeveloperName = 'example_party_record_page' LIMIT 1/);
});

test('loadOrgData: path guidance queries fail → warnings only, other sources still load', async () => {
  globalThis.fetch = async (u) => {
    const url = decodeURIComponent(u);
    if (/FROM (PathAssistantStepInfo|PathAssistant)\b/.test(url)) {
      return { ok: false, status: 400, text: async () => JSON.stringify([{ message: "sObject type 'PathAssistant' is not supported." }]) };
    }
    if (url.includes('/userinfo')) return { ok: true, json: async () => ({ language: 'en_US' }) };
    if (url.endsWith('/sobjects')) return { ok: true, json: async () => ({ sobjects: [] }) };
    return { ok: true, json: async () => ({ records: [], done: true }) };
  };
  const org = await loadOrgData({ host: 'paths-fail.my.salesforce.com', sid: 's' }, { refresh: true });
  assert.equal(org.pathSteps, null);
  assert.equal(org.paths, null);
  assert.deepEqual(org.customLabels, []);
  assert.equal(org.userLanguage, 'en_US');
  assert.ok(org.warnings.some((w) => w.startsWith('Path guidance not searched')));
  assert.ok(org.warnings.some((w) => w.startsWith('Paths not searched')));
});

// Utility bar FlexiPage Metadata (dev org Sales app, Tooling, checked live): the label is a "decorator" property.
const salesBarPage = {
  DeveloperName: 'LightningSales_UtilityBar', MasterLabel: 'Sales App Utility Bar',
  Metadata: {
    flexiPageRegions: [{
      name: 'utilityItems', type: 'Region',
      itemInstances: [
        { componentInstance: { componentInstanceProperties: [], componentName: 'runtime_sales_todo_list:unifiedToDoListAuraWrapper', identifier: 'runtime_sales_todo_list_unifiedToDoListAuraWrapper' }, fieldInstance: null },
        { componentInstance: { componentInstanceProperties: [
          { name: 'icon', type: 'decorator', value: 'info', valueList: null },
          { name: 'label', type: 'decorator', value: 'Example Tips', valueList: null },
          { name: 'richTextValue', type: null, value: '<p>Example</p>', valueList: null },
        ], componentName: 'flexipage:richText', identifier: 'flexipage_richText' }, fieldInstance: null },
        { componentInstance: { componentInstanceProperties: [{ name: 'label', type: null, value: 'Chart title', valueList: null }], componentName: 'flexipage:reportChart', identifier: 'flexipage_reportChart' }, fieldInstance: null },
      ],
    }],
  },
};

test('utilityItems: the label decorator is the item label; a component property named label is not', () => {
  assert.deepEqual(utilityItems(salesBarPage), [
    { id: 'runtime_sales_todo_list_unifiedToDoListAuraWrapper', component: 'runtime_sales_todo_list:unifiedToDoListAuraWrapper', label: null },
    { id: 'flexipage_richText', component: 'flexipage:richText', label: 'Example Tips' },
    { id: 'flexipage_reportChart', component: 'flexipage:reportChart', label: null },
  ]);
});

test('loadUtilityApps puts the current app first; loadUtilityBar reads a package bar by namespace', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    const url = decodeURIComponent(u);
    urls.push(url);
    const body = /userinfo/.test(url)
      ? { user_id: '005000000000001AAA' }
      : /FROM AppDefinition/.test(url)
        ? { done: true, records: [{ DurableId: '06m000000000001', Label: 'Sales', UtilityBar: 'LightningSales_UtilityBar' }, { DurableId: '06m000000000002', Label: 'Example Edition', UtilityBar: 'exns__Example_UtilityBar' }] }
        : /FROM UserAppInfo/.test(url)
          ? { done: true, records: [{ AppDefinitionId: '06m000000000002' }] }
          : { done: true, records: [salesBarPage] };
    return { ok: true, json: async () => body };
  };
  const session = { host: 'utility.example.com', sid: 's' };
  const apps = await loadUtilityApps(session);
  assert.deepEqual(apps.map((a) => [a.app, a.current]), [['Example Edition', true], ['Sales', false]]);
  assert.ok(urls.some((u) => /UserAppInfo WHERE UserId = '005000000000001AAA' AND FormFactor = 'Large'/.test(u)));
  await loadUtilityBar(session, apps[0]);
  assert.match(urls.at(-1), /\/tooling\/query\/.*FROM FlexiPage WHERE DeveloperName = 'Example_UtilityBar' AND NamespacePrefix = 'exns' LIMIT 1/);
  const bar = await loadUtilityBar(session, apps[1]);
  assert.match(urls.at(-1), /DeveloperName = 'LightningSales_UtilityBar' AND NamespacePrefix = null/);
  assert.equal(bar.app, 'Sales');
  assert.equal(bar.items[1].label, 'Example Tips');
});

test('loadPipelineMetrics: an org without Pipeline Inspection has no metric names, not an error', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify([{ message: "sObject type 'PipelineInspMetricConfig' is not supported.", errorCode: 'INVALID_TYPE' }]) });
  assert.deepEqual(await loadPipelineMetrics({ host: 'nopipeline.example.com', sid: 's' }), []);
  const urls = [];
  globalThis.fetch = async (u) => (urls.push(decodeURIComponent(u)), { ok: true, json: async () => ({ done: true, records: [{ Id: '0ZZ000000000001', MasterLabel: 'Example Open Deals', Metric: 'OpenPipeline' }] }) });
  const rows = await loadPipelineMetrics({ host: 'pipeline.example.com', sid: 's' });
  assert.equal(rows[0].MasterLabel, 'Example Open Deals');
  assert.match(urls[0], /\/services\/data\/v\d+\.0\/query\/\?q=SELECT Id, DeveloperName, MasterLabel, Language, Metric FROM PipelineInspMetricConfig$/);
});
