// Pure lookup logic: matches text against org metadata and decides which of the
// three translation places owns it. No chrome.* or network calls here, so it can
// be unit tested in Node.

export const SOURCE = {
  CUSTOM_LABEL: 'Custom Labels',
  RENAME_TABS: 'Rename Tabs and Labels',
  WORKBENCH: 'Translation Workbench',
  OVERRIDE: 'Workbench Override (package)',
  DATA: 'Data Translation (record data)',
  CUSTOM_OBJECT: 'Custom translation object',
  NOT_TRANSLATABLE: 'Not translatable as-is',
  CONTEXT: 'Page context',
};

const CONFIDENCE_RANK = { confirmed: 0, exact: 1, partial: 2, context: 3 };
const SOURCE_RANK = {
  [SOURCE.CUSTOM_LABEL]: 0,
  [SOURCE.DATA]: 1,
  [SOURCE.CUSTOM_OBJECT]: 1,
  [SOURCE.RENAME_TABS]: 2,
  [SOURCE.OVERRIDE]: 3,
  [SOURCE.WORKBENCH]: 4,
  [SOURCE.NOT_TRANSLATABLE]: 5,
  [SOURCE.CONTEXT]: 6,
};
const MAX_PARTIAL = 3;

export const SETUP = {
  customLabels: '/lightning/setup/ExternalStrings/home',
  customLabel: (id) => `/lightning/setup/ExternalStrings/page?address=${encodeURIComponent('/' + id)}`,
  renameTabs: '/lightning/setup/RenameTab/home',
  workbench: '/lightning/setup/LabelWorkbenchTranslate/home',
  override: '/lightning/setup/LabelWorkbenchOverride/home',
  companyInfo: '/lightning/setup/CompanyProfileInfo/home',
  record: (o, id) => `/lightning/r/${o}/${id}/view`,
  objectDetails: (o) => `/lightning/setup/ObjectManager/${o}/Details/view`,
  objectFields: (o) => `/lightning/setup/ObjectManager/${o}/FieldsAndRelationships/view`,
  appManager: '/lightning/setup/NavigationMenus/home',
  customTabs: '/lightning/setup/CustomTabs/home',
  flows: '/lightning/setup/Flows/home',
};

// ---------- "Go to translation" URLs ----------

/** Page to open plus what content.js should auto-fill there. Pure, so it is unit tested. */
export function buildGotoUrl(goto, lang, orgDefault) {
  if (goto.page === 'label') {
    const existingId = lang && goto.existing?.[lang];
    if (existingId) return { path: DEEP.labelEditTranslation(existingId), autofill: null };
    return { path: DEEP.labelNewTranslation(goto.labelId), autofill: lang && lang !== goto.masterLanguage ? { page: 'labelNew', lang } : null };
  }
  if (goto.page === 'rename') {
    const l = lang || orgDefault || 'en_US';
    // Standard objects open their Edit page directly. Custom objects only appear in a
    // non-default language, so start from the list and let content.js click Edit.
    if (goto.object && !goto.custom) {
      return { path: DEEP.renameEdit(goto.object, l), autofill: goto.fieldLabel ? { page: 'renameStage', lang: l, fieldLabel: goto.fieldLabel, fieldName: goto.fieldName || null } : null };
    }
    return { path: SETUP.renameTabs, autofill: { page: 'renameHome', lang: l, tabLabel: goto.tabLabel, fieldLabel: goto.fieldLabel || null, fieldName: goto.fieldName || null } };
  }
  if (goto.page === 'workbench' || goto.page === 'override') {
    return { path: goto.page === 'override' ? SETUP.override : SETUP.workbench, autofill: { ...goto, page: 'workbench', lang: lang || null } };
  }
  if (goto.page === 'dataTranslation') {
    return { path: SETUP.record(goto.object, goto.recordId), autofill: { page: 'dataTranslation', lang: lang || null } };
  }
  return null;
}

// ---------- text matching ----------

export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[\s ]+/g, ' ')
    .trim()
    .replace(/^[*\s]+/, '') // required-field asterisk
    .replace(/[\s:*]+$/, '') // trailing colon / asterisk
    .toLowerCase();
}

/** Returns 'exact', 'partial' or null. `needle` must already be normalized. */
export function matchType(needle, candidate) {
  const c = normalize(candidate);
  if (!c || !needle) return null;
  if (c === needle) return 'exact';
  if (needle.length >= 3 && c.includes(needle)) return 'partial';
  // Selected text contains the candidate, e.g. "Edit Industry" contains "Industry".
  if (c.length >= 4 && c.length / needle.length >= 0.4 && wordContains(needle, c)) return 'partial';
  return null;
}

function wordContains(haystack, word) {
  const i = haystack.indexOf(word);
  if (i < 0) return false;
  const before = i === 0 ? ' ' : haystack[i - 1];
  const after = i + word.length >= haystack.length ? ' ' : haystack[i + word.length];
  return !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after);
}

// ---------- page context ----------

export function parseSelectionName(s) {
  const m = /^sfdc:([A-Za-z]+)\.(.+)$/.exec(String(s || ''));
  if (!m) return null;
  const parts = m[2].split('.');
  return { kind: m[1], object: parts.length > 1 ? parts[0] : null, name: parts[parts.length - 1], raw: s };
}

