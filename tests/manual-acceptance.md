# WME acceptance checks

The automated tests exercise geometry, evidence reconciliation and backup data without a WME account. The following checks require the installed userscript in Waze Map Editor. A passing simulated event sequence does not establish the actual order or completeness of WME SDK events.

Use a test area and only make legitimate map edits. Keep WME production and beta results separate. Record the browser, Tampermonkey version, SDK version, date, object category and actual event sequence with each result.

## Version 0.2.0 release gate

Automated results and live results must be recorded separately. The local simulated SDK renders SVG polygons and exercises IndexedDB, but cannot establish actual WME event ordering or map-layer acceptance.

1. Install version 0.2.0 and open a clean WME session. Confirm History contains its filters and the red underlined deletion control immediately below Session. All sessions and the current session must disable deletion.
2. Observe one legitimate user-performed segment correction. Confirm one Pending group, with its actions expandable; record the current saved-record and tile counts.
3. Save in WME. Capture `[Edited Boundary]` console messages for object ID remapping, object save notifications, global success, and clean-state reconciliation. Confirm one Saved group, no stranded pending object, and a visible polygon at the edited geometry.
4. Refresh after saving. Confirm that the same saved group and polygon return, without an additional saved record.
5. Make another legitimate edit to the same segment and save. Confirm a second group and that the original group remains unchanged.
6. Confirm an interrupted unsaved observation remains unconfirmed after refresh and does not become saved after an unrelated later save. Exercise failed saves/storage writes only in the synthetic fixture unless they occur naturally.

Live status: not yet verified for this version. Complete the steps above before marking the live release gate passed.

## Installation and automatic tracking

| Check | Expected result |
| --- | --- |
| Open WME with the script enabled | One sidebar tab and one set of controls appear after readiness. |
| Enable or inject the script after WME has already loaded | Initialization completes without waiting for an already dispatched ready event. |
| Reload while SDK loading is slow | Status explains loading; no duplicate listeners or controls appear. |
| Initialize with unsaved work, or with nonempty redo history | The script waits for a clean state and discloses that earlier work was not captured. |
| Return both edit counters to zero | Tracking begins automatically. |
| Pan, zoom, select, open an object or refresh loaded map data | No observed edit or saved footprint is created. |
| Hide the boundary, edit and save, then show it | Tracking continues while the boundary is hidden. |

## Save evidence and location

For each supported category, check addition, attribute change, movement where applicable, deletion, undo, redo, a failed save and a successful retry. Categories without usable persistence evidence must remain visibly limited.

| Check | Expected result |
| --- | --- |
| Edit a segment missing a street name or address | Segment geometry still places the saved boundary correctly. |
| Edit a road whose line crosses many tiles | All intersected tiles are included, including cells between the line's vertices. |
| Save an edit at location A after panning to distant location B | Only the edited geometry at A contributes coverage. |
| Change several objects, undo part of the work, and save | Reconcile undo before confirmation; uncertain observations are excluded from the successful-save fallback. |
| Add an object, change it, then save | The saved result is an addition while observed changes remain distinguishable. |
| Add and delete an object before saving | Observed activity may remain; no persisted addition or deletion footprint is invented. |
| Save an addition, then delete and save the same object | Confirmed addition and deletion remain separate outcomes. |
| Fail a save, then retry successfully | No early boundary or duplicate confirmed records appear. |
| Save a new object whose temporary ID changes | The saved outcome retains continuous object identity. |
| Delete a previously located object | Prior geometry is retained when object-specific deletion persistence is established. |
| Delete an object with no recoverable geometry | The script reports an unlocated observation instead of using the cursor or viewport. |
| Resolve an ID outside the loaded map | Only documented SDK lookup is used; unavailable or stale results remain unresolved. |
| Edit again while an older geometry lookup is in progress | The older result cannot replace newer evidence. |
| Act on a request or suggestion | Workflow-specific confirmation is required; submitted and applied changes stay distinct. |

## Boundary and history

| Check | Expected result |
| --- | --- |
| Save work in two distant areas | Separate outlines appear without connecting the areas. |
| Work around an untouched interior tile | The boundary retains the unworked hole. |
| Change tile size | Current filtered boundary rebuilds from retained geometry. |
| Filter dates, sessions, categories and operations | Grouped outcomes and saved boundary records agree with the shared filters. |
| Filter Status | History changes; the saved boundary remains unchanged. |
| Revisit a historical record | The SDK map view moves to its recorded location. |
| Delete a stored session | Only that session's records disappear; shared tiles remain when other records support them. |

## Persistence and portability

| Check | Expected result |
| --- | --- |
| Reload with pending edits | Confirmed history survives; unfinished observations remain unconfirmed and the session is marked interrupted. |
| Reload immediately after save confirmation | Recovery receipts commit exactly one saved outcome and its linked actions; the polygon returns. |
| Use two tabs for the same editor | Each tab has a distinct session; writes do not overwrite another tab's history. |
| Change editor, region or production/beta environment | Records remain partitioned and retain their original context. |
| Export JSON, remove local records, and import the backup | Geometry, history, IDs and provenance are restored. |
| Import the same backup twice | No duplicate history or boundary appears. |
| Import malformed JSON, unsupported versions or a conflicting record ID | Existing storage remains unchanged and a useful error is shown. |
| Import pending or foreign-editor records | Import does not promote observations to Waze-confirmed edits or attribute them to the current editor. |
| Import with settings restoration disabled | Current display settings remain unchanged. |
| Export GeoJSON with a date filter | The file contains WGS84 polygons for the filtered boundary with grid and coverage metadata. |
| Deny browser storage or simulate a failed storage transaction | A visible persistent error explains that history is not safely stored. |
| Populate a large historical dataset, then make one edit | The editor remains responsive; work is processed outside the immediate edit callback. |

Do not mark a workflow fully supported until its real event sequences pass these checks. Keep unresolved SDK limitations in the support matrix and release notes.
