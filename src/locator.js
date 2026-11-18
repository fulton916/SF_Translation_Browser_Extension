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
    // Same language as the label itself (e.g. English for an English label): that is the master
    // Value, not a translation. Open the label so it can be edited. Package labels keep the override path.
    if (lang && lang === goto.masterLanguage && !goto.namespace) return { path: SETUP.customLabel(goto.labelId), autofill: null, masterEdit: true };
    const existingId = lang && goto.existing?.[lang];
    if (existingId) return { path: DEEP.labelEditTranslation(existingId), autofill: null };
    return { path: DEEP.labelNewTranslation(goto.labelId), autofill: lang && lang !== goto.masterLanguage ? { page: 'labelNew', lang } : null };
  }
  if (goto.page === 'rename') {
    const l = lang || orgDefault || 'en_US';
    // Standard objects open their Edit page directly. Custom objects only appear in a
    // non-default language, so start from the list and let content.js click Edit.
    if (goto.object && !goto.custom) {
      // Object names: Step 1 marks the Singular or Plural input (bug: Plural was never marked).
      return {
        path: DEEP.renameEdit(goto.object, l),
        autofill: goto.fieldLabel
          ? { page: 'renameStage', lang: l, fieldLabel: goto.fieldLabel, fieldName: goto.fieldName || null }
          : { page: 'renameStage', lang: l, fieldLabel: null, plural: !!goto.plural },
      };
    }
    return { path: SETUP.renameTabs, autofill: { page: 'renameHome', lang: l, tabLabel: goto.tabLabel, fieldLabel: goto.fieldLabel || null, fieldName: goto.fieldName || null, plural: !!goto.plural } };
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
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width spaces (seen in real Path guidance)
    .replace(/[\s ]+/g, ' ')
    .trim()
    .replace(/^[*\s]+/, '') // required-field asterisk
    .replace(/[\s:*]+$/, '') // trailing colon / asterisk
    .replace(/\s*\(\d+\+?\)$/, '') // record count on a card title: "Active Relationships (0)", "Cases (10+)"
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
  // A tab's own label, not anything inside its content (bug: a field section inside the
  // Details tab was reported as "Lightning page tab label").
  if (hints.tabRole ? hints.tabRole === 'tab' && has(/^(flexipage-tab|lightning-tab-bar)/) : has(/^(flexipage-tab|lightning-tab-bar)/)) {
    areas.add('lightningPageTab');
  }
  // Dynamic Forms field section header (not a field inside it).
  if (has(/^flexipage-field-section/) && !has(/^(flexipage-field$|record_flexipage-record-field)/)) areas.add('fieldSection');
  // A related list's title bar only; rows and cells inside the list are record data or child fields
  // (bug: "Sales Representative" in Opportunity Team got the "Related list title" card).
  // hints.listHeader is null/undefined from older content.js: keep the old behaviour then.
  if (has(/^(lst-related-list|force-related-list)/)) areas.add(hints.listHeader === false ? 'relatedListRow' : 'relatedList');
  // Record highlights panel (records-highlights2): the object name above the record name, or the record name.
  if (has(/^records-(lwc-)?highlights/)) areas.add(hints.recordTitle ? 'recordTitle' : 'highlights');
  if (hints.helpIcon) areas.add('helpIcon');
  // Path: the guidance is in Aura divs (no custom tag names), so read their data-aura-class too.
  // Verified on a UAT2 Opportunity (Nov 2026): runtime_sales_pathassistantPathAssistantInfo wraps "Guidance for Success".
  const aura = hints.auraClasses || [];
  if (has(/(^lightning-path|pathassistant)/) || aura.some((a) => /pathassistant/i.test(a))) areas.add('path');
  if (aura.some((a) => /pathassistantPathAssistantInfo/i.test(a)) || has(/pathassistant-?info/i)) areas.add('pathGuidance');
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

// Translate page dropdown values, read from a real org (Setup Component and Aspect <select>s).
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
  'Path Step Rich Text': 'PathAssistantStepInfo',
};
const WB_ASPECT = { 'Field Label': 'master', 'Help Text': 'help', 'Related List Label': 'relationshiplabel', Description: 'description' };

// Setup Components offered on Translation Workbench → Override (read from a real org).
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
    pkg: label.NamespacePrefix || null,
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
      namespace: label.NamespacePrefix || null,
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
    goto: { page: 'rename', object: obj.name, custom: obj.custom, tabLabel: tab?.Label || obj.labelPlural, plural: !!plural },
    copy: obj.name,
    notes,
  };
}