const OBJECT_URL_PATTERNS = [
  /\/lightning\/[ro]\/([A-Za-z0-9_]+)\//,
  /\/lightning\/setup\/ObjectManager\/([A-Za-z0-9_]+)\//,
];

/** Object API names relevant to the click, most specific first. */
export function contextObjects(urls, hints = {}) {
  const out = [];
  const push = (o) => {
    if (o && /^[A-Za-z][A-Za-z0-9_]*$/.test(o) && !/^[a-zA-Z0-9]{15,18}$/.test(o) && !out.includes(o)) out.push(o);
  };
  for (const sn of hints.selectionNames || []) push(parseSelectionName(sn)?.object);
  for (const o of hints.objectApiNames || []) push(o);
  for (const url of urls.filter(Boolean)) {
    for (const re of OBJECT_URL_PATTERNS) push(re.exec(url)?.[1]);
  }
  return out.filter((o) => o !== 'home').slice(0, 3);
}

/** Turns raw tag names from the clicked element's path into named UI areas. */
export function detectAreas(hints = {}) {
  const tags = hints.tags || [];
  const has = (re) => tags.some((t) => re.test(t));
  const areas = new Set();
  if (has(/^one-app-nav-bar/)) areas.add('navTab');
  if (has(/layout-section$/) && !has(/layout-item$/)) areas.add('layoutSection');
  if (has(/^(flowruntime-|lightning-flow)/)) areas.add('flow');
  if (has(/^(flexipage-tab|lightning-tab-bar)/)) areas.add('lightningPageTab');
  if (has(/^(lst-related-list|force-related-list)/)) areas.add('relatedList');
  if (has(/(^lightning-path|pathassistant)/)) areas.add('path');
  const custom = tags.filter((t) => /^c-/.test(t));
  if (custom.length || (hints.auraCustom || []).length) areas.add('customComponent');
  return areas;
}

// ---------- language ----------

export function languageName(code) {
  if (!code) return null;
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'language' });
    return dn.of(code.replace('_', '-')) || code;
  } catch {
    return code;
  }
}

function languageStep(org) {
  const user = org.userLanguage;
  if (user && org.defaultLanguage && user !== org.defaultLanguage) {
    return `Language: ${languageName(user)} (the language you are viewing now)`;
  }
  return 'Language: the language you want to translate into';
}

function isDefaultLanguage(org) {
  return !org.userLanguage || !org.defaultLanguage || org.userLanguage === org.defaultLanguage;
}

// ---------- result builders ----------

// Translate page dropdown values, read from the live page (Setup Component and Aspect <select>s).
export const WB_COMPONENT = {
  'Custom Field': 'CustomFieldDefinition',
  'Standard Field Help': 'FieldAttributes',
  'Picklist Value': 'PicklistMaster',
  'Global Value Set': 'SharedPicklistDefinition',
  'Record Type': 'RecordType',
  Action: 'QuickActionDefinition',
  'Validation Error Message': 'ValidationFormula',
  App: 'TabSet',
  'Web Tab': 'CustomTabDefinition',
  'Button and Link Label': 'WebLink',
  'Layout Section': 'LayoutSection',
  Flow: 'FlowDefinition',
  'Custom Label': 'ExternalString',
  'Address Country': 'AddressCountry',
  'Address State': 'AddressState',
};
const WB_ASPECT = { 'Field Label': 'master', 'Help Text': 'help', 'Related List Label': 'relationshiplabel', Description: 'description' };

// Setup Components offered on Translation Workbench → Override (read from the live page).
// Picklist Value, Layout Section and App are NOT overridable, so they stay on Translate.
const OVERRIDE_COMPONENTS = new Set(['Action', 'Button and Link Label', 'Custom Field', 'Custom Label', 'Flow', 'Record Type', 'Validation Error Message', 'Web Tab']);

/** Namespace of a packaged API name: "acme__Region__c" → "acme", "Region__c" → null. */
export function namespaceOf(apiName) {
  const parts = String(apiName || '').split('.').pop().split('__');
  if (parts.length >= 3) return parts[0];
  if (parts.length === 2 && parts[0] && !/^(c|r|mdt|e|x|b|s|kav|share|history|feed|chn|dt)$/i.test(parts[1])) return parts[0];
  return null;
}

