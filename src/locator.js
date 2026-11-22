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
  NOT_TRANSLATABLE: 'Admin work required to translate',
  SALESFORCE: 'Owned by Salesforce',
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
  [SOURCE.SALESFORCE]: 5,
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
          ? { page: 'renameStage', lang: l, fieldLabel: goto.fieldLabel, fieldName: goto.fieldName || null, candidates: renameFieldCandidates(goto.fieldLabel, goto.fieldName) }
          : { page: 'renameStage', lang: l, fieldLabel: null, plural: !!goto.plural },
      };
    }
    const candidates = goto.fieldLabel ? { candidates: renameFieldCandidates(goto.fieldLabel, goto.fieldName) } : {};
    const recordName = goto.recordName ? { recordName: true, recordNameLabel: goto.recordNameLabel || null } : {};
    return { path: SETUP.renameTabs, autofill: { page: 'renameHome', lang: l, tabLabel: goto.tabLabel, fieldLabel: goto.fieldLabel || null, fieldName: goto.fieldName || null, plural: !!goto.plural, ...candidates, ...recordName } };
  }
  if (goto.page === 'workbench' || goto.page === 'override') {
    return { path: goto.page === 'override' ? SETUP.override : SETUP.workbench, autofill: { ...goto, page: 'workbench', lang: lang || null } };
  }
  if (goto.page === 'dataTranslation') {
    return { path: SETUP.record(goto.object, goto.recordId), autofill: { page: 'dataTranslation', lang: lang || null, object: goto.object || null } };
  }
  return null;
}

/**
 * Texts to look for in the first column of Rename Tabs Step 2, best first. That column shows the
 * Salesforce master label, which differs from a renamed describe label (DV2: Account.BillingAddress
 * is "Billing Address/Account Address" in the describe, "Billing Address" on Step 2).
 */
