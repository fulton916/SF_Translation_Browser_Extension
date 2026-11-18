// Runs in every Salesforce frame. Two jobs:
// 1. Remember what was right-clicked and collect Lightning metadata from it.
// 2. In the top frame, render the results panel.
(() => {
  // Guard against double injection. After an extension reload the old copy is
  // disconnected (chrome.runtime.id is gone), so a fresh copy must take over.
  if (window.__sftlAlive?.()) return;
  window.__sftlAlive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  // ---------- test log (stored by the background; viewer: toolbar icon or panel link) ----------
  function logEvent(level, where, message, details, stack) {
    try {
      if (!window.__sftlAlive()) return;
      chrome.runtime.sendMessage({ type: 'sftl:log', level, where, message, details, stack }, () => void chrome.runtime.lastError);
    } catch {}
  }
  window.addEventListener('error', (e) => {
    if (String(e.filename || '').startsWith('chrome-extension://')) logEvent('error', 'content-script', e.message, { file: e.filename, line: e.lineno }, e.error?.stack);
  });

  const HINT_ATTRS = ['data-target-selection-name', 'field-name', 'data-field-api-name', 'data-api-name', 'object-api-name', 'data-id'];
  let lastTarget = null;
  let lastRequest = null;

  document.addEventListener(
    'contextmenu',
    (e) => {
      const path = e.composedPath().filter((n) => n instanceof Element);
      lastTarget = { path, at: Date.now() };
    },
    true
  );

  // Keyboard shortcut Alt+Shift+T: same lookup as the right-click menu, for the element under the mouse
  // (or the highlighted text). A page listener, not chrome.commands, so automated key presses reach it too.
  let pointerPath = null;
  document.addEventListener('mousemove', (e) => (pointerPath = e.composedPath()), { capture: true, passive: true });
  window.addEventListener(
    'keydown',
    (e) => {
      if (!(e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyT') || !window.__sftlAlive()) return;
      e.preventDefault();
      e.stopPropagation();
      lastTarget = { path: (pointerPath || []).filter((n) => n instanceof Element), at: Date.now() };
      const selectionText = String(window.getSelection() || '').trim();
      chrome.runtime.sendMessage({ type: 'sftl:shortcut', selectionText }, () => void chrome.runtime.lastError);
    },
    true
  );

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'sftl:getTarget') {
      sendResponse(describeTarget());
    } else if (msg?.type === 'sftl:showPanel') {
      if (window.top === window) renderPanel(msg.payload);
      sendResponse({ ok: true });
    }
  });

  // ---------- target capture ----------

  function describeTarget() {
    // componentIds: Lightning App Builder component ids (e.g. flexipage_fieldSection6), nearest first.
    // flexipage: the record page's generated tag, which carries its developer name.
    // tabRole: 'tab' when the click was on a tab's label, 'tabpanel' when inside its content.
    // auraClasses: data-aura-class values on the path, e.g. runtime_sales_pathassistantPathAssistantInfo
    // (Path "Guidance for Success" is plain Aura divs, so tag names alone do not show it).
    // fieldPart: 'label' or 'value' of a record field (classes checked live on an Account, Nov 2026:
    // span.test-id__field-label / span.test-id__field-value.slds-form-element__static).
    // helpIcon: pointed at a field's (i) icon (lightning-helptext); its text is the assistive "Help <label>".
    // listHeader: true on a related list's title bar (h2.slds-card__header-title), false inside its rows.
    // recordTitle: the record name in the highlights panel (lightning-formatted-text slot="primaryField").
    const hints = {
      selectionNames: [], objectApiNames: [], tags: [], auraCustom: [], auraClasses: [], attrs: {}, componentIds: [], flexipage: null, tabRole: null,
      fieldPart: null, helpIcon: false, listHeader: null, recordTitle: false, sfComponents: [], highlightsLabel: null,
    };
    const path = lastTarget && Date.now() - lastTarget.at < 60000 ? lastTarget.path : [];
    let inField = false;
    let headerSeen = false;
    let titleSeen = false;
    let valueSeen = false;
    for (const el of path.slice(0, 60)) {
      const tag = el.tagName.toLowerCase();
      hints.tags.push(tag);
      const cls = typeof el.className === 'string' ? el.className : '';
      if (!inField && !hints.fieldPart) {
        if (/\btest-id__field-label\b|\bslds-form-element__label\b/.test(cls)) hints.fieldPart = 'label';
        else if (/\btest-id__field-value\b|\bslds-form-element__static\b|\bslds-form-element__control\b/.test(cls)) hints.fieldPart = 'value';
      }
      // Highlights panel (compact layout) field, seen live (Nov 2026): records-highlights-details-item
      // (shadow) > div > p.slds-text-title (label) + p.fieldComponent > slot (value). No RecordField name here,
      // so keep the item's label text too: locator.js finds the field by it.
      if (/\bslds-text-title\b/.test(cls)) titleSeen = true;
      if (/\bfieldComponent\b/.test(cls)) valueSeen = true;
      if (tag === 'records-highlights-details-item' && !hints.highlightsLabel) {
        const t = (el.shadowRoot || el).querySelector?.('.slds-text-title');
        hints.highlightsLabel = (t?.getAttribute('title') || t?.innerText || '').trim().slice(0, 200) || null;
        if (!hints.fieldPart) hints.fieldPart = titleSeen ? 'label' : valueSeen ? 'value' : null;
      }
      if (tag === 'lightning-helptext') hints.helpIcon = true;
      if (tag === 'h2' || /\bslds-card__header\b|\bslds-card__header-title\b/.test(cls)) headerSeen = true;
      if (hints.listHeader === null && /^(lst-related-list|force-related-list|lst-dynamic-related-list)/.test(tag)) hints.listHeader = headerSeen;
      if (el.getAttribute('slot') === 'primaryField' && path.some((p) => p.tagName === 'RECORDS-HIGHLIGHTS2')) hints.recordTitle = true;
      if (!hints.flexipage && tag.startsWith('forcegenerated-flexipage_')) hints.flexipage = tag.slice(0, 200);
      const role = el.getAttribute('role');
      if (!hints.tabRole && (role === 'tab' || role === 'tabpanel')) hints.tabRole = role;
      const tsn = el.getAttribute('data-target-selection-name');
      if (tsn?.startsWith('sfdc:RecordField.')) inField = true;
      // Lightning App Builder component ids, as in the page metadata: flexipage_fieldSection6,
      // flexipage_tab2Tab (tab flexipage_tab2), lst_dynamicRelatedList16, force_relatedListSingleContainer15.
      if (tsn && /^(flexipage_|lst_|force_)/.test(tsn)) hints.componentIds.push(tsn.slice(0, 100));
      // Salesforce's own record page components (seen live): runtime_sales_activities_activityPanel,
      // runtime_sales_merge_mergeCandidatesPreviewCard2 (duplicates), forceChatter_recordFeedContainer.
      if (tsn && /^(runtime_|forceChatter_)/.test(tsn) && hints.sfComponents.length < 10) hints.sfComponents.push(tsn.slice(0, 100));
      const aura = el.getAttribute('data-aura-class');
      if (aura && /^c[A-Z]/.test(aura)) hints.auraCustom.push(aura);
      if (aura && hints.auraClasses.length < 20) hints.auraClasses.push(aura.split(/\s+/)[0].slice(0, 100));
      for (const a of HINT_ATTRS) {
        const v = el.getAttribute(a);
        if (!v) continue;
        if (a === 'data-target-selection-name' && v.startsWith('sfdc:')) hints.selectionNames.push(v);
        // Publisher tabs carry no sfdc: prefix (R-21: "Post" is FeedItem.TextPostTab): the feed action.
        const feedTab = a === 'data-target-selection-name' && /^FeedItem\.(\w+?)Tab$/.exec(v);
        if (feedTab) hints.selectionNames.push(`sfdc:QuickAction.FeedItem.${feedTab[1]}`);
        if (a === 'object-api-name') hints.objectApiNames.push(v);
        if (!(a in hints.attrs)) hints.attrs[a] = v.slice(0, 200);
      }
    }
    hints.selectionNames = [...new Set(hints.selectionNames)];
    hints.tags = [...new Set(hints.tags)];
    hints.auraClasses = [...new Set(hints.auraClasses)];
    let text = elementText(path);
    // The (i) icon only holds "Help <field label>" for screen readers (the help text itself is in a
    // popup that is not in the path). Keep the label; locator.js lists the field's help text.
    if (hints.helpIcon) {
      text = text.replace(/^Help\s+/i, '');
      hints.fieldPart = null;
    }
    return { text, hints, url: location.href };
  }

  // Screen-reader-only text (seen live: "Enable table equivalent for screen reader users" on a chart).
  const isAssistive = (el) => /\b(slds-assistive-text|assistiveText)\b/.test(typeof el.className === 'string' ? el.className : '');

  function elementText(path) {
    for (const el of path.slice(0, 6)) {
      if (isAssistive(el)) continue;
      const t = (el.innerText || '').trim();
      if (t && t.length <= 300) return t.split('\n')[0].trim();
      const label = el.getAttribute('title') || el.getAttribute('aria-label');
      if (label) return label.trim();
    }
    return '';
  }

  // ---------- panel ----------

  let host = null;
  let root = null;

  function renderPanel(p) {
    if (!host) {
      // Remove a panel left by a disconnected (pre-reload) copy: its buttons no longer work.
      document.querySelectorAll('#sftl-panel-host').forEach((h) => h.remove());
      host = document.createElement('div');
      host.id = 'sftl-panel-host';
      host.style.cssText = 'position:fixed;top:64px;right:16px;z-index:2147483647;';
      root = host.attachShadow({ mode: 'open' });
      document.documentElement.appendChild(host);
    }
    root.replaceChildren(style(), build(p));
    if (p.state === 'results') lastRequest = { text: p.text, hints: p.hints };
    if (p.state !== 'loading') lastPayload = p;
  }

  function build(p) {
    const panel = el('div', 'panel');
    const head = el('div', 'head');
    head.append(el('div', 'title', 'Where to translate'), button('×', 'icon', 'Close', () => host.remove() || (host = null)));
    panel.append(head);
    if (p.text) panel.append(el('div', 'query', `"${p.text.length > 120 ? p.text.slice(0, 119) + '…' : p.text}"`));

    if (p.state === 'loading') {
      panel.append(el('div', 'muted', 'Searching your org…'));
      return panel;
    }
    if (p.state === 'error') {
      panel.append(el('div', 'error', p.message));
      return panel;
    }

    panel.append(languagePicker(p.language));

    const meta = [];
    if (p.language?.user) meta.push(`Viewing in ${langName(p.language.user)}`);
    if (p.language?.orgDefault) meta.push(`org default ${langName(p.language.orgDefault)}`);
    if (p.contextObjects?.length) meta.push(`objects searched: ${p.contextObjects.join(', ')}`);
    if (meta.length) panel.append(el('div', 'muted', meta.join(' · ')));

    const list = el('div', 'list');
    for (const r of p.results || []) list.append(card(r));
    panel.append(list);

    if (p.more?.length) {
      const n = p.more.length;
      panel.append(
        button(`Show ${n} more match${n === 1 ? '' : 'es'}`, 'link', 'Show the other places this text appears', (ev) => {
          ev.currentTarget.remove();
          for (const r of p.more) list.append(card(r));
        })
      );
    }
    if (p.notFoundHelp) {
      const nf = el('div', 'card');
      nf.append(el('div', 'card-title', 'No match found'));
      const ul = el('ul', 'notes');
      p.notFoundHelp.forEach((n) => ul.append(el('li', '', n)));
      nf.append(ul);
      panel.append(nf);
    }
    for (const w of p.warnings || []) panel.append(el('div', 'warn', w));

    const foot = el('div', 'foot');
    foot.append(
      button('Refresh org data', 'link', 'Reload metadata from Salesforce', (ev) => {
        const b = ev.currentTarget;
        ask({ type: 'sftl:refresh', text: p.text, hints: lastRequest?.hints }).catch((e) => b.after(el('div', 'error', e.message)));
      }),
      document.createTextNode(' · '),
      button('Test log', 'link', 'Open the log of lookups and errors', (ev) => {
        const b = ev.currentTarget;
        ask({ type: 'sftl:openLog' }, 3000).catch(() => {});
        b.blur();
      }),
      document.createTextNode(' · '),
      button('Report a problem', 'link', 'Copy a report of this lookup and open a new GitHub issue', (ev) => reportProblem(ev.currentTarget)),
      // Version shows whether the extension was reloaded after an update.
      el('span', 'muted version', ` · v${chrome.runtime.getManifest?.().version || '?'}`)
    );
    panel.append(foot);
    return panel;
  }

  function card(r) {
    // A confirmed "not translatable" result is the right answer but has no translation location.
    const conf = r.confidence === 'confirmed' && r.source === 'Not translatable as-is' ? 'confirmed-none' : r.confidence;
    const c = el('div', `card card-${conf}`);
    const top = el('div', 'card-top');
    top.append(el('span', `badge ${badgeClass(r.source)}`, r.source), el('span', `conf ${conf}`, confidenceText(conf)));
    c.append(top, el('div', 'card-title', r.title));
    if (r.subtitle) c.append(el('div', 'muted', r.subtitle));
    const ol = el('ol', 'steps');
    (r.steps || []).forEach((s) => ol.append(el('li', '', s)));
    c.append(ol);
    if (r.notes?.length) {
      const ul = el('ul', 'notes');
      r.notes.forEach((n) => ul.append(el('li', '', n)));
      c.append(ul);
    }
    const actions = el('div', 'actions');
    if (r.goto) {
      actions.append(
        button('Go to translation', 'btn', 'Open the exact translation screen and fill in the choices', (ev) => {
          const b = ev.currentTarget;
          b.textContent = 'Opening…';
          ask({ type: 'sftl:goto', goto: r.goto, lang: targetLang, orgDefault: lastLanguage?.orgDefault })
            .then((res) => {
              if (res?.error) throw new Error(res.error);
              b.textContent = 'Go to translation';
              if (res?.note) showCardNote(b, res.note);
            })
            .catch((e) => {
              b.textContent = 'Go to translation';
              showCardError(b, e.message);
              logEvent('error', 'panel', `Go to translation failed: ${e.message}`, { title: r.title, goto: r.goto, lang: targetLang });
            });
        })
      );
    }
    if (r.url && r.url.startsWith('/lightning/')) {
      const a = el('a', r.goto ? 'btn secondary' : 'btn', 'Open page');
      a.href = new URL(r.url, location.origin).href;
      a.target = '_blank';
      a.rel = 'noopener';
      actions.append(a);
    }
    if (r.copy) {
      actions.append(
        button(`Copy ${r.copy.length > 40 ? 'name' : r.copy}`, 'btn secondary', 'Copy API name', (ev) => {
          navigator.clipboard.writeText(r.copy).then(() => (ev.target.textContent = 'Copied'));
        })
      );
    }
    c.append(actions);
    return c;
  }

  // ---------- target language ----------

  // Salesforce language codes (end-user + common platform languages).
  const LANGUAGES = [
    'ar', 'bg', 'zh_CN', 'zh_TW', 'hr', 'cs', 'da', 'nl_NL', 'en_US', 'en_GB', 'en_AU', 'en_CA', 'et', 'fi', 'fr', 'fr_BE', 'fr_CA',
    'de', 'de_AT', 'de_CH', 'el', 'he', 'hi', 'hu', 'in', 'ga', 'it', 'ja', 'kk', 'ko', 'lv', 'lt', 'ms', 'no', 'pl', 'pt_BR',
    'pt_PT', 'ro', 'ru', 'sr', 'sk', 'sl', 'es', 'es_MX', 'sv', 'th', 'tr', 'uk', 'vi',
  ];
  let targetLang = '';
  let lastLanguage = null;

  /** Defaults to the org's default language; English and every other language can be picked. */
  function languagePicker(language) {
    lastLanguage = language || null;
    const orgDefault = language?.orgDefault || '';
    const wrap = el('label', 'lang', 'Translate into ');
    const sel = el('select', 'lang-select');
    const codes = [...new Set([orgDefault, ...LANGUAGES].filter(Boolean))];
    const sorted = codes
      .filter((c) => c !== orgDefault)
      .sort((a, b) => langName(a).localeCompare(langName(b)));
    if (orgDefault) sel.append(new Option(`${langName(orgDefault)} (org default)`, orgDefault));
    sorted.forEach((code) => sel.append(new Option(`${langName(code)} (${code})`, code)));
    sel.append(new Option('(choose on the page)', ''));
    targetLang = orgDefault;
    sel.value = targetLang;
    sel.addEventListener('change', () => {
      targetLang = sel.value || '';
    });
    wrap.append(sel);
    return wrap;
  }

  function badgeClass(source) {
    return (
      {
        'Custom Labels': 'b-label',
        'Rename Tabs and Labels': 'b-rename',
        'Translation Workbench': 'b-workbench',
        'Workbench Override (package)': 'b-override',
        'Data Translation (record data)': 'b-data',
        'Custom translation object': 'b-data',
        'Not translatable as-is': 'b-none',
      }[source] || 'b-context'
    );
  }

  function confidenceText(c) {
    // "Same text" (not "Exact match"): equal words do not prove this is where the text comes from.
    return { confirmed: 'Confirmed Location', 'confirmed-none': 'Not Translatable', exact: 'Same text', partial: 'Similar text', context: 'From page area' }[c] || c;
  }

  function langName(code) {
    try {
      // "standard" shows "English (United States)" instead of "American English".
      return new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' }).of(code.replace('_', '-'));
    } catch {
      return code;
    }
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text; // never innerHTML: org data may contain markup
    return e;
  }

  const RELOAD_MSG = 'The extension was reloaded. Refresh this Salesforce page (F5), then try again.';

  /** sendMessage that always settles: handles a disconnected extension, errors, and no reply. */
  function ask(msg, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!window.__sftlAlive()) return reject(new Error(RELOAD_MSG));
      const timer = setTimeout(() => reject(new Error('No reply from the extension. Refresh this page (F5) and try again.')), timeoutMs);
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          clearTimeout(timer);
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(/context invalidated|receiving end/i.test(err.message) ? RELOAD_MSG : err.message));
          else resolve(res);
        });
      } catch (e) {
        clearTimeout(timer);
        reject(new Error(/context invalidated/i.test(e.message) ? RELOAD_MSG : e.message));
      }
    });
  }

  function showCardNote(fromEl, message) {
    const actions = fromEl.closest('.actions');
    actions?.parentElement.querySelector('.card-note')?.remove();
    actions?.after(el('div', 'muted card-note', message));
  }

  // ---------- "Report a problem": copy a report, open a GitHub issue to paste it into ----------
  const ISSUE_URL = 'https://github.com/fulton916/SF_Translation_Browser_Extension/issues/new';
  let lastPayload = null;

  async function reportProblem(b) {
    const p = lastPayload || {};
    const h = p.hints || {};
    let recent = '';
    try {
      recent = (await ask({ type: 'sftl:getLog', limit: 15 }, 3000))?.text || '';
    } catch {}
    const lines = [
      `Looked up: "${p.text || ''}"`,
      `Page: ${location.host}${location.pathname}`,
      `Translate into: ${targetLang || '(choose on the page)'} · viewing ${p.language?.user || '?'} · org default ${p.language?.orgDefault || '?'}`,
      `Objects searched: ${(p.contextObjects || []).join(', ') || 'none'}`,
      `Clicked element: ${(h.tags || []).filter((t) => t.includes('-')).slice(0, 6).join(' > ') || '(none)'}`,
      h.selectionNames?.length ? `Page metadata: ${h.selectionNames.join(', ')}` : null,
      h.componentIds?.length ? `Lightning components: ${h.componentIds.slice(0, 3).join(', ')}` : null,
      p.areas?.length ? `Areas: ${p.areas.join(', ')}` : null,
      p.state === 'error' ? `Error shown: ${p.message}` : null,
      '',
      'Results shown:',
      ...(p.results || []).map((r, i) => `  ${i + 1}. ${r.confidence} | ${r.source} | ${r.title}`),
      p.more?.length ? `  (+${p.more.length} more behind "Show more")` : null,
      ...(p.warnings || []).map((w) => `Warning: ${w}`),
      '',
      `Extension version: ${chrome.runtime.getManifest?.().version || '?'}`,
      '',
      recent,
    ].filter((x) => x !== null);
    const report = lines.join('\n');
    let copied = false;
    try {
      await navigator.clipboard.writeText(report);
      copied = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = report;
      document.body.appendChild(ta);
      ta.select();
      copied = document.execCommand('copy');
      ta.remove();
    }
    const title = `Test finding: "${String(p.text || '').slice(0, 60)}"`;
    window.open(`${ISSUE_URL}?template=test_finding.yml&title=${encodeURIComponent(title)}`, '_blank', 'noopener');
    logEvent('info', 'panel', 'Opened a GitHub issue to report a problem', { text: p.text, copied });
    b.parentElement.querySelector('.report-note')?.remove();
    b.parentElement.append(
      el('div', 'muted report-note', copied
        ? 'Report copied. In the GitHub tab: click the Test log box, press Ctrl+V, and add a sentence about what was wrong. Screenshots: Win+Shift+S, then Ctrl+V.'
        : 'Could not copy the report. Open Test log → Copy all, then paste it into the issue.')
    );
  }

  function showCardError(fromEl, message) {
    const actions = fromEl.closest('.actions');
    actions?.parentElement.querySelector('.card-error')?.remove();
    actions?.after(el('div', 'error card-error', message));
  }

  function button(text, cls, title, onClick) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function style() {
    const s = document.createElement('style');
    s.textContent = `
      :host { all: initial; }
      .panel { width: 400px; max-height: calc(100vh - 96px); overflow: auto; background: #fff; color: #181818;
        border: 1px solid #c9c9c9; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.18);
        font: 13px/1.4 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; padding: 12px; box-sizing: border-box; }
      .head { display: flex; justify-content: space-between; align-items: center; }
      .title { font-weight: 700; font-size: 15px; }
      .query { margin: 6px 0; font-style: italic; word-break: break-word; }
      .muted { color: #5c5c5c; font-size: 12px; margin: 2px 0; word-break: break-word; }
      .error { color: #ba0517; margin-top: 8px; }
      .warn { color: #8c4b02; background: #fef1e6; border-radius: 4px; padding: 4px 6px; font-size: 12px; margin-top: 6px; }
      .list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
      .card { border: 1px solid #e5e5e5; border-radius: 6px; padding: 8px 10px; }
      .card-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
      .card-title { font-weight: 600; margin-top: 4px; word-break: break-word; }
      .badge { font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 10px; color: #fff; }
      .b-label { background: #0b5cab; } .b-rename { background: #2e844a; } .b-workbench { background: #7526e3; }
      .b-none { background: #747474; } .b-override { background: #a43ec0; } .b-data { background: #0d7d8c; } .b-context { background: #a96404; }
      .conf { font-size: 11px; color: #5c5c5c; } .conf.exact { color: #2e844a; font-weight: 600; }
      .card-confirmed { border: 2px solid #2e844a; background: #f3faf5; box-shadow: 0 0 0 3px rgba(46,132,74,.15); }
      .conf.confirmed { font-size: 12px; font-weight: 700; color: #fff; background: #2e844a; padding: 2px 8px; border-radius: 10px; }
      .conf.confirmed::before { content: '\\2713  '; }
      .card-confirmed-none { border: 2px solid #dd7a01; background: #fef6ec; box-shadow: 0 0 0 3px rgba(221,122,1,.15); }
      .conf.confirmed-none { font-size: 12px; font-weight: 700; color: #fff; background: #747474; padding: 2px 8px; border-radius: 10px; }
      .steps { margin: 6px 0 4px 18px; padding: 0; } .steps li { margin: 1px 0; }
      .notes { margin: 4px 0 0 16px; padding: 0; color: #5c5c5c; font-size: 12px; }
      .actions { display: flex; gap: 6px; margin-top: 6px; }
      .btn { background: #0176d3; color: #fff; border: 0; border-radius: 4px; padding: 4px 10px; font: inherit; font-size: 12px;
        cursor: pointer; text-decoration: none; }
      .btn.secondary { background: #fff; color: #0176d3; border: 1px solid #c9c9c9; }
      .icon { background: none; border: 0; font-size: 20px; cursor: pointer; color: #5c5c5c; line-height: 1; }
      .lang { display: flex; align-items: center; gap: 6px; font-size: 12px; margin: 4px 0; }
      .lang-select { font: inherit; font-size: 12px; padding: 2px; max-width: 240px; }
      .foot { margin-top: 8px; text-align: right; }
      .link { background: none; border: 0; color: #0176d3; cursor: pointer; font: inherit; font-size: 12px; padding: 0; }
    `;
    return s;
  }

  // ---------- auto-fill after "Go to translation" ----------
  // background.js stores a pending target for the new tab. The Setup page loads in an
  // iframe; when that frame's page matches, pick the dropdowns and highlight the row.
  // Nothing is ever saved: the user types the translation and clicks Save.

  const AUTOFILL_PAGES = /^\/(i18n\/(TranslationWorkbench|LabelWorkbenchOverride)\.apexp|_ui\/common\/i18n\/RenameTabStageManager|ui\/setup\/RenameTabPage|01j\/e|lightning\/r\/)/;
  if (AUTOFILL_PAGES.test(location.pathname)) {
    chrome.runtime.sendMessage({ type: 'sftl:pending' }, (p) => {
      if (chrome.runtime.lastError || !p) return;
      logEvent('info', 'auto-fill', `Started ${p.page}${p.componentLabel ? ' / ' + p.componentLabel : ''}${p.object ? ' / ' + p.object : ''}`, {
        lang: p.lang, rows: p.rows, package: p.package, hidden: document.hidden,
      });
      let hiddenDuringRun = document.hidden;
      const onVis = () => document.hidden && (hiddenDuringRun = true);
      document.addEventListener('visibilitychange', onVis);
      const attempt = () => runAutofill(p);
      attempt()
        .catch(async (e) => {
          // You switched tabs while it ran: wait until you are back, then try once more.
          if (!hiddenDuringRun) throw e;
          logEvent('warn', 'auto-fill', `Failed while the tab was in the background (${e.message}). Retrying when you return.`);
          await whenVisible();
          return attempt();
        })
        .catch((e) => {
          toast(`Auto-fill stopped: ${e.message}`, true, false);
          logEvent('error', 'auto-fill', `Stopped: ${e.message}`, { page: p.page, component: p.componentLabel, object: p.object, rows: p.rows, lang: p.lang }, e.stack);
          finish();
        })
        .finally(() => document.removeEventListener('visibilitychange', onVis));
    });
  }

  // Read lastError in every callback so Chrome does not list "Unchecked runtime.lastError" under Errors.
  const quietSend = (msg) =>
    new Promise((res) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? null : r));
      } catch {
        res(null);
      }
    });
  const patch = (obj) => quietSend({ type: 'sftl:pendingUpdate', patch: obj });
  const finish = () => quietSend({ type: 'sftl:pendingUpdate', done: true });
  const norm = (s) => String(s ?? '').replace(/[\s ]+/g, ' ').trim().replace(/^\*\s*/, '').toLowerCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function runAutofill(p) {
    const path = location.pathname;
    if (p.page === 'workbench' && /^\/i18n\/(TranslationWorkbench|LabelWorkbenchOverride)/.test(path)) return fillWorkbench(p);
    if (p.page === 'dataTranslation' && path.startsWith('/lightning/r/') && window.top === window) return fillDataTranslation(p);
    if (p.page === 'labelNew' && path.startsWith('/01j/e')) return fillLabelNew(p);
    if (p.page === 'renameHome' && path.startsWith('/ui/setup/RenameTabPage')) return fillRenameHome(p);
    if (path.startsWith('/_ui/common/i18n/RenameTabStageManager')) return fillRenameStage(p);
  }

  async function fillLabelNew(p) {
    const sel = await waitFor(() => document.getElementById('Language'), 8000);
    const ok = setSelect(sel, [p.lang]);
    if (ok) sel.dispatchEvent(new Event('change', { bubbles: true }));
    const value = document.getElementById('Value');
    if (value) mark(value, true);
    toast(ok ? `Language set to ${p.lang}. Type the translation, then Save.` : `${p.lang} is not an active language here. Pick one, then Save.`, !ok);
    finish();
  }

  async function fillRenameHome(p) {
    const sel = document.getElementById('l');
    if (sel && p.lang && sel.value !== p.lang) {
      if (p.langTried || ![...sel.options].some((o) => o.value === p.lang)) {
        toast(`Language ${p.lang} is not available on this page. Pick it manually.`, true);
        return finish();
      }
      await patch({ langTried: true });
      sel.value = p.lang;
      sel.dispatchEvent(new Event('change', { bubbles: true })); // page reloads in the new language
      return;
    }
    const want = norm(p.tabLabel);
    const link = [...document.querySelectorAll('a')]
      .filter((a) => /^edit$/i.test(a.textContent.trim()))
      .find((a) => [...(a.closest('tr')?.cells || [])].some((c) => norm(c.innerText) === want));
    const id = link && /RenameTabStageManager\?id=([^&']+)/.exec(decodeURIComponent(link.getAttribute('href') || ''))?.[1];
    if (!id) {
      toast(`Could not find the "${p.tabLabel}" row. Custom objects only show in a non-default language.`, true);
      return finish();
    }
    await patch({ page: 'renameStage' });
    location.href = `/_ui/common/i18n/RenameTabStageManager?id=${encodeURIComponent(id)}&l=${encodeURIComponent(p.lang)}&setupid=RenameTab&isdtp=p1`;
  }

  async function fillRenameStage(p) {
    const stage = document.querySelector('input[name=currentStage]')?.value;
    if (!p.fieldLabel) {
      // Step 1 inputs (checked live, Nov 2026): val___0 Singular, val___1 Plural. The page header can have its
      // own text inputs (search), so never take "the first input".
      const byLabel = (re) => [...document.querySelectorAll('input[type=text]')].find((i) => re.test(document.querySelector(`label[for="${i.id}"]`)?.innerText || ''));
      // German (checked live, a3-13): one input per case, val___0-n / val___1-n (nominative) / -a / -g / -d.
      const byId = (i) => document.getElementById(`val___${i}`) || document.getElementById(`val___${i}-n`);
      const input = p.plural ? byId(1) || byLabel(/plural/i) : byId(0) || byLabel(/singular/i);
      if (input) {
        mark(input.closest('tr') || input, false);
        focusInput(input);
      }
      toast(`Change the ${p.plural ? 'Plural' : 'Singular'} name${input ? ' (marked)' : ''}, then Save.`);
      return finish();
    }
    if (stage === '0') {
      if (p.nextClicked) {
        toast('Could not open Step 2. Click Next yourself.', true);
        return finish();
      }
      await patch({ nextClicked: true });
      document.querySelector('input[name=goNext]')?.click(); // moves to Step 2, saves nothing
      return;
    }
    const inputs = [...document.querySelectorAll('input[type=text]')];
    const firstCell = (i) => norm(i.closest('tr')?.cells[0]?.innerText);
    // Row = <th>master label</th><td><input value="current translation"></td>…gender options.
    // Try the label first, then the API name (Lead.Name is "Full Name" in the API, "Name" here), then
    // the other candidates from locator.js: the first column is the Salesforce master label, so a renamed
    // label ("Billing Address/Account Address") is found by its parts or its API name in words.
    const wants = [...new Set((p.candidates?.length ? p.candidates : [p.fieldLabel, p.fieldName]).filter(Boolean).map(norm))];
    let input = wants.reduce(
      (found, want) => found || inputs.find((i) => firstCell(i) === want) || inputs.find((i) => norm(i.value) === want),
      null
    );
    // Last resort: a row whose master label starts the wanted label at a word break ("billing address" in
    // "billing address/account address"); the longest such label wins.
    if (!input) {
      const label = norm(p.fieldLabel);
      input = inputs
        .filter((i) => {
          const c = firstCell(i);
          return c.length >= 4 && label.startsWith(c) && !/[\p{L}\p{N}]/u.test(label[c.length] || ' ');
        })
        .sort((a, b) => firstCell(b).length - firstCell(a).length)[0] || null;
    }
    if (!input) {
      toast(`Could not find the "${p.fieldLabel}" field on Step 2. Look for it in the list.`, true);
      return finish();
    }
    mark(input.closest('tr') || input, false);
    focusInput(input);
    toast(`Found "${p.fieldLabel}". Change it, then Save.`);
    finish();
  }

  /**
   * Focus and select an input, and again after the classic page's own onload focus (setFocusOnLoad
   * moves focus to the first input, e.g. "Action Visibility", after this script ran). Stops once the
   * user has moved focus somewhere else themselves.
   */
  function focusInput(input) {
    const go = () => {
      input.focus();
      input.select?.();
    };
    go();
    let userActed = false;
    const acted = () => (userActed = true);
    document.addEventListener('mousedown', acted, { once: true, capture: true });
    document.addEventListener('keydown', acted, { once: true, capture: true });
    const again = () => !userActed && document.activeElement !== input && go();
    for (const ms of [400, 1200, 2500]) setTimeout(again, ms);
    if (document.readyState !== 'complete') window.addEventListener('load', () => setTimeout(again, 100), { once: true });
  }

  async function fillWorkbench(p) {
    const q = (sfx) => document.querySelector(`select[id$="${sfx}"]`);
    await waitFor(() => q('setupEntSelect'), 10000);
    const warnings = [];

    // Override page only: package options look like "acme:Acme App" (namespace:Package Name)
    if (p.package) {
      const pk = q('packageSelect');
      const matches = pk ? [...pk.options].filter((o) => o.value.split(':')[0].toLowerCase() === p.package.toLowerCase()) : [];
      const opt = matches[0];
      if (!opt) throw new Error(`Package "${p.package}" is not listed on the Override page.`);
      // Two packages can share one namespace (seen live).
      if (matches.length > 1) warnings.push(`${matches.length} packages use "${p.package}". Picked "${opt.text.trim()}"; if the row is missing, pick the other one.`);
      if (pk.value !== opt.value) {
        pk.value = opt.value;
        pk.dispatchEvent(new Event('change', { bubbles: true }));
        await quiet();
      }
    }

    if (p.lang && !(await choose(q, 'langSelect', [p.lang]))) {
      warnings.push(`You are not a translator for ${p.lang}. Add it in Translation Language Settings, or pick another language.`);
    }
    if (!(await choose(q, 'setupEntSelect', [p.component], [p.componentLabel]))) {
      throw new Error(`Setup Component "${p.componentLabel}" is not in this org's list.`);
    }
    if (p.object) {
      await waitFor(() => q('assocEntSelect') && q('assocEntSelect').options.length > 1, 8000).catch(() => null);
      if (!(await choose(q, 'assocEntSelect', [p.object], [p.objectLabel]))) {
        warnings.push(`Object "${p.objectLabel || p.object}" is not listed for ${p.componentLabel}.`);
      }
    }
    // Action: a "Quick Action Selection" list appears after the object (checked live, Nov 2026). Its option values
    // are 09D Ids that do not equal the Tooling QuickActionDefinition Ids, and labels can repeat
    // (the same label twice), so pick by label and say when there is more than one.
    if (p.component === 'QuickActionDefinition' && p.rows?.[0]) {
      const qa = await waitFor(() => q('quickActionSelect'), 5000).catch(() => null);
      if (qa) {
        const want = norm(p.rows[0]);
        const opts = [...qa.options].filter((o) => norm(o.text) === want);
        if (!opts.length) warnings.push(`Action "${p.rows[0]}" is not in the Quick Action Selection list for ${p.objectLabel || 'this object'}.`);
        else {
          if (!opts.some((o) => o.value === qa.value)) {
            qa.value = opts[0].value;
            qa.dispatchEvent(new Event('change', { bubbles: true }));
            await quiet();
          }
          if (opts.length > 1) warnings.push(`${opts.length} actions are named "${p.rows[0]}". Picked the first in Quick Action Selection; the other is in the same list.`);
        }
      }
    }
    if (p.aspect) {
      await waitFor(() => q('aspectSelect') && !q('aspectSelect').disabled, 5000).catch(() => null);
      await choose(q, 'aspectSelect', [p.aspect]);
    }

    // Most components show a grid; Picklist Value shows a tree (field node → values).
    await waitFor(() => document.querySelector('.x-grid3-row, li.x-tree-node'), 10000).catch(() => null);
    const isTree = !!document.querySelector('li.x-tree-node') && !document.querySelector('.x-grid3-row');
    let row = null;
    if (p.rows?.length && isTree && !p.parent) {
      // Layout Section (layout → sections): one section name can sit in several layouts.
      const hits = await findInEveryNode(p.rows);
      row = hits[0]?.row || null;
      if (hits.length > 1) warnings.push(`Also in: ${hits.slice(1).map((h) => h.place).join(', ')}. Each layout has its own copy, so translate each one.`);
    } else if (p.rows?.length) {
      row = isTree ? await findTreeRow(p.parent ? [p.parent] : [], p.rows) : await findGridRow(p.rows, p.rowMatch === 'richText' ? richTextMatcher(p.rows) : null);
    }
    const shown = (r) => {
      const t = (r.querySelector('.x-grid3-col-masterLabel, .x-tree-node-anchor')?.innerText || p.rows[0]).trim();
      return p.rowMatch === 'richText' ? p.rowLabel || t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : t;
    };
    if (row) {
      mark(row, false);
      const cell = row.querySelector('.x-grid3-td-translation .x-grid3-cell-inner, .x-grid3-td-translation, .x-tree-col.translation');
      if (cell) {
        for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
          cell.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      }
      toast(`Found "${shown(row)}". Type the translation, then Save.${warnings.length ? ' ' + warnings.join(' ') : ''}`, warnings.length > 0);
    } else {
      toast(`Filters are set. ${p.rows?.length ? `Row "${p.rowLabel || p.rows[0]}" was not found; scroll to it.` : 'Pick the row in the list.'} ${warnings.join(' ')}`, true);
    }
    finish();
  }

  /** Record page: click the "Translation" tab that Data Translation adds. */
  async function fillDataTranslation() {
    const isTab = (e) => e.getAttribute('role') === 'tab' || e.getAttribute('data-tab-value') !== null;
    const tab = await waitFor(
      () => deepFind((e) => isTab(e) && /^translations?$/i.test((e.textContent || '').trim())),
      15000
    ).catch(() => null);
    if (!tab) {
      toast('No "Translations" tab on this record page. An admin adds it in Lightning App Builder. Or use Workbench Export/Import (Data).', true);
      return finish();
    }
    tab.click();
    toast('Opened the Translations tab. Add or edit the row for your language, then Save.');
    finish();
  }

  /** querySelector that also looks inside shadow roots (Lightning components). */
  function deepFind(pred, root = document) {
    for (const e of root.querySelectorAll('*')) {
      if (pred(e)) return e;
      if (e.shadowRoot) {
        const hit = deepFind(pred, e.shadowRoot);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** Sets a <select> by option value, else by visible text. Waits for the page to update. */
  async function choose(q, suffix, values, labels = []) {
    const sel = q(suffix);
    if (!sel) return false;
    if (values.includes(sel.value)) return true;
    if (!setSelect(sel, values, labels)) return false;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await quiet();
    return true;
  }

  function setSelect(sel, values, labels = []) {
    if (!sel) return false;
    const wantLabels = labels.filter(Boolean).map(norm);
    const opt = [...sel.options].find((o) => values.includes(o.value)) || [...sel.options].find((o) => wantLabels.includes(norm(o.text)));
    if (!opt) return false;
    sel.value = opt.value;
    return true;
  }

  /** Picklist Value tree: expand the field's node, then find the value under it. Verified in a real org (Nov 2026). */
  async function findTreeRow(parents, candidates) {
    const want = candidates.filter(Boolean).map(norm);
    const pw = parents.filter(Boolean).map(norm);
    const label = (li) => norm(li.querySelector(':scope > .x-tree-node-el .x-tree-node-anchor')?.innerText);
    const nodes = () => [...document.querySelectorAll('li.x-tree-node')];
    // Two fields can share a label (e.g. standard and custom "Account Type"): try each.
    const parentNodes = nodes().filter((li) => pw.includes(label(li)));
    for (const li of parentNodes) {
      const el = li.querySelector(':scope > .x-tree-node-el');
      if (el?.classList.contains('x-tree-node-collapsed')) {
        li.querySelector(':scope > .x-tree-node-el .x-tree-ec-icon')?.dispatchEvent(new MouseEvent('click', { bubbles: true, view: window }));
        await waitFor(() => li.querySelector('li.x-tree-node'), 5000).catch(() => null);
      }
      const hit = [...li.querySelectorAll('li.x-tree-node')].find((k) => want.includes(label(k)));
      if (hit) return hit.querySelector(':scope > .x-tree-node-el');
    }
    // No field given or not found under it: a value already visible anywhere.
    const any = nodes().find((li) => want.includes(label(li)) && !pw.includes(label(li)));
    if (!any) logEvent('warn', 'auto-fill', 'Picklist value not found in the tree', { field: parents, looking_for: candidates, fieldNodes: parentNodes.length });
    return any ? any.querySelector(':scope > .x-tree-node-el') : null;
  }

  /**
   * Layout Section tree (layout → sections), parent unknown: open each layout and collect every
   * match. A closed node's children are not on the page, so a search of what is visible stops at
   * whichever layout happens to be open (bug: a section under a closed layout missed).
   * Returns [{ row, place }], first match first.
   */
  async function findInEveryNode(candidates) {
    const want = candidates.filter(Boolean).map(norm);
    const anchor = (li) => (li.querySelector(':scope > .x-tree-node-el .x-tree-node-anchor')?.innerText || '').trim();
    const nodeEl = (li) => li.querySelector(':scope > .x-tree-node-el');
    const isClosed = (li) => nodeEl(li)?.classList.contains('x-tree-node-collapsed');
    const toggle = (li) => li.querySelector(':scope > .x-tree-node-el .x-tree-ec-icon')?.dispatchEvent(new MouseEvent('click', { bubbles: true, view: window }));
    const tops = [...document.querySelectorAll('li.x-tree-node')].filter((li) => !li.parentElement?.closest('li.x-tree-node'));
    const hits = [];
    const stopAt = Date.now() + 60000; // ponytail: 60 s budget; a layout list longer than that gets a partial search
    for (const li of tops) {
      if (Date.now() > stopAt) break;
      const opened = isClosed(li);
      if (opened) {
        toggle(li);
        // Done once it is no longer closed (an empty layout turns into a leaf, with no children).
        await waitFor(() => !isClosed(li) && !nodeEl(li).classList.contains('x-tree-node-loading'), 4000).catch(() => null);
      }
      const hit = [...li.querySelectorAll('li.x-tree-node')].find((k) => want.includes(norm(anchor(k))));
      if (hit) hits.push({ row: nodeEl(hit), place: anchor(li) });
      else if (opened) toggle(li); // close layouts opened for nothing, so the list stays short
    }
    if (!hits.length) logEvent('warn', 'auto-fill', 'Section not found in any layout', { looking_for: candidates, layouts: tops.length });
    else if (hits.length > 1) logEvent('info', 'auto-fill', `Section found in ${hits.length} layouts`, { looking_for: candidates, layouts: hits.map((h) => h.place) });
    return hits;
  }

  /**
   * Path Step Rich Text: the master cell shows the guidance as raw HTML (checked live: it equals Info exactly).
   * Fallback when the exact compare misses: compare the text without tags, entities and spaces, and
   * accept a prefix either way (a cut-off cell, or a shortened candidate). Returns a row scorer.
   */
  function richTextMatcher(candidates) {
    // Same entity rules as htmlLines() in locator.js (no innerHTML: Salesforce pages may enforce Trusted Types).
    const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    const decode = (s) =>
      s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
        e[0] === '#' ? cp(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1)), m) : ENT[e.toLowerCase()] ?? m
      );
    const cp = (n, m) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m);
    const key = (s) =>
      decode(String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/<[^>]*$/, ' '))
        .replace(/(\.\.\.|…)\s*$/, '')
        .replace(/[\s\u200B-\u200D\uFEFF]+/g, '')
        .toLowerCase();
    const want = candidates.filter(Boolean).map(key).filter(Boolean);
    return (row) => {
      const c = key(row.querySelector('.x-grid3-col-masterLabel')?.innerText);
      if (!c) return 0;
      if (want.includes(c)) return 3;
      if (c.length >= 12 && want.some((w) => w.startsWith(c))) return 2;
      if (want.some((w) => w.length >= 12 && c.startsWith(w))) return 1;
      return 0;
    };
  }

  async function findGridRow(candidates, scorer = null) {
    const want = candidates.filter(Boolean).map(norm);
    await waitFor(() => document.querySelector('.x-grid3-row'), 10000).catch(() => null);
    const bestBy = (rows) => {
      let top = null;
      let topScore = 0;
      for (const r of rows) {
        const s = scorer(r);
        if (s > topScore) [top, topScore] = [r, s];
      }
      return top;
    };
    for (let page = 0; page < 40; page++) {
      const rows = [...document.querySelectorAll('.x-grid3-row')];
      const hit =
        rows.find((r) => want.includes(norm(r.querySelector('.x-grid3-col-masterLabel')?.innerText))) ||
        rows.find((r) => [...r.querySelectorAll('.x-grid3-cell-inner')].some((c) => want.includes(norm(c.innerText)))) ||
        (scorer && bestBy(rows));
      if (hit) return hit;
      // Workbench pager: <table id="nextBtn" class="x-btn ..."><button>. Verified in a grid of several pages (Nov 2026).
      const nextWrap = document.querySelector('#nextBtn') || document.querySelector('.x-tbar-page-next')?.closest('table');
      const next = nextWrap?.querySelector('button') || nextWrap;
      if (!next || next.disabled || nextWrap.classList.contains('x-item-disabled')) {
        logEvent('warn', 'auto-fill', `Row not found after ${page + 1} grid page(s)`, { looking_for: candidates, pager: !!nextWrap });
        return null;
      }
      const firstLabel = () => document.querySelector('.x-grid3-col-masterLabel')?.innerText;
      const before = firstLabel();
      next.click();
      await waitFor(() => firstLabel() !== before, 8000).catch(() => null);
      await quiet();
    }
    return null;
  }

  // Chrome slows timers in background tabs and Salesforce may not render there.
  // Time spent hidden does not count toward a timeout, so switching tabs never aborts a step.
  function waitFor(fn, timeout = 8000) {
    return new Promise((resolve, reject) => {
      let elapsed = 0;
      let last = Date.now();
      (function tick() {
        let v = null;
        try {
          v = fn();
        } catch {}
        if (v) return resolve(v);
        const now = Date.now();
        if (!document.hidden) elapsed += Math.min(now - last, 1000);
        last = now;
        if (elapsed > timeout) return reject(new Error('page did not finish loading'));
        setTimeout(tick, 200);
      })();
    });
  }

  function whenVisible() {
    if (!document.hidden) return Promise.resolve();
    return new Promise((resolve) => {
      const on = () => {
        if (document.hidden) return;
        document.removeEventListener('visibilitychange', on);
        resolve();
      };
      document.addEventListener('visibilitychange', on);
    });
  }

  /** Resolves once the page has had no DOM changes for `idle` ms (Visualforce AJAX finished). */
  function quiet(idle = 700, max = 10000) {
    return new Promise((resolve) => {
      let timer = setTimeout(done, idle);
      const stop = setTimeout(done, max);
      const obs = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, idle);
      });
      obs.observe(document.body, { subtree: true, childList: true, attributes: true });
      function done() {
        obs.disconnect();
        clearTimeout(timer);
        clearTimeout(stop);
        resolve();
      }
    });
  }

  function mark(node, focus) {
    node.style.outline = '3px solid #ff9a3c';
    node.style.outlineOffset = '1px';
    node.scrollIntoView({ block: 'center' });
    if (focus) node.focus?.();
  }

  function toast(message, warn = false, logIt = true) {
    if (logIt) logEvent(warn ? 'warn' : 'info', 'auto-fill', message);
    const t = document.createElement('div');
    t.textContent = `SF Translation Locator: ${message}`;
    t.style.cssText = `position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:560px;
      padding:8px 12px;border-radius:6px;font:13px/1.4 Arial,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.2);
      background:${warn ? '#fef1e6' : '#ebf7e6'};color:${warn ? '#8c4b02' : '#2e844a'};border:1px solid ${warn ? '#f4bc8d' : '#91db8b'}`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 9000);
  }
})();