/** Translate page steps, or Override steps when the item comes from a package. */
function workbench(org, { component, object, objectLabel, aspect, row, rows, pkg, parent }) {
  const override = pkg && OVERRIDE_COMPONENTS.has(component);
  const steps = override
    ? ['Setup → Translation Workbench → Override', `Package: the one with namespace "${pkg}"`, languageStep(org), `Setup Component: ${component}`]
    : ['Setup → Translation Workbench → Translate', languageStep(org), `Setup Component: ${component}`];
  if (objectLabel) steps.push(`Object: ${objectLabel}`);
  if (aspect) steps.push(`Aspect: ${aspect}`);
  if (row) steps.push(`Find the row: ${row}`);
  const goto = {
    page: override ? 'override' : 'workbench',
    package: override ? pkg : null,
    component: WB_COMPONENT[component],
    componentLabel: component,
    object: object || null,
    objectLabel: objectLabel || null,
    aspect: WB_ASPECT[aspect] || null,
    rows: [...new Set((rows || [row]).filter(Boolean))],
    // Picklist Value is a tree on the Translate page: values sit under their field's node.
    parent: parent || null,
  };
  const out = { source: override ? SOURCE.OVERRIDE : SOURCE.WORKBENCH, steps, url: override ? SETUP.override : SETUP.workbench, goto };
  if (override) out.packageNote = `Comes from the "${pkg}" package. Package items are translated on the Override page, not Translate.`;
  else if (pkg) out.packageNote = `Comes from the "${pkg}" package. Override does not support ${component}, so use Translate; the package may lock it.`;
  return out;
}

const RENAME_EDIT = (objectName, lang) =>
  `/lightning/setup/RenameTab/page?address=${encodeURIComponent(
    `/_ui/common/i18n/RenameTabStageManager?id=${objectName}&l=${lang}&setupid=RenameTab`
  )}`;
export const DEEP = {
  renameEdit: RENAME_EDIT,
  labelNewTranslation: (labelId) => `/lightning/setup/ExternalStrings/page?address=${encodeURIComponent(`/01j/e?Parent=${labelId}`)}`,
  labelEditTranslation: (locId) => `/lightning/setup/ExternalStrings/page?address=${encodeURIComponent(`/${locId}/e`)}`,
};

function customLabelResult(org, label, confidence, translations, matchedLanguage) {
  const existing = (translations || []).map((t) => t.Language);
  const ns = label.NamespacePrefix ? `${label.NamespacePrefix}__` : '';
  const userLang = org.userLanguage;
  const hasUserLang = userLang && existing.includes(userLang);
  const notes = [];
  if (matchedLanguage) notes.push(`Matched the ${languageName(matchedLanguage)} translation, not the master value.`);
  notes.push(`Master value (${languageName(label.Language)}): "${truncate(label.Value, 120)}"`);
  notes.push(existing.length ? `Translated into: ${existing.map(languageName).join(', ')}` : 'No translations yet.');
  if (label.NamespacePrefix) notes.push(`Managed package label (${label.NamespacePrefix}). Your entry is an override.`);
  if (isDefaultLanguage(org)) notes.push('To change the master text itself, click Edit on the label.');
  return {
    key: `label:${label.Id}`,
    source: SOURCE.CUSTOM_LABEL,
    confidence,
    title: `Custom label ${ns}${label.Name}`,
    subtitle: label.MasterLabel && label.MasterLabel !== label.Name ? label.MasterLabel : '',
    steps: [
      'Setup → Custom Labels',
      `Open ${ns}${label.Name}`,
      'Related list: Local Translations / Overrides',
      hasUserLang ? `Edit the ${languageName(userLang)} row` : 'Click New and pick the language',
    ],
    url: SETUP.customLabel(label.Id),
    // existing: language → translation record Id, so the button can open Edit instead of New
    goto: {
      page: 'label',
      labelId: label.Id,
      masterLanguage: label.Language,
      existing: Object.fromEntries((translations || []).filter((t) => t.Id).map((t) => [t.Language, t.Id])),
    },
    copy: `$Label.${label.NamespacePrefix || 'c'}.${label.Name}`,
    notes,
  };
}

function renameSteps(org, { custom, tabLabel }) {
  return [
    'Setup → Rename Tabs and Labels',
    `Select Language: ${languageStep(org).replace(/^Language: /, '')}`,
    `In the ${custom ? 'Custom Tabs' : 'Standard Tabs'} list, find the "${tabLabel}" row and click Edit`,
  ];
}

function objectResult(org, obj, confidence, plural, tab) {
  const notes = [];
  if (obj.custom && isDefaultLanguage(org)) {
    notes.push(`Master label (default language): Object Manager → ${obj.label} → Edit.`);
  }
  return {
    key: `object:${obj.name}`,
    source: SOURCE.RENAME_TABS,
    confidence,
    title: `${obj.custom ? 'Custom' : 'Standard'} object name: ${obj.label}`,
    subtitle: `API name ${obj.name}`,
    steps: [
      ...renameSteps(org, { custom: obj.custom, tabLabel: tab?.Label || obj.labelPlural }),
      `Step 1 page: change the ${plural ? 'Plural' : 'Singular'} name, then Save`,
    ],
    url: SETUP.renameTabs,
    goto: { page: 'rename', object: obj.name, custom: obj.custom, tabLabel: tab?.Label || obj.labelPlural },
    copy: obj.name,
    notes,
  };
}