export function renameFieldCandidates(fieldLabel, fieldName) {
  const out = [fieldLabel, fieldName];
  for (const part of String(fieldLabel || '').split('/')) out.push(part);
  // API name as words: BillingAddress → Billing Address, AccountId → Account Id → Account.
  const words = String(fieldName || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  out.push(words);
  if (/ Id$/.test(words)) out.push(words.slice(0, -3));
  return [...new Set(out.map((s) => String(s || '').trim()).filter(Boolean))];
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
  // A short highlight ("ANZ") only matches whole words: inside other words ("ganz") it is noise (DV2 R-02).
  if (needle.length >= 3 && (needle.length >= 5 ? c.includes(needle) : wordContains(c, needle))) return 'partial';
  // Selected text contains the candidate, e.g. "Edit Industry" contains "Industry".
  if (c.length >= 4 && c.length / needle.length >= 0.4 && wordContains(needle, c)) return 'partial';
  return null;
}

// A custom label whose value is a URL or path ("/lightning/page/home") is a setting, not page text: only an
// exact match counts (C-05: it ranked first among Home's similar texts).
const URL_VALUE = /^(\/|https?:\/\/)/i;
function labelMatch(needle, value) {
  const mt = matchType(needle, value);
  return mt === 'partial' && URL_VALUE.test(String(value ?? '').trim()) ? null : mt;
}

function wordContains(haystack, word) {
  // Every occurrence: "ganz anz" holds the word "anz" at its second one.
  for (let i = haystack.indexOf(word); i >= 0; i = haystack.indexOf(word, i + 1)) {
    const before = i === 0 ? ' ' : haystack[i - 1];
    const after = i + word.length >= haystack.length ? ' ' : haystack[i + word.length];
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
  }
  return false;
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
  // FeedItem (feed actions) and Global (global actions) are not the page's objects.
  return out.filter((o) => !['home', 'FeedItem', 'Global'].includes(o)).slice(0, 3);
}

/**
 * The object a dialog title names ("Add Opportunity Team Members" → OpportunityTeamMember): the object whose
 * plural or singular label is the longest whole-word part of the title. Null when none is.
 * A picklist inside a dialog opens its options in a popup outside the dialog (UAT2 Add Opportunity Team
 * Members: a[role=option] < div[data-aura-class=uiPopupTarget], nothing names the object), so the title does.
 */
export function objectFromTitle(title, objects = []) {
  const words = (s) => normalize(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const t = ` ${words(title)} `;
  let best = null;
  let bestLen = 0;
  for (const o of objects || []) {
    for (const l of [o.labelPlural, o.label]) {
      const n = words(l);
      if (n && n.length > bestLen && t.includes(` ${n} `)) {
        best = o.name;
        bestLen = n.length;
      }
    }
  }
  return best;
}

/** Turns raw tag names from the clicked element's path into named UI areas. */
export function detectAreas(hints = {}) {
  const tags = hints.tags || [];
  const has = (re) => tags.some((t) => re.test(t));
  const areas = new Set();
  if (has(/^one-app-nav-bar/)) areas.add('navTab');
  // The app name left of the nav items (DV2: h1.appName inside one-appnav, outside one-app-nav-bar).
  else if (has(/^one-appnav$/)) areas.add('appName');
  if (has(/layout-section$/) && !has(/layout-item$/)) areas.add('layoutSection');
  // Aura record layout (DV2 Event Details, checked live): span < button < h3.slds-section__title < legend <
  // fieldset[data-aura-class="forcePageBlockSection ..."] < div.forcePageBlock. Fields are forcePageBlockItem.
  const aura = hints.auraClasses || [];
  const inAuraField = aura.includes('forcePageBlockItem') || (hints.selectionNames || []).some((s) => s.startsWith('sfdc:RecordField.'));
  if (aura.includes('forcePageBlockSection') && has(/^(h[1-6]|legend)$/) && !inAuraField) areas.add('layoutSection');
  if (has(/^(flowruntime-|lightning-flow)/)) areas.add('flow');
  // A tab's own label, not anything inside its content (bug: a field section inside the
  // Details tab was reported as "Lightning page tab label").
  // A role=tab must be in a page tab bar (lightning-tab-bar) that is nearer than any tab panel: the Chatter
  // publisher's own Post/Poll tabs (Aura div[role=tablist]) inside a page's Chatter tab are not tab labels
  // (DV2, checked live: a[role=tab] < ... < flexipage-tab2[role=tabpanel] < lightning-tabset, no tab bar).
  const tabBarAt = tags.indexOf('lightning-tab-bar');
  const tabPanelAt = tags.findIndex((t) => /^flexipage-tab\d*$/.test(t));
  const onPageTabBar = tabBarAt >= 0 && (tabPanelAt < 0 || tabBarAt < tabPanelAt);
  if (hints.tabRole ? hints.tabRole === 'tab' && onPageTabBar : has(/^(flexipage-tab|lightning-tab-bar)/)) {
    areas.add('lightningPageTab');
  }
  // Dynamic Forms field section header (not a field inside it).
  if (has(/^flexipage-field-section/) && !has(/^(flexipage-field$|record_flexipage-record-field)/)) areas.add('fieldSection');
  // A related list's title bar only; rows and cells inside the list are record data or child fields
  // (bug: "Sales Representative" in Opportunity Team got the "Related list title" card).
  // hints.listHeader is null/undefined from older content.js: keep the old behaviour then.
  if (has(/^(lst-related-list|force-related-list)/)) areas.add(hints.listHeader === false ? 'relatedListRow' : 'relatedList');
  // Record highlights panel (records-highlights2): the object name above the record name, or the record name.
  // A field (label or value) in the highlights panel is 'highlightsField' (DV2: "Account Number" there).
  if (has(/^records-(lwc-)?highlights/)) {
    areas.add(hints.recordTitle ? 'recordTitle' : has(/^records-highlights-details-item$/) ? 'highlightsField' : 'highlights');
  }
  if (hints.helpIcon) areas.add('helpIcon');
  // The error popup of a failed save (content.js hints.errorPopover): its heading is Salesforce's.
  if (hints.errorPopover) areas.add(hints.errorPopover === 'header' ? 'errorPopoverHeader' : 'errorPopover');
  // Salesforce's own components on a record page (component ids seen in the UAT2 Account page DOM).
  const comps = [...(hints.componentIds || []), ...(hints.sfComponents || [])];
  const comp = (re) => comps.some((c) => re.test(c));
  if (comp(/^runtime_sales_activities/)) areas.add('activityTimeline');
  if (comp(/^runtime_sales_merge/)) areas.add('duplicates');
  if (comp(/^forceChatter_/)) areas.add('feed');
  // A utility item's label (its button, or the open panel's title) sits inside the item's component
  // (div[flexipageComponent][tsn=flexipage_richText] in the dev org Sales app): that is no text of the component.
  const utilityLabel = aura.includes('oneUtilityBarItem') || (aura.includes('oneUtilityBarPanel') && tags.slice(0, 3).includes('h2'));
  if (comp(/^flexipage_reportChart/) && !utilityLabel) areas.add('reportChart');
  // Lightning App Builder Rich Text component (dev org, checked live: p < div.uiOutputRichText <
  // div[data-aura-class=flexipageRichText] < flexipage-aura-wrapper < flexipage-component2).
  if (!utilityLabel && (aura.includes('flexipageRichText') || has(/^flexipage-rich-?text/) || comp(/^flexipage_richText/))) areas.add('richText');
  // Path: the guidance is in Aura divs (no custom tag names), so read their data-aura-class too.
  // Verified on a UAT2 Opportunity (Nov 2026): runtime_sales_pathassistantPathAssistantInfo wraps "Guidance for Success".
  if (has(/(^lightning-path|pathassistant)/) || aura.some((a) => /pathassistant/i.test(a))) areas.add('path');
  if (aura.some((a) => /pathassistantPathAssistantInfo/i.test(a)) || has(/pathassistant-?info/i)) areas.add('pathGuidance');
  // Path parts by page marker, so they are found in every language (dev org, checked live Nov 2026):
  // - the step button (Mark Stage as Complete, Mark as Current Stage, Select Closed Stage):
  //   span < button.slds-path__mark-complete < div < div[data-aura-class=runtime_sales_pathassistantPathAssistantHeader];
  // - the generic last step: span < a < li[data-target-selection-name=closedPathTab] (content.js keeps it in componentIds);
  // - the headings "Key Fields" and "Guidance for Success": an h2 in …PathAssistantFields / …PathAssistantInfo,
  //   outside the guidance text (div.uiOutputRichText).
  // A path with no path assistant marker (lightning-path, an LWC) is 'pathNoMarker': English words only there.
  if (areas.has('path')) {
    if (!aura.some((a) => /^runtime_sales_pathassistant/.test(a))) areas.add('pathNoMarker');
    if (aura.includes('runtime_sales_pathassistantPathAssistantHeader')) areas.add('pathButton');
    if ((hints.componentIds || []).includes('closedPathTab')) areas.add('pathClosed');
    const inCoach = aura.some((a) => /^runtime_sales_pathassistantPathAssistant(Info|Fields)$/.test(a));
    if (inCoach && tags.slice(0, 5).includes('h2') && !aura.includes('uiOutputRichText')) areas.add('pathHeading');
  }
  // Calendar page (DV2 /lightning/o/Event/home, checked live): Salesforce's own Aura calendar. Header buttons
  // (button.new-event-button carries no action name: it is not the NewEvent global action), day headers
  // (forceCalendarDayHeader) and the sidebar (calendarListPanel > calendarListItem). Event boxes
  // (runtime_calendar-timed-event; all-day strip runtime_calendar-horizontal-layout-display) show record data.
  // Global header (DV2, checked live): header[data-aura-class=oneHeader] holds search, notifications and the
  // event reminder popup (div[data-aura-class=unsCardQueue]). The nav bar and app name are not part of it.
  if (!areas.has('navTab') && !areas.has('appName') && (aura.some((a) => /^(oneHeader|unsCardQueue|forceSearchDesktopHeader)$/.test(a)) || has(/^(one-header|search_dialog-)/))) {
    areas.add('globalHeader');
    if (aura.some((a) => /^(unsCardQueue|unsNotificationCardFrame)$/.test(a))) areas.add('headerNotification');
  }
  if (has(/^runtime_calendar-[\w-]*event$/)) areas.add('calendarEvent');
  if (aura.some((a) => /^(forceCalendar|calendarHome)/.test(a)) && !has(/^runtime_calendar-/)) {
    areas.add('calendar');
    if (aura.includes('calendarListItem')) areas.add('calendarList');
    // My Events is Salesforce's own calendar: its checkbox is input#calendarToggle-03A0000000000000001 in every
    // org and language (dev org, checked live). content.js sends that Id as hints.calendarId.
    if (areas.has('calendarList') && hints.calendarId === MY_EVENTS_CALENDAR_ID) areas.add('calendarOwn');
  }
  // Pipeline Inspection (UAT2 /lightning/o/Opportunity/pipelineInspection, checked live Nov 2026): Salesforce's own
  // page in div[data-aura-class=runtime_pipeline_inspectorPipelineInspectorHome]. Metric tiles
  // (runtime_pipeline_inspector-kpi-panel), filters (runtime_pipeline_inspectorHighlightPanel), Metrics picker and
  // buttons (runtime_pipeline_inspectorActionsBar, ...RecordsView) are Salesforce text. The view name is a list view
  // (lst-list-view-picker), the h1 above it is the object name, and the list status line ("0 items • Filtered by
  // Close Date, Type") is force-list-view-manager-status-info. The list rows hold field labels and record values.
  if (aura.some((a) => /^runtime_pipeline_inspector/.test(a)) || has(/^runtime_pipeline_inspector-/)) {
    areas.add('pipelineInspection');
    if (has(/^lst-list-view-picker/)) areas.add('pipelineView');
    else if (has(/^force-list-view-manager-status-info$/)) areas.add('pipelineStatus');
    else if (has(/^(th|td|table|lightning-datatable)$/)) areas.add('pipelineGrid');
    else if (has(/^h1$/)) areas.add('pipelineObjectName');
    if (has(/^runtime_pipeline_inspector-kpi-panel$/)) areas.add('pipelineMetric');
  }
  // Utility bar (UAT2, checked live): span.itemTitle < button < div[oneUtilityBarItem] <
  // div[flexipageComponent][tsn=runtime_sales_todo_list_unifiedToDoListAuraWrapper] < ul.slds-utility-bar; an open
  // item's panel title is h2.panelTitle < div[oneUtilityBarPanel]. Item labels are set in App Manager → Utility Items.
  // Only the label: the item's button, or the open panel's own title (not the records listed in the panel).
  // The open panel is outside the item's component (dev org, checked live: h2.panelTitle < … < div[oneUtilityBarPanel]
  // < div[oneUtilityBarContainer]); content.js sends the component inside the panel as hints.utilityPanelComponent
  // (To Do List: div[data-aura-class=runtime_sales_todo_listUnifiedToDoListAuraWrapper]).
  if (utilityLabel) {
    areas.add('utilityBar');
    if (comp(/^runtime_sales_todo_list/) || /^runtime_sales_todo_list/.test(hints.utilityPanelComponent || '')) areas.add('utilityToDo');
  }
  // File upload area of the Files related list (UAT2, checked live): "Upload Files" / "Or drop files" are a span <
  // label < lightning-primitive-file-droppable-zone < lightning-input < div[forceContentFileDroppableZone].
  if (aura.includes('forceContentFileDroppableZone') || has(/^lightning-primitive-file-droppable-zone$/)) areas.add('fileUpload');
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

// ---------- master labels (another language than the org default) ----------
// Describes hold the labels of the language you view; Translation Workbench and Object Manager list items by
// their master label (dev org, French: the row "Paint Color" holds "Couleur de peinture"). org.masterDescribes
// (background.js, sfApi.loadMasterDescribe) holds the master labels, by object API name.

const masterObject = (org, objectName) => (isDefaultLanguage(org) ? null : org.masterDescribes?.[objectName] || null);
const masterField = (org, objectName, fieldName) => masterObject(org, objectName)?.fields?.find((x) => x.name === fieldName) || null;

/** Master label of a field: its describe label in the default language, else from the master describe (or null). */
function masterFieldLabel(org, d, f) {
  return isDefaultLanguage(org) ? f.label : masterField(org, d.name, f.name)?.label || null;
}

/** "Label (API_Name)", or the API name alone when the label is not known. */
const labelAndApi = (label, api) => (label && label !== api ? `${label} (${api})` : api);

/**
 * Where the master label is edited, for every language. Default language: the labels you see. Another
 * language: master labels with API names, since the page shows translations.
 * `d` is the object describe, `f` the field (or null), `tail` the last steps, e.g. 'Values → Edit'.
 */
function objectManagerNote(org, prefix, d, f, tail) {
  if (isDefaultLanguage(org)) return `${prefix}: Object Manager → ${d.label}${f ? ` → Fields → ${f.label}` : ''} → ${tail}.`;
  const obj = labelAndApi(masterObject(org, d.name)?.label, d.name);
  const field = f ? ` → Fields → ${labelAndApi(masterField(org, d.name, f.name)?.label, f.name)}` : '';
  return `${prefix.replace(/ \(default language\)$/, '')} (${languageName(org.defaultLanguage)}): Object Manager → ${obj}${field} → ${tail}.`;
}

/** Workbench row of a field: its label in the default language; else its master label and API name. */
function fieldRow(org, d, f) {
  if (isDefaultLanguage(org)) return { row: f.label };
  const master = masterFieldLabel(org, d, f);
  return { row: labelAndApi(master || f.label, f.name), rows: [master, f.name, f.label] };
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
export function workbench(org, { component, object, objectLabel, aspect, row, rows, pkg, parent }) {
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
  if (obj.custom) notes.push(objectManagerNote(org, 'Master label (default language)', obj, null, 'Edit'));
  return {
    key: `object:${obj.name}`,
    source: SOURCE.RENAME_TABS,
    confidence,
    title: `${obj.custom ? 'Custom' : 'Standard'} object name: ${obj.label}`,
    subtitle: `API name ${obj.name}`,
    steps: [
      ...renameSteps(org, { custom: obj.custom, tabLabel: tab?.Label || obj.labelPlural }),
      `${obj.custom ? 'On that page' : 'Step 1 page'}: change the ${plural ? 'Plural' : 'Singular'} name, then Save`,
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

/**
 * One card for every text Salesforce writes and translates itself. Same title and first step everywhere;
 * `subtitle` says what was found, `steps` adds an optional "to show different text" fix.
 */
export const SALESFORCE_TEXT = {
  title: 'Salesforce text',
  step: 'Salesforce writes and translates this text. Admins cannot change or translate it.',
};

function salesforceTextResult(key, confidence, extra = {}) {
  return {
    key,
    source: SOURCE.SALESFORCE,
    confidence,
    url: null,
    notes: [],
    ...extra,
    title: SALESFORCE_TEXT.title,
    steps: [SALESFORCE_TEXT.step, ...(extra.steps || [])],
  };
}

function systemFieldResult(d, f, confidence, what = 'System field') {
  return {
    ...salesforceTextResult(`field:${d.name}.${f.name}`, confidence, { subtitle: `${what} ${d.name}.${f.name}` }),
    url: SETUP.objectFields(d.name),
    copy: `${d.name}.${f.name}`,
  };
}

/**
 * The Step 2 (master) label of a renamed standard field, when the label proves it: one "/" part equals the
 * API name as words (DV2 R-01: BillingAddress "Billing Address/Account Address" is "Billing Address" on Step 2).
 */
function renamedMasterLabel(f) {
  const parts = String(f.label || '').split('/').map((s) => s.trim());
  if (parts.length < 2) return null;
  const words = normalize(String(f.name || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
  return parts.find((p) => normalize(p) === words) || null;
}

/** "Its label in Salesforce is …", or the label the page shows when it differs (R-05: "Account Record Type"). */
function fieldLabelNote(prefix, d, f, hints = {}) {
  const hl = hints.highlightsLabel;
  const shown = hl && displayLabels(d, f).some((l) => normalize(l) === normalize(hl)) ? hl : f.name === 'RecordTypeId' ? `${d.label} Record Type` : null;
  if (shown && normalize(shown) !== normalize(f.label)) return `${prefix} The page shows it as "${shown}"; its API label is "${f.label}".`;
  return `${prefix} Its label in Salesforce is "${f.label}".`;
}

function fieldLabelResult(org, d, f, confidence) {
  if (SYSTEM_FIELDS.has(f.name)) return systemFieldResult(d, f, confidence);
  // A custom object's standard fields (Owner ID, Record Type ID, Deleted) are Salesforce's own; Rename Tabs
  // and Labels was the wrong place for them (dev org A-10, A-13). Its Name field keeps the Rename Tabs card.
  if (!f.custom && d.custom && f.name !== 'Name') return systemFieldResult(d, f, confidence, 'Standard field');
  // A custom object's Name field: Rename Tabs and Labels → Custom Tabs → Edit shows it as "Record Name" on
  // the object's own page, next to the object names; there is no Step 2 (seen in an org, Polish, Nov 2026).
  if (!f.custom && d.custom) {
    const tabLabel = d.labelPlural || d.label;
    return {
      key: `field:${d.name}.${f.name}`,
      source: SOURCE.RENAME_TABS,
      confidence,
      title: `Record name label: ${d.label} → ${f.label}`,
      subtitle: `API name ${d.name}.${f.name}`,
      steps: [
        ...renameSteps(org, { custom: true, tabLabel }),
        `On that page: change "Record Name" (now "${masterFieldLabel(org, d, f) || f.label}"), then Save`,
      ],
      url: SETUP.renameTabs,
      goto: { page: 'rename', object: d.name, custom: true, tabLabel, recordName: true, recordNameLabel: masterFieldLabel(org, d, f) || f.label },
      copy: `${d.name}.${f.name}`,
      notes: [],
    };
  }
  if (!f.custom) {
    // Step 2 lists fields by their master label: in another language, the master describe's label.
    const shownLabel = f.label;
    f = { ...f, label: masterFieldLabel(org, d, f) || f.label };
    return {
      key: `field:${d.name}.${f.name}`,
      source: SOURCE.RENAME_TABS,
      confidence,
      title: `Standard field label: ${d.label} → ${shownLabel}`,
      subtitle: `API name ${d.name}.${f.name}`,
      steps: [
        ...renameSteps(org, { custom: false, tabLabel: d.labelPlural || d.label }),
        'On the Step 1 page, click Next (do not change anything)',
        renamedMasterLabel(f)
          ? `Step 2 page: find "${renamedMasterLabel(f)}" (shown on the page as "${f.label}"), change it, then Save`
          : `Step 2 page: find "${f.label}", change it, then Save`,
      ],
      url: SETUP.renameTabs,
      goto: { page: 'rename', object: d.name, custom: d.custom, tabLabel: d.labelPlural || d.label, fieldLabel: f.label, fieldName: f.name },
      copy: `${d.name}.${f.name}`,
      notes: [],
    };
  }
  const notes = [objectManagerNote(org, 'Master label (default language)', d, f, 'Edit')];
  if (f.type === 'reference') notes.push('Related list title for this lookup: same screen, Aspect "Related List Label".');
  return {
    key: `field:${d.name}.${f.name}`,
    source: SOURCE.WORKBENCH,
    confidence,
    title: `Custom field label: ${d.name}.${f.name}`,
    subtitle: `"${f.label}"`,
    ...workbench(org, { component: 'Custom Field', object: d.name, objectLabel: d.label, aspect: 'Field Label', ...fieldRow(org, d, f), pkg: namespaceOf(f.name) }),
    copy: `${d.name}.${f.name}`,
    notes,
  };
}

function helpTextResult(org, d, f, confidence) {
  const base = f.custom
    ? workbench(org, { component: 'Custom Field', object: d.name, objectLabel: d.label, aspect: 'Help Text', ...fieldRow(org, d, f), pkg: namespaceOf(f.name) })
    : workbench(org, { component: 'Standard Field Help', object: d.name, objectLabel: d.label, ...fieldRow(org, d, f) });
  return {
    key: `help:${d.name}.${f.name}`,
    confidence,
    title: `Help text for ${d.name}.${f.name}`,
    subtitle: `"${truncate(f.inlineHelpText, 80)}"`,
    ...base,
    copy: `${d.name}.${f.name}`,
    notes: [objectManagerNote(org, 'Master text', d, f, 'Edit')],
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
  // The Workbench tree lists values (and their fields) by master label: in another language, read from the
  // master describe or the field's metadata (both master), else the API value, which is often the same.
  const other = !isDefaultLanguage(org);
  const pvKnown = other
    ? masterField(org, d.name, f.name)?.picklistValues?.find((v) => v.value === pv.value)?.label || (vs?.values || []).find((v) => v.value === pv.value)?.label || null
    : pv.label;
  const pvMaster = pvKnown || pv.value;
  const fieldMaster = other ? masterFieldLabel(org, d, f) || f.label : f.label;
  const valueRows = [...new Set([pvMaster, pv.value, pv.label])];
  if (vs?.name) {
    const vsLabel = vs.label || vs.name;
    return {
      key: `picklist:${d.name}.${f.name}.${pv.value}`,
      confidence,
      title: `Global value set ${vsLabel}: picklist value`,
      subtitle: `"${pv.label}" (API value: ${pv.value}), used by ${d.name}.${f.name}`,
      ...workbench(org, { component: 'Global Value Set', row: `${pvMaster} (value set: ${vsLabel})`, rows: valueRows, pkg: vs.namespace || null, parent: vsLabel }),
      copy: pv.value,
      notes: [
        'One translation for every field that uses this value set.',
        'Setup Component "Picklist Value" does not list values of a global value set.',
        `Master label${other ? ` (${languageName(org.defaultLanguage)})` : ''}: Setup → Picklist Value Sets → ${vsLabel} → Values → Edit.`,
      ],
    };
  }
  // The note only when the value set was not read: a standard picklist never uses a Global Value Set, and
  // a read value set without a name is the field's own (A-03, A-24).
  const notes = f.custom && !vs ? ['If the field uses a Global Value Set, pick Setup Component "Global Value Set" instead.'] : [];
  if (!pv.active) notes.push('This value is inactive.');
  if (other && pvKnown) notes.push(`Master label of this value: "${pvKnown}".`);
  notes.push(objectManagerNote(org, 'Master label', d, f, 'Values → Edit'));
  return {
    key: `picklist:${d.name}.${f.name}.${pv.value}`,
    confidence,
    title: `Picklist value on ${d.name}.${f.name}`,
    subtitle: `"${pv.label}" (API value: ${pv.value})`,
    ...workbench(org, { component: 'Picklist Value', object: d.name, objectLabel: d.label, row: `${pvMaster} (field: ${fieldMaster})`, rows: valueRows, pkg: namespaceOf(f.name), parent: fieldMaster }),
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
    return { ...salesforceTextResult(base.key, 'confirmed', { subtitle: `Currency name in ${d.label} → ${f.label}` }), url: base.url, copy: base.copy };
  }
  if (f.autoNumber) {
    return {
      ...base,
      title: `Auto-number: generated by Salesforce (${d.label} → ${f.label})`,
      subtitle: `${d.name}.${f.name} is an auto-number field`,
      steps: [
        'Salesforce generates this value from the field\'s display format. It is not translated.',
        `To change its prefix or format: Object Manager → ${d.label} → Fields → ${f.label} → Edit → Display Format (new records only).`,
      ],
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
    steps: [...RECORD_DATA_STEPS],
  };
}

const RECORD_DATA_STEPS = [
  'Translation tools do not change values that people type on records.',
  'If every user must see it in their language, use a picklist field instead, or Data Translation where the object supports it.',
];

/** An event box on the Calendar page shows the Event's Subject (DV2: a.subject-link in runtime_calendar-timed-event). */
function calendarEventResult() {
  return {
    key: 'value:Event.Subject',
    source: SOURCE.NOT_TRANSLATABLE,
    confidence: 'confirmed',
    title: 'Record data: Event subject',
    subtitle: 'An event on the calendar shows its Subject, typed on the event',
    steps: [...RECORD_DATA_STEPS],
    url: SETUP.objectFields('Event'),
    copy: 'Event.Subject',
    notes: [],
  };
}

/**
 * A picklist field's value on the record that matched none of its values. `allKnown`: the full value
 * list, inactive values included, was read from the field metadata; otherwise only active values are known.
 */
function notInPicklistResult(d, f, allKnown) {
  return {
    key: `value:${d.name}.${f.name}`,
    source: SOURCE.NOT_TRANSLATABLE,
    confidence: allKnown ? 'confirmed' : 'exact',
    title: `${allKnown ? 'Not a value' : 'Not an active value'} of the picklist ${d.label} → ${f.label}`,
    subtitle: 'This value is stored on the record',
    steps: allKnown
      ? [
          'This value is stored on the record but is not a value of this picklist (unrestricted picklist, or imported data).',
          'Add it as a picklist value or fix the data. Then translate it in Translation Workbench → Picklist Value.',
        ]
      : [
          'This value is stored on the record but is not an active value of this picklist.',
          'If it is an inactive value, translate it in Translation Workbench → Picklist Value (inactive values are listed there).',
          'Otherwise it was saved in an unrestricted picklist or imported: add it as a picklist value or fix the data, then translate it in Translation Workbench → Picklist Value.',
        ],
    url: SETUP.objectFields(d.name),
    copy: `${d.name}.${f.name}`,
    notes: [],
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
  // Another language: the Workbench row is the master name (master describe), with the API name.
  const master = isDefaultLanguage(org) ? null : masterObject(org, d.name)?.recordTypeInfos?.find((x) => x.developerName === rt.developerName)?.name || null;
  const row = isDefaultLanguage(org) ? { row: rt.name } : { row: labelAndApi(master || rt.name, rt.developerName), rows: [master, rt.developerName, rt.name] };
  return {
    key: `rt:${d.name}.${rt.developerName}`,
    confidence,
    title: `Record type ${d.name}.${rt.developerName}`,
    subtitle: `"${rt.name}"`,
    ...workbench(org, { component: 'Record Type', object: d.name, objectLabel: d.label, aspect: 'Field Label', ...row }),
    copy: rt.developerName,
    notes: [],
  };
}

function quickActionResult(org, object, objectLabel, qa, confidence) {
  return {
    // A global action is "Global.NewContact" in page metadata and "NewContact" in the describe: one key (DV2-10).
    key: `qa:${String(qa.name || '').replace(/^Global\./, '')}`,
    confidence,
    title: `Quick action ${qa.name}`,
    subtitle: qa.label ? `"${qa.label}"` : '',
    ...workbench(org, { component: 'Action', object, objectLabel, aspect: 'Field Label', row: qa.label || qa.name, rows: [qa.label, qa.name.split('.').pop()], pkg: namespaceOf(qa.name) }),
    copy: qa.name,
    notes: [],
  };
}

// Global actions Salesforce creates with every org. Translation Workbench → Action does not list them
// (DV2, German, Object Global: 9 rows, all custom; none of these), and Salesforce translates their labels.
const STANDARD_GLOBAL_ACTIONS = new Set(['NewTask', 'NewContact', 'NewCase', 'NewEvent', 'NewAccount', 'NewLead', 'NewOpportunity', 'LogACall', 'NewNote', 'NewGroup', 'SendEmail']);

const isStandardGlobalAction = (name) => STANDARD_GLOBAL_ACTIONS.has(String(name || '').replace(/^Global\./, ''));

/** A Salesforce standard action (global or feed) that TW → Action does not list. */
function standardActionResult(object, name, confidence, label) {
  const feed = object === 'FeedItem';
  return salesforceTextResult(`stdaction:${object}.${name}`, confidence, {
    subtitle: `Standard ${feed ? 'feed' : 'global'} action ${object}.${name}`,
    steps: [feed ? 'To show different text, use a custom quick action instead, then translate that.' : 'To show different text, create a custom global action and translate that.'],
    copy: `${object}.${name}`,
  });
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

/**
 * Active validation rules of an object that show their message under this field (Tooling ValidationRule
 * ErrorDisplayField; metadata names it errorDisplayField, the field's API name). Compared without case,
 * with or without the object prefix.
 */
function errorRulesOfField(org, objectName, fieldName, labels = []) {
  const want = new Set([fieldName, ...labels].filter(Boolean).map((x) => String(x).toLowerCase()));
  return (org.validationRules || []).filter((vr) => {
    if (vr.EntityDefinition?.QualifiedApiName !== objectName) return false;
    const df = String(vr.ErrorDisplayField || '').toLowerCase();
    return !!df && (want.has(df) || want.has(df.split('.').pop()));
  });
}

// Salesforce's own field messages (English). Only a shortcut: no page marker tells them from a validation rule's
// message (both are div.slds-form-element__help). In another language the field's rules are listed as 'context'.
const SF_FIELD_ERRORS = ['complete this field.', 'complete this field', 'enter a valid value.', 'this field is required.'];

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
// The heading above the guidance (Salesforce text). Highlights often start with it. English only: a highlight
// has no page marker for the part of it that is the heading (pointing at the heading itself is found by its
// marker in detectAreas, in any language). In another language a highlight with the heading still matches
// the step as 'partial' (the selection runs past the guidance).
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
 * The path a step belongs to. Step DeveloperNames seen in real orgs (Nov 2026):
 * "X<num>_<picklist value Id 01J…>_<record type Id 012… or null>_<Object>_<field without __c>",
 * the older "<Object>_<record type or null>_<field>_<01J…>_<num>", and for a custom object the object's
 * Id instead of its name, cut at 80 characters (dev org: "X…_01J…_012…_01I…_SFTL_Stat" for SFTL_Status__c).
 * A record type has one path, so its Id alone names the path. With no record type, the object (name, or
 * Id from sfApi's SobjectId) and the field (its start, when the name was cut) must match.
 */
export function pathOfStep(dn, paths = [], objects = []) {
  dn = String(dn || '');
  const cut = dn.length >= 80;
  const parts = /_01J[A-Za-z0-9]{12,15}_(012[A-Za-z0-9]{12,15}|null)_(.+)$/.exec(dn);
  const hits = (paths || []).filter((p) => {
    const field = String(p.SobjectProcessField || '').replace(/__c$/, '');
    const rts = p.RecordTypeId ? [p.RecordTypeId, p.RecordTypeId.slice(0, 15)] : ['null'];
    if (rts.some((rt) => dn.endsWith(`_${rt}_${p.SobjectType}_${field}`) || dn.startsWith(`${p.SobjectType}_${rt}_${field}_`))) return true;
    if (!parts) return false;
    const [, rt, rest] = parts;
    if (rt !== 'null') return !!p.RecordTypeId && id15(rt) === id15(p.RecordTypeId);
    if (p.RecordTypeId) return false;
    return [p.SobjectType, p.SobjectId && id15(p.SobjectId)].filter(Boolean).some((o) => {
      const full = `${o}_${field}`;
      return rest === full || (cut && rest.length > o.length + 1 && full.startsWith(rest));
    });
  });
  const path = hits.find((p) => p.IsActive) || hits[0] || null;
  if (path) return { path, object: path.SobjectType, field: path.SobjectProcessField };
  // No path data: read object and field from the name itself.
  const old = /^(.+?)_(?:012[A-Za-z0-9]{12,15}|null)_(.+?)_01J[A-Za-z0-9]{12,15}_\d+$/.exec(dn);
  if (old) return { path: null, object: old[1], field: old[2] };
  const rest = parts?.[2];
  if (!rest) return { path: null, object: null, field: null };
  // A custom object's Id (01I…) is not a name to show: keep only a field name that was not cut.
  const byId = /^01I[A-Za-z0-9]{12}(?:_(.*))?$/.exec(rest);
  if (byId) return { path: null, object: null, field: byId[1] && !cut ? byId[1] : null };
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
  const pathName = where.path?.MasterLabel || where.path?.DeveloperName || null;
  const where2 = [objectLabel, fieldLabel].filter(Boolean).join(' › ');
  const base = workbench(org, { component: 'Path Step Rich Text' });
  const notes = [];
  if (where.path && where.path.IsActive === false) notes.push('This path is inactive.');
  if (step.Language && org.defaultLanguage && step.Language !== org.defaultLanguage) notes.push(`This guidance is written in ${languageName(step.Language)}.`);
  if (isDefaultLanguage(org)) notes.push(`Master text: Setup → Path Settings → ${pathName || `the path for ${where2 || 'this step'}`} → Edit → the step's Guidance for Success.`);
  return {
    key: `path:${step.Id || step.DeveloperName}`,
    confidence,
    title: pathName ? `Path guidance: ${pathName}${where2 ? ` (${where2})` : ''}` : `Path guidance${where2 ? `: ${where2}` : ''}`,
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

const id15 = (id) => String(id || '').slice(0, 15);
const MASTER_RECORD_TYPE = '012000000000000';

/**
 * Active paths of `object` that a record of that object shows. A path belongs to one record type
 * (DV2, Nov 2026: Open_Opportunity → Sales, Specification_Path → Specification), so a record shows
 * only its own record type's path. record.recordTypeId: undefined = not known (every active path),
 * null = no record type (master). A record type without its own path falls back to a path with no
 * record type.
 */
export function pathsForRecord(paths, object, record) {
  const active = (paths || []).filter((p) => p.IsActive !== false && p.SobjectType === object);
  if (!record || record.object !== object || record.recordTypeId === undefined) return active;
  const rt = id15(record.recordTypeId);
  if (rt && rt !== MASTER_RECORD_TYPE) {
    const own = active.filter((p) => p.RecordTypeId && id15(p.RecordTypeId) === rt);
    if (own.length) return own;
  }
  return active.filter((p) => !p.RecordTypeId || id15(p.RecordTypeId) === MASTER_RECORD_TYPE);
}

/** False when the record type of the open record is known and this path is not the one it shows. */
export function pathAppliesToRecord(p, record, paths) {
  if (!p || !record || record.object !== p.SobjectType || record.recordTypeId === undefined) return true;
  return pathsForRecord(paths, p.SobjectType, record).includes(p);
}

const recordTypeName = (describes, object, rtId) =>
  describes.find((d) => d.name === object)?.recordTypeInfos?.find((rt) => rt.recordTypeId && id15(rt.recordTypeId) === id15(rtId))?.name || null;

/**
 * Pointed inside the guidance of the path this record shows (record type known): a word or short phrase
 * of that guidance (R-34: "information") is that guidance, even below MIN_PATH_NEEDLE.
 */
function inOwnPathGuidance(org, step, needle, areas, record) {
  if (!areas.has('pathGuidance') || !record || record.recordTypeId === undefined) return false;
  const n = stripGuidanceHeading(needle);
  if (n.length < 3) return false;
  const where = pathOfStep(step.DeveloperName, org.paths, org.objects);
  if (!where.path || where.path.SobjectType !== record.object) return false;
  if (!pathsForRecord(org.paths, record.object, record).includes(where.path)) return false;
  return wordContains(htmlLines(step.Info).map(normalize).filter(Boolean).join(' '), n);
}

function pathResults(org, needle, areas, describes, add, rawText, record) {
  const pageObjects = new Set(describes.map((d) => d.name));
  const steps = (org.pathSteps || []).map((step) => {
    const direct = pathStepMatch(needle, step.Info, rawText);
    return { step, direct, word: !direct && inOwnPathGuidance(org, step, needle, areas, record) };
  });
  // A word in the guidance of several steps: the page shows one of them, so confirm none.
  const wordSteps = steps.filter((s) => s.word).length;
  for (const { step, direct, word } of steps) {
    const mt = direct || (word ? 'exact' : null);
    if (!mt) continue;
    if (word && wordSteps > 1) {
      const r = pathStepResult(org, step, pathOfStep(step.DeveloperName, org.paths, org.objects), describes, 'exact');
      r.notes = ['These words are in the guidance of several steps of this path.', ...r.notes];
      add(r);
      continue;
    }
    const where = pathOfStep(step.DeveloperName, org.paths, org.objects);
    // A path for another object can share a line ("Who else needs to be contacted?"): never confirm it.
    const otherObject = where.object && pageObjects.size && !pageObjects.has(where.object);
    // A path of another record type is not on this page (DV2: Specification Path guidance confirmed on a Sales Opportunity).
    const otherRecordType = !otherObject && where.path && !pathAppliesToRecord(where.path, record, org.paths);
    let confidence = mt;
    if (!otherObject && !otherRecordType && (areas.has('pathGuidance') || (areas.has('path') && mt === 'exact'))) confidence = 'confirmed';
    else if (otherObject) confidence = 'partial';
    const r = pathStepResult(org, step, where, describes, confidence);
    if (otherRecordType) {
      const rtName = recordTypeName(describes, where.path.SobjectType, where.path.RecordTypeId);
      r.notes = [`This guidance is for ${rtName ? `record type ${rtName}` : 'another record type'}, not this record.`, ...r.notes];
    }
    add(r);
  }
}

// ---------- hint-only results (from page metadata, no text match needed) ----------

/**
 * Text in a running flow. pageComponent.flow (background.js, from the page's Flow component and the
 * flow's active version) gives the flow, screen and screen component: TW → Flow lists display text under
 * Flow Component "Screen Component" with Aspect "Description", an input's label with Aspect "Label"
 * (dev org B-13, checked by hand). Without it, the card names what is known and never uses an
 * instruction as a row name.
 */
/**
 * How the text matches a screen component's text. Display text counts as 'exact' only for the whole text
 * or one whole line (paragraph, list item) of it, the rule path guidance uses; a phrase inside a line is
 * 'partial' ("Next" in "<p>Click Next to continue.</p>").
 */
function flowTextMatch(needle, f) {
  if (!needle || !f.fieldText) return null;
  if (f.fieldType !== 'DisplayText') return matchType(needle, f.fieldText);
  const lines = htmlLines(f.fieldText).map(normalize).filter(Boolean);
  const full = lines.join(' ');
  if (!full) return null;
  if (full === needle || (needle.length >= 4 && lines.includes(needle))) return 'exact';
  return matchType(needle, full) ? 'partial' : null;
}

/**
 * The flow's navigation bar (Next, Previous, Finish, Pause): Salesforce text, unless a screen sets its
 * own label for that button (FlowScreen backButtonLabel, nextOrFinishButtonLabel, pauseButtonLabel).
 */
function flowNavigationResult(flow, needle) {
  const own = (flow?.screens || []).some((s) => (s.buttonLabels || []).some((l) => normalize(l) === needle));
  if (own) return null;
  return salesforceTextResult('sfdctext:flowNavigation', flow ? 'confirmed' : 'context', {
    subtitle: 'A button in the flow\'s navigation bar (Next, Previous, Finish, Pause)',
    steps: ['To show different text: in Flow Builder, open the screen → Configure Footer → set a custom label for the button.'],
  });
}

function flowResult(org, pc, text, hints = {}) {
  const flow = pc?.flow || null;
  const flowName = flow?.label || pc?.props?.flowName || null;
  const needle = normalize(text);
  if ((hints.tags || []).some((t) => /^flowruntime-navigation-bar/.test(t))) {
    const nav = flowNavigationResult(flow, needle);
    if (nav) return nav;
  }
  let hit = null;
  for (const s of flow?.screens || []) {
    for (const f of s.fields || []) {
      const mt = flowTextMatch(needle, f);
      if (mt === 'exact' ? !hit?.exact : mt && !hit) hit = { s, f, display: f.fieldType === 'DisplayText', exact: mt === 'exact' };
    }
  }
  const base = workbench(org, { component: 'Flow' });
  if (!hit) {
    return {
      key: 'area:flow',
      confidence: 'context',
      title: 'Flow screen text',
      subtitle: flowName ? `You pointed at text in the running flow ${flowName}` : 'You pointed at text in a running flow',
      ...base,
      steps: [...base.steps, flowName ? `Flow: ${flowName}` : 'Flow: the flow on this page', 'Flow Component: Screen Component, then the screen and the component that shows this text'],
      goto: { ...base.goto, rows: text ? [text] : [], flow: flowName ? { label: flowName, name: pc?.props?.flowName || null } : null },
      url: SETUP.workbench,
      notes: ['Flow labels referencing {!$Label...} are translated in Custom Labels instead.'],
    };
  }
  const aspect = hit.display ? 'Description' : 'Label';
  return {
    key: `flow:${flow.name}.${hit.s.name}.${hit.f.name}`,
    confidence: hit.exact ? 'confirmed' : 'partial',
    title: `Flow screen text: ${flowName}`,
    subtitle: `Screen "${hit.s.label}", component ${hit.f.name}${flow.version ? ` (version ${flow.version})` : ''}`,
    ...base,
    steps: [...base.steps, `Flow: ${flowName}`, 'Flow Component: Screen Component', `Screen: ${hit.s.label}`, `Screen Component: ${hit.f.name}`, `Aspect: ${aspect}`],
    goto: {
      ...base.goto,
      flow: { label: flowName, name: flow.name, component: 'Screen Component', screen: hit.s.label, screenName: hit.s.name, screenComponent: hit.f.name, aspect },
      rows: [hit.f.fieldText, text].filter(Boolean),
      rowMatch: hit.display ? 'richText' : null,
      rowLabel: truncate(text, 80),
    },
    url: SETUP.workbench,
    copy: hit.f.name,
    notes: [
      hit.exact
        ? `The flow on this page is ${flowName}; this text is ${hit.display ? 'the display text' : 'the label'} of its screen component ${hit.f.name}.`
        : `The flow on this page is ${flowName}; this text and the ${hit.display ? 'display text' : 'label'} of its screen component ${hit.f.name} share words.`,
    ],
  };
}

function hintResults(org, hints, describes, areas, text, pageHandled = false, pageComponent = null) {
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
        // The grid's first column shows the label (A-12): name the row by it, API name in brackets.
        ...workbench(org, { component: 'Button and Link Label', object: sn.object, objectLabel: objLabel(sn.object), row: text ? `${text} (${sn.name})` : sn.name, rows: [sn.name, text], pkg: namespaceOf(sn.name) }),
        copy: sn.name,
        notes: [],
      });
    } else if (sn.kind === 'StandardButton') {
      out.push(salesforceTextResult(`stdbtn:${sn.object}.${sn.name}`, 'confirmed', {
        subtitle: `Standard button ${sn.name}`,
        steps: ['To show different text, replace it with a custom button or quick action, then translate that.'],
        url: SETUP.objectDetails(sn.object || ''),
        copy: sn.name,
      }));
    } else if (sn.kind === 'QuickAction' && sn.object === 'FeedItem') {
      // Salesforce's own feed actions (DV2: FeedItem.ContentNote "New Note"; also TextPost, LinkPost,
      // PollPost, QuestionPost). QuickActionDefinition has no row for them, so TW → Action does not list them.
      out.push(standardActionResult('FeedItem', sn.name, 'confirmed'));
    } else if (sn.kind === 'QuickAction' && (!sn.object || sn.object === 'Global') && isStandardGlobalAction(sn.name)) {
      // Standard global actions (DV2: Global.NewContact, NewTask, NewCase, LogACall) are not in TW → Action.
      out.push(standardActionResult('Global', sn.name, 'confirmed'));
    } else if (sn.kind === 'QuickAction') {
      const name = sn.object ? `${sn.object}.${sn.name}` : sn.name;
      const r = quickActionResult(org, sn.object || 'Global', sn.object ? objLabel(sn.object) : 'Global', { name, label: text }, 'confirmed');
      // An object action missing from that object's loaded action list is not proven to be in TW → Action.
      const d = describes.find((x) => x.name === sn.object);
      if (sn.object !== 'Global' && d?.quickActions?.length && !d.quickActions.some((q) => q.name === name)) {
        r.confidence = 'exact';
        r.notes = [`${name} is not in the ${d.label} action list. It is a Salesforce standard action.`, ...r.notes];
      }
      out.push(r);
    }
  }

  const obj = contextObjects([], hints)[0] || describes[0]?.name;
  if (areas.has('layoutSection')) {
    // A heading in the path means the header itself was clicked (not blank space in the section):
    // rank it above a field that happens to share the name (bug: "Business Unit" header → field card).
    const onHeader = (hints.tags || []).some((t) => /^h[1-6]$/.test(t));
    // Another language: the Layout Section tree lists sections by their master name (the section's
    // translation in CustomObjectTranslation, background.js); the name you pointed at is its translation.
    const tr = !isDefaultLanguage(org) && text ? (org.sectionTranslations || []).filter((s) => normalize(s.label) === normalize(text)) : [];
    const masters = [...new Set(tr.map((s) => s.section))];
    out.push({
      key: 'area:layoutSection',
      confidence: onHeader ? 'confirmed' : 'context',
      title: 'Page layout section header',
      subtitle: masters.length ? `You pointed at a record page section header: "${text}"` : 'You pointed at a record page section header',
      ...workbench(org, { component: 'Layout Section', object: obj, objectLabel: obj ? objLabel(obj) : null, row: masters.join(' / ') || text || 'the section name', ...(masters.length ? { rows: [...masters, text] } : {}) }),
      notes: [
        ...(masters.length ? [`Master name of this section: "${masters.join('", "')}" (${languageName(org.defaultLanguage)}).`] : []),
        'The same section name can be in several page layouts. Go to translation opens every layout and lists each copy.',
        'If the section comes from a Dynamic Forms field section, the label is set in Lightning App Builder and is not translatable there.',
      ],
    });
  }
  if (areas.has('flow')) out.push(flowResult(org, pageComponent, text, hints));
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
    const base = workbench(org, { component: 'Custom Field', objectLabel: 'the child object', aspect: 'Related List Label', row: text || 'the lookup field' });
    out.push({
      key: 'area:relatedList',
      confidence: 'context',
      title: 'Related list title',
      subtitle: 'Comes from the lookup field that links the two objects',
      ...base,
      // The child object is not known here: auto-fill leaves Object for you (B-10: it kept the parent).
      goto: { ...base.goto, objectLabel: null, rows: text ? [text] : [] },
      notes: ['For standard relationships, the title is the plural object name: use Rename Tabs and Labels.'],
    });
  }
  if (areas.has('richText')) {
    out.push({
      key: 'area:richText',
      source: SOURCE.NOT_TRANSLATABLE,
      confidence: 'confirmed',
      title: 'Rich text typed in Lightning App Builder',
      subtitle: 'Text of a Rich Text component on this Lightning page',
      steps: [
        'The text of a Rich Text component is typed in Lightning App Builder. Salesforce does not translate it.',
        'To translate it, an admin replaces the component with one that shows a Custom Label (for example a custom Lightning component that reads $Label), then translates that label.',
        'Or: one Rich Text component per language, each with a Component Visibility filter on the user\'s Language.',
      ],
      url: SETUP.customLabels,
      notes: [],
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
  return salesforceTextResult('setup:builtin', 'context', {
    steps: ['To see it in another language, change your personal language: your profile picture → Settings → Language & Time Zone.'],
  });
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
      ...relatedListFallbackStep(org, pc),
    ],
    url: same ? SETUP.customLabel(same.Id) : SETUP.customLabels,
    copy: ref,
    notes: [],
  };
}

/**
 * A related list whose label was typed (DV2 Opportunity page: Dynamic Related Lists "Involved Parties",
 * "Showpad Activities", "PPG Tech"): with the label cleared, the list shows its standard title, which is translated.
 */
function relatedListFallbackStep(org, pc) {
  if (!RELATED_LIST_COMPONENTS.has(pc.component)) return [];
  const api = String(pc.props?.relatedListApiName || '');
  const c = pc.child;
  if (c?.childSObject && c.field) {
    const objectLabel = c.objectLabel || (org.objects || []).find((o) => o.name === c.childSObject)?.label || c.childSObject;
    // A managed package's lookup field (DV2: ShowpadForSF__…) is translated in Workbench → Override.
    const pkg = namespaceOf(c.field);
    const tool = pkg ? `Translation Workbench → Override (package ${pkg})` : 'Translation Workbench';
    return [
      `Or clear the ${pcKind(pc).field} → Save: the list then shows the Related List Label of the lookup field ${c.fieldLabel || c.field} on ${objectLabel} (${c.childSObject}.${c.field}), which is translated in ${tool} → Custom Field → ${objectLabel} → Related List Label.`,
    ];
  }
  if (api && !/__r$/.test(api)) {
    return [`Or clear the ${pcKind(pc).field} → Save: the list then shows its standard title (${api}). An object's plural name there is translated in Rename Tabs and Labels; other standard titles are Salesforce text.`];
  }
  return [];
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
    ...salesforceTextResult(`sfdcname:${pc.page}.${pc.id}`, 'confirmed'),
    subtitle: `Standard ${kind.part} name "${name}" on the Lightning page ${pc.page} (stored as ${pc.label})`,
    steps: [
      SALESFORCE_TEXT.step,
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

// A related list read from the page metadata names its page; one in the standard Related Lists component
// is known by its title link only (background.js, page: null).
const onPage = (pc) => (pc.page ? ` on the Lightning page ${pc.page}` : ' in the Related Lists component');

/**
 * Related list with no label of its own (UAT2: Files = AttachedContentDocuments, Account Team,
 * Opportunities). A custom relationship (…__r) keeps the generic Translation Workbench card.
 */
function standardRelatedList(org, results, add, pc) {
  const api = String(pc.props?.relatedListApiName || '');
  if (/__r$/.test(api)) return customRelatedList(org, results, add, pc);
  if (!api) return false;
  // Object-backed lists (Opportunities, Contacts, Cases) show the object's plural name.
  const obj = results.find((r) => r.key.startsWith('object:') && r.confidence !== 'partial');
  if (obj) {
    obj.confidence = 'confirmed';
    obj.notes = [`Standard related list ${api}: its title is the object's plural name.`, ...(obj.notes || [])];
  } else {
    add({
      ...salesforceTextResult(`stdlist:${api}`, 'confirmed'),
      subtitle: `Standard related list ${api}${onPage(pc)}`,
      steps: [
        SALESFORCE_TEXT.step,
        `To show different text: in Lightning App Builder → ${pc.page || 'this record page'}, use a Dynamic Related List – Single and set its Related List Label to {!$Label.c.Your_Label}, then translate that label.`,
      ],
      url: SETUP.customLabels,
      copy: api,
      notes: [],
    });
  }
  demoteSameTextLabels(results, 'this related list title comes from Salesforce, not from a custom label.');
  return true;
}

/**
 * Related list of a custom lookup (…__r) with no label of its own: the title is the lookup field's
 * Related List Label on the child object. pc.child comes from background.js (parent describe
 * childRelationships + child describe). Without it the generic card stays.
 */
function customRelatedList(org, results, add, pc) {
  const c = pc.child;
  if (!c?.childSObject || !c.field) return false;
  const objectLabel = c.objectLabel || (org.objects || []).find((o) => o.name === c.childSObject)?.label || c.childSObject;
  const fieldLabel = c.fieldLabel || c.field;
  // Another language: the Workbench row is the field's master label (master describe of the child object).
  const masterLabel = isDefaultLanguage(org) ? null : masterField(org, c.childSObject, c.field)?.label || null;
  const row = isDefaultLanguage(org) ? fieldLabel : labelAndApi(masterLabel || fieldLabel, c.field);
  add({
    key: `rellist:${c.childSObject}.${c.field}`,
    confidence: 'confirmed',
    title: `Related list label of ${c.childSObject}.${c.field}`,
    subtitle: `${pc.props.relatedListApiName}${onPage(pc)}`,
    ...workbench(org, { component: 'Custom Field', object: c.childSObject, objectLabel, aspect: 'Related List Label', row, rows: [masterLabel, fieldLabel, c.field], pkg: namespaceOf(c.field) }),
    copy: `${c.childSObject}.${c.field}`,
    notes: [
      `The title comes from the lookup field ${fieldLabel} on ${objectLabel}: its Related List Label.`,
      objectManagerNote(org, 'Master text', { name: c.childSObject, label: objectLabel }, { name: c.field, label: fieldLabel }, 'Edit → Related List Label'),
    ],
  });
  demoteSameTextLabels(results, 'this related list title comes from a lookup field, not from a custom label.');
  return true;
}

/** Returns true when the component's text was explained (so generic area cards are not needed). */
function applyPageComponent(org, results, add, pc) {
  const text = String(pc.label ?? '').trim();
  const kind = pcKind(pc);
  if (!text && RELATED_LIST_COMPONENTS.has(pc.component)) return standardRelatedList(org, results, add, pc);
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

function confirmPathValues(org, describes, results, record) {
  const paths = describes.flatMap((d) => pathsForRecord(org.paths, d.name, record));
  const hitsOf = (p) => results.filter((r) => r.key.startsWith(`picklist:${p.SobjectType}.${p.SobjectProcessField}.`) && r.confidence === 'exact');
  const withHits = paths.filter((p) => hitsOf(p).length);
  // Record type not known and steps of several paths match (e.g. "Connect" is a StageName and a Sub Stage
  // value): the page shows one of them only, so confirm none.
  const unknown = !record || record.recordTypeId === undefined;
  const ambiguous = unknown && new Set(withHits.map((p) => `${p.SobjectType}.${p.SobjectProcessField}`)).size > 1;
  let confirmed = false;
  for (const p of withHits) {
    for (const r of hitsOf(p)) {
      if (ambiguous) {
        r.notes = [`A step of the path "${p.MasterLabel || p.DeveloperName}" (field ${p.SobjectProcessField}), if this record shows that path.`, ...(r.notes || [])];
        continue;
      }
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

const STANDARD_AREAS = {
  activityTimeline: { what: 'the activity timeline' },
  duplicates: { what: 'the duplicates card' },
  feed: { what: 'the Chatter feed' },
  reportChart: { what: 'the report chart' },
  path: { what: 'the path (heading and buttons)' },
  calendar: { what: 'the Calendar page (header buttons, views, day headers, My Calendars)' },
  globalHeader: { what: 'the global header (search, reminders, notifications)' },
  pipelineInspection: { what: 'Pipeline Inspection (metric tiles, filters, Metrics menu, tabs and buttons)' },
  fileUpload: { what: 'the file upload area (Upload Files, Or drop files)' },
  utilityBar: { what: 'the To Do List utility' },
};

function utilityLabelResult() {
  return {
    key: 'area:utilityItem',
    source: SOURCE.CONTEXT,
    confidence: 'context',
    title: 'Utility bar item label',
    subtitle: 'An item in the utility bar at the bottom of the app',
    steps: [
      'The label is set per app: Setup → App Manager → the app → Edit → Utility Items (Desktop Only) → the item → Label.',
      'Translation Workbench has no Setup Component for utility item labels.',
    ],
    url: '/lightning/setup/NavigationMenus/home',
    notes: [],
  };
}

/**
 * The utility item the text belongs to, from the app utility bars (sfApi loadUtilityBar, current app first).
 * An item whose label is the text wins; else the pointed item (its identifier is among the element's
 * component ids) when it has no label of its own, so the text is the name Salesforce gives the component.
 * Returns { bar, item } or null.
 */
export function findUtilityItem(bars = [], needle = '', componentIds = []) {
  const live = (bars || []).filter(Boolean);
  for (const bar of live) {
    const pointed = bar.items.find((i) => i.label && componentIds.includes(i.id) && normalize(i.label) === needle);
    if (pointed) return { bar, item: pointed };
  }
  for (const bar of live) {
    const item = bar.items.find((i) => i.label && normalize(i.label) === needle);
    if (item) return { bar, item };
  }
  for (const bar of live) {
    const item = bar.items.find((i) => !i.label && componentIds.includes(i.id));
    if (item) return { bar, item };
  }
  return null;
}

/** A utility item label typed in App Manager: Translation Workbench has no Setup Component for it. */
function utilityItemLabelResult({ bar, item }) {
  return {
    key: `utility:${item.id}`,
    source: SOURCE.NOT_TRANSLATABLE,
    confidence: 'confirmed',
    title: 'Utility item label typed in App Manager',
    subtitle: `Label of the "${item.label}" utility item in the ${bar.app} app`,
    steps: [
      'Translation Workbench and Rename Tabs and Labels have no Setup Component for utility item labels: the typed label shows in every language.',
      `To change it: Setup → App Manager → ${bar.app} → Edit → Utility Items (Desktop Only) → ${item.label} → Label.`,
    ],
    url: SETUP.appManager,
    copy: item.label,
    notes: item.component ? [`Component: ${item.component} (utility bar "${bar.page}").`] : [],
  };
}

// Pipeline Inspection metric tiles (PipelineInspMetricConfig.Metric picklist, UAT2 describe).
const PIPELINE_METRICS = {
  TotalPipeline: 'Total',
  ClosedWon: 'Closed Won',
  Commit: 'Commit',
  MostLikely: 'Most Likely',
  BestCase: 'Best Case',
  OpenPipeline: 'Open Pipeline',
  ClosedLost: 'Closed Lost',
};

/** A metric name an admin set in Pipeline Settings → Metrics Settings: its own Translation Workbench row. */
function pipelineMetricResult(org, m) {
  const wb = workbench(org, { component: 'Pipeline Inspection Metric Configuration', rows: [m.MasterLabel, m.DeveloperName] });
  wb.steps.push(`Find the row: ${m.MasterLabel}`, 'Column: Pipeline Inspection Metric Custom Label');
  const tile = PIPELINE_METRICS[m.Metric] || m.Metric;
  return {
    key: `pipelineMetric:${m.Id}`,
    ...wb,
    confidence: 'confirmed',
    title: `Pipeline Inspection metric name: ${m.MasterLabel}`,
    subtitle: tile ? `The name an admin gave the ${tile} metric (Pipeline Settings → Metrics Settings)` : 'A metric name an admin set in Pipeline Settings → Metrics Settings',
    copy: m.MasterLabel,
    notes: [],
  };
}

function pipelineViewResult() {
  return {
    key: 'sfdctext:pipelineView',
    source: SOURCE.NOT_TRANSLATABLE,
    confidence: 'confirmed',
    title: 'List view name',
    subtitle: 'The view Pipeline Inspection shows (the name under the object name)',
    steps: [
      'This is the name of a list view on Opportunities. Translation Workbench and Rename Tabs and Labels do not list list view names.',
      'To show a name in another language: Pipeline Settings (gear icon) → Clone, name the copy in that language, then Pipeline Settings → Sharing Settings to share it with the users of that language.',
      'To rename it: Pipeline Settings (gear icon) → Rename.',
    ],
    url: null,
    notes: [],
  };
}

/**
 * Pipeline Inspection: Salesforce's own page. The object name, view name, status line and list rows show org text.
 * Same-text custom labels and quick actions are coincidences everywhere on it.
 */
function pipelineRecordDataResult() {
  return {
    key: 'value:pipelineList',
    source: SOURCE.NOT_TRANSLATABLE,
    confidence: 'context',
    title: 'Record data: a value in the Pipeline Inspection list',
    subtitle: 'A field value of the opportunity in this row (or of its account)',
    steps: [...RECORD_DATA_STEPS],
    url: null,
    notes: ['Picklist values (such as Stage) are listed above when one matches: those are translated in Translation Workbench → Picklist Value.'],
  };
}

function addPipelineResults(areas, results, add, hints = {}, needle = '', org = {}) {
  const why = `custom labels are not used in ${STANDARD_AREAS.pipelineInspection.what}.`;
  // A metric tile an admin renamed (Pipeline Settings → Metrics Settings), read from PipelineInspMetricConfig.
  const metric = areas.has('pipelineMetric') && needle ? (org.pipelineMetrics || []).find((m) => m.MasterLabel && normalize(m.MasterLabel) === needle) : null;
  if (metric) {
    demoteLabelsToPartial(results, 'this metric name was set in Pipeline Settings → Metrics Settings, not as a custom label.');
    add(pipelineMetricResult(org, metric));
    return;
  }
  // The object name above the view name: object/tab results were confirmed by confirmNames.
  if (areas.has('pipelineObjectName') && results.some((r) => /^(object|tab):/.test(r.key) && r.confidence === 'confirmed')) return;
  if (areas.has('pipelineView')) {
    demoteLabelsToPartial(results, 'the view name is a list view name, not a custom label.');
    add(pipelineViewResult());
    return;
  }
  demoteLabelsToPartial(results, why);
  for (const r of results) {
    if (!/^(qa|stdaction):/.test(r.key) || r.confidence === 'confirmed' || r.confidence === 'partial') continue;
    r.confidence = 'partial';
    r.notes = ['Same words only: the Pipeline Inspection buttons are Salesforce text, not quick actions.', ...(r.notes || [])];
  }
  const orgName = results.some((r) => r.confidence === 'confirmed' || r.confidence === 'exact');
  // List rows (UAT2 with records, checked live: lightning-datatable inside runtime_pipeline_inspector-…-common-list).
  if (areas.has('pipelineGrid')) {
    const tags = hints.tags || [];
    // The Activity cell is Salesforce's activity chart ("No recent activity": runtime_sales_activities-activity-stacked-bar-chart…).
    if (tags.some((t) => /^runtime_sales_activities-/.test(t))) {
      add(standardTextResult('pipelineInspection', 'confirmed'));
      return;
    }
    if (tags.includes('th')) {
      // A column header that is no Opportunity field label is a column Pipeline Inspection adds (Alerts, Contacts,
      // Activity, Important). Field labels were confirmed in the main flow.
      if (orgName) return;
      const near = results.some((r) => r.key.startsWith('field:'));
      add(salesforceTextResult('sfdctext:pipelineColumn', near ? 'context' : 'confirmed', { subtitle: 'A column Pipeline Inspection adds to the list (Alerts, Contacts, Activity, Important)' }));
      return;
    }
    // A cell: a value of the opportunity or its account. Counts (Alerts, Contacts) are numbers, not text.
    if (!orgName && needle && !/^[\d\s.,%+-]*$/.test(needle)) add(pipelineRecordDataResult());
    return;
  }
  // Renamed metrics are matched by MasterLabel. Viewing another language, the tile shows the translation of a
  // renamed metric, which MasterLabel never holds. A row whose Language is the one you view holds that text in
  // MasterLabel (matched above): no translation there.
  const renamed = areas.has('pipelineMetric') && !isDefaultLanguage(org)
    ? (org.pipelineMetrics || []).filter((m) => m.MasterLabel && m.Language !== org.userLanguage)
    : [];
  // The translations of the renamed metrics in the language you view (background.js, Metadata API
  // Translations.pipelineInspMetricConfigs by DeveloperName): the tile whose text is one of them is that metric.
  const translations = Array.isArray(org.pipelineMetricTranslations) ? org.pipelineMetricTranslations : null;
  if (renamed.length && translations && needle) {
    const names = new Set(translations.filter((t) => t.label && normalize(t.label) === needle).map((t) => t.name));
    const hits = renamed.filter((m) => names.has(m.DeveloperName));
    if (hits.length) {
      demoteLabelsToPartial(results, 'this metric name was set in Pipeline Settings → Metrics Settings, not as a custom label.');
      for (const m of hits) {
        const mr = pipelineMetricResult(org, m);
        const lang = languageName(org.userLanguage);
        if (hits.length > 1) mr.confidence = 'exact';
        mr.notes = [hits.length > 1
          ? `You view Salesforce in ${lang}: ${hits.length} renamed metrics have this ${lang} translation. Same words only.`
          : `You view Salesforce in ${lang}: this tile shows the ${lang} translation from this row.`];
        add(mr);
      }
      return;
    }
  }
  // Translations read and none is the text: the tile is Salesforce's own metric name. Not read: every renamed
  // metric stays possible, so the tile is Salesforce text only as context and the renamed metrics are listed.
  const unresolved = translations ? [] : renamed;
  const renamedElsewhere = unresolved.length > 0;
  const r = standardTextResult('pipelineInspection', areas.has('pipelineStatus') || orgName || renamedElsewhere ? 'context' : 'confirmed');
  if (areas.has('pipelineStatus')) {
    r.notes = ['"items" and "Filtered by" are Salesforce text. The filter names after them are field labels and values from your org.'];
  }
  // An admin can rename a metric (Pipeline Settings → Metrics Settings): that name has its own Workbench row.
  // A renamed metric whose name is the text was matched above; the note stays unless the org has none renamed.
  if (areas.has('pipelineMetric') && !(Array.isArray(org.pipelineMetrics) && !org.pipelineMetrics.length)) {
    r.notes = ['A metric name an admin set in Pipeline Settings → Metrics Settings is translated in Translation Workbench → Translate → Setup Component: Pipeline Inspection Metric Configuration (column "Pipeline Inspection Metric Custom Label"). Salesforce\'s own metric names are not listed there.'];
  }
  add(r);
  for (const m of unresolved) {
    const mr = pipelineMetricResult(org, m);
    mr.confidence = 'context';
    mr.notes = [`You view Salesforce in ${languageName(org.userLanguage)}: a tile of a renamed metric shows its ${languageName(org.userLanguage)} translation from this row.`];
    add(mr);
  }
}

// The calendar list entry Salesforce names itself (My Events), by its fixed Id. Any other entry is a calendar
// a user created (from a list view, or a user's or resource's calendar). The My Calendars / Other Calendars
// headings are outside the list items (h2 in div.calendarPanelHeader): plain calendar text.
const MY_EVENTS_CALENDAR_ID = '03A0000000000000001';

function userCalendarResult() {
  return {
    key: 'sfdctext:calendarName',
    source: SOURCE.NOT_TRANSLATABLE,
    confidence: 'context',
    title: 'Calendar name created by a user',
    subtitle: 'An entry in My Calendars / Other Calendars',
    steps: [
      'A user named this calendar when creating it (or it is a person\'s or resource\'s name). Translation tools do not change it.',
      'To change it: click the arrow next to the calendar → Edit (only its owner can).',
    ],
    url: null,
    notes: [],
  };
}

/** Calendar page: Salesforce's own text. Same-text labels, quick actions and objects are coincidences. */
function addCalendarResults(needle, areas, results, add) {
  demoteLabelsToPartial(results, `custom labels are not used in ${STANDARD_AREAS.calendar.what}.`);
  for (const r of results) {
    if (!/^(qa|stdaction|object):/.test(r.key) || r.confidence === 'confirmed' || r.confidence === 'partial') continue;
    r.confidence = 'partial';
    r.notes = ['Same words only: the Calendar page buttons are Salesforce text. The "New Event" button is not the NewEvent global action.', ...(r.notes || [])];
  }
  if (areas.has('calendarList') && needle && !areas.has('calendarOwn')) {
    add(userCalendarResult());
    return;
  }
  const orgName = results.some((r) => r.confidence === 'confirmed' || r.confidence === 'exact');
  add(standardTextResult('calendar', orgName ? 'context' : 'confirmed'));
}

function standardTextResult(area, confidence) {
  return {
    ...salesforceTextResult(`sfdctext:${area}`, confidence),
    notes: area === 'reportChart' ? ['The chart title is set on the Lightning page; report and field names come from the report.'] : [],
  };
}

// English path text for a path with no page marker (lightning-path): the step buttons and the generic last step.
const LWC_PATH_BUTTONS = [/^mark (.+) as complete$/, /^mark as current (.+)$/, /^mark (.+) as current$/, /^select closed (.+)$/];
const LWC_PATH_CLOSED = ['closed'];

/**
 * The fields a path step button names ("Mark Sub Stage as Complete", French "Marquer Sous-étape comme terminé(e)"):
 * fields whose label is a whole phrase of the button text, in any language. The record's path fields first; else
 * picklists, without a label that is part of a longer one found (Stage inside Sub Stage).
 */
function fieldsNamedInButton(org, needle, describes, record) {
  // The path is the record's: only its object's fields, when the record is known.
  const own = record?.object ? describes.filter((d) => d.name === record.object) : [];
  const hits = (own.length ? own : describes).flatMap((d) =>
    (d.fields || [])
      .map((f) => ({ d, f, l: displayLabels(d, f).map(normalize).filter((l) => l.length >= 3 && wordContains(needle, l)) }))
      .filter((x) => x.l.length)
  );
  const onPath = hits.filter(({ d, f }) => pathsForRecord(org.paths, d.name, record).some((p) => p.SobjectProcessField === f.name));
  if (onPath.length) return onPath;
  const lists = hits.filter(({ f }) => f.type === 'picklist');
  return lists.filter((x) => !lists.some((y) => y !== x && y.l.some((ly) => x.l.every((lx) => lx !== ly && ly.includes(lx)))));
}

/** The path's final "Closed" chevron, when no path field on the page has a value with that label. */
function addClosedStepResult(org, needle, describes, results, add, record) {
  const pathFields = describes.flatMap((d) =>
    pathsForRecord(org.paths, d.name, record).map((p) => ({ d, f: (d.fields || []).find((f) => f.name === p.SobjectProcessField) }))
  ).filter((x) => x.f);
  const isValue = pathFields.some(({ f }) => (f.picklistValues || []).some((pv) => normalize(pv.label) === needle));
  // No path data: any matching picklist value may be the step.
  if (isValue || (!Array.isArray(org.paths) && results.some((r) => r.key.startsWith('picklist:') && r.confidence === 'exact'))) return false;
  add({
    ...standardTextResult('path', 'confirmed'),
    key: 'sfdctext:pathClosed',
    steps: [
      SALESFORCE_TEXT.step,
      'This final step groups the closed values. Once the record is closed, the step shows its closed value (e.g. Closed Won). That value is a picklist value: Translation Workbench → Picklist Value.',
    ],
  });
  demoteLabelsToPartial(results, 'the Closed step is Salesforce path text.');
  // Field labels, record types and values of other fields with the same word are coincidences (S-04: IsClosed, ForecastCategory, record type Closed).
  for (const r of results) {
    if (!/^(field|rt|picklist):/.test(r.key) || r.confidence === 'confirmed' || r.confidence === 'partial') continue;
    r.confidence = 'partial';
    r.notes = ['Same words only: the Closed step is Salesforce path text.', ...(r.notes || [])];
  }
  return true;
}

/** The title of a Report Chart component: typed in Lightning App Builder (or the report name when blank). */
function reportChartTitleResult(results) {
  const label = results.find((r) => r.source === SOURCE.CUSTOM_LABEL && !r.pkg && r.confidence === 'exact');
  return {
    key: 'sfdctext:reportChartTitle',
    source: SOURCE.NOT_TRANSLATABLE,
    confidence: label ? 'context' : 'confirmed',
    title: 'Report chart title typed in Lightning App Builder',
    subtitle: 'Set on the Report Chart component of this Lightning page',
    steps: [
      label ? `If the title is {!$Label.c.${label.copy?.split('.').pop()}}, translate that custom label (listed above).` : 'A title typed as plain text is never translated.',
      'Setup → Custom Labels → New: create a label with this text, then add its translations.',
      'Lightning App Builder → click the report chart → set its Label to {!$Label.c.Your_Label} → Save.',
    ],
    url: SETUP.customLabels,
    copy: '{!$Label.c.Your_Label}',
    notes: ['With no title set, the chart shows the report name, which is not translated.'],
  };
}

function addStandardTextResults(org, needle, areas, describes, results, add, record, hints = {}) {
  // Heading of the error popup after a failed save ("We hit a snag.", Aura "Review the errors on this page.").
  // Its list below names fields and shows messages, which are looked up as usual.
  if (areas.has('errorPopoverHeader')) {
    add(salesforceTextResult('sfdctext:errorPopover', 'confirmed', { subtitle: 'Heading of the error popup Lightning shows when a save fails' }));
    demoteLabelsToPartial(results, 'the heading of the save error popup is Salesforce text.');
    return;
  }
  // Path parts are found by page marker (detectAreas), so the text can be in any language. A path with no
  // marker (lightning-path) is matched by its English words only: no page marker tells its parts apart.
  const noMarker = areas.has('pathNoMarker') && needle;
  const closed = areas.has('pathClosed') || (noMarker && LWC_PATH_CLOSED.includes(needle));
  if (closed && needle && addClosedStepResult(org, needle, describes, results, add, record)) return;
  const lwcButton = noMarker && LWC_PATH_BUTTONS.some((re) => re.test(needle));
  if ((areas.has('pathHeading') || areas.has('pathButton') || lwcButton || (noMarker && needle === 'guidance for success')) && needle) {
    add(standardTextResult('path', 'confirmed'));
    demoteLabelsToPartial(results, 'this is Salesforce path text.');
    // The button names the path field ("Sub Stage"): its label is translated like any field label.
    for (const { d, f } of areas.has('pathButton') || lwcButton ? fieldsNamedInButton(org, needle, describes, record) : []) {
      const r = fieldLabelResult(org, d, f, 'context');
      r.notes = [`The button shows this field's label ("${f.label}"). Translating the label changes the button text.`, ...r.notes];
      add(r);
    }
    return;
  }
  if (areas.has('calendarEvent')) {
    add(calendarEventResult());
    demoteLabelsToPartial(results, 'an event on the calendar shows its subject, not a custom label.');
    return;
  }
  if (areas.has('calendar')) {
    addCalendarResults(needle, areas, results, add);
    return;
  }
  if (areas.has('pipelineInspection')) {
    addPipelineResults(areas, results, add, hints, needle, org);
    return;
  }
  if (areas.has('utilityBar')) {
    // The app's utility bar (App Manager → Utility Items), read from the org: a label typed there, or an item
    // that keeps the name Salesforce gives its component.
    const found = findUtilityItem(org.utilityBars, needle, hints.componentIds || []);
    if (found?.item.label) {
      demoteLabelsToPartial(results, 'this is a utility item label typed in App Manager, not a custom label.');
      add(utilityItemLabelResult(found));
      return;
    }
    if (found && !areas.has('utilityToDo')) {
      demoteLabelsToPartial(results, 'this utility item has no label of its own in App Manager: it shows the name Salesforce gives it.');
      add(salesforceTextResult('sfdctext:utilityBar', 'confirmed', {
        subtitle: `Name Salesforce gives the ${found.item.component || found.item.id} utility item (${found.bar.app} app)`,
        notes: [`App Manager → ${found.bar.app} → Edit → Utility Items: its Label is empty, so the item shows Salesforce's name. A label typed there replaces it in every language.`],
      }));
      return;
    }
    // To Do List: its Label field is locked in App Manager (UAT2 checked live). Found by its component, in any language.
    if (areas.has('utilityToDo')) {
      demoteLabelsToPartial(results, `custom labels are not used in ${STANDARD_AREAS.utilityBar.what}.`);
      add(salesforceTextResult('sfdctext:utilityBar', 'confirmed', {
        subtitle: 'Label of the To Do List utility',
        notes: ['Its Label field is locked in App Manager → the app → Edit → Utility Items.'],
      }));
    } else {
      add(utilityLabelResult());
    }
    return;
  }
  if (areas.has('fileUpload')) {
    demoteLabelsToPartial(results, `custom labels are not used in ${STANDARD_AREAS.fileUpload.what}.`);
    add(standardTextResult('fileUpload', 'confirmed'));
    return;
  }
  for (const area of ['activityTimeline', 'duplicates', 'feed', 'reportChart', 'globalHeader']) {
    if (!areas.has(area)) continue;
    // Reminder and notification cards also show org text (event subjects, custom notification types):
    // say whose text the card frame is, without confirming the clicked words.
    if (area === 'globalHeader' && areas.has('headerNotification')) {
      demoteLabelsToPartial(results, `custom labels are not used in ${STANDARD_AREAS[area].what}.`);
      const r = standardTextResult(area, 'context');
      r.notes = ['Headings like "Event Reminder Notification" are Salesforce text. Event subjects and custom notification text in these cards come from your org.'];
      add(r);
      return;
    }
    if (area !== 'reportChart') demoteLabelsToPartial(results, `custom labels are not used in ${STANDARD_AREAS[area].what}.`);
    // Pointed at the report chart's own title (a heading): typed in App Builder, not Salesforce text.
    if (area === 'reportChart' && (hints.tags || []).some((t) => /^h[1-6]$/.test(t))) {
      add(reportChartTitleResult(results));
      return;
    }
    // Field labels, picklist values and record data inside these components are still listed above it.
    // Nothing from the org matched: the text is Salesforce's own, so say so plainly (confirmed).
    const orgName = results.some((r) => r.confidence === 'confirmed' || r.confidence === 'exact');
    add(standardTextResult(area, orgName ? 'context' : 'confirmed'));
    return;
  }
}

function demoteLabelsToPartial(results, why) {
  for (const r of results) {
    if (r.source !== SOURCE.CUSTOM_LABEL || r.confidence === 'confirmed') continue;
    r.confidence = 'partial';
    r.notes = [`Same words only: ${why}`, ...(r.notes || [])];
  }
}

/** "Object.Field" of the one field of the record's object that shows this label, else null. */
function fieldByShownLabel(describes, record, label) {
  const n = normalize(label);
  const d = describes.find((x) => x.name === record?.object) || describes[0];
  if (!n || !d) return null;
  const hits = (d.fields || []).filter((f) => displayLabels(d, f).some((l) => normalize(l) === n));
  return hits.length === 1 ? `${d.name}.${hits[0].name}` : null;
}

function addHelpIconResults(org, describes, confirmedFields, results, add, hints = {}, needle = '') {
  const fieldOf = (o, n) => {
    const d = describes.find((x) => x.name === o);
    return { d, f: d?.fields?.find((x) => x.name === n) };
  };
  const fields = confirmedFields.map((cf) => fieldOf(...cf.split('.'))).filter((x) => x.f);
  // No field in the path: content.js sends the help text itself as the text (the icon button's
  // aria-description, in the language you view) and the label shown beside the icon as hints.helpLabel.
  // Describes hold both in that language. Older content.js sent the label as the text.
  const withHelp = describes.flatMap((d) => (d.fields || []).filter((f) => f.inlineHelpText).map((f) => ({ d, f })));
  const label = normalize(hints.helpLabel || '');
  let byText = needle ? withHelp.filter(({ f }) => normalize(f.inlineHelpText) === needle) : [];
  if (!byText.length && label) byText = withHelp.filter(({ f }) => normalize(f.label) === label);
  if (!byText.length) {
    byText = results
      .filter((r) => r.key.startsWith('field:') && r.confidence === 'exact')
      .map((r) => fieldOf(...r.key.slice(6).split('.')))
      .filter((x) => x.f?.inlineHelpText);
  }
  const confidence = fields.length ? 'confirmed' : 'exact';
  for (const { d, f } of fields.length ? fields : byText) {
    const r = helpTextResult(org, d, f, confidence);
    if (!f.inlineHelpText) r.subtitle = 'Help text of this field';
    r.notes = ["You pointed at this field's help (i) icon.", ...r.notes];
    add(r);
    const labelCard = results.find((x) => x.key === `field:${d.name}.${f.name}`);
    if (labelCard) labelCard.confidence = 'context';
  }
  if (fields.length || byText.length) demoteSameTextLabels(results, "this is a field's help text, not a custom label.");
}

/** Pointed at a field's value (not its label) and the value is not one of its picklist values. */
function addRecordValueResults(org, d, f, results, add) {
  const key = `${d.name}.${f.name}`;
  if (results.some((r) => r.key.startsWith(`picklist:${key}.`) && r.confidence !== 'partial')) return;
  // A record type name is metadata (TW → Record Type), not typed data.
  if (f.name === 'RecordTypeId' && results.some((r) => r.key.startsWith(`rt:${d.name}.`) && r.confidence !== 'partial')) return;
  // Several values of a multi-select do not match one value: not typed data.
  if (f.type === 'multipicklist') return;
  // A single-select value that is not a value of the picklist (DV2: Lead Source "Partner Referral").
  if (/picklist/.test(f.type || '') && f.name !== 'CurrencyIsoCode') {
    // Part of a real value (partial highlight, or a partial match of an inactive value): the value is in
    // the picklist, so do not flag it. Only a text that matches no value of the field at all is flagged.
    if (results.some((r) => r.key.startsWith(`picklist:${key}.`))) return;
    add(notInPicklistResult(d, f, !!org.valueSets?.[key]?.values));
    demoteSameTextLabels(results, 'you pointed at a value on the record, not at a label.');
    return;
  }
  // Data Translation is on for this field: that is the answer.
  const dt = results.find((r) => r.key === `data:${key}` && !r.off);
  if (dt) dt.confidence = 'confirmed';
  else add(recordValueResult(d, f));
  demoteSameTextLabels(results, 'you pointed at a value on the record, not at a label.');
}

export function locate({ text, hints = {}, org = {}, describes = [], dataTranslations = [], record = null, pageUrls = [], pageComponent = null, listObject = null }) {
  const needle = normalize(text);
  const results = [];
  const add = (r) => r && results.push(r);
  const areas = detectAreas(hints);

  if (needle) {
    // 1. Custom labels (master value, then existing translations)
    const translationsById = groupBy(org.labelTranslations || [], 'ExternalStringId');
    const labelsById = new Map((org.customLabels || []).map((l) => [l.Id, l]));
    for (const label of org.customLabels || []) {
      const mt = labelMatch(needle, label.Value);
      if (mt) add(customLabelResult(org, label, mt, translationsById.get(label.Id)));
    }
    // A user viewing the org's default language sees master values: a match on another language's
    // translation only is a coincidence (DV2 R-34: en_US user, maps__ labels matched through sv/fr).
    const otherLanguage = (lang) => org.userLanguage && org.userLanguage === org.defaultLanguage && lang !== org.userLanguage;
    for (const tr of org.labelTranslations || []) {
      const label = labelsById.get(tr.ExternalStringId);
      const mt = label && labelMatch(needle, tr.Value);
      if (mt) add(customLabelResult(org, label, otherLanguage(tr.Language) ? 'partial' : mt, translationsById.get(label.Id), tr.Language));
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
        // Inactive values (from the field metadata; describe has active values only). Records still show them.
        for (const v of org.valueSets?.[`${d.name}.${f.name}`]?.values || []) {
          if (v.active || (f.picklistValues || []).some((pv) => pv.value === v.value)) continue;
          const pm = matchType(needle, v.label);
          if (pm) add(picklistResult(org, d, f, { label: v.label, value: v.value, active: false }, pm));
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
        if (!mt) continue;
        // Salesforce's standard global actions are not listed in TW → Action (DV2-10 review).
        if (global && isStandardGlobalAction(qa.name)) add(standardActionResult('Global', String(qa.name).replace(/^Global\./, ''), mt, qa.label));
        // Feed actions in the describe (DV2 Contact: FeedItem.TextPost, ContentNote...): Salesforce's own (DV2-04, R-20).
        else if (String(qa.name).startsWith('FeedItem.')) add(standardActionResult('FeedItem', String(qa.name).slice(9), mt, qa.label));
        // TW → Action has an Object option "Global" (value Global) for these.
        else add(quickActionResult(org, global ? 'Global' : d.name, global ? 'Global' : d.label, qa, mt));
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
    pathResults(org, needle, areas, describes, add, text, record);
  }

  // Path chevrons show the path field's picklist values (UAT2: Sub Stage "Connect" ranked below maps__MA_Connect).
  if (areas.has('path') && !areas.has('pathGuidance')) confirmPathValues(org, describes, results, record);

  // Navigation bar items are object, tab and app names, never custom labels.
  if (areas.has('navTab')) confirmNames(results, /^(object|tab|app):/, 'navigation bar items show object, tab and app names, not custom labels.');
  if (areas.has('appName')) confirmNames(results, /^app:/, 'the app name comes from the app, not from a custom label.');
  // A standard tab that matched no object, tab or app name is Salesforce's own tab (DV2 nav items: data-id="home",
  // sfdc:TabDefinition.standard-home; R-67 "Calendar", sfdc:TabDefinition.standard-Event, whose object is "Event").
  const stdTab =
    (hints.selectionNames || []).map((s) => /^sfdc:TabDefinition\.standard-(\w+)$/.exec(s)?.[1]).find(Boolean) ||
    (hints.attrs?.['data-id'] === 'home' ? 'home' : null);
  // An object tab says so only when the object names were loaded (else a renamed object would look like Salesforce's).
  const tabKnown = stdTab === 'home' || (Array.isArray(org.objects) && org.objects.length > 0);
  if (areas.has('navTab') && stdTab && tabKnown && !results.some((r) => /^(object|tab|app):/.test(r.key) && ['confirmed', 'exact'].includes(r.confidence))) {
    const shown = String(text || '').trim().slice(0, 60) || stdTab;
    add(salesforceTextResult(`sfdctab:${stdTab}`, 'confirmed', { subtitle: `Standard tab ${shown}` }));
    demoteLabelsToPartial(results, `the ${shown} tab is named by Salesforce, not by a custom label.`);
  }
  // The object name above the record name in the highlights panel (UAT2: "Account" ranked below 3 labels).
  if (areas.has('highlights')) confirmNames(results, /^object:/, 'the highlights panel shows the object name, not a custom label.');
  // Pipeline Inspection: the small heading above the view name is the object's plural name.
  if (areas.has('pipelineObjectName')) confirmNames(results, /^(object|tab):/, 'Pipeline Inspection shows the object name above the view name, not a custom label.');
  // Pipeline Inspection list: a column header is an Opportunity field label.
  if (areas.has('pipelineGrid') && (hints.tags || []).includes('th')) {
    confirmNames(results, /^field:Opportunity\./, 'the Pipeline Inspection columns show field labels, not custom labels.');
  }

  // A field label in a related list row ("Stage:" in an Opportunities tile): the child object's field.
  const onRowLabel = hints.fieldPart === 'label' || (hints.tags || []).includes('dt');
  if (areas.has('relatedListRow') && listObject && onRowLabel) {
    const hits = results.filter((r) => r.key.startsWith(`field:${listObject}.`) && r.confidence === 'exact');
    if (hits.length === 1) {
      hits[0].confidence = 'confirmed';
      hits[0].notes = [`A field shown in the ${listObject} related list rows.`, ...(hits[0].notes || [])];
      demoteSameTextLabels(results, 'related list rows show field labels, not custom labels.');
      for (const r of results) if (r.key.startsWith('vr:')) r.confidence = 'partial';
    }
  }

  // Salesforce's own text in standard record page components.
  addStandardTextResults(org, needle, areas, describes, results, add, record, hints);

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

  for (const r of hintResults(org, hints, describes, areas, String(text || '').trim(), pageHandled, pageComponent)) {
    const existing = results.find((x) => x.key === r.key);
    if (!existing) add(r);
    else if (CONFIDENCE_RANK[r.confidence] < CONFIDENCE_RANK[existing.confidence]) existing.confidence = r.confidence;
  }
  // 7b. Org-wide search (#24): page layout sections, buttons and screen flows of the whole org, not only this page's.
  if (needle && org.orgIndex) addOrgWideResults(org, needle, String(text || ''), describes, results, add, pageComponent?.props?.flowName || null);
  // A page layout section header is translated in TW → Layout Section; layouts cannot use custom labels.
  if (results.some((r) => (r.key === 'area:layoutSection' || r.key.startsWith('section:')) && r.confidence === 'confirmed')) {
    demoteLabelsToPartial(results, 'page layout section names are not custom labels.');
  }
  if (areas.has('richText')) demoteSameTextLabels(results, 'a Rich Text component shows typed text, not a custom label.');

  // Boost matches confirmed by the clicked element (e.g. sfdc:RecordField.Account.Industry)
  const confirmedFields = (hints.selectionNames || [])
    .map(parseSelectionName)
    .filter((s) => s && s.kind === 'RecordField' && s.object)
    .map((s) => `${s.object}.${s.name}`);
  // Highlights panel fields carry no RecordField name: the item's label names the field.
  if (areas.has('highlightsField') && !confirmedFields.length && hints.fieldPart) {
    const cf = fieldByShownLabel(describes, record, hints.highlightsLabel || (hints.fieldPart === 'label' ? text : null));
    if (cf) confirmedFields.push(cf);
  }
  const aboutField = (r, cf) => r.key.endsWith(cf) || r.key.includes(cf + '.');
  for (const r of results) {
    if (r.confidence === 'exact' && confirmedFields.some((cf) => aboutField(r, cf))) r.confidence = 'confirmed';
  }
  // A value of one field: another field's picklist or global value set value with the same words is a
  // coincidence (DV2 R-62: Lead Source value matched GVS Source System of Lead.Source_System_LST__c).
  if (hints.fieldPart === 'value' && confirmedFields.length) {
    const [o, fName] = confirmedFields[0].split('.');
    const shown = describes.find((x) => x.name === o)?.fields?.find((x) => x.name === fName)?.label || fName;
    for (const r of results) {
      if (!r.key.startsWith('picklist:') || confirmedFields.some((cf) => r.key.startsWith(`picklist:${cf}.`)) || ['partial', 'confirmed'].includes(r.confidence)) continue;
      r.confidence = 'partial';
      r.notes = [`Same words only: you pointed at the ${shown} field.`, ...(r.notes || [])];
    }
    // Part of this field's value highlighted (DV2 R-02: "ANZ" of "EX ANZ"): its value card is the answer,
    // not one of hundreds of similar texts.
    // Only values that contain the highlighted text ("USD - U.S. Dollar" contains a value: not this case).
    const prefix = `picklist:${confirmedFields[0]}.`;
    const fieldDesc = describes.find((x) => x.name === o)?.fields?.find((x) => x.name === fName);
    const values = [...(fieldDesc?.picklistValues || []), ...(org.valueSets?.[confirmedFields[0]]?.values || [])];
    const own = (r) => r.key.startsWith(prefix);
    const holdsNeedle = (r) => values.some((v) => v.value === r.key.slice(prefix.length) && normalize(v.label).includes(needle));
    if (needle && !results.some((r) => own(r) && r.confidence !== 'partial')) {
      for (const r of results) {
        if (!own(r) || !holdsNeedle(r)) continue;
        r.confidence = 'context';
        r.notes = ['You highlighted part of this value.', ...(r.notes || [])];
      }
    }
  }
  // The value of the Record Type field is a record type name (DV2: "Buying Accounts" under Account Record Type).
  for (const cf of hints.fieldPart === 'label' ? [] : confirmedFields) {
    const [o, fName] = cf.split('.');
    if (fName !== 'RecordTypeId') continue;
    for (const r of results) {
      if (!r.key.startsWith(`rt:${o}.`) || r.confidence !== 'exact') continue;
      r.confidence = 'confirmed';
      r.notes = ["You pointed at this record's Record Type.", ...(r.notes || [])];
    }
  }
  // A field's error message (dev org: a validation rule's message under the field in the edit form): an
  // active rule of that object with this message is the answer; the field's label and value are not.
  const onError = hints.fieldPart === 'error';
  if (onError) {
    const objs = new Set(confirmedFields.map((cf) => cf.split('.')[0]));
    const [eo, ef] = (confirmedFields[0] || '').split('.');
    const shown = ef ? describes.find((d) => d.name === eo)?.fields?.find((f) => f.name === ef)?.label || ef : null;
    let found = false;
    for (const r of results) {
      if (!r.key.startsWith('vr:') || r.confidence !== 'exact') continue;
      const o = r.goto?.object;
      if (objs.size && !objs.has(o)) continue;
      r.confidence = 'confirmed';
      r.notes = [`You pointed at the error message${shown ? ` shown under the field ${shown}` : ''}.`, ...(r.notes || [])];
      found = true;
    }
    // Viewing another language, the message is its translation, which ErrorMessage (the master text) never
    // holds (dev org, French): the field's own active rules are the answer. In the default language a message
    // that differs from every rule is Salesforce's own ("Complete this field."), so nothing is added then.
    // ErrorDisplayField holds the field's label in the user's language (dev org: "Couleur de peinture").
    const fieldLabels = ef ? [shown, org.masterDescribes?.[eo]?.fields?.find((f) => f.name === ef)?.label] : [];
    const onField = ef ? errorRulesOfField(org, eo, ef, fieldLabels) : [];
    if (!found && onField.length && !isDefaultLanguage(org) && !SF_FIELD_ERRORS.includes(needle)) {
      const objLabel = describes.find((d) => d.name === eo)?.label;
      // The rule's message in this language (CustomObjectTranslation) equals the text: confirmed. Otherwise
      // the text can also be Salesforce's own required-field message in this language, so the field's rules
      // are listed as the rules that show their message there.
      const translated = new Map((org.validationTranslations || []).map((v) => [v.name, v.errorMessage]));
      const exact = onField.filter((vr) => normalize(translated.get(vr.ValidationName) || '') === needle);
      for (const vr of exact.length ? exact : onField) {
        const r = validationResult(org, vr, exact.length ? 'confirmed' : 'context', objLabel);
        r.subtitle = `"${truncate(String(text || '').trim(), 100)}"`;
        r.notes = [
          exact.length
            ? `You pointed at the error message shown under the field ${shown}: this rule's ${languageName(org.userLanguage)} translation.`
            : `You pointed at an error message shown under the field ${shown}. ${onField.length > 1 ? `These ${onField.length} active rules show their message there.` : 'This active rule shows its message there.'}`,
          `Its master text is "${truncate(vr.ErrorMessage, 120)}".`,
          ...r.notes,
        ];
        add(r);
      }
      found = true;
    }
    if (found) demoteSameTextLabels(results, 'this is a validation rule message, not a custom label.');
  }
  // Help (i) icon of a field: its help text, not the label (bug: "Help Display Name" matched labels only).
  if (areas.has('helpIcon')) addHelpIconResults(org, describes, confirmedFields, results, add, hints, needle);
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
  for (const cf of onLabel || onError ? [] : confirmedFields) {
    if (results.some((r) => aboutField(r, cf) && r.confidence !== 'partial')) continue;
    const [o, fName] = cf.split('.');
    const dt = dataTranslations.find((x) => x.object === o);
    const f = dt?.fields.find((x) => x.name === fName);
    if (f) add(dataResult(org, dt, f, 'context', null));
    else if (!dt && DATA_TRANSLATION_FIELDS[o]?.includes(fName) && Array.isArray(org.objects)) add(dataOffResult(o, fName));
  }
  // Clicked a record value: also list org-built translation objects (e.g. Product_Translations__c).
  for (const cf of onLabel || onError ? [] : confirmedFields) {
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
        r.notes = [fieldLabelNote("You pointed at this field's label.", d, f, hints), ...r.notes];
        add(r);
      }
      demoteSameTextLabels(results, 'record page field labels come from the field, not from custom labels.');
      continue;
    }
    // An error message whose rule was found: the field's label is not what you pointed at.
    if (fieldPart === 'error' && results.some((x) => x.key.startsWith('vr:') && ['confirmed', 'context'].includes(x.confidence))) continue;
    const r = fieldLabelResult(org, d, f, 'context');
    r.notes = [fieldLabelNote(fieldPart === 'error' ? 'You pointed at an error message under this field.' : 'You pointed inside this field.', d, f, hints), ...r.notes];
    add(r);
  }

  // Setup pages show Salesforce's own text. Custom labels are not used there, so a label
  // with the same words is a coincidence (bug: "Export" heading matched the maps__MA_Export label).
  if (isSetupPage(pageUrls)) {
    for (const r of results) {
      if (r.source !== SOURCE.CUSTOM_LABEL) continue;
      r.confidence = 'partial';
      r.notes = ['Same words only: Setup pages do not show custom labels.', ...(r.notes || [])];
    }
    // Object Manager lists the object's own metadata (A-27: the "Paint Color" field label in Fields &
    // Relationships also got a Salesforce text card): a same-text match of it is not Salesforce text.
    const inObjectManager = pageUrls.some((u) => /\/lightning\/setup\/ObjectManager\/[A-Za-z0-9_]+\//.test(u || ''));
    const own = new Set(describes.map((d) => d.name));
    const ownMetadata = (r) =>
      ['exact', 'confirmed'].includes(r.confidence) &&
      ([...own].some((o) => new RegExp(`^(field|help|picklist|rt|qa):${o}\\.`).test(r.key)) || (r.key.startsWith('vr:') && own.has(r.goto?.object)));
    if (!(inObjectManager && results.some(ownMetadata))) add(setupTextResult());
  }

  const idx = org.orgIndex;
  return finalize(results, areas, { layouts: !!idx?.layouts, buttons: !!idx?.buttons, flows: !!idx?.flows });
}

// ---------- org-wide search (#24) ----------

const MAX_ORG_WIDE = 5;

/**
 * Whether a lookup reads the org-wide data (sfApi orgIndex.js: every page layout, screen flow and button):
 * when nothing is confirmed, or for a page layout section header (its card names this page's object, and the
 * section can belong to another one: a Related Record component shows another object's layout).
 */
export function needsOrgWideSearch(located, text) {
  if (!normalize(text)) return false;
  if ((located?.areas || []).includes('layoutSection')) return true;
  return !(located?.results || []).some((r) => r.confidence === 'confirmed');
}

function labelOfObject(org, describes, name) {
  return describes.find((d) => d.name === name)?.label || (org.objects || []).find((o) => o.name === name)?.label || name;
}

/** "A, B and 3 more" for a card subtitle. */
function shortList(items, n = 3) {
  return items.length <= n ? items.join(', ') : `${items.slice(0, n).join(', ')} and ${items.length - n} more`;
}

/**
 * Page layout sections, custom buttons and screen flow text of the whole org that is the text (org.orgIndex,
 * master text). A section card for this page's object stays; one on another object replaces it.
 */
function addOrgWideResults(org, needle, text, describes, results, add, pageFlowName = null) {
  const idx = org.orgIndex;
  const objLabel = (o) => labelOfObject(org, describes, o);

  // Layout sections, grouped by object (each layout keeps its own copy of the name). Only the names an admin
  // typed: Translation Workbench → Layout Section does not list Salesforce's standard section names.
  const byObject = new Map();
  for (const l of idx.layouts || []) {
    const name = (l.sections || []).find((s) => normalize(s) === needle);
    if (!name) continue;
    if (!byObject.has(l.object)) byObject.set(l.object, { name, layouts: [] });
    byObject.get(l.object).layouts.push(l.layout);
  }
  // Viewing another language: a section's translation (background.js reads them when the text is no master name).
  for (const t of idx.sectionTranslations || []) {
    if (normalize(t.label) !== needle || (byObject.has(t.object) && !byObject.get(t.object).translated)) continue;
    if (!byObject.has(t.object)) byObject.set(t.object, { name: t.section, layouts: [], translated: t.label });
    const o = byObject.get(t.object);
    if (o.name === t.section && t.layout && !o.layouts.includes(t.layout)) o.layouts.push(t.layout);
  }
  const area = results.find((r) => r.key === 'area:layoutSection');
  const here = area?.goto?.object || null;
  // A Salesforce standard section name in this page's object's layouts (customLabel false): Salesforce text.
  const standardHere = !!area && !!here && !byObject.has(here) && (idx.layouts || []).some((l) => l.object === here && (l.standardSections || []).some((s) => normalize(s) === needle));
  if (standardHere) {
    results.splice(results.indexOf(area), 1);
    add(
      salesforceTextResult(`sfsection:${here}.${needle}`, area.confidence === 'confirmed' ? 'confirmed' : 'exact', {
        subtitle: `A standard section name in the ${objLabel(here)} page layouts`,
        steps: ['To show different text: in the page layout editor, rename the section. A renamed section is listed in Translation Workbench → Layout Section.'],
        notes: ['Translation Workbench → Layout Section lists only section names an admin typed.', 'Found by the org-wide search of page layouts.'],
      })
    );
  } else if (area && here && byObject.has(here)) {
    const { layouts } = byObject.get(here);
    area.notes = [`In the ${objLabel(here)} page layout${layouts.length === 1 ? '' : 's'}: ${shortList(layouts)}.`, ...(area.notes || [])];
  } else if (byObject.size) {
    // This page's object's layouts were read and lack the name: the section belongs to another object.
    // Not read (managed-package layouts, a failed call): keep this object's card next to the others.
    const replace = !area || !here || (idx.layouts || []).some((l) => l.object === here);
    // Pointed at a section header: with one object holding that name, that is its section.
    const single = replace && byObject.size === 1 && area?.confidence === 'confirmed';
    if (area && replace) results.splice(results.indexOf(area), 1);
    for (const [object, { name, layouts, translated }] of [...byObject].slice(0, MAX_ORG_WIDE)) {
      add({
        key: `section:${object}.${name}`,
        confidence: single ? 'confirmed' : 'exact',
        title: `Page layout section: ${name}`,
        subtitle: layouts.length ? `In the ${objLabel(object)} page layout${layouts.length === 1 ? '' : 's'} ${shortList(layouts)}` : `In the ${objLabel(object)} page layouts`,
        ...workbench(org, { component: 'Layout Section', object, objectLabel: objLabel(object), row: name, ...(translated ? { rows: [name, translated] } : {}) }),
        notes: [
          ...(translated ? [`"${translated}" is the ${languageName(org.userLanguage)} translation of this section's master name "${name}".`] : []),
          ...(area && here && replace ? [`This section is not in the ${objLabel(here)} page layouts.`] : []),
          'Found by the org-wide search of page layouts.',
          ...(layouts.length > 1 ? ['Each layout has its own copy of the section name. Go to translation opens every layout and lists each copy.'] : []),
        ],
      });
    }
  }

  // Screen flows (TW → Flow): a screen component whose label or display text is the text. Not when the
  // flow on this page already explained it.
  if (!results.some((r) => r.key.startsWith('flow:') && ['confirmed', 'exact'].includes(r.confidence))) {
    const hits = (idx.flows || [])
      .map((flow) => flowResult(org, { flow, props: { flowName: flow.name } }, text))
      .filter((r) => r.key.startsWith('flow:') && r.confidence === 'confirmed');
    const flowArea = results.find((r) => r.key === 'area:flow');
    for (const r of hits.slice(0, MAX_ORG_WIDE)) {
      const f = r.goto.flow;
      // Pointed at a running flow: with one flow holding the text, it is that one; with several, the one the
      // page names (its screens could not be read).
      const own = hits.length > 1 && f.name === pageFlowName && hits.filter((h) => h.goto.flow.name === pageFlowName).length === 1;
      r.confidence = flowArea && (hits.length === 1 || own) ? 'confirmed' : 'exact';
      r.notes = [`This text is the ${f.aspect === 'Description' ? 'display text' : 'label'} of the screen component ${f.screenComponent} in the flow ${f.label}.`, 'Found by the org-wide search of screen flows.'];
      add(r);
    }
    if (flowArea && hits.length) results.splice(results.indexOf(flowArea), 1);
  }

  // A screen's own footer button label (Flow Builder → Configure Footer). TW → Flow → Flow Component "Screen
  // Info" lists them by Flow Version (it starts at version 1) and Aspect (dev org, Nov 2026).
  const buttonHits = (idx.flows || []).flatMap((flow) =>
    (flow.screens || []).flatMap((sc) => (sc.buttons || []).filter((b) => normalize(b.label) === needle).map((b) => ({ flow, sc, b })))
  );
  const navArea = results.find((r) => r.key === 'area:flow');
  for (const { flow, sc, b } of buttonHits.slice(0, MAX_ORG_WIDE)) {
    const base = workbench(org, { component: 'Flow' });
    const own = buttonHits.length === 1 || (flow.name === pageFlowName && buttonHits.filter((h) => h.flow.name === pageFlowName).length === 1);
    add({
      key: `flowbtn:${flow.name}.${sc.name}.${b.aspect}`,
      confidence: navArea && own ? 'confirmed' : 'exact',
      title: `Flow button label: ${flow.label}`,
      subtitle: `Screen "${sc.label}", ${b.aspect}`,
      ...base,
      steps: [...base.steps, `Flow: ${flow.label}`, 'Flow Component: Screen Info', `Flow Version: ${flow.version ?? 'the newest version'}`, `Aspect: ${b.aspect}`],
      goto: { ...base.goto, flow: { label: flow.label, name: flow.name, component: 'Screen Info', version: flow.version ?? null, aspect: b.aspect }, rows: [b.label], rowLabel: truncate(b.label, 80) },
      url: SETUP.workbench,
      copy: b.label,
      notes: [`This text is the ${b.aspect.toLowerCase()} the screen ${sc.label} sets in its footer (Flow Builder → Configure Footer) in the flow ${flow.label}.`, 'Found by the org-wide search of screen flows.'],
    });
  }
  if (navArea && buttonHits.length && results.includes(navArea)) results.splice(results.indexOf(navArea), 1);

  // Custom buttons and links (TW → Button and Link Label lists them by object). Same key as the card the
  // page metadata gives (btn:Object.Name), so a button you pointed at keeps its confirmed card.
  for (const b of (idx.buttons || []).filter((x) => normalize(x.label) === needle).slice(0, MAX_ORG_WIDE)) {
    const name = b.namespace ? `${b.namespace}__${b.name}` : b.name;
    add({
      key: `btn:${b.object}.${name}`,
      confidence: 'exact',
      title: `Custom button/link ${b.object}.${name}`,
      subtitle: `A button or link on ${objLabel(b.object)}`,
      ...workbench(org, { component: 'Button and Link Label', object: b.object, objectLabel: objLabel(b.object), row: `${b.label} (${name})`, rows: [name, b.label], pkg: b.namespace }),
      copy: name,
      notes: ['Found by the org-wide search of custom buttons and links.'],
    });
  }
}

// Managed-package labels with the same words as a field or object are usually a coincidence
// (UAT2: maps__ and genesysps__ labels "Territory", "Phone", "Type"...). Rank them after non-label answers.
const MANAGED_EXACT_RANK = SOURCE_RANK[SOURCE.NOT_TRANSLATABLE] + 0.5;
// With a page-confirmed answer, show at most this many same-text managed labels; fold the rest.
const MAX_MANAGED_WITH_CONFIRMED = 2;

const isManagedLabel = (r) => r.source === SOURCE.CUSTOM_LABEL && !!r.pkg;
const sourceRank = (r) => (isManagedLabel(r) && r.confidence === 'exact' ? MANAGED_EXACT_RANK : SOURCE_RANK[r.source]);

function finalize(results, areas, orgWide = {}) {
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
  // One "Salesforce text" card: a page-area card (sfdctext:feed...) adds nothing next to a specific
  // Salesforce text card that matched (R-05: Chatter "Post" also got a bare feed card).
  const isAreaText = (r) => r.source === SOURCE.SALESFORCE && r.key.startsWith('sfdctext:');
  const specific = unique.filter((r) => r.source === SOURCE.SALESFORCE && !isAreaText(r)).map((r) => r.confidence);
  if (specific.includes('confirmed')) unique = unique.filter((r) => !isAreaText(r));
  else if (specific.includes('exact')) unique = unique.filter((r) => !isAreaText(r) || r.confidence === 'confirmed');
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
  const more = [];
  if (unique.some((r) => r.confidence === 'confirmed')) {
    let shown = 0;
    unique = unique.filter((r) => {
      if (!isManagedLabel(r) || r.confidence !== 'exact') return true;
      if (++shown <= MAX_MANAGED_WITH_CONFIRMED) return true;
      hiddenManaged++;
      more.push(r);
      return false;
    });
  }
  // Partial matches go behind "Show more" when a closer match exists.
  const hasBetter = unique.some((r) => r.confidence !== 'partial');
  const limit = hasBetter ? 0 : MAX_PARTIAL;
  let partialCount = 0;
  let droppedPartial = 0;
  unique = unique.filter((r) => {
    if (r.confidence !== 'partial') return true;
    if (++partialCount <= limit) return true;
    droppedPartial++;
    more.push(r);
    return false;
  });
  // Org-wide sources searched (#24) are named as searched, and no longer as places to check.
  const wide = [orgWide.layouts && 'page layout sections', orgWide.buttons && 'custom buttons', orgWide.flows && 'screen flows'].filter(Boolean);
  const places = [['Layout Section', 'layouts'], ['Flow', 'flows'], ['Lookup Filter'], ['Button and Link Label', 'buttons'], ['Report'], ['Dashboard']].filter(([, k]) => !orgWide[k]).map(([p]) => p);
  const notFoundHelp = unique.length
    ? null
    : [
        wide.length
          ? `Not found in custom labels, object/field names, picklists, record types, actions, apps, tabs, validation messages, path guidance, or the ${wide.length > 1 ? `${wide.slice(0, -1).join(', ')} and ${wide[wide.length - 1]}` : wide[0]} of the whole org.`
          : 'Not found in custom labels, object/field names, picklists, record types, actions, apps, tabs, validation messages, or path guidance.',
        `Other places to check in Translation Workbench: ${places.join(', ')}.`,
        'Text typed into custom components is not translatable until a developer moves it into a Custom Label.',
      ];
  return { results: unique, more, droppedPartial, hiddenManaged, notFoundHelp, areas: [...areas] };
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
