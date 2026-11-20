import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soqlLike, loadLabelTranslations, stripAttributes, loadFlexiPageComponent, loadOrgData, utilityItems, loadUtilityApps, loadUtilityBar, loadPipelineMetrics, parsePipelineMetricTranslations, loadPipelineMetricTranslations, translationsTabIds, loadTranslationsTabIds } from '../src/sfApi.js';

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

test('loadFlexiPageComponent reads a field section label (real shape)', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(decodeURIComponent(u));
    return {
      ok: true,
      json: async () => ({
        done: true,
        records: [{
          attributes: { type: 'FlexiPage' }, DeveloperName: 'Demo_Account_Record_Page', MasterLabel: 'Demo Account Record Page',
          Metadata: { flexiPageRegions: [{ itemInstances: [
            { componentInstance: { identifier: 'flexipage_tabset', componentName: 'flexipage:tabset', componentInstanceProperties: [] } },
            { componentInstance: { identifier: 'flexipage_fieldSection6', componentName: 'flexipage:fieldSection',
              componentInstanceProperties: [{ name: 'columns', value: 'Facet-1' }, { name: 'label', value: '{!$Label.Demo_Team}' }] } },
          ] }] },
        }],
      }),
    };
  };
  const pc = await loadFlexiPageComponent({ host: 'x', sid: 's' },
    'forcegenerated-flexipage_demo_account_record_page_account__view_js___lmt___1', 'flexipage_fieldSection6', ['Account']);
  assert.equal(pc.label, '{!$Label.Demo_Team}');
  assert.equal(pc.page, 'Demo Account Record Page');
  assert.match(urls[0], /DeveloperName = 'demo_account_record_page' LIMIT 1/);
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
          DeveloperName: 'Demo_Part_Record_Page', MasterLabel: 'Demo Part Record Page',
          Metadata: { flexiPageRegions: [{ itemInstances: [
            { componentInstance: { identifier: 'flexipage_fieldSection2', componentName: 'flexipage:fieldSection',
              componentInstanceProperties: [{ name: 'label', value: 'System Information' }] } },
          ] }] },
        }],
      }),
    };
  };
  const pc = await loadFlexiPageComponent({ host: 'create-form', sid: 's' },
    'forcegenerated-flexipage_demo_part_record_page_demo_part__c__create_js___lmt___1', 'flexipage_fieldSection2', ['Demo_Part__c']);
  assert.equal(pc.label, 'System Information');
  assert.match(urls[0], /DeveloperName = 'demo_part_record_page' LIMIT 1/);
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

// Issue #23. Shapes as read live in the dev org (Nov 2026): readMetadata Translations "fr" (a row with no
// translation has a comment as its label) and the FlexiPage of a Product2 page with a Translations tab.
const translationsXml =
  '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="http://soap.sforce.com/2006/04/metadata"><soapenv:Body><readMetadataResponse><result><records xsi:type="Translations"><fullName>fr</fullName>' +
  '<customLabels><label>Bienvenue à l&apos;atelier</label><name>SFTL_Greeting</name></customLabels>' +
  '<pipelineInspMetricConfigs><label>Affaires perdues</label><name>LostDeals</name></pipelineInspMetricConfigs>' +
  '<pipelineInspMetricConfigs><description><!-- x --></description><label><!-- Open Deals --></label><name>OpenDeals</name></pipelineInspMetricConfigs>' +
  '<pipelineInspMetricConfigs><label>L&apos;entonnoir</label><name>Funnel</name></pipelineInspMetricConfigs>' +
  '</records></result></readMetadataResponse></soapenv:Body></soapenv:Envelope>';

test('#23: renamed metric translations are read from Translations, untranslated rows left out', async () => {
  assert.deepEqual(parsePipelineMetricTranslations(translationsXml), [
    { name: 'LostDeals', label: 'Affaires perdues' },
    { name: 'Funnel', label: "L'entonnoir" },
  ]);
  const bodies = [];
  globalThis.fetch = async (u, init) => {
    bodies.push(init.body);
    return { ok: true, status: 200, text: async () => translationsXml };
  };
  const session = { host: 'metrics23.my.salesforce.com', sid: 'x' };
  const rows = await loadPipelineMetricTranslations(session, 'fr');
  assert.equal(rows.length, 2);
  assert.match(bodies[0], /<s:type>Translations<\/s:type><s:fullNames>fr<\/s:fullNames>/);
  assert.equal(await loadPipelineMetricTranslations(session, "fr'); x"), null);
});

const productPage = {
  DeveloperName: 'SFTL_Product_Record_Page',
  MasterLabel: 'SFTL Product Record Page',
  Metadata: {
    flexiPageRegions: [
      {
        name: 'Facet-p-tabs',
        type: 'Facet',
        itemInstances: [
          { componentInstance: { componentName: 'flexipage:tab', identifier: 'flexipage_tab1', componentInstanceProperties: [{ name: 'title', value: 'Standard.Tab.detail' }] } },
          { componentInstance: { componentName: 'flexipage:tab', identifier: 'flexipage_tab2', componentInstanceProperties: [{ name: 'body', value: 'Facet-p-tr' }, { name: 'title', value: 'Standard.Tab.translations' }] } },
        ],
      },
      { name: 'main', type: 'Region', itemInstances: [{ componentInstance: { componentName: 'flexipage:tabset', identifier: 'flexipage_tabset' } }] },
    ],
  },
};

test('#23: the Translations tab is found by its title key in the page metadata, in any language', async () => {
  assert.deepEqual(translationsTabIds(productPage), ['flexipage_tab2']);
  assert.deepEqual(translationsTabIds({ Metadata: { flexiPageRegions: [] } }), []);
  // A title the admin typed: the same text in every language.
  const typed = { componentInstance: { componentName: 'flexipage:tab', identifier: 'sftl_tab_tr', componentInstanceProperties: [{ name: 'title', value: 'Translations' }] } };
  assert.deepEqual(translationsTabIds({ Metadata: { flexiPageRegions: [{ itemInstances: [typed] }] } }), ['sftl_tab_tr']);
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(decodeURIComponent(u));
    return { ok: true, status: 200, json: async () => ({ records: [productPage], done: true }) };
  };
  const session = { host: 'tabs23.my.salesforce.com', sid: 'x' };
  const ids = await loadTranslationsTabIds(session, 'forcegenerated-flexipage_sftl_product_record_page_product2__view_js', ['Product2']);
  assert.deepEqual(ids, ['flexipage_tab2']);
  assert.match(urls[0], /FROM FlexiPage WHERE DeveloperName = 'sftl_product_record_page'/);
  assert.deepEqual(await loadTranslationsTabIds(session, 'not-a-page', []), []);
});
