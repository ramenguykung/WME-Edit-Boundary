# WME Edited Boundary

A Tampermonkey userscript that outlines where you have saved work in Waze Map Editor. It tracks editing automatically, keeps history in your browser, and can export a backup or a geographic boundary.

A shaded area means that confirmed saved work occurred somewhere inside its grid cells. It does not mean that every road or place in the area was reviewed.

## Install and use

1. Create a new script in Tampermonkey.
2. Replace the template with the complete contents of `walker.user.script.js`, including its userscript header, and save it.
3. Reload Waze Map Editor and sign in.
4. Open the **Edited Boundary** tab in WME's Scripts sidebar.

The script matches production and beta WME URLs, including language-prefixed editor URLs. It runs after the page is ready, uses `@grant none`, and requires no remote runtime dependencies or build step.

Recording starts automatically after the SDK is ready and the undo/save and redo histories are both empty. If the editor already has unfinished changes, the panel waits for a clean edit state and reports a coverage gap. It cannot reconstruct edits made before it started observing.

Edit and save normally in WME. Object-specific saved events confirm the identified work even when WME normalizes its data while saving. For tracked main-editor map objects with resolved numeric IDs, a successful save followed by a clean editor also reconciles known pending revisions. An intervening edit, undo, or incompatible mode change cancels deferred reconciliation. Independently persisted workflows still require their own object confirmation. The script does not save, undo, or change your WME edits.

The panel provides:

- Tracking status, counts, and coverage limitations.
- A show/hide checkbox that changes only boundary visibility.
- Tile size from 50 to 5,000 nominal metres, with 300 metres as the default.
- A boundary color picker and live fill-opacity slider, saved locally and included in backups.
- History with date, object type, operation, source, session, and history-only Status filters directly above the results.
- One expandable outcome per object per save, containing the original actions and a Pending, Saved, Undone, or Interrupted/unconfirmed label.
- JSON backup export and import, with optional settings restoration.
- GeoJSON export of the currently filtered saved boundary.
- A red underlined deletion control beneath the Session filter, disabled for All sessions and the active session.

## How the boundary is recorded

The primary observation is the documented `wme-after-edit` event. It identifies affected objects; the script then captures their available geometry and state through SDK methods. Geometry is cached so that an earlier location can survive a move or deletion.

Missing names and addresses do not block location recording. Geometry from the affected object is preferred. An explicit segment relationship, such as a road closure's segment ID, can provide a derived location. For an existing segment absent from the loaded model, `Segments.findSegment()` can attempt retrieval. It cannot recover historical or deleted geometry, and late lookup results are rejected when the captured revision has changed.

An edit without sufficient location evidence remains in history without a guessed footprint. The current viewport, cursor, and selection do not establish where an edit happened.

Observed activity and confirmed saved outcomes are separate records. Undo does not provide affected object IDs, so pending objects require reconciliation. Saving an object does not establish that each previous action on that object survived undo. Suggestions remain distinct from applied map edits.

Actions share a stable work-group ID until their outcome is saved, undone, or interrupted. A subsequent edit after saving starts a new group. History displays the current group outcome without rewriting the original activity log. Status filters history only; the other filters select both history and saved boundary records.

The grid uses Web Mercator. Its nominal cell width differs from ground distance by latitude; the panel gives an approximate local ground size. Full lines and polygons are intersected with the grid, and adjacent cells merge into outlines while disconnected areas and holes remain separate. Changing tile size rebuilds outlines from retained geometry.

Tile boundaries that touch at a corner are split into simple rings before drawing, including holes that touch their surrounding boundary. If WME rejects an individual polygon, accepted areas remain visible and the panel reports the omitted polygons. The browser console includes each rejected geometry and the tile size, filters, and render generation that produced it. The covered-tile count and GeoJSON export describe the computed boundary; display rejections do not change saved history or exported footprint exclusions.

## Coverage and limitations

The panel's capability matrix is the current support reference. These workflows require real WME validation before being described as fully supported:

| Workflow | Location evidence and confirmation considerations |
| --- | --- |
| Segments, nodes, places, map comments, and junction boxes | Geometry and tracked model events are available. Saved coverage requires an observed edit and object confirmation, or successful-save reconciliation of a known revision with a resolved numeric ID and a clean editor. |
| Road closures | The related segment can provide location. The closure's persistence evidence must refer to the closure. |
| House numbers | Dedicated edit events exist, but their payload supplies only a house number ID. The SDK retrieves house numbers by segment IDs; a missing edit-linked segment relationship limits recovery. |
| Turns, turn closures, junctions, hazards, and restricted driving areas | Some readable SDK objects are not independently trackable models. An affected segment may contribute its own confirmed footprint, but its save does not independently prove another object's outcome. |
| Requests, problems, and suggestions | Their workflows can persist independently. Viewing or loading an item does not prove an edit. Unsupported confirmations remain visible limitations. |

