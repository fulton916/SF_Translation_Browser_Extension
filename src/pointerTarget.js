// Which element the Alt+Shift+T shortcut describes. Content script, loaded before content.js
// (no import/export: it runs as a classic script there). Pure DOM walking, unit tested in Node with fakes.
globalThis.sftlPointer = (() => {
  /** Elements from node up to the document, through slots and shadow roots, like event.composedPath(). */
  function composedAncestors(node) {
    const out = [];
    for (let n = node; n && out.length < 200; ) {
      if (n.nodeType === 1) out.push(n);
      n = n.assignedSlot || n.parentNode || null;
      if (n && n.nodeType === 11) n = n.host || null; // ShadowRoot → its host
    }
    return out;
  }

  /** The element at a point, inside open shadow roots too. Unlike mouse events, it finds disabled buttons. */
  function deepElementAt(doc, x, y) {
    let el = doc?.elementFromPoint?.(x, y) || null;
    for (let i = 0; el?.shadowRoot && i < 50; i++) {
      const inner = el.shadowRoot.elementFromPoint?.(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  /**
   * Path for the shortcut: the highlighted text's element when text is selected (R-06: a selection made
   * away from the mouse got the hovered element's page area), else the element under the pointer, looked
   * up again at the last pointer position (C-02: a disabled "Today" button gets no mousemove, so the path
   * was the neighbouring button's).
   */
  function shortcutPath({ doc, selection, pointerPath, pointerXY }) {
    let path = (pointerPath || []).filter((n) => n && n.nodeType === 1);
    if (pointerXY) {
      const el = deepElementAt(doc, pointerXY[0], pointerXY[1]);
      if (el && el !== path[0]) path = composedAncestors(el);
    }
    if (selection && selection.rangeCount && String(selection).trim()) {
      const sel = composedAncestors(selection.getRangeAt(0).commonAncestorContainer);
      // The pointer is on the selected text (or deeper inside it): its path is the more precise one.
      if (sel.length && !path.includes(sel[0])) path = sel;
    }
    return path;
  }

  return { composedAncestors, deepElementAt, shortcutPath };
})();
