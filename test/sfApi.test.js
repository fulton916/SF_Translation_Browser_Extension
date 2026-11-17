import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soqlLike, loadLabelTranslations, stripAttributes, loadFlexiPageComponent } from '../src/sfApi.js';

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