// Labels Lightning shows for standard fields whose describe label differs (checked in UAT2, Nov 2026:
// OwnerId "Owner ID" shows "Account Owner", Opportunity.AccountId "Account ID" shows "Account Name").
const STD_DISPLAY = {
  OwnerId: (d) => [`${d.label} Owner`, 'Owner'],
  AccountId: () => ['Account Name'],
  ContactId: () => ['Contact Name'],
  RecordTypeId: (d) => [`${d.label} Record Type`, 'Record Type'],
  Name: (d) => [`${d.label} Name`],
};
// Audit fields: Salesforce names them, and Rename Tabs and Labels does not list them.
const SYSTEM_FIELDS = new Set(['CreatedById', 'LastModifiedById', 'CreatedDate', 'LastModifiedDate', 'SystemModstamp']);

/** Every label a field can show on a Lightning page: the describe label first. */
export function displayLabels(d, f) {
  const out = [f.label];
  if (!f.custom && f.label) {
    const prefix = `${d.label} `;
    // "Account Phone" shows as "Phone", "Account Description" as "Description".
    if (f.label.startsWith(prefix) && f.label.length > prefix.length) out.push(f.label.slice(prefix.length));
    // Lookups: "Created By ID" shows as "Created By", "Parent Account ID" as "Parent Account".
    if (f.type === 'reference' && / ID$/.test(f.label)) out.push(f.label.slice(0, -3));
    out.push(...(STD_DISPLAY[f.name]?.(d) || []));
  }
  return [...new Set(out.filter(Boolean))];
}

function fieldLabelMatch(needle, d, f) {
  let out = null;
  for (const l of displayLabels(d, f)) out = best(out, matchType(needle, l));
  return out;
}

function systemFieldResult(d, f, confidence) {
  const shown = displayLabels(d, f).slice(-1)[0];
  return {
    key: `field:${d.name}.${f.name}`,
    source: SOURCE.NOT_TRANSLATABLE,
    confidence,
    title: `Salesforce system field: ${d.label} → ${shown}`,
    subtitle: `API name ${d.name}.${f.name}`,
    steps: [
      'Salesforce names this audit field and translates it into every language.',
      'It is not a custom label, and it is not listed in Translation Workbench.',
    ],
    url: SETUP.objectFields(d.name),
    copy: `${d.name}.${f.name}`,
    notes: ['If you do find it on Rename Tabs and Labels → Step 2 for this object, rename it there.'],
  };
}