function fieldLabelResult(org, d, f, confidence) {
  if (!f.custom) {
    return {
      key: `field:${d.name}.${f.name}`,
      source: SOURCE.RENAME_TABS,
      confidence,
      title: `Standard field label: ${d.label} → ${f.label}`,
      subtitle: `API name ${d.name}.${f.name}`,
      steps: [
        ...renameSteps(org, { custom: false, tabLabel: d.labelPlural || d.label }),
        'On the Step 1 page, click Next (do not change anything)',
        `Step 2 page: find "${f.label}", change it, then Save`,
      ],
      url: SETUP.renameTabs,
      goto: { page: 'rename', object: d.name, custom: d.custom, tabLabel: d.labelPlural || d.label, fieldLabel: f.label, fieldName: f.name },
      copy: `${d.name}.${f.name}`,
      notes: [],
    };
  }
  const notes = [];
  if (isDefaultLanguage(org)) notes.push(`Master label (default language): Object Manager → ${d.label} → Fields → ${f.label} → Edit.`);
  if (f.type === 'reference') notes.push('Related list title for this lookup: same screen, Aspect "Related List Label".');
  return {
    key: `field:${d.name}.${f.name}`,
    source: SOURCE.WORKBENCH,
    confidence,
    title: `Custom field label: ${d.name}.${f.name}`,
    subtitle: `"${f.label}"`,
    ...workbench(org, { component: 'Custom Field', object: d.name, objectLabel: d.label, aspect: 'Field Label', row: f.label, pkg: namespaceOf(f.name) }),
    copy: `${d.name}.${f.name}`,
    notes,
  };
}

function helpTextResult(org, d, f, confidence) {
  const base = f.custom
    ? workbench(org, { component: 'Custom Field', object: d.name, objectLabel: d.label, aspect: 'Help Text', row: f.label, pkg: namespaceOf(f.name) })
    : workbench(org, { component: 'Standard Field Help', object: d.name, objectLabel: d.label, row: f.label });
  return {
    key: `help:${d.name}.${f.name}`,
    confidence,
    title: `Help text for ${d.name}.${f.name}`,
    subtitle: `"${truncate(f.inlineHelpText, 80)}"`,
    ...base,
    copy: `${d.name}.${f.name}`,
    notes: isDefaultLanguage(org) ? [`Master text: Object Manager → ${d.label} → Fields → ${f.label} → Edit.`] : [],
  };
}

function picklistResult(org, d, f, pv, confidence) {
  // State and Country/Territory picklists (BillingCountryCode, MailingStateCode...) have their own components.
  const address = /CountryCode$/.test(f.name) ? 'Address Country' : /StateCode$/.test(f.name) ? 'Address State' : null;
  if (address) {
    return {
      key: `address:${address}.${pv.value}`,
      confidence,
      title: `${address === 'Address Country' ? 'Country/territory' : 'State/province'} name`,
      subtitle: `"${pv.label}" (code: ${pv.value})`,
      ...workbench(org, { component: address, row: pv.label, rows: [pv.label, pv.value] }),
      copy: pv.value,
      notes: ['One translation for the whole org: it applies to every address field.', 'Master name: Setup → State and Country/Territory Picklists.'],
    };
  }
  const notes = ['If the field uses a Global Value Set, pick Setup Component "Global Value Set" instead.'];
  if (!pv.active) notes.push('This value is inactive.');
  if (isDefaultLanguage(org)) notes.push(`Master label: Object Manager → ${d.label} → Fields → ${f.label} → Values → Edit.`);
  return {
    key: `picklist:${d.name}.${f.name}.${pv.value}`,
    confidence,
    title: `Picklist value on ${d.name}.${f.name}`,
    subtitle: `"${pv.label}" (API value: ${pv.value})`,
    ...workbench(org, { component: 'Picklist Value', object: d.name, objectLabel: d.label, row: `${pv.label} (field: ${f.label})`, rows: [pv.label, pv.value], pkg: namespaceOf(f.name), parent: f.label }),
    copy: pv.value,
    notes,
  };
}

// Standard fields Data Translation supports out of the box (Salesforce Help: "Enable Data Translation").
const DATA_TRANSLATION_FIELDS = { Product2: ['Name', 'Description'], ProductCategory: ['Name', 'Description'] };

function dataResult(org, dt, f, confidence, row) {
  const notes = [];
  if (row?.Language) notes.push(`Matched the existing ${languageName(row.Language)} translation.`);
  if (dt.recordId) {
    const langs = [...new Set(dt.rows.map((r) => r.Language).filter(Boolean))];
    notes.push(langs.length ? `This record is translated into: ${langs.map(languageName).join(', ')}.` : 'This record has no translations yet.');
  }
  notes.push('No Translations tab on the record? An admin adds it to the record page in Lightning App Builder.');
  if (f.name !== 'Name') notes.push('Translate Name first. Other fields need a Name translation for that language.');
  notes.push('Bulk option: Translation Workbench → Export / Import with Translation Type "Data". Uses data storage.');
  return {
    key: `data:${dt.object}.${f.name}`,
    source: SOURCE.DATA,
    confidence,
    title: `Record data: ${dt.object} ${f.label}`,
    subtitle: 'This is a value on the record, not a label',
    steps: [
      dt.recordId ? 'Open this record' : `Open the ${dt.object} record`,
      'Click its Translations tab',
      `Add or edit the row for ${languageStep(org).replace(/^Language: /, '')}`,
      `Fill in ${f.label}, then Save`,
    ],
    url: dt.recordId ? SETUP.record(dt.object, dt.recordId) : null,
    goto: dt.recordId ? { page: 'dataTranslation', object: dt.object, recordId: dt.recordId } : undefined,
    copy: f.name,
    notes,
  };
}

