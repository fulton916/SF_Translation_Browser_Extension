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
