// Dev org re-test of v0.2.5 (Nov 2026): one test per fix, with made-up names and zero-padded fake Ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../src/pointerTarget.js');
const { visibleText } = globalThis.sftlPointer;

// Fake element: innerText as Chrome gives it (the absolutely positioned assistive span on its own line).
const fakeEl = (innerText, assistive = []) => ({
  innerText,
  querySelectorAll: (sel) => (/slds-assistive-text/.test(sel) ? assistive.map((t) => ({ innerText: t })) : []),
});

test('1: an error message under a field gives its message, not the assistive field label before it', () => {
  const err = fakeEl('Coat Color\nShipped gadgets need a coat color.', ['Coat Color']);
  assert.equal(visibleText(err).split('\n')[0], 'Shipped gadgets need a coat color.');
  // Same line (no line break from innerText): the label prefix is dropped.
  assert.equal(visibleText(fakeEl('Coat Color Shipped gadgets need a coat color.', ['Coat Color'])), 'Shipped gadgets need a coat color.');
  // Only assistive text in the element (the (i) icon's "Help <label>"): kept.
  assert.equal(visibleText(fakeEl('Help Coat Color', ['Help Coat Color'])), 'Help Coat Color');
  // No assistive text: unchanged.
  assert.equal(visibleText(fakeEl('  Gadget Basics  ')), 'Gadget Basics');
  assert.equal(visibleText(null), '');
});

// ---------- 2: a change of the user's language is seen on the next lookup ----------
import { loadOrgData, loadUserLanguage, loadDescribe } from '../src/sfApi.js';

test('2: the user language is read every 15 s; on a change only the language-dependent org data is read again', async () => {
  let lang = 'en_US';
  const urls = [];
  globalThis.fetch = async (u) => {
    const url = decodeURIComponent(u);
    urls.push(url);
    const json = (body) => ({ ok: true, json: async () => body });
    if (url.includes('/userinfo')) return json({ language: lang });
    if (url.endsWith('/sobjects')) return json({ sobjects: [{ name: 'Demo_Gadget__c', label: lang === 'fr' ? 'Gadget FR' : 'Gadget', labelPlural: 'Gadgets', custom: true }] });
    if (url.endsWith('/describe')) return json({ name: 'Demo_Gadget__c', label: lang === 'fr' ? 'Gadget FR' : 'Gadget', fields: [] });
    if (url.endsWith('/quickActions')) return json([]);
    return json({ records: [], done: true });
  };
  const s = { host: 'retest-lang.my.salesforce.com', sid: 's' };
  const en = await loadOrgData(s, { language: await loadUserLanguage(s) });
  assert.equal(en.userLanguage, 'en_US');
  assert.equal(en.objects[0].label, 'Gadget');
  const d1 = await loadDescribe(s, 'Demo_Gadget__c', { language: 'en_US' });
  assert.equal(d1.label, 'Gadget');

  // The user switches to French. Within 15 s the cached language is used; a refresh reads it again.
  lang = 'fr';
  urls.length = 0;
  assert.equal(await loadUserLanguage(s), 'en_US');
  assert.equal(urls.length, 0);
  const now = await loadUserLanguage(s, { refresh: true });
  assert.equal(now, 'fr');
  urls.length = 0;
  const fr = await loadOrgData(s, { language: now });
  assert.equal(fr.userLanguage, 'fr');
  assert.equal(fr.objects[0].label, 'Gadget FR');
  // Object names, tabs and apps only: custom labels, validation rules and paths are kept.
  assert.equal(urls.length, 3);
  assert.ok(urls.some((u) => u.endsWith('/sobjects')));
  assert.ok(urls.some((u) => /FROM TabDefinition/.test(u)));
  assert.ok(urls.some((u) => /FROM AppMenuItem/.test(u)));
  assert.ok(!urls.some((u) => /ExternalString|ValidationRule|PathAssistant/.test(u)));
  // Same language again: nothing read.
  urls.length = 0;
  assert.equal((await loadOrgData(s, { language: 'fr' })).userLanguage, 'fr');
  assert.equal(urls.length, 0);
  // Describes are kept per language: the French one is read, the English one stays cached.
  const d2 = await loadDescribe(s, 'Demo_Gadget__c', { language: 'fr' });
  assert.equal(d2.label, 'Gadget FR');
  assert.equal((await loadDescribe(s, 'Demo_Gadget__c', { language: 'en_US' })).label, 'Gadget');
});
