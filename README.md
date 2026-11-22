# SF Translation Locator (Chrome extension)

Right-click any text in Salesforce (or point at it and press **Alt + Shift + T**) and see **where its
translation lives**. It checks Custom Labels, Rename Tabs and Labels, Translation Workbench (Translate
and Override), and Data Translation. Each result shows the click path. Results that have a translation
screen also show a **Go to translation** button. It opens that screen and fills in the language and
filters. You type the translation and click Save.

**Roadmap:** [open features](https://github.com/fulton916/SF_Translation_Browser_Extension/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement)

## Install (developer mode, about 2 minutes)

1. Get the zip. From GitHub: open
   [the Releases page](https://github.com/fulton916/SF_Translation_Browser_Extension/releases/latest) and,
   under **Assets**, click `SF-Translation-Locator-<version>.zip`. Use that file, not "Source code (zip)".
   If someone sent you the zip, use that instead. Unzip it into a folder you will keep: Chrome loads the
   extension from that folder, so moving or deleting it removes the extension. Inside is a folder named
   `SF-Translation-Locator`. That is the folder to pick in step 4.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right). On a company-managed Chrome, IT policy can block Developer
   mode or **Load unpacked**. If so, ask IT.
4. Click **Load unpacked** and pick the `SF-Translation-Locator` folder (the one that holds `manifest.json`).
   "Manifest file is missing" means you picked the folder above it.
5. Pin the extension: puzzle-piece menu → **SF Translation Locator** (a grey letter icon). Clicking it
   opens the test log.
6. Reload any open Salesforce tabs.
7. In Salesforce, highlight a word, right-click, and choose **Find Salesforce translation for "..."**.
   With nothing highlighted, right-click the text and choose **Find Salesforce translation for this text**,
   or point at it and press **Alt + Shift + T** (**Option + Shift + T** on a Mac).

To update to a newer version: download the new zip from the Releases page and unzip it over the same
folder (replace the files). Click reload on the extension in `chrome://extensions`, then press F5 on your
Salesforce tabs. Panels left open from before the reload stop working. The version shows at the bottom
right of every panel.

## Requirements

Log in to Salesforce. Your user needs:

- **API Enabled**: for every lookup.
- **View Setup and Configuration**: for custom labels, validation rules, paths and path guidance,
  Lightning App Builder text, and picklist value sets. Without it, those answers are missing from the panel.
- **Modify Metadata Through Metadata API Functions** (or **Modify All Data**): only while you view a language
  other than the org default, to name a page layout section by its master name and to confirm a translated
  validation message. Without it, the section card names the text you pointed at, and a translated message
  under a field lists that field's rules from the page area instead of confirming one.
- **Manage Translation**: to save or remove a custom label translation in the panel (**Edit translations**).
  Without it, the panel shows "Saving needs the Manage Translation permission." and nothing is written.
  Salesforce requires View Setup and Configuration for Manage Translation, so a user who can save can also read.
- For **Go to translation**, the permissions of the screen it opens:
  - Translation Workbench: enabled in the org, plus **Manage Translation** (or you are set up as a
    translator for the target language).
  - Rename Tabs and Labels, and custom label translations: **Customize Application**.
  - Data Translation (record data): **Manage Translation** and **Create Documents** to export and import
    the translation files. Turning data translation on for a field needs **Customize Application** and
    **Modify All Data**.

## Reading the panel

Each card is one place the text can come from. The best answer is first.

The **badge** (top left of a card) says who can change the text:

| Badge | Meaning |
|---|---|
| Owned by Salesforce | Salesforce writes and translates this text. There is nothing to do. |
| Admin work required to translate | An admin must change the setup first (the card lists the steps), for example move the text into a Custom Label. Then it can be translated. |
| Custom Labels, Rename Tabs and Labels, Translation Workbench, Workbench Override (package), Data Translation (record data), Custom translation object | Translate it in that tool. |
| Page context | The page area you pointed at, when no text in the org matched. |

The **tag** (top right) says how the card was found, strongest first:

| Tag | Meaning |
|---|---|
| Confirmed Location (green) | The page itself shows where this text comes from. |
| Not Translatable (orange card) | Confirmed: Salesforce text, or text that needs admin work first. |
| Same text | A place in your org with the same words. |
| Similar text | A place in your org that shares words with it. |
| From page area | Found from the part of the page you pointed at. |

Lower matches are behind the link **Show N similar texts in your org**. Click it to add those cards.

Buttons: **Go to translation** (only on cards with a translation screen), **Open page** (the Setup or record page for that card),
**Copy ...** (the API name or label reference), and **Edit translations** (custom label cards only). At the bottom: **Refresh org data** (reload the org's
metadata after a change), **Test log**, and **Report a problem**.

### Edit a custom label translation in the panel

1. On a custom label card, click **Edit translations**. The editor reads the label from the org and shows one
   box per active translation language. The label's own language and inactive languages are not offered.
2. Type the translation (at most 1000 characters) and click **Save**. Save is off while the box is empty or unchanged.
3. The panel reads the value back from the org and shows it under the box. Salesforce pages show the new text
   after Lightning refreshes its label cache, which takes a few minutes.
4. To delete a translation, click **Remove**, then **Click again to remove**.

## Report a problem

In the panel, click **Report a problem**. A report of the lookup is copied. Paste it into an email or chat
to the person who sent you the extension, and add a sentence about what was wrong. Or open the test log
(toolbar icon, or **Test log** at the bottom of the panel), click **Copy all**, and send that.
Do not paste logs in public places: they contain field names and page addresses.

## How it works

```
Right-click
(or Alt+Shift+T)
           ─► content.js records the element + its Lightning metadata
               (e.g. data-target-selection-name="sfdc:RecordField.Account.Industry")
           ─► background.js gets your session from the sid cookie (same method as
               Salesforce Inspector), then calls the REST + Tooling APIs
           ─► locator.js matches the text against every translatable source and
               decides where each match is translated
           ─► content.js shows a panel with the results and buttons
```

Read-only. The extension never writes to your org. Org metadata is cached in memory for 5 minutes.
Your language is read again on each lookup (cached 15 seconds): after you change it in your personal
settings, the next lookup reads object names, tabs, apps and field labels again in the new language.
Custom label translations are searched per lookup (by text and by matching label, then every language of
each label found), not cached: large orgs have 150,000+ of them.

Viewing a language other than the org default, the panel also reads the master labels of the objects in
play (SOAP `describeSObject` with the `LocaleOptions` header in the org default language) and, for a page
layout section header, the section translations (Metadata API `readMetadata` of `CustomObjectTranslation`
`<Object>-<language>`). Translation Workbench lists rows by their master label, so "Find the row" and Go
to translation use it, with the API name; the card still shows the text you pointed at.

## The decision map (what lives where)

This is the core rule set, coded in [src/locator.js](src/locator.js).

| Text you see | Where to translate | Searched |
|---|---|---|
| Custom label value (Apex, LWC, Aura, VF, Flow `{!$Label}`) | **Custom Labels** → label → Local Translations / Overrides | Yes (value and existing translations) |
| Standard object name (Account, Opportunity) | **Rename Tabs and Labels** → Standard Tabs | Yes |
| Custom object name | **Rename Tabs and Labels** → Custom Tabs (master label: Object Manager) | Yes |
| Standard field label | **Rename Tabs and Labels** → object → Edit → Next (step 2). A custom object's standard fields (Owner ID, Record Type ID, Deleted) are Salesforce text | Yes (current object) |
| Custom object's Name field label ("Widget Name") | **Rename Tabs and Labels** → Custom Tabs → object → Edit → **Record Name** on that page (no step 2) | Yes (current object) |
| Standard tab (Chatter and others TabDefinition lists) | **Rename Tabs and Labels** | Yes |
| Nav bar standard tab with no object/tab name match (Home, Calendar) | Owned by Salesforce, unless TabDefinition lists it with that name (then **Rename Tabs and Labels**) | From page metadata (`sfdc:TabDefinition.standard-<X>`, nav item `data-id="home"`) |
| Custom field label / help text | **Translation Workbench** → Custom Field | Yes (current object) |
| Standard field help text | **Translation Workbench** → Standard Field Help | Yes (current object) |
| Picklist value | **Translation Workbench** → Picklist Value, or → Global Value Set (tree: value set label → values) when the field uses one | Yes (current object). The value set is read from Tooling `CustomField.Metadata` for matching custom picklists, and from `StandardValueSet.Metadata` for a standard picklist you point at (inactive values too) |
| Path step chevron | The path field's picklist value (above); the generic last "Closed" step is Salesforce text | Confirmed for the active path of the record's record type (read from the record). The Closed step is found by its marker (`li[data-target-selection-name=closedPathTab]`), in any language |
| Record type | **Translation Workbench** → Record Type | Yes (current object) |
| Quick action | **Translation Workbench** → Action; feed actions (`FeedItem.*`, e.g. New Note, Post) and standard global actions (NewTask, NewContact, NewCase, NewEvent, LogACall…) are Salesforce text: TW → Action does not list them | Yes (current object) |
| Validation error message | **Translation Workbench** → Validation Error Message | Yes (all objects, master message). Confirmed when you point at the error message under a field (`.slds-form-element__help`) and an active rule of that object has this message. Viewing a language other than the org default, a message under a field that matches no master message gives that object's active rules whose error location is that field (`ErrorDisplayField`, which Salesforce returns as the API name or as the field label): confirmed when the rule's translation in that language (CustomObjectTranslation) is the text, otherwise listed from the page area (the text can also be Salesforce's own required-field message), with the master message in a note |
| App name | **Translation Workbench** → App | Yes |
| Web / Visualforce / Lightning tab | **Translation Workbench** → Web Tab | Yes |
| Custom button / link | **Translation Workbench** → Button and Link Label | From page metadata only |
| Page layout section header | **Translation Workbench** → Layout Section | From page metadata. Also detected on Aura classic record layouts: a `forcePageBlockSection` header (an `h1`–`h6` or `legend` in the path), not a `forcePageBlockItem` field; a custom label with the same text then drops to similar text. Auto-fill opens every layout and lists each copy of the section |
| Flow screen text | **Translation Workbench** → Flow → the flow → Flow Component "Screen Component" → Screen → Screen Component → Aspect "Description" (display text) or "Label" (an input) | From page metadata. On a Lightning page, the Flow component names the flow, and its active version's screens are read (Tooling `Flow.Metadata`): confirmed when the text is a screen component's text |
| Path guidance ("Guidance for Success") | **Translation Workbench** → Path Step Rich Text (find the row by its raw HTML; the whole block is one translation) | Yes (all paths; a whole list line is enough). Confirmed when you point inside the guidance of the record's own path. A custom object's step names the object by its Id (01I…), cut at 80 characters: the step is matched to its path by record type Id, or by object Id and field |
| Report / dashboard names and parts | **Translation Workbench** → Report, Dashboard, Report Chart… | Not yet |
| Anything from an installed package (namespace like `acme__`) | **Translation Workbench → Override** (pick the package) | Yes, for Custom Field, Action, Button, Record Type, Validation, Web Tab, Flow, Custom Label |
| Record data: Product / Product Category Name and Description, plus enabled custom fields | **Data Translation**: the record's Translations tab (an admin adds it in Lightning App Builder) | Yes, on record pages; says how to enable it if off |
| Record data in an org-built translation object (e.g. `Product_Translations__c`) | That object's related list on the record | Yes: any custom child object with "Translat" in its name |
| Standard button (Edit, Delete) | Owned by Salesforce (Salesforce translates it) | Flagged |
| Text typed into a custom LWC/Aura component or into Lightning App Builder | Admin work required to translate: move the text into a Custom Label | Flagged |
| Lightning App Builder text: field section label, Dynamic Related List label, record page tab title | `{!$Label.X}` → that **Custom Label**; `@@@SFDC…SFDC@@@` / `Standard.Tab.*` / standard related lists → Salesforce text; plain text → Admin work required to translate | Read from the FlexiPage for the section (also on a New or Edit form), list header or tab you point at (any component identifier, also custom ones like `my_tab_greeting`). A custom lookup list (`…__r`) → **Translation Workbench** → Custom Field → Related List Label of the child lookup field. In the standard Related Lists component, the list's title link (`…/related/<relationship>/view`) names the relationship |
| Rich Text component text (Lightning App Builder) | Admin work required to translate: replace it with a component that shows a Custom Label, or one Rich Text component per language with a Component Visibility filter on the user's Language | From the page area (`data-aura-class="flexipageRichText"`) |
| Report chart title (Report Chart component) | Admin work required to translate: set its Label to a Custom Label | From the page area |
| User calendar names in My Calendars / Other Calendars | Admin work required to translate: a user named it; only its owner can change it | From the page area. My Events is told apart by its fixed calendar Id (`input#calendarToggle-03A0000000000000001`), in any language |
| Value in a record field, record name in the highlights panel | Record data, formula output (change the formula), a value missing from the picklist: Admin work required to translate. Auto-number and currency name: Salesforce text. Inactive picklist values go to Picklist Value | When you point at the value, not the label (Details or highlights panel). An event box on the Calendar page (`runtime_calendar-*-event`) gives "Record data: Event subject", confirmed, with no Salesforce text card |
| Salesforce text: path headings (Key Fields, Guidance for Success) and step button, activity timeline, duplicates card, Chatter feed, report chart body, Calendar page (New Event, Today, day headers, My Events, the My Calendars / Other Calendars headings), global header (search) | Owned by Salesforce (Salesforce translates it) | Flagged from the page area, in any language: the step button by `runtime_sales_pathassistantPathAssistantHeader` (the field its text names is listed as context: its label is translated), the headings by an `h2` in `…PathAssistantInfo` / `…PathAssistantFields` |
| Pipeline Inspection (Opportunities → Pipeline Inspection) | Metric tiles (Open Pipeline, Moved In…), filters, the Metrics menu, the Inspection / Chart tabs, buttons and the empty-list message: Owned by Salesforce. The heading above the view name is the object name: **Rename Tabs and Labels**. The view name is a list view name: Admin work required to translate (clone the view per language). List column headers are field labels; the columns Pipeline Inspection adds (Alerts, Contacts, Activity, Important) and the Activity chart ("No recent activity") are Owned by Salesforce; other cells are record data. A metric name an admin set in Pipeline Settings → Metrics Settings: **Translation Workbench** → Pipeline Inspection Metric Configuration, row = the metric name, column "Pipeline Inspection Metric Custom Label" (confirmed) | From the page area (`data-aura-class="runtime_pipeline_inspectorPipelineInspectorHome"`; the view name in `lst-list-view-picker`). A metric tile's text is matched against the org's `PipelineInspMetricConfig` rows (REST query, `MasterLabel`); an org without Pipeline Inspection has none. Viewing a language other than the org default, a tile shows a renamed metric's translation, which `MasterLabel` never holds: the tile card drops to context and the renamed metrics are listed as context. Same-text custom labels and the New quick action drop to similar text |
| Utility bar item (its button, or the open panel's title) | A label typed in App Manager → the app → Edit → Utility Items: Admin work required to translate (Translation Workbench has no component for it), confirmed with the app and item named. An item with no label of its own (To Do List, History, Notes): Owned by Salesforce. To Do List is found by its component (`runtime_sales_todo_list…`; in the open panel, the component inside `oneUtilityBarPanel`), in any language. An item not found in the org's utility bars: the App Manager context card | From the page area (`oneUtilityBarItem`, the item's component id), then the utility bar FlexiPages: the current app first (`UserAppInfo` → `AppDefinition.UtilityBar`), other apps' bars only when it has no match. The item label is the `label` decorator property |
| Upload Files / Or drop files in the Files related list | Owned by Salesforce | From the page area (`forceContentFileDroppableZone`) |
| Picklist value in a dialog (e.g. Team Role in Add Opportunity Team Members) | **Translation Workbench** → Picklist Value → the dialog's object (Opportunity Team Member) | The dialog title names the object; the picklist's options open in a popup outside the dialog |
| Reminder and notification cards in the global header | The card frame is Salesforce text; event subjects and custom notification text in them come from your org | "From page area" |
| Heading of the error popup after a failed save ("We hit a snag.") | Owned by Salesforce | From the page area (`.slds-popover_error` with `.slds-popover__header`, Aura `forcePageError`). The fields and messages listed below it are looked up as usual |

Matching rule: a highlight of 1 or 2 characters matches only the same text. 3 or 4 characters also match
whole words inside a longer text. 5 or more characters also match inside words. A highlight that contains
a whole name of 4 or more characters, at least 40% of the highlight's length, matches that name too:
"Edit Industry" matches "Industry".

Language rule: if you are viewing Salesforce in the org default language, the text is the
**master label**. Change it in Object Manager (or the label itself). Translations go into the
other languages. In another language, cards name the master label (with its API name) for the
Workbench row and for Object Manager.

Salesforce's own text is found by page marker (component, `data-aura-class`, `data-target-selection-name`),
never by its English words, so "Owned by Salesforce" answers work in every language. English words are still
compared in three places with no marker: the step buttons, "Closed" step and "Guidance for Success" of a
`lightning-path` (an LWC path with no path assistant markers), a highlight that starts with the "Guidance for Success" heading (in
another language it matches the step as similar text), and Salesforce's required-field messages under a field
(in another language the field's validation rules are listed as context).

## "Go to translation" (verified in real orgs, Nov 2026)

Salesforce has no documented deep links for these pages. These were found by inspecting the pages.

| Result | Opens | Auto-fill |
|---|---|---|
| Custom label | Setup → Custom Labels → the label's New Translation page (`/01j/e?Parent=<label Id>` inside `/lightning/setup/ExternalStrings/page`), or the existing translation's edit page for that language | Picks the Language |
| Standard object / field | Setup → Rename Tabs and Labels → the object's Edit page (`RenameTabStageManager?id=<Object>&l=<lang>` inside `/lightning/setup/RenameTab/page`) | For a field: clicks Next (saves nothing), highlights the field on Step 2 |
| Custom object | Setup → Rename Tabs and Labels (`/lightning/setup/RenameTab/home`) | Switches language, opens the object's Edit page (`RenameEntityUi/e`, one page, no Next); highlights Singular, Plural, or for its Name field Record Name |
| Translation Workbench item | Setup → Translate (`/lightning/setup/LabelWorkbenchTranslate/home`) | Sets Language, Setup Component, Object, Aspect (for a flow: Flow, Flow Component, Screen, Screen Component, Aspect); finds the row (pages through the grid; a tree is searched again until it has loaded, up to 15 s) and marks it. Double-click its translation cell to type: a script-opened edit box closed on the next click and lost the text. Path guidance: matches the row's raw HTML, or its text without tags |
| Package item | Setup → Override (`/lightning/setup/LabelWorkbenchOverride/home`) | Same as Translate, plus picks the Package by namespace (warns if two packages share it) |
| Record data | The record page | Clicks the Translations tab, found by its App Builder identifier in any language. If the page has none, says so |

Pick the target language in the panel ("Translate into"). It starts on the org default language; every
language, including English, can be picked. The extension never clicks Save. If you switch tabs while
auto-fill runs, it keeps going, and retries a failed step when you come back.

## Test log

Click the extension's icon in the toolbar (or **Test log** at the bottom of the panel) to open the log.
It records each lookup, its top results and the page element behind it (tags, component names, dialog title), each Go to translation, every auto-fill step and message,
and all errors with details. It updates live while you test. **Copy all** gives plain text to send
to the person who sent you the extension. **Download** saves JSON. Stored only in this browser (last 500 entries);
session IDs and URL query strings are removed before saving.

## Roadmap

Planned features are tracked one per GitHub issue, label `enhancement` plus a `group: <area>` label
([open feature list](https://github.com/fulton916/SF_Translation_Browser_Extension/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement)).
Each one gets its own branch and PR.

1. **Phase 1 (done):** identify the source and give the click path + Setup link.
2. **Phase 2 (done):** "Go to translation" opens the exact screen and auto-fills it.
3. **Phase 3:** edit the translation inside the panel.
   - **Part 1 (done):** custom label translations through the Tooling API (`ExternalStringLocalization`) (#25).
   - Part 2: other translation types through the Metadata API (`CustomObjectTranslation`, `Translations`) (#29).
4. **Phase 4 (done):** coverage report. List every label with a missing translation per active language (#14).
5. Search layout sections, flows, and buttons org-wide (Metadata API retrieve, cached) (#24).

## Other translation places (not in the extension yet)

Found in Salesforce Help: Knowledge article translations, Experience Builder site languages, Salesforce CMS,
Surveys (Languages tab), Einstein Bot dialog translations, Channel Menu labels, OmniStudio multi-language
Omniscripts (they write Custom Labels), and Workbench Export/Import for bulk files.
Most of these show on Experience Cloud sites or in builders, where this extension does not run.

## Known limits

- **Edit translations** saves custom label translations only. Other translation types use **Go to translation** (#29).
  A user set up only as a translator for a language (Translation Settings), without Manage Translation, is not tested.
- Fields, picklists, record types, and actions are searched for the object on the current page only. In a
  related list's rows, the child object's field labels are searched too.
- Per lookup, the full value list (inactive values and value sets) is read for at most 4 picklist fields,
  the one you point at first.
- Salesforce text is recognised by page markers, in any language. Two checks still use English words: a
  path guidance highlight that starts with its heading, and Salesforce's required-field messages.
- The record's Translations tab is found by the page metadata (Lightning App Builder's standard
  "Translations" tab title, or a title typed as "Translations"), so auto-fill needs the View Setup permission
  to read the page. A tab with any other title is not found.
- Viewing another language, a renamed Pipeline metric tile is named from its Translation Workbench row
  (Metadata API, needs Modify Metadata or Modify All Data). Without that access, every renamed metric is listed
  as context.
- Path guidance is matched on its master text only. Viewing Salesforce in a translated language, the guidance shows the translation, which is not searched.
- Validation messages are matched on their master text. A translated message is found only when it shows
  under a field (by the rule's error location, confirmed through the rule's translation); a translated message
  at the top of the page is not searched.
- Viewing another language, quick action and button rows are named by the text on the page and their
  API name (their master label is not read).
- Chrome's own page translation ("Translate this page", or "Always translate" for a language) rewrites
  Salesforce's text in the page, so the extension sees Chrome's translation, not Salesforce's. When you test
  another language, turn it off for Salesforce: Chrome's translate icon in the address bar → ⋮ → Never
  translate this site.
- Gov Cloud (`.mil`) and China (`.sfcrmproducts.cn`) domains are not mapped yet (#26).
- Experience Cloud sites are not supported (different session).
- Some Setup component names in Translation Workbench vary slightly by org edition. The panel says
  which to pick; if it is missing in your dropdown, check the nearest match.

## Develop (repository collaborators only)

The zip does not hold the tests; this section is for people with access to the repository.

[![Tests](https://github.com/fulton916/SF_Translation_Browser_Extension/actions/workflows/test.yml/badge.svg)](https://github.com/fulton916/SF_Translation_Browser_Extension/actions/workflows/test.yml)

Get the code: on GitHub click **Code → Download ZIP**, or run
`git clone https://github.com/fulton916/SF_Translation_Browser_Extension.git`.
Bugs and test findings: open a [new issue](https://github.com/fulton916/SF_Translation_Browser_Extension/issues/new/choose)
(**Bug report** or **Test finding**) and paste the test log. Labels: `bug`, `test-finding`, `enhancement`.
The repository is private: test logs contain org details (field names, page addresses).

Needs Node.js 20 or newer. No dependencies to install.

```bash
npm test
```

Tests run on every push and pull request (GitHub Actions). They cover:

- `test/locator.test.js`: matching and classification in `src/locator.js`, using fake org data and cases found in real orgs.
- `test/sfApi.test.js`: the per-lookup custom label translation query.
- `test/logStore.test.js`: the test log (redaction, size cap, export).
- `test/pipeline.test.js`, `test/uat2Sweep.test.js`: Pipeline Inspection, dialog picklists, the utility bar and the Files upload area (element paths read from UAT2).
- `test/sweep.test.js`, `test/sweepPage.test.js`, `test/dv2.test.js`, `test/live2.test.js`, `test/devorg.test.js`: one test per
  finding from the live sandbox and Developer Edition runs (made-up names and Ids), including the Alt+Shift+T pointer logic in
  `src/pointerTarget.js` and the auto-fill retry in `src/waitUntil.js`.
- `test/devVersion.test.js`: the code fingerprint used by the auto-reload below.

### Auto-reload while developing

```bash
npm run dev
```

Leave it running. Within 30 seconds of a change to `manifest.json` or anything in `src/`, the extension
reloads itself and puts the new content script into open Salesforce tabs without refreshing them.
Panels that were open stop working: open them again. The server only listens on 127.0.0.1 and writes
`dev.json` (gitignored, not in the zip). Without that file the extension does not poll anything.
After a change to the reload code itself (in `src/background.js`), reload once by hand.

Auto-fill (`src/content.js`) runs against live Salesforce pages and is tested by hand. Record what you test in an issue.

### Files

| File | Job |
|---|---|
| `manifest.json` | Chrome extension setup (permissions, scripts) |
| `src/background.js` | Right-click menu, Salesforce API calls, opens translation pages, writes the log |
| `src/pointerTarget.js` | Picks the element the Alt+Shift+T shortcut describes: the highlighted text, else the element under the pointer (unit tested) |
| `src/waitUntil.js` | Auto-fill retry: searches again until the Translate page's tree has loaded (unit tested) |
| `src/content.js` | Reads the clicked element, shows the panel, auto-fills Setup pages |
| `src/locator.js` | Decides where each text is translated (no browser code; unit tested) |
| `src/sfApi.js` | REST and Tooling API queries, and the write helper (`sfWrite`) |
| `src/labelEdit.js` | Custom label translation editor: requests, plain-word errors, save and read back (unit tested) |
| `src/logStore.js`, `src/log.html`, `src/log.js` | Test log storage and viewer |
