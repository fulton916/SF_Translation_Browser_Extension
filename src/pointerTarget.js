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
   * The innermost child of el (shadow children too) whose box holds the point. elementFromPoint skips
   * elements with pointer-events: none, such as Lightning's disabled buttons (DV2: the disabled calendar
   * "Today" gave its container, whose first label is "Previous Week").
   */
  function innermostAt(el, x, y) {
    let cur = el;
    for (let depth = 0; cur && depth < 60; depth++) {
      const kids = [...(cur.shadowRoot?.children || []), ...(cur.children || [])];
      const hit = kids.findLast((k) => {
        const r = k.getBoundingClientRect?.();
        return r && r.width > 0 && r.height > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
      });
      if (!hit) break;
      cur = hit;
    }
    return cur;
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
      const at = deepElementAt(doc, pointerXY[0], pointerXY[1]);
      const el = at && innermostAt(at, pointerXY[0], pointerXY[1]);
      if (el && el !== path[0]) path = composedAncestors(el);
    }
    if (selection && selection.rangeCount && String(selection).trim()) {
      const sel = composedAncestors(selection.getRangeAt(0).commonAncestorContainer);
      // The pointer is on the selected text (or deeper inside it): its path is the more precise one.
      if (sel.length && !path.includes(sel[0])) path = sel;
    }
    return path;
  }

  /**
   * True when the path is inside the element with this id (the extension's own panel host): the
   * shortcut over the panel looked up the panel's own text (C-09: "No match found").
   */
  function insideId(path, id) {
    return Boolean(id) && (path || []).some((n) => n && n.nodeType === 1 && n.id === id);
  }

  /**
   * The element's text without its screen-reader-only parts (.slds-assistive-text), one line per row.
   * A field's error message starts with the field label for screen readers (dev org:
   * <div class="slds-form-element__help"><span class="slds-assistive-text">Paint Color</span>Shipped
   * widgets need a paint color.</div>), and innerText puts that label on its own first line.
   * Only assistive text in the element: kept (the (i) icon's "Help <label>").
   */
  function visibleText(el) {
    const lines = String(el?.innerText || '')
      .split('\n')
      .map((l) => l.replace(/[\s ]+/g, ' ').trim())
      .filter(Boolean);
    const hidden = [...(el?.querySelectorAll?.('.slds-assistive-text, .assistiveText') || [])]
      .map((a) => String(a.innerText || a.textContent || '').replace(/[\s ]+/g, ' ').trim())
      .filter(Boolean);
    if (!hidden.length) return lines.join('\n');
    const shown = [];
    for (let line of lines) {
      for (const h of hidden) {
        if (line === h) line = '';
        else if (line.startsWith(h + ' ')) line = line.slice(h.length + 1).trim();
      }
      if (line) shown.push(line);
    }
    return (shown.length ? shown : lines).join('\n');
  }

  return { composedAncestors, deepElementAt, innermostAt, shortcutPath, insideId, visibleText };
})();
