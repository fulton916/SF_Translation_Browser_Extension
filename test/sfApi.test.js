import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soqlLike, loadLabelTranslations, stripAttributes, loadFlexiPageComponent, loadOrgData } from '../src/sfApi.js';

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
