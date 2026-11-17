# SF Translation Locator (Chrome extension)

[![Tests](https://github.com/fulton916/SF_Translation_Browser_Extension/actions/workflows/test.yml/badge.svg)](https://github.com/fulton916/SF_Translation_Browser_Extension/actions/workflows/test.yml)

Right-click any text in Salesforce and see **where its translation lives**. It checks Custom Labels,
Rename Tabs and Labels, Translation Workbench (Translate and Override), and Data Translation. Each
result shows the exact click path and a **Go to translation** button. That button opens the exact
screen and fills in the language and filters. You type the translation and click Save.

## Install (developer mode, about 2 minutes)

1. Get the code: on this page click **Code → Download ZIP** and unzip it, or run
   `git clone https://github.com/fulton916/SF_Translation_Browser_Extension.git`.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the folder that holds `manifest.json`.
5. Pin the extension (puzzle-piece menu). Its toolbar icon opens the test log.
6. Reload any open Salesforce tabs.
7. In Salesforce, highlight a word, right-click, and choose **Find Salesforce translation for "..."**.
   You can also right-click text without highlighting it.

After you update the code: click reload on the extension in `chrome://extensions`, then press F5 on
your Salesforce tabs. Panels left open from before the reload stop working.

Requirements: you are logged in to Salesforce, and your user has **API Enabled**.
Custom label and validation-rule search also need **View Setup and Configuration**.

## Report a bug or test finding

1. Open the test log (toolbar icon, or **Test log** at the bottom of the panel).
2. Click **Copy all**.
3. Open a [new issue](https://github.com/fulton916/SF_Translation_Browser_Extension/issues/new/choose),
   pick **Bug report** or **Test finding**, and paste the log.

Labels: `bug` (something is wrong), `test-finding` (seen while testing in an org), `enhancement` (new idea).

This repository is private. Test logs can contain org details (field names, page addresses), so keep it private.

## How it works

```
Right-click ─► content.js records the clicked element + its Lightning metadata
               (e.g. data-target-selection-name="sfdc:RecordField.Account.Industry")
           ─► background.js gets your session from the sid cookie (same method as
               Salesforce Inspector), then calls the REST + Tooling APIs
           ─► locator.js matches the text against every translatable source and
               decides where each match is translated
           ─► content.js shows a panel with the results and buttons
```

Read-only. The extension never writes to your org. Org metadata is cached in memory for 5 minutes.
Custom label translations are searched per lookup (by text and by matching label), not cached:
large orgs have 150,000+ of them.

## The decision map (what lives where)

This is the core rule set, coded in [src/locator.js](src/locator.js).

| Text you see | Where to translate | Searched |
|---|---|---|
| Custom label value (Apex, LWC, Aura, VF, Flow `{!$Label}`) | **Custom Labels** → label → Local Translations / Overrides | Yes (value and existing translations) |
| Standard object name (Account, Opportunity) | **Rename Tabs and Labels** → Standard Tabs | Yes |
| Custom object name | **Rename Tabs and Labels** → Custom Tabs (master label: Object Manager) | Yes |
| Standard field label | **Rename Tabs and Labels** → object → Edit → Next (step 2) | Yes (current object) |
| Standard tab (Home, Chatter) | **Rename Tabs and Labels** | Yes |
| Custom field label / help text | **Translation Workbench** → Custom Field | Yes (current object) |
| Standard field help text | **Translation Workbench** → Standard Field Help | Yes (current object) |
| Picklist value | **Translation Workbench** → Picklist Value (or Global Value Set) | Yes (current object) |
| Record type | **Translation Workbench** → Record Type | Yes (current object) |
| Quick action | **Translation Workbench** → Action | Yes (current object) |
| Validation error message | **Translation Workbench** → Validation Error Message | Yes (all objects) |
| App name | **Translation Workbench** → App | Yes |
| Web / Visualforce / Lightning tab | **Translation Workbench** → Web Tab | Yes |
| Custom button / link | **Translation Workbench** → Button and Link Label | From page metadata only |
| Page layout section header | **Translation Workbench** → Layout Section | From page metadata only |
| Flow screen text | **Translation Workbench** → Flow | From page metadata only |
| Report / dashboard names and parts | **Translation Workbench** → Report, Dashboard, Report Chart… | Not yet |
| Anything from an installed package (namespace like `acme__`) | **Translation Workbench → Override** (pick the package) | Yes, for Custom Field, Action, Button, Record Type, Validation, Web Tab, Flow, Custom Label |
| Record data: Product / Product Category Name and Description, plus enabled custom fields | **Data Translation**: the record's Translations tab (an admin adds it in Lightning App Builder) | Yes, on record pages; says how to enable it if off |
| Record data in an org-built translation object (e.g. `Demo_Translations__c`) | That object's related list on the record | Yes: any custom child object with "Translat" in its name |
| Standard button (Edit, Delete) | Not translatable (Salesforce translates it) | Flagged |
| Text typed into a custom LWC/Aura or Lightning App Builder | Not translatable until moved into a Custom Label | Flagged |

Language rule: if you are viewing Salesforce in the org default language, the text is the
**master label**. Change it in Object Manager (or the label itself). Translations go into the
other languages.

## "Go to translation" (verified in real orgs, Nov 2026)

Salesforce has no documented deep links for these pages. These were found by inspecting the pages.

| Result | Opens | Auto-fill |
|---|---|---|
| Custom label | `/01j/e?Parent=<label Id>` (New Translation), or `/<translation Id>/e` if one exists for the language | Picks the Language |
| Standard object / field | `/_ui/common/i18n/RenameTabStageManager?id=<Object>&l=<lang>` | For a field: clicks Next (saves nothing), highlights the field on Step 2 |
| Custom object | Rename Tabs and Labels list | Switches language, opens the object's Edit page |
| Translation Workbench item | Translate page (`/i18n/TranslationWorkbench.apexp`) | Sets Language, Setup Component, Object, Aspect; finds the row (pages through the grid); opens its edit box |
| Package item | Override page (`/i18n/LabelWorkbenchOverride.apexp`) | Same as Translate, plus picks the Package by namespace (warns if two packages share it) |
| Record data | The record page | Clicks the Translations tab. If the page has none, says so |

Pick the target language in the panel ("Translate into"). It starts on the org default language; every
language, including English, can be picked. The extension never clicks Save. If you switch tabs while
auto-fill runs, it keeps going, and retries a failed step when you come back.

## Test log

Click the extension's toolbar icon (or **Test log** at the bottom of the panel) to open the log.
It records each lookup and its top results, each Go to translation, every auto-fill step and message,
and all errors with details. It updates live while you test. **Copy all** gives plain text to paste
into an issue. **Download** saves JSON. Stored only in this browser (last 500 entries);
session IDs and URL query strings are removed before saving.

## Roadmap

1. **Phase 1 (done):** identify the source and give the click path + Setup link.
2. **Phase 2 (done):** "Go to translation" opens the exact screen and auto-fills it.
3. **Phase 3:** edit the translation inside the panel. Write it through the Tooling API
   (`ExternalStringLocalization`) or Metadata API (`CustomObjectTranslation`, `Translations`).
4. **Phase 4:** coverage report. List every label with a missing translation per active language.
5. Search layout sections, flows, and buttons org-wide (Metadata API retrieve, cached).

## Other translation places (not in the extension yet)

Found in Salesforce Help: Knowledge article translations, Experience Builder site languages, Salesforce CMS,
Surveys (Languages tab), Einstein Bot dialog translations, Channel Menu labels, OmniStudio multi-language
Omniscripts (they write Custom Labels), and Workbench Export/Import for bulk files.
Most of these show on Experience Cloud sites or in builders, where this extension does not run.

## Known limits

- Fields, picklists, record types, and actions are searched for the object on the current page only.
- Gov Cloud (`.mil`) and China (`.sfcrmproducts.cn`) domains are not mapped yet.
- Experience Cloud sites are not supported (different session).
- Some Setup component names in Translation Workbench vary slightly by org edition. The panel says
  which to pick; if it is missing in your dropdown, check the nearest match.

## Develop

Needs Node.js 20 or newer. No dependencies to install.

```bash
npm test
```

Tests run on every push and pull request (GitHub Actions). They cover:

- `test/locator.test.js`: matching and classification in `src/locator.js`, using fake org data and cases found in real orgs.
- `test/sfApi.test.js`: the per-lookup custom label translation query.
- `test/logStore.test.js`: the test log (redaction, size cap, export).

Auto-fill (`src/content.js`) runs against live Salesforce pages and is tested by hand. Record what you test in an issue.

### Files

| File | Job |
|---|---|
| `manifest.json` | Chrome extension setup (permissions, scripts) |
| `src/background.js` | Right-click menu, Salesforce API calls, opens translation pages, writes the log |
| `src/content.js` | Reads the clicked element, shows the panel, auto-fills Setup pages |
| `src/locator.js` | Decides where each text is translated (no browser code; unit tested) |
| `src/sfApi.js` | REST and Tooling API queries |
| `src/logStore.js`, `src/log.html`, `src/log.js` | Test log storage and viewer |