function dataOffResult(object, fieldName) {
  return {
    key: `data:${object}.${fieldName}`,
    source: SOURCE.DATA,
    confidence: 'context',
    title: `Record data: ${object} ${fieldName}`,
    subtitle: 'Data Translation is turned off in this org',
    steps: [
      'This is a value on the record, not a label.',
      'Data Translation can translate it, but it is off.',
      'To turn it on: Setup → Company Information → Edit → Enable Data Translation → Save.',
      'Then use the Translation tab on the record.',
    ],
    url: SETUP.companyInfo,
    notes: ['Needs the Modify All Data permission. Translations count against data storage.'],
  };
}

/** An org-built translation object (e.g. Demo_Translations__c) linked to the record. */
function customTranslationResult(d, child, record) {
  const url = record?.id && record.object === d.name ? `/lightning/r/${d.name}/${record.id}/related/${child.relationship}/view` : null;
  return {
    key: `customtr:${d.name}.${child.object}`,
    source: SOURCE.CUSTOM_OBJECT,
    confidence: 'context',
    title: `Your org's own translation object: ${child.label || child.object}`,
    subtitle: `${child.object}, linked to ${d.label}`,
    steps: [
      url ? 'Open this record' : `Open the ${d.label} record`,
      `Find the "${child.label || child.object}" related list`,
      'Add or edit the row for your language',
    ],
    url,
    copy: child.object,
    notes: ['Built by your org or an app, not a Salesforce translation feature. Ask your admin which one your team uses.'],
  };
}

function recordTypeResult(org, d, rt, confidence) {
  return {
    key: `rt:${d.name}.${rt.developerName}`,
    confidence,
    title: `Record type ${d.name}.${rt.developerName}`,
    subtitle: `"${rt.name}"`,
    ...workbench(org, { component: 'Record Type', object: d.name, objectLabel: d.label, aspect: 'Field Label', row: rt.name }),
    copy: rt.developerName,
    notes: [],
  };
}

function quickActionResult(org, object, objectLabel, qa, confidence) {
  return {
    key: `qa:${qa.name}`,
    confidence,
    title: `Quick action ${qa.name}`,
    subtitle: qa.label ? `"${qa.label}"` : '',
    ...workbench(org, { component: 'Action', object, objectLabel, aspect: 'Field Label', row: qa.label || qa.name, rows: [qa.label, qa.name.split('.').pop()], pkg: namespaceOf(qa.name) }),
    copy: qa.name,
    notes: [],
  };
}

function validationResult(org, vr, confidence, objLabel) {
  const obj = vr.EntityDefinition?.QualifiedApiName || '';
  return {
    key: `vr:${vr.Id}`,
    confidence,
    title: `Validation rule ${obj ? obj + '.' : ''}${vr.ValidationName}`,
    subtitle: `"${truncate(vr.ErrorMessage, 100)}"`,
    ...workbench(org, { component: 'Validation Error Message', object: obj, objectLabel: objLabel || obj, row: vr.ValidationName, rows: [vr.ValidationName, vr.ErrorMessage], pkg: vr.NamespacePrefix || null }),
    copy: vr.ValidationName,
    notes: [],
  };
}

function tabResult(org, tab, confidence) {
  if (!tab.IsCustom) {
    return {
      key: `tab:${tab.Name}`,
      source: SOURCE.RENAME_TABS,
      confidence,
      title: `Standard tab ${tab.Name}`,
      subtitle: `"${tab.Label}"`,
      steps: [...renameSteps(org, { custom: false, tabLabel: tab.Label }), 'Change the name, then Save'],
      url: SETUP.renameTabs,
      goto: { page: 'rename', object: null, custom: false, tabLabel: tab.Label },
      copy: tab.Name,
      notes: [],
    };
  }
  return {
    key: `tab:${tab.Name}`,
    confidence,
    title: `Custom tab ${tab.Name}`,
    subtitle: `"${tab.Label}" (Web, Visualforce, or Lightning tab)`,
    ...workbench(org, { component: 'Web Tab', row: tab.Label, pkg: namespaceOf(tab.Name) }),
    copy: tab.Name,
    notes: ['If the tab is not listed under Web Tab, check Rename Tabs and Labels → Custom Tabs.'],
  };
}

function appResult(org, app, confidence) {
  if (app.NamespacePrefix === 'standard') {
    return {
      key: `app:${app.Name}`,
      source: SOURCE.NOT_TRANSLATABLE,
      confidence,
      title: `Salesforce standard app ${app.Name}`,
      subtitle: `"${app.Label}"`,
      steps: ['Salesforce translates standard app names. To change it, create a custom app.'],
      url: SETUP.appManager,
      copy: app.Name,
      notes: [],
    };
  }
  return {
    key: `app:${app.Name}`,
    confidence,
    title: `App ${app.NamespacePrefix ? app.NamespacePrefix + '__' : ''}${app.Name}`,
    subtitle: `"${app.Label}"`,
    ...workbench(org, { component: 'App', aspect: 'Field Label', row: app.Label }),
    copy: app.Name,
    notes: [],
  };
}