Confirmed history survives reloads. IndexedDB version 2 journals work groups while editing, and a per-tab receipt preserves received confirmation until the saved record is committed. Reload replays these receipts without duplicates. A refresh without confirmation leaves the work Interrupted/unconfirmed; it cannot be confirmed by an unrelated later save. Version 1 observations lack the evidence needed for automatic recovery and remain unconfirmed.

Tabs have separate sessions, and history is partitioned by editor, WME region, and production or beta environment. Browser storage is local to its origin and profile; it does not synchronize automatically between devices or between production and beta. Storage failures are visible, with a retry control. Clearing both browser storage and recovery receipts cannot be recovered automatically.

The implementation has these resource and geometry limits:

- A boundary calculation is limited to 250,000 cells. Narrow the filters or increase tile size when the panel reports this limit.
- Geometry calculations normally run in a background worker. If browser policy blocks workers, a bounded scheduled fallback keeps boundary drawing available but can be slower on large histories.
- Geometry crossing the date line cannot currently produce an outline. Coordinates beyond the Web Mercator latitude limit of approximately 85.05 degrees cannot be outlined.
- Storage failures are reported. Browser data clearing or eviction can remove local history; export backups for records you want to retain.
- Detailed real WME event ordering, deletion confirmation, and independently persisted workflows still require live acceptance testing. Automated test doubles do not prove those behaviours.

## Import and export

**JSON backup version 2** preserves sessions, activity, saved outcomes, group associations, geometry evidence, context, import provenance, and settings, including boundary color and fill opacity. Version 1 backups and backups created before the appearance controls remain accepted with default appearance settings. Live candidate snapshots and recovery receipts stay local and are excluded from portable backups. Import validates the complete file before writing, merges records by stable IDs, skips identical duplicates, and rejects conflicting IDs or unsupported versions. Settings restoration is off by default.

Import does not submit WME edits, resume pending work, or independently verify another file's claimed save results. Keep the original editor, region, environment, and timestamps when moving history between browser profiles.

Import limits are 50 MB per file, 200,000 records, and 20,000 sessions. Exported history beyond those limits must be reduced before importing. The import control accepts the script's versioned backup format, not arbitrary GeoJSON.

**GeoJSON export** contains WGS84 polygons for the filtered confirmed boundary and its coverage metadata. Use this format with GIS software or other map tools. It does not contain enough information to restore the complete editing history.

## Development and checks

The installable file is plain JavaScript with JSDoc. Primary functions use JSDoc, and variables use comments or type annotations where they improve clarity. TypeScript checks the JavaScript without producing output.

Install development dependencies with `npm install`, then run:

```text
npm test
npm run typecheck
npm run check:syntax
```

The tests exercise the shipped core. They cover geometry, saved-record reconciliation, backup validation, and duplicate handling. The live acceptance proposal is maintained separately when available. No live WME edits were performed to validate this release.

`npm run test:browser` runs an optional headless browser smoke test against a local simulated SDK. It requires Playwright and Microsoft Edge; use `PLAYWRIGHT_MODULE` to point to an existing Playwright installation and `BROWSER_CHANNEL` to select another installed Chromium channel. It checks normalized and reordered saves, grouped history, filters, deletion, IndexedDB migration, failed writes and retry, immediate refresh recovery, tab isolation, downloads, and login lifecycle. The fixture draws the generated GeoJSON as SVG, but does not connect to Waze or establish WME's rendering behavior. The SDK's actual event ordering and map rendering require the live acceptance checks in `tests/manual-acceptance.md`.

The published SDK declarations require the narrow development-only repair described in `types/README.md`. The repair runs after installation; application checking remains strict.

All WME access must continue to use the [official JavaScript SDK](https://www.waze.com/editor/sdk/index.html). Relevant references are [SDK events](https://www.waze.com/editor/sdk/interfaces/index.SDK.SdkEvents.html), [Editing](https://www.waze.com/editor/sdk/classes/index.SDK.Editing.html), [Segments](https://www.waze.com/editor/sdk/classes/index.SDK.Segments.html), [Map](https://www.waze.com/editor/sdk/classes/index.SDK.Map.html), and [Sidebar](https://www.waze.com/editor/sdk/classes/index.SDK.Sidebar.html). Browser APIs handle the script-owned controls, local storage, files, and geometry processing.
