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
    const hints = { selectionNames: [], objectApiNames: [], tags: [], auraCustom: [], attrs: {} };
    const path = lastTarget && Date.now() - lastTarget.at < 60000 ? lastTarget.path : [];
    for (const el of path.slice(0, 60)) {
      const tag = el.tagName.toLowerCase();
      hints.tags.push(tag);
      const aura = el.getAttribute('data-aura-class');
      if (aura && /^c[A-Z]/.test(aura)) hints.auraCustom.push(aura);
      for (const a of HINT_ATTRS) {
        const v = el.getAttribute(a);
        if (!v) continue;
        if (a === 'data-target-selection-name' && v.startsWith('sfdc:')) hints.selectionNames.push(v);
        if (a === 'object-api-name') hints.objectApiNames.push(v);
        if (!(a in hints.attrs)) hints.attrs[a] = v.slice(0, 200);
      }
    }
    hints.selectionNames = [...new Set(hints.selectionNames)];
    hints.tags = [...new Set(hints.tags)];
    return { text: elementText(path), hints, url: location.href };
  }

  function elementText(path) {
    for (const el of path.slice(0, 6)) {
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

    if (p.droppedPartial) panel.append(el('div', 'muted', `${p.droppedPartial} weaker partial matches hidden.`));
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
      })
    );
    panel.append(foot);
    return panel;
  }

  function card(r) {
    const c = el('div', 'card');
    const top = el('div', 'card-top');
    top.append(el('span', `badge ${badgeClass(r.source)}`, r.source), el('span', `conf ${r.confidence}`, confidenceText(r.confidence)));
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
    return { confirmed: 'Confirmed by page', exact: 'Same text', partial: 'Similar text', context: 'From page area' }[c] || c;
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
      .conf { font-size: 11px; color: #5c5c5c; } .conf.confirmed, .conf.exact { color: #2e844a; font-weight: 600; }
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

  const patch = (obj) => new Promise((res) => chrome.runtime.sendMessage({ type: 'sftl:pendingUpdate', patch: obj }, res));
  const finish = () => chrome.runtime.sendMessage({ type: 'sftl:pendingUpdate', done: true });
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
      const singular = [...document.querySelectorAll('input[type=text]')][0];
      if (singular) mark(singular, true);
      toast('Change the Singular and Plural names, then Save.');
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
    // Row = <th>master label</th><td><input value="current translation"></td>…gender options.
    // Try the label first, then the API name (Lead.Name is "Full Name" in the API, "Name" here).
    const input = [p.fieldLabel, p.fieldName]
      .filter(Boolean)
      .map(norm)
      .reduce(
        (found, want) =>
          found || inputs.find((i) => norm(i.closest('tr')?.cells[0]?.innerText) === want) || inputs.find((i) => norm(i.value) === want),
        null
      );
    if (!input) {
      toast(`Could not find the "${p.fieldLabel}" field on Step 2. Look for it in the list.`, true);
      return finish();
    }
    mark(input.closest('tr') || input, false);
    input.focus();
    input.select();
    toast(`Found "${p.fieldLabel}". Change it, then Save.`);
    finish();
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
      // Seen in a real org: two packages share the "genesyscloud" namespace.
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
    if (p.aspect) {
      await waitFor(() => q('aspectSelect') && !q('aspectSelect').disabled, 5000).catch(() => null);
      await choose(q, 'aspectSelect', [p.aspect]);
    }

    // Most components show a grid; Picklist Value shows a tree (field node → values).
    await waitFor(() => document.querySelector('.x-grid3-row, li.x-tree-node'), 10000).catch(() => null);
    const isTree = !!document.querySelector('li.x-tree-node') && !document.querySelector('.x-grid3-row');
    const row = !p.rows?.length ? null : isTree ? await findTreeRow(p.parent ? [p.parent] : [], p.rows) : await findGridRow(p.rows);
    if (row) {
      mark(row, false);
      const cell = row.querySelector('.x-grid3-td-translation .x-grid3-cell-inner, .x-grid3-td-translation, .x-tree-col.translation');
      if (cell) {
        for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
          cell.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      }
      toast(`Found "${(row.querySelector('.x-grid3-col-masterLabel, .x-tree-node-anchor')?.innerText || p.rows[0]).trim()}". Type the translation, then Save.${warnings.length ? ' ' + warnings.join(' ') : ''}`, warnings.length > 0);
    } else {
      toast(`Filters are set. ${p.rows?.length ? `Row "${p.rows[0]}" was not found; scroll to it.` : 'Pick the row in the list.'} ${warnings.join(' ')}`, true);
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

  async function findGridRow(candidates) {
    const want = candidates.filter(Boolean).map(norm);
    await waitFor(() => document.querySelector('.x-grid3-row'), 10000).catch(() => null);
    for (let page = 0; page < 40; page++) {
      const rows = [...document.querySelectorAll('.x-grid3-row')];
      const hit =
        rows.find((r) => want.includes(norm(r.querySelector('.x-grid3-col-masterLabel')?.innerText))) ||
        rows.find((r) => [...r.querySelectorAll('.x-grid3-cell-inner')].some((c) => want.includes(norm(c.innerText))));
      if (hit) return hit;
      // Workbench pager: <table id="nextBtn" class="x-btn ..."><button>. Verified in a 238-row grid (Nov 2026).
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