// ---------- hint-only results (from page metadata, no text match needed) ----------

function hintResults(org, hints, describes, areas, text) {
  const out = [];
  const objLabel = (o) => describes.find((d) => d.name === o)?.label || o;

  for (const raw of hints.selectionNames || []) {
    const sn = parseSelectionName(raw);
    if (!sn) continue;
    if (sn.kind === 'CustomButton') {
      out.push({
        key: `btn:${sn.object}.${sn.name}`,
        confidence: 'confirmed',
        title: `Custom button/link ${sn.object}.${sn.name}`,
        subtitle: 'Found in page metadata',
        ...workbench(org, { component: 'Button and Link Label', object: sn.object, objectLabel: objLabel(sn.object), row: sn.name, rows: [sn.name, text], pkg: namespaceOf(sn.name) }),
        copy: sn.name,
        notes: [],
      });
    } else if (sn.kind === 'StandardButton') {
      out.push({
        key: `stdbtn:${sn.object}.${sn.name}`,
        source: SOURCE.NOT_TRANSLATABLE,
        confidence: 'confirmed',
        title: `Standard button ${sn.name}`,
        subtitle: 'Found in page metadata',
        steps: [
          'Salesforce translates standard button labels itself.',
          'To show different text, replace it with a custom button or quick action, then translate that.',
        ],
        url: SETUP.objectDetails(sn.object || ''),
        copy: sn.name,
        notes: [],
      });
    } else if (sn.kind === 'QuickAction') {
      out.push(quickActionResult(org, sn.object, sn.object ? objLabel(sn.object) : 'Global', { name: sn.object ? `${sn.object}.${sn.name}` : sn.name, label: text }, 'confirmed'));
    }
  }

  const obj = contextObjects([], hints)[0] || describes[0]?.name;
  if (areas.has('layoutSection')) {
    out.push({
      key: 'area:layoutSection',
      confidence: 'context',
      title: 'Page layout section header',
      subtitle: 'You clicked inside a record page section header',
      ...workbench(org, { component: 'Layout Section', object: obj, objectLabel: obj ? objLabel(obj) : null, row: text || 'the section name' }),
      notes: ['If the section comes from a Dynamic Forms field section, the label is set in Lightning App Builder and is not translatable there.'],
    });
  }
  if (areas.has('flow')) {
    out.push({
      key: 'area:flow',
      confidence: 'context',
      title: 'Flow screen text',
      subtitle: 'You clicked inside a running flow',
      ...workbench(org, { component: 'Flow', row: 'pick the flow and version' }),
      url: SETUP.workbench,
      notes: ['Flow labels referencing {!$Label...} are translated in Custom Labels instead.'],
    });
  }
  if (areas.has('lightningPageTab')) {
    out.push({
      key: 'area:lightningPageTab',
      source: SOURCE.NOT_TRANSLATABLE,
      confidence: 'context',
      title: 'Lightning page tab label',
      subtitle: 'Set in Lightning App Builder',
      steps: [
        'Standard tab names (Details, Related, Activity) are translated by Salesforce.',
        'A custom tab label typed in Lightning App Builder is not translated.',
        'Fix: create a Custom Label and set the tab label to {!$Label.c.Your_Label}.',
      ],
      url: SETUP.customLabels,
      notes: [],
    });
  }
  if (areas.has('relatedList')) {
    out.push({
      key: 'area:relatedList',
      confidence: 'context',
      title: 'Related list title',
      subtitle: 'Comes from the lookup field that links the two objects',
      ...workbench(org, { component: 'Custom Field', objectLabel: 'the CHILD object', aspect: 'Related List Label', row: text || 'the lookup field' }),
      notes: ['For standard relationships, the title is the plural object name: use Rename Tabs and Labels.'],
    });
  }
  if (areas.has('customComponent')) {
    const names = [...(hints.tags || []).filter((t) => /^c-/.test(t)), ...(hints.auraCustom || [])];
    out.push({
      key: 'area:customComponent',
      source: SOURCE.NOT_TRANSLATABLE,
      confidence: 'context',
      title: `Custom component: ${[...new Set(names)].slice(0, 3).join(', ')}`,
      subtitle: 'Developer-built component',
      steps: [
        'If a Custom Label result is listed above, translate that label.',
        'If not, the text is hardcoded. A developer must move it into a Custom Label.',
      ],
      url: SETUP.customLabels,
      notes: [],
    });
  }
  return out;
}

// ---------- main entry ----------

/**
 * @param {object} input
 * @param {string} input.text   selected or clicked text
 * @param {object} input.hints  page metadata collected by content.js
 * @param {object} input.org    org-wide data (labels, objects, tabs, apps, validation rules, languages)
 * @param {object[]} input.describes  sObject describes for context objects (with quickActions)
 */
/** True when the click happened on a Salesforce Setup page (Lightning Setup or a classic Setup frame). */
export function isSetupPage(urls = []) {
  return urls.filter(Boolean).some((u) => {
    try {
      const { host, pathname } = new URL(u);
      if (/\.salesforce-setup\.com$/.test(host)) return true;
      if (pathname.startsWith('/lightning/setup/')) return true;
      return /\.my\.salesforce\.com$/.test(host) && /^\/(i18n|setup|ui\/setup|_ui\/common|01j|p\/setup)\b/.test(pathname);
    } catch {
      return false;
    }
  });
}