function fieldLabelResult(org, d, f, confidence) {
  if (SYSTEM_FIELDS.has(f.name)) return systemFieldResult(d, f, confidence);
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
  // Field uses a Global Value Set (sfApi.loadValueSet; UAT2: Preferred_Language_LST__c → "Languages").
  // TW → Global Value Set is a tree of value set labels with their values under them (checked in UAT2).
  const vs = org.valueSets?.[`${d.name}.${f.name}`];
  if (vs?.name) {
    const vsLabel = vs.label || vs.name;
    return {
      key: `picklist:${d.name}.${f.name}.${pv.value}`,
      confidence,
      title: `Global value set ${vsLabel}: picklist value`,
      subtitle: `"${pv.label}" (API value: ${pv.value}), used by ${d.name}.${f.name}`,
      ...workbench(org, { component: 'Global Value Set', row: `${pv.label} (value set: ${vsLabel})`, rows: [pv.label, pv.value], pkg: vs.namespace || null, parent: vsLabel }),
      copy: pv.value,
      notes: [
        'One translation for every field that uses this value set.',
        'Setup Component "Picklist Value" does not list values of a global value set.',
        ...(isDefaultLanguage(org) ? [`Master label: Setup → Picklist Value Sets → ${vsLabel} → Values → Edit.`] : []),
      ],
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

/** A value shown in a record field (content.js hints.fieldPart === 'value') that is not a picklist value. */
function recordValueResult(d, f) {
  const base = { key: `value:${d.name}.${f.name}`, source: SOURCE.NOT_TRANSLATABLE, confidence: 'confirmed', url: SETUP.objectFields(d.name), copy: `${d.name}.${f.name}`, notes: [] };
  if (f.name === 'CurrencyIsoCode') {
    return {
      ...base,
      title: 'Salesforce currency name',
      subtitle: `Value of ${d.label} → ${f.label}`,
      steps: ['Salesforce names currencies (ISO code and name) and translates the names itself. No action needed.'],
    };
  }
  if (f.calculated) {
    return {
      ...base,
      title: `Formula output: ${d.label} → ${f.label}`,
      subtitle: `${d.name}.${f.name} is a formula field`,
      steps: [
        'The formula calculates this text. Translation tools do not change it.',
        `To translate it: Object Manager → ${d.label} → Fields → ${f.label} → Edit the formula, and return text from custom labels ($Label.c.Your_Label) instead of typed text.`,
      ],
    };
  }
  return {
    ...base,
    title: `Record data: a value typed on the record (${d.label} → ${f.label})`,
    subtitle: 'This is data stored on the record, not a label',
    steps: [
      'Translation tools do not change values that people type on records.',
      'If every user must see it in their language, use a picklist field instead, or Data Translation where the object supports it.',
    ],
  };
}

function dataOffResult(object, fieldName) {
  return {
    key: `data:${object}.${fieldName}`,
    off: true,
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

/** An org-built translation object (e.g. Product_Translations__c) linked to the record. */
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
    // A renamed standard app (e.g. LightningSales shown as "Acme Sales") is listed in
    // Translation Workbench → App, so point there; not verified that the launcher shows that translation.
    return {
      key: `app:${app.Name}`,
      confidence,
      title: `Salesforce standard app ${app.Name}`,
      subtitle: `"${app.Label}"`,
      ...workbench(org, { component: 'App', aspect: 'Field Label', row: app.Label }),
      copy: app.Name,
      notes: [
        'Standard app: if it was renamed, translate the new name here. Otherwise Salesforce translates it itself.',
        'If the translation does not show, the name cannot be translated: use a custom app instead (App Manager).',
      ],
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

// ---------- Path guidance ("Guidance for Success", PathAssistantStepInfo.Info) ----------

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

/** Rich text HTML → its visible lines (one per paragraph / list item), entities decoded, spaces collapsed. */
export function htmlLines(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<\/?(p|div|br|li|ol|ul|h[1-6]|tr|td|th|table|blockquote|pre|hr)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/<[^>]*$/, '') // a cut-off tag at the end
  )
    .split('\n')
    .map((l) => l.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[\s ]+/g, ' ').trim())
    .filter(Boolean);
}

export const htmlToText = (html) => htmlLines(html).join(' ');

// Contained matches need a real phrase: a single word like "Client" or "a" says nothing.
const MIN_PATH_NEEDLE = 12;

/**
 * 'exact' when the text is the whole guidance or one whole line of it (the element you point at is
 * usually one list item), 'partial' when a phrase of it, or the guidance plus more, else null.
 */
// The heading above the guidance (Salesforce text). Highlights often start with it.
const GUIDANCE_HEADINGS = ['guidance for success'];
function stripGuidanceHeading(n) {
  for (const h of GUIDANCE_HEADINGS) {
    if (n === h) return '';
    if (n.startsWith(h + ' ')) return n.slice(h.length + 1);
  }
  return n;
}

/**
 * `rawText` (optional) is the text before normalize, so a highlight across several list items can be
 * compared line by line: every line in the step → 'exact', at least 2 lines → 'partial'.
 */
export function pathStepMatch(needle, info, rawText = null) {
  const lines = htmlLines(info).map(normalize).filter(Boolean);
  const full = lines.join(' ');
  needle = stripGuidanceHeading(needle || '');
  if (!needle || !full) return null;
  const needleLines = String(rawText ?? '')
    .split(/\r?\n/)
    .map(normalize)
    .filter((l) => l && !GUIDANCE_HEADINGS.includes(l));
  if (needleLines.length >= 2) {
    const hits = needleLines.filter((l) => lines.includes(l)).length;
    if (hits === needleLines.length) return 'exact';
    if (hits >= 2) return 'partial';
  }
  if (full === needle || (needle.length >= 4 && lines.includes(needle))) return 'exact';
  if (needle.length >= MIN_PATH_NEEDLE && /\s/.test(needle) && full.includes(needle)) return 'partial';
  // Selection ran past the guidance (e.g. it includes the "Guidance for Success" heading).
  if (full.length >= MIN_PATH_NEEDLE && full.length / needle.length >= 0.5 && needle.includes(full)) return 'partial';
  return null;
}

/**
 * The path a step belongs to. Step DeveloperNames seen in a real org (Nov 2026):
 * "X<num>_<picklist value Id 01J…>_<record type Id 012… or null>_<Object>_<field without __c>"
 * and the older "<Object>_<record type or null>_<field>_<01J…>_<num>".
 */
export function pathOfStep(dn, paths = [], objects = []) {
  dn = String(dn || '');
  const hits = (paths || []).filter((p) => {
    const field = String(p.SobjectProcessField || '').replace(/__c$/, '');
    const rts = p.RecordTypeId ? [p.RecordTypeId, p.RecordTypeId.slice(0, 15)] : ['null'];
    return rts.some((rt) => dn.endsWith(`_${rt}_${p.SobjectType}_${field}`) || dn.startsWith(`${p.SobjectType}_${rt}_${field}_`));
  });
  const path = hits.find((p) => p.IsActive) || hits[0] || null;
  if (path) return { path, object: path.SobjectType, field: path.SobjectProcessField };
  // No path data: read object and field from the name itself.
  const old = /^(.+?)_(?:012[A-Za-z0-9]{12,15}|null)_(.+?)_01J[A-Za-z0-9]{12,15}_\d+$/.exec(dn);
  if (old) return { path: null, object: old[1], field: old[2] };
  const rest = /_01J[A-Za-z0-9]{12,15}_(?:012[A-Za-z0-9]{12,15}|null)_(.+)$/.exec(dn)?.[1];
  if (!rest) return { path: null, object: null, field: null };
  const obj = (objects || [])
    .map((o) => o.name)
    .filter((n) => rest.startsWith(n.replace(/__c$/, '') + '_'))
    .sort((a, b) => b.length - a.length)[0];
  if (obj) return { path: null, object: obj, field: rest.slice(obj.replace(/__c$/, '').length + 1) };
  const i = rest.indexOf('_');
  return i > 0 ? { path: null, object: rest.slice(0, i), field: rest.slice(i + 1) } : { path: null, object: rest, field: null };
}

function pathStepResult(org, step, where, describes, confidence) {
  const lines = htmlLines(step.Info);
  const d = describes.find((x) => x.name === where.object);
  const fieldName = where.field || '';
  const f = d?.fields?.find((x) => x.name === fieldName || x.name === `${fieldName}__c`);
  const objectLabel = d?.label || (org.objects || []).find((o) => o.name === where.object)?.label || where.object;
  const fieldLabel = f?.label || fieldName.replace(/__c$/, '').replace(/_/g, ' ');
  const pathName = where.path?.MasterLabel || where.path?.DeveloperName || 'unknown path';
  const where2 = [objectLabel, fieldLabel].filter(Boolean).join(' › ');
  const base = workbench(org, { component: 'Path Step Rich Text' });
  const notes = [];
  if (where.path && where.path.IsActive === false) notes.push('This path is inactive.');
  if (step.Language && org.defaultLanguage && step.Language !== org.defaultLanguage) notes.push(`This guidance is written in ${languageName(step.Language)}.`);
  if (isDefaultLanguage(org)) notes.push(`Master text: Setup → Path Settings → ${pathName} → Edit → the step's Guidance for Success.`);
  return {
    key: `path:${step.Id || step.DeveloperName}`,
    confidence,
    title: `Path guidance: ${pathName}${where2 ? ` (${where2})` : ''}`,
    subtitle: `"${truncate(lines.join(' '), 100)}"`,
    ...base,
    steps: [
      ...base.steps,
      `Find the row that starts with "${truncate(step.Info, 50)}". The list shows the raw HTML; the text starts "${truncate(lines[0], 60)}".`,
      'Double-click its translation cell. The whole guidance block is one translation: keep its formatting (lists, bold, links).',
    ],
    // The grid's master cell holds the raw Info HTML (checked in a real org: all 20 rows equal Info exactly).
    goto: { ...base.goto, rows: [step.Info, lines.join(' ')], rowMatch: 'richText', rowLabel: truncate(lines[0], 80) },
    copy: step.DeveloperName,
    notes,
  };
}

function pathResults(org, needle, areas, describes, add, rawText) {
  const pageObjects = new Set(describes.map((d) => d.name));
  for (const step of org.pathSteps || []) {
    const mt = pathStepMatch(needle, step.Info, rawText);
    if (!mt) continue;
    const where = pathOfStep(step.DeveloperName, org.paths, org.objects);
    // A path for another object can share a line ("Who else needs to be contacted?"): never confirm it.
    const otherObject = where.object && pageObjects.size && !pageObjects.has(where.object);
    let confidence = mt;
    if (!otherObject && (areas.has('pathGuidance') || (areas.has('path') && mt === 'exact'))) confidence = 'confirmed';
    else if (otherObject) confidence = 'partial';
    add(pathStepResult(org, step, where, describes, confidence));
  }
}

// ---------- hint-only results (from page metadata, no text match needed) ----------

function hintResults(org, hints, describes, areas, text, pageHandled = false) {
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
      out.push(quickActionResult(org, sn.object || 'Global', sn.object ? objLabel(sn.object) : 'Global', { name: sn.object ? `${sn.object}.${sn.name}` : sn.name, label: text }, 'confirmed'));
    }
  }

  const obj = contextObjects([], hints)[0] || describes[0]?.name;
  if (areas.has('layoutSection')) {
    // A heading in the path means the header itself was clicked (not blank space in the section):
    // rank it above a field that happens to share the name (bug: "Business Unit" header → field card).
    const onHeader = (hints.tags || []).some((t) => /^h[1-6]$/.test(t));
    out.push({
      key: 'area:layoutSection',
      confidence: onHeader ? 'confirmed' : 'context',
      title: 'Page layout section header',
      subtitle: 'You clicked inside a record page section header',
      ...workbench(org, { component: 'Layout Section', object: obj, objectLabel: obj ? objLabel(obj) : null, row: text || 'the section name' }),
      notes: [
        'The same section name can be in several page layouts. Go to translation opens every layout and lists each copy.',
        'If the section comes from a Dynamic Forms field section, the label is set in Lightning App Builder and is not translatable there.',
      ],
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
  // Tab title read from the page metadata: that answer replaces the generic card.
  if (areas.has('lightningPageTab') && !pageHandled) {
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
  if (areas.has('relatedList') && !pageHandled) {
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

// Lightning App Builder components whose text the page metadata holds, by componentName.
// prop: the componentInstanceProperty with the shown text (sfApi.js reads the same table).
export const PAGE_COMPONENT_KINDS = {
  'flexipage:fieldSection': { prop: 'label', what: 'Field section label', part: 'section', field: 'Label' },
  'lst:dynamicRelatedList': { prop: 'relatedListLabel', what: 'Related list label', part: 'related list', field: 'Related List Label' },
  'flexipage:tab': { prop: 'title', what: 'Tab label', part: 'tab', field: 'Label' },
  // Classic related list component: no label property, only relatedListApiName.
  'force:relatedListSingleContainer': { prop: 'relatedListLabel', what: 'Related list label', part: 'related list', field: 'Related List Label' },
};
const RELATED_LIST_COMPONENTS = new Set(['lst:dynamicRelatedList', 'force:relatedListSingleContainer']);
const pcKind = (pc) => PAGE_COMPONENT_KINDS[pc.component] || { prop: 'label', what: 'Component label', part: 'component', field: 'Label' };

/** Label typed as plain text in Lightning App Builder: never translated. */
function builderTextResult(org, pc) {
  const kind = pcKind(pc);
  const same = (org.customLabels || []).find((l) => normalize(l.Value) === normalize(pc.label) && !l.NamespacePrefix);
  const ref = `{!$Label.c.${same ? same.Name : 'Your_Label'}}`;
  return {
    key: `builder:${pc.page}.${pc.id}`,
    source: SOURCE.NOT_TRANSLATABLE,
    confidence: 'confirmed',
    title: `${kind.what} typed in Lightning App Builder`,
    subtitle: `"${pc.label}" on the Lightning page ${pc.page}`,
    steps: [
      'This label is plain text, so Salesforce never translates it.',
      same ? `Custom label ${same.Name} already has this text. Add its translations if needed.` : 'Setup → Custom Labels → New: create a label with this text, then add its translations.',
      `Lightning App Builder → ${pc.page} → click the ${kind.part} → set ${kind.field} to ${ref} → Save.`,
    ],
    url: same ? SETUP.customLabel(same.Id) : SETUP.customLabels,
    copy: ref,
    notes: [],
  };
}

const LABEL_REF = /^\{!\$Label\.(?:([A-Za-z0-9_]+)\.)?([A-Za-z0-9_]+)\}$/;
// Salesforce's own name for a standard section, stored in the page as a token (seen in UAT2:
// "@@@SFDCOpportunity_InformationSFDC@@@"). Salesforce shows and translates it itself.
const SFDC_TOKEN = /^@@@SFDC(.+)SFDC@@@$/;
// Salesforce's own tab names (Details, Related, Chatter...): "Standard.Tab.detail".
const STANDARD_TAB = /^Standard\.Tab\.([A-Za-z0-9_]+)$/;

function standardNameResult(org, pc, name) {
  const kind = pcKind(pc);
  return {
    key: `sfdcname:${pc.page}.${pc.id}`,
    source: SOURCE.NOT_TRANSLATABLE,
    confidence: 'confirmed',
    title: `Salesforce standard ${kind.part} name (translated by Salesforce)`,
    subtitle: `"${name}" on the Lightning page ${pc.page} (stored as ${pc.label})`,
    steps: [
      'Salesforce supplies this name and translates it into every language. No action needed.',
      `To show different text: create a custom label, then Lightning App Builder → ${pc.page} → click the ${kind.part} → set ${kind.field} to {!$Label.c.Your_Label} → Save, and translate that label.`,
    ],
    url: SETUP.customLabels,
    copy: pc.label,
    notes: [],
  };
}

/** A custom label with the same words as a Salesforce standard name: a coincidence, never the source. */
function demoteSameTextLabels(results, why) {
  for (const r of results) {
    if (r.source !== SOURCE.CUSTOM_LABEL || r.confidence === 'partial') continue;
    r.confidence = 'exact';
    r.notes = [`Same words only: ${why}`, ...(r.notes || [])];
  }
}

/**
 * Related list with no label of its own (UAT2: Files = AttachedContentDocuments, Account Team,
 * Opportunities). A custom relationship (…__r) keeps the generic Translation Workbench card.
 */
function standardRelatedList(results, add, pc) {
  const api = String(pc.props?.relatedListApiName || '');
  if (!api || /__r$/.test(api)) return false;
  // Object-backed lists (Opportunities, Contacts, Cases) show the object's plural name.
  const obj = results.find((r) => r.key.startsWith('object:') && r.confidence !== 'partial');
  if (obj) {
    obj.confidence = 'confirmed';
    obj.notes = [`Standard related list ${api}: its title is the object's plural name.`, ...(obj.notes || [])];
  } else {
    add({
      key: `stdlist:${api}`,
      source: SOURCE.NOT_TRANSLATABLE,
      confidence: 'confirmed',
      title: 'Salesforce standard related list',
      subtitle: `${api} on the Lightning page ${pc.page}`,
      steps: [
        'Salesforce names this related list and translates its title itself. No action needed.',
        `To show different text: in Lightning App Builder → ${pc.page}, use a Dynamic Related List – Single and set its Related List Label to {!$Label.c.Your_Label}, then translate that label.`,
      ],
      url: SETUP.customLabels,
      copy: api,
      notes: [],
    });
  }
  demoteSameTextLabels(results, 'this related list title comes from Salesforce, not from a custom label.');
  return true;
}

/** Returns true when the component's text was explained (so generic area cards are not needed). */
function applyPageComponent(org, results, add, pc) {
  const text = String(pc.label ?? '').trim();
  const kind = pcKind(pc);
  if (!text && RELATED_LIST_COMPONENTS.has(pc.component)) return standardRelatedList(results, add, pc);
  // No text set: the generic cards still apply.
  if (!text && pc.component !== 'flexipage:fieldSection') return false;
  const token = SFDC_TOKEN.exec(text);
  const std = STANDARD_TAB.exec(text);
  if (token || std) {
    const name = token ? token[1].replace(/_/g, ' ') : std[1];
    add(standardNameResult(org, pc, name));
    demoteSameTextLabels(results, `this ${kind.part} shows a Salesforce standard name (${text}), not a custom label.`);
    return true;
  }
  const m = LABEL_REF.exec(text);
  if (!m) {
    add(builderTextResult(org, pc));
    return true;
  }
  const ns = m[1] && m[1] !== 'c' ? m[1] : null;
  const label = (org.customLabels || []).find((l) => l.Name === m[2] && (l.NamespacePrefix || null) === ns);
  if (!label) {
    add({ ...builderTextResult(org, pc), title: `${kind.what} uses a custom label that was not found`, subtitle: `${pc.label} on ${pc.page}` });
    return true;
  }
  let r = results.find((x) => x.key === `label:${label.Id}`);
  if (!r) {
    r = customLabelResult(org, label, 'confirmed', (org.labelTranslations || []).filter((t) => t.ExternalStringId === label.Id));
    add(r);
  }
  r.confidence = 'confirmed';
  r.notes = [`Confirmed: this ${kind.part}'s label in Lightning App Builder is ${pc.label} (page ${pc.page}).`, ...(r.notes || [])];
  return true;
}

function confirmPathValues(org, describes, results) {
  const pageObjects = new Set(describes.map((d) => d.name));
  const paths = (org.paths || []).filter((p) => p.IsActive !== false && pageObjects.has(p.SobjectType));
  let confirmed = false;
  for (const p of paths) {
    const prefix = `picklist:${p.SobjectType}.${p.SobjectProcessField}.`;
    for (const r of results) {
      if (!r.key.startsWith(prefix) || r.confidence !== 'exact') continue;
      r.confidence = 'confirmed';
      r.notes = [`This is a step of the path "${p.MasterLabel || p.DeveloperName}" (field ${p.SobjectProcessField}).`, ...(r.notes || [])];
      confirmed = true;
    }
  }
  if (confirmed) demoteSameTextLabels(results, 'path steps show picklist values, not custom labels.');
}

/** Areas that only ever show object, tab or app names: confirm those, demote same-text custom labels. */
function confirmNames(results, keyRe, why) {
  const hits = results.filter((r) => keyRe.test(r.key) && r.confidence === 'exact');
  if (!hits.length) return;
  for (const r of hits) r.confidence = 'confirmed';
  for (const r of results) {
    if (r.source !== SOURCE.CUSTOM_LABEL) continue;
    r.confidence = 'partial';
    r.notes = [`Same words only: ${why}`, ...(r.notes || [])];
  }
}

function addHelpIconResults(org, describes, confirmedFields, results, add) {
  const fieldOf = (o, n) => {
    const d = describes.find((x) => x.name === o);
    return { d, f: d?.fields?.find((x) => x.name === n) };
  };
  const fields = confirmedFields.map((cf) => fieldOf(...cf.split('.'))).filter((x) => x.f);
  // No field in the path: the field whose label is the text (the icon's text is "Help <label>").
  const byText = results
    .filter((r) => r.key.startsWith('field:') && r.confidence === 'exact')
    .map((r) => fieldOf(...r.key.slice(6).split('.')))
    .filter((x) => x.f?.inlineHelpText);
  const confidence = fields.length ? 'confirmed' : 'exact';
  for (const { d, f } of fields.length ? fields : byText) {
    const r = helpTextResult(org, d, f, confidence);
    if (!f.inlineHelpText) r.subtitle = 'Help text of this field';
    r.notes = ["You pointed at this field's help (i) icon.", ...r.notes];
    add(r);
    const label = results.find((x) => x.key === `field:${d.name}.${f.name}`);
    if (label) label.confidence = 'context';
  }
}

/** Pointed at a field's value (not its label) and the value is not one of its picklist values. */
function addRecordValueResults(org, d, f, results, add) {
  const key = `${d.name}.${f.name}`;
  if (results.some((r) => r.key.startsWith(`picklist:${key}.`) && r.confidence !== 'partial')) return;
  // Data Translation is on for this field: that is the answer.
  const dt = results.find((r) => r.key === `data:${key}` && !r.off);
  if (dt) dt.confidence = 'confirmed';
  else add(recordValueResult(d, f));
  demoteSameTextLabels(results, 'you pointed at a value on the record, not at a label.');
}

export function locate({ text, hints = {}, org = {}, describes = [], dataTranslations = [], record = null, pageUrls = [], pageComponent = null }) {
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
        const lm = fieldLabelMatch(needle, d, f);
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
        // Object actions are "Account.New_Case"; a name without a dot is a global action
        // (UAT2: NewTaskServiceACEMEAANZ was shown as Object: Account).
        const global = !String(qa.name || '').includes('.');
        // TW → Action has an Object option "Global" (value Global) for these.
        if (mt) add(quickActionResult(org, global ? 'Global' : d.name, global ? 'Global' : d.label, qa, mt));
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

    // 6c. Path guidance ("Guidance for Success")
    pathResults(org, needle, areas, describes, add, text);
  }

  // Path chevrons show the path field's picklist values (UAT2: Sub Stage "Connect" ranked below maps__MA_Connect).
  if (areas.has('path') && !areas.has('pathGuidance')) confirmPathValues(org, describes, results);

  // Navigation bar items are object, tab and app names, never custom labels.
  if (areas.has('navTab')) confirmNames(results, /^(object|tab|app):/, 'navigation bar items show object, tab and app names, not custom labels.');
  // The object name above the record name in the highlights panel (UAT2: "Account" ranked below 3 labels).
  if (areas.has('highlights')) confirmNames(results, /^object:/, 'the highlights panel shows the object name, not a custom label.');

  // 7. Page metadata (buttons, sections, flows, custom components)
  // Clicked a Lightning App Builder component whose label was read from the page metadata.
  const labelHits = results.filter((r) => r.source === SOURCE.CUSTOM_LABEL);
  const pageHandled = pageComponent ? applyPageComponent(org, results, add, pageComponent) : false;
  if (pageHandled) {
    // The page metadata explained the text.
  } else if (areas.has('fieldSection') && labelHits.length) {
    // Page metadata not readable: no extra card (it confused testers). Say why the label is likely.
    for (const r of labelHits) r.notes = ['Likely the source: Dynamic Forms section headers usually use a custom label.', ...(r.notes || [])];
  } else if (areas.has('fieldSection')) {
    add({
      key: 'area:fieldSection',
      source: SOURCE.CONTEXT,
      confidence: 'context',
      title: 'Dynamic Forms field section header',
      subtitle: 'Its label is set in Lightning App Builder',
      steps: [
        'If the section label is {!$Label.…}, translate that custom label.',
        'If it is plain text, it is not translated: replace it with a custom label.',
      ],
      url: SETUP.customLabels,
      notes: ['It is not a page layout section, so Translation Workbench → Layout Section does not change it.'],
    });
  }

  for (const r of hintResults(org, hints, describes, areas, String(text || '').trim(), pageHandled)) {
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
  // Help (i) icon of a field: its help text, not the label (bug: "Help Display Name" matched labels only).
  if (areas.has('helpIcon')) addHelpIconResults(org, describes, confirmedFields, results, add);
  // The record name in the highlights panel is the Name field's value.
  if (areas.has('recordTitle')) {
    const d = describes.find((x) => x.name === record?.object) || describes[0];
    const f = d?.fields?.find((x) => x.name === 'Name');
    if (f) {
      addRecordValueResults(org, d, f, results, add);
      results.find((r) => r.key === `value:${d.name}.Name`)?.notes.push('This is the record name shown at the top of the page.');
    }
  }

  // Clicked a record value in a field that supports Data Translation (never for a click on the label).
  const onLabel = hints.fieldPart === 'label';
  for (const cf of onLabel ? [] : confirmedFields) {
    if (results.some((r) => aboutField(r, cf) && r.confidence !== 'partial')) continue;
    const [o, fName] = cf.split('.');
    const dt = dataTranslations.find((x) => x.object === o);
    const f = dt?.fields.find((x) => x.name === fName);
    if (f) add(dataResult(org, dt, f, 'context', null));
    else if (!dt && DATA_TRANSLATION_FIELDS[o]?.includes(fName) && Array.isArray(org.objects)) add(dataOffResult(o, fName));
  }
  // Clicked a record value: also list org-built translation objects (e.g. Product_Translations__c).
  for (const cf of onLabel ? [] : confirmedFields) {
    if (results.some((r) => aboutField(r, cf) && r.confidence !== 'partial' && !r.key.startsWith('data:'))) continue;
    const d = describes.find((x) => x.name === cf.split('.')[0]);
    for (const child of d?.translationChildren || []) {
      const label = child.label || (org.objects || []).find((x) => x.name === child.object)?.labelPlural;
      add(customTranslationResult(d, { ...child, label }, record));
    }
  }
  // Clicked inside a field but the text matched nothing about it (e.g. "Name" vs. describe label "Full Name").
  // A 'partial' card for the field ("Phone" vs. "Account Phone") is replaced: finalize keeps the better card.
  const fieldPart = hints.fieldPart || null;
  for (const cf of confirmedFields) {
    const [o, fName] = cf.split('.');
    const d = describes.find((x) => x.name === o);
    const f = d?.fields?.find((x) => x.name === fName);
    if (!f) continue;
    if (fieldPart === 'value') addRecordValueResults(org, d, f, results, add);
    // On a value, the field's label card is still listed below the value answer.
    const covers = (r) => aboutField(r, cf) && r.confidence !== 'partial' && !(fieldPart === 'value' && /^(value|data):/.test(r.key));
    if (fieldPart !== 'label' && results.some(covers)) continue;
    if (fieldPart === 'label') {
      // Pointed at the field's label: the page proves it, whatever the describe label says.
      const existing = results.find((r) => r.key === `field:${cf}` && r.confidence !== 'partial');
      if (existing) existing.confidence = 'confirmed';
      else {
        const r = fieldLabelResult(org, d, f, 'confirmed');
        r.notes = [`You pointed at this field's label. Its label in Salesforce is "${f.label}".`, ...r.notes];
        add(r);
      }
      demoteSameTextLabels(results, 'record page field labels come from the field, not from custom labels.');
      continue;
    }
    const r = fieldLabelResult(org, d, f, 'context');
    r.notes = [`You clicked inside this field. Its label in Salesforce is "${f.label}".`, ...r.notes];
    add(r);
  }

  // Setup pages show Salesforce's own text. Custom labels are not used there, so a label
  // with the same words is a coincidence (bug: "Export" heading matched the maps__MA_Export label).
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

// Managed-package labels with the same words as a field or object are usually a coincidence
// (UAT2: maps__ and genesysps__ labels "Territory", "Phone", "Type"...). Rank them after non-label answers.
const MANAGED_EXACT_RANK = SOURCE_RANK[SOURCE.NOT_TRANSLATABLE] + 0.5;
// With a page-confirmed answer, show at most this many same-text managed labels; fold the rest.
const MAX_MANAGED_WITH_CONFIRMED = 2;

const isManagedLabel = (r) => r.source === SOURCE.CUSTOM_LABEL && !!r.pkg;
const sourceRank = (r) => (isManagedLabel(r) && r.confidence === 'exact' ? MANAGED_EXACT_RANK : SOURCE_RANK[r.source]);

function finalize(results, areas) {
  // One card per key, the best-ranked one (bug: Account "Phone" kept a 'partial' field card added
  // first and dropped it, losing the 'context' card for the clicked field).
  // 'partial' loses even to 'context' here, because partial cards are hidden when anything better exists.
  const KEEP_RANK = { confirmed: 0, exact: 1, context: 2, partial: 3 };
  const byKey = new Map();
  for (const r of results) {
    const prev = byKey.get(r.key);
    if (!prev || KEEP_RANK[r.confidence] < KEEP_RANK[prev.confidence]) byKey.set(r.key, r);
  }
  let unique = [...byKey.values()];
  unique.forEach((r) => {
    r.source ||= SOURCE.WORKBENCH;
    if (r.packageNote) r.notes = [r.packageNote, ...(r.notes || [])];
    delete r.packageNote;
  });
  unique.sort(
    (a, b) =>
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
      sourceRank(a) - sourceRank(b) ||
      // Unmanaged labels before managed ones (bug: maps__Territory sorted before the org's own Territory label).
      Number(isManagedLabel(a)) - Number(isManagedLabel(b)) ||
      a.title.localeCompare(b.title)
  );
  let hiddenManaged = 0;
  if (unique.some((r) => r.confidence === 'confirmed')) {
    let shown = 0;
    unique = unique.filter((r) => {
      if (!isManagedLabel(r) || r.confidence !== 'exact') return true;
      if (++shown <= MAX_MANAGED_WITH_CONFIRMED) return true;
      hiddenManaged++;
      return false;
    });
  }
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
        'Not found in custom labels, object/field names, picklists, record types, actions, apps, tabs, validation messages, or path guidance.',
        'Other places to check in Translation Workbench: Layout Section, Flow, Lookup Filter, Button and Link Label, Report, Dashboard.',
        'Text typed into custom components is not translatable until a developer moves it into a Custom Label.',
      ];
  return { results: unique, droppedPartial, hiddenManaged, notFoundHelp, areas: [...areas] };
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
