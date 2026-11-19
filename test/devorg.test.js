// Developer Edition sweep (Nov 2026, tester A): one test per confirmed finding, using the failing example
// with made-up names and Ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, SOURCE } from '../src/locator.js';

const baseOrg = {
  userLanguage: 'en_US',
  defaultLanguage: 'en_US',
  labelTranslations: [],
  objects: [
    { name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false },
    { name: 'Demo_Gadget__c', label: 'Gadget', labelPlural: 'Gadgets', custom: true },
  ],
  tabs: [
    { Name: 'standard-Account', Label: 'Accounts', IsCustom: false, SobjectName: 'Account' },
    { Name: 'Demo_Gadget__c', Label: 'Gadgets', IsCustom: true, SobjectName: 'Demo_Gadget__c' },
  ],
  apps: [],
  validationRules: [],
  customLabels: [],
};
const gadget = {
  name: 'Demo_Gadget__c', label: 'Gadget', labelPlural: 'Gadgets', custom: true, quickActions: [], recordTypeInfos: [],
  fields: [{ name: 'Demo_Color__c', label: 'Coat Color', custom: true, type: 'string', picklistValues: [] }],
};

test('A-26: the error message under a field is its validation rule, not the field', () => {
  const org = {
    ...baseOrg,
    validationRules: [{ Id: '03d000000000001AAA', ValidationName: 'Demo_Color_Required', ErrorMessage: 'Shipped gadgets need a coat color.', EntityDefinition: { QualifiedApiName: 'Demo_Gadget__c' } }],
  };
  const hints = { selectionNames: ['sfdc:RecordField.Demo_Gadget__c.Demo_Color__c'], fieldPart: 'error' };
  const rs = locate({ text: 'Shipped gadgets need a coat color.', org, describes: [gadget], hints }).results;
  assert.equal(rs[0].key, 'vr:03d000000000001AAA');
  assert.equal(rs[0].confidence, 'confirmed');
  assert.equal(rs[0].notes[0], 'You pointed at the error message shown under the field Coat Color.');
  assert.ok(!rs.some((r) => r.key.startsWith('value:')), 'not "Record data"');
});