function setupTextResult() {
  return {
    key: 'setup:builtin',
    source: SOURCE.NOT_TRANSLATABLE,
    confidence: 'context',
    title: "Salesforce's own Setup text",
    subtitle: 'Page titles, headings, buttons, and help text on Setup pages',
    steps: [
      'Salesforce writes and translates this text. Admins cannot change or translate it.',
      'To see it in another language, change your personal language: your profile picture → Settings → Language & Time Zone.',
      'Names from your org shown on Setup pages (objects, fields, picklist values) are listed separately when found.',
    ],
    url: null,
    notes: [],
  };
}

export function locate({ text, hints = {}, org = {}, describes = [], dataTranslations = [], record = null, pageUrls = [] }) {
  const needle = normalize(text);
  const results = [];
  const add = (r) => r && results.push(r);
  const areas = detectAreas(hints);

  if (needle) {
    // 1. Custom labels (master value, then existing translations)
    const translationsById = groupBy(org.labelTranslations || [], 'ExternalStringId');
    const labelsById = new Map((org.customLabels || []).map((l) => [l.Id, l]));
    for (const label of org.customLabels || []) {
      const mt = matchType(needle, label.Value);
      if (mt) add(customLabelResult(org, label, mt, translationsById.get(label.Id)));
    }
    for (const tr of org.labelTranslations || []) {
      const label = labelsById.get(tr.ExternalStringId);
      const mt = label && matchType(needle, tr.Value);
      if (mt) add(customLabelResult(org, label, mt, translationsById.get(label.Id), tr.Language));
    }

    // 2. Object names. Rename Tabs and Labels only lists objects that have a tab,
    // so internal objects (Name, LeadStatus, ChatterActivity...) are skipped.
    const tabByObject = new Map((org.tabs || []).filter((t) => t.SobjectName).map((t) => [t.SobjectName, t]));
    const gateOnTabs = Array.isArray(org.tabs) && org.tabs.length > 0;
    const matchedObjects = new Set();
    for (const obj of org.objects || []) {
      if (isNoiseObject(obj.name)) continue;
      if (gateOnTabs && !tabByObject.has(obj.name)) continue;
      const single = matchType(needle, obj.label);
      const plural = matchType(needle, obj.labelPlural);
      const mt = best(single, plural);
      if (mt) {
        matchedObjects.add(obj.name);
        add(objectResult(org, obj, mt, single !== 'exact' && plural === 'exact', tabByObject.get(obj.name)));
      }
    }

    // 3. Tabs not backed by an object
    for (const tab of org.tabs || []) {
      if (tab.SobjectName && matchedObjects.has(tab.SobjectName)) continue;
      if (tab.SobjectName) continue; // object tabs are renamed with the object
      const mt = matchType(needle, tab.Label);
      if (mt) add(tabResult(org, tab, mt));
    }

    // 4. Apps
    for (const app of org.apps || []) {
      if (app.Type && !/TabSet|CustomApplication|Lightning/i.test(app.Type)) continue;
      const mt = matchType(needle, app.Label);
      if (mt) add(appResult(org, app, mt));
    }

    // 5. Validation rule messages (org-wide)
    for (const vr of org.validationRules || []) {
      const mt = matchType(needle, vr.ErrorMessage);
      if (mt) {
        const o = vr.EntityDefinition?.QualifiedApiName;
        const objLabel = (org.objects || []).find((x) => x.name === o)?.label;
        add(validationResult(org, vr, mt, objLabel));
      }
    }

    // 6. Context objects: fields, help text, picklists, record types, quick actions
    for (const d of describes) {
      for (const f of d.fields || []) {
        const lm = matchType(needle, f.label);
        if (lm) add(fieldLabelResult(org, d, f, lm));
        const hm = f.inlineHelpText && matchType(needle, f.inlineHelpText);
        if (hm) add(helpTextResult(org, d, f, hm));
        for (const pv of f.picklistValues || []) {
          const pm = matchType(needle, pv.label);
          if (pm) add(picklistResult(org, d, f, pv, pm));
        }
      }
      for (const rt of d.recordTypeInfos || []) {
        if (rt.master) continue;
        const mt = matchType(needle, rt.name);
        if (mt) add(recordTypeResult(org, d, rt, mt));
      }
      for (const qa of d.quickActions || []) {
        const mt = matchType(needle, qa.label);
        if (mt) add(quickActionResult(org, d.name, d.label, qa, mt));
      }
    }

    // 6b. Data Translation: record values (e.g. a Product's Name), master value then translations
    for (const dt of dataTranslations) {
      for (const f of dt.fields) {
        const mt = dt.parent && matchType(needle, dt.parent[f.name]);
        if (mt) add(dataResult(org, dt, f, mt, null));
        for (const row of dt.rows) {
          const rm = matchType(needle, row[f.name]);
          if (rm) add(dataResult(org, dt, f, rm, row));
        }
      }
    }
  }

  // 7. Page metadata (buttons, sections, flows, custom components)
  for (const r of hintResults(org, hints, describes, areas, String(text || '').trim())) {
    const existing = results.find((x) => x.key === r.key);
    if (existing) existing.confidence = 'confirmed';
    else add(r);
  }

  // Boost matches confirmed by the clicked element (e.g. sfdc:RecordField.Account.Industry)
  const confirmedFields = (hints.selectionNames || [])
    .map(parseSelectionName)
    .filter((s) => s && s.kind === 'RecordField' && s.object)
    .map((s) => `${s.object}.${s.name}`);
  const aboutField = (r, cf) => r.key.endsWith(cf) || r.key.includes(cf + '.');
  for (const r of results) {
    if (r.confidence === 'exact' && confirmedFields.some((cf) => aboutField(r, cf))) r.confidence = 'confirmed';
  }
  // Clicked a record value in a field that supports Data Translation.
  for (const cf of confirmedFields) {
    if (results.some((r) => aboutField(r, cf) && r.confidence !== 'partial')) continue;
    const [o, fName] = cf.split('.');
    const dt = dataTranslations.find((x) => x.object === o);
    const f = dt?.fields.find((x) => x.name === fName);
    if (f) add(dataResult(org, dt, f, 'context', null));
    else if (!dt && DATA_TRANSLATION_FIELDS[o]?.includes(fName) && Array.isArray(org.objects)) add(dataOffResult(o, fName));
  }
  // Clicked a record value: also list org-built translation objects (e.g. Demo_Translations__c).
  for (const cf of confirmedFields) {
    if (results.some((r) => aboutField(r, cf) && r.confidence !== 'partial' && !r.key.startsWith('data:'))) continue;
    const d = describes.find((x) => x.name === cf.split('.')[0]);
    for (const child of d?.translationChildren || []) {
      const label = child.label || (org.objects || []).find((x) => x.name === child.object)?.labelPlural;
      add(customTranslationResult(d, { ...child, label }, record));
    }
  }
  // Clicked inside a field but the text matched nothing about it (e.g. "Name" vs. describe label "Full Name").
  for (const cf of confirmedFields) {
    if (results.some((r) => aboutField(r, cf) && r.confidence !== 'partial')) continue;
    const [o, fName] = cf.split('.');
    const d = describes.find((x) => x.name === o);
    const f = d?.fields?.find((x) => x.name === fName);
    if (!f) continue;
    const r = fieldLabelResult(org, d, f, 'context');
    r.notes = [`You clicked inside this field. Its label in Salesforce is "${f.label}".`, ...r.notes];
    add(r);
  }

  // Setup pages show Salesforce's own text. Custom labels are not used there, so a label
  // with the same words is a coincidence (bug: "Export" heading matched the acme__Pkg_Export label).
  if (isSetupPage(pageUrls)) {
    for (const r of results) {
      if (r.source !== SOURCE.CUSTOM_LABEL) continue;
      r.confidence = 'partial';
      r.notes = ['Same words only. Setup pages do not show custom labels, so this is probably not the text you clicked.', ...(r.notes || [])];
    }
    add(setupTextResult());
  }

  return finalize(results, areas);
}

function finalize(results, areas) {
  const seen = new Set();
  let unique = results.filter((r) => {
    if (seen.has(r.key)) return false;
    seen.add(r.key);
    return true;
  });
  unique.forEach((r) => {
    r.source ||= SOURCE.WORKBENCH;
    if (r.packageNote) r.notes = [r.packageNote, ...(r.notes || [])];
    delete r.packageNote;
  });
  unique.sort(
    (a, b) =>
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
      SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
      a.title.localeCompare(b.title)
  );
  // Partial matches are guesses. Show them only when nothing better exists.
  const hasBetter = unique.some((r) => r.confidence !== 'partial');
  const limit = hasBetter ? 0 : MAX_PARTIAL;
  let partialCount = 0;
  let droppedPartial = 0;
  unique = unique.filter((r) => {
    if (r.confidence !== 'partial') return true;
    if (++partialCount <= limit) return true;
    droppedPartial++;
    return false;
  });
  const notFoundHelp = unique.length
    ? null
    : [
        'Not found in custom labels, object/field names, picklists, record types, actions, apps, tabs, or validation messages.',
        'Other places to check in Translation Workbench: Layout Section, Flow, Path Step Rich Text, Lookup Filter, Button and Link Label, Report, Dashboard.',
        'Text typed into custom components is not translatable until a developer moves it into a Custom Label.',
      ];
  return { results: unique, droppedPartial, notFoundHelp, areas: [...areas] };
}

// ---------- helpers ----------

function best(a, b) {
  if (a === 'exact' || b === 'exact') return 'exact';
  return a || b;
}

function isNoiseObject(name) {
  return /(History|Feed|Share|ChangeEvent|Tag|__hd|__e)$/.test(name) || /^(Aggregate|Apex|Auth|Flow[A-Z]|Setup)/.test(name);
}

function groupBy(arr, key) {
  const m = new Map();
  for (const x of arr) {
    if (!m.has(x[key])) m.set(x[key], []);
    m.get(x[key]).push(x);
  }
  return m;
}

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
