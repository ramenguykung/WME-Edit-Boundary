# WME acceptance checks

The automated tests exercise geometry, evidence reconciliation and backup data without a WME account. The following checks require the installed userscript in Waze Map Editor. A passing simulated event sequence does not establish the actual order or completeness of WME SDK events.

Use a test area and only make legitimate map edits. Keep WME production and beta results separate. Record the browser, Tampermonkey version, SDK version, date, object category and actual event sequence with each result.

## Boundary appearance

1. With a saved boundary visible, confirm Boundary color has separate Fill opacity and Border opacity sliders with percentage values. Existing settings retain their fill opacity and start with 100% border opacity.
2. Set fill to 0% and border to 100%: only the outline should remain. Set fill to 100% and border to 0%: only the filled area should remain. Adjust each slider independently and confirm the other value stays unchanged.
3. Change the color with both opacities above 0%. Confirm the fill and border use that color at their chosen opacities. Hide the boundary, adjust both sliders, and show it again; it should stay hidden until shown.
4. Reload and confirm both opacity values persist. Export a JSON backup, change both values, then import with display settings restoration enabled. Confirm the controls and map return to the exported appearance.

## Version 1.0.1 boundary validation regression

The supplied history reproduces a geometry validation failure at polygon index 3 with 300-metre tiles and all filters cleared. Automated replay against the WME bundle from the reported stack trace now accepts all six polygons, preserves all 204 cells, and retains the touching hole. The same replay accepts all nine polygons / 685 cells at 100 metres; all ten polygons / 1,444 cells at 50 metres remain unchanged. The regression fixture contains only 33 normalized cells from the failing polygon, without the complete history backup.

1. Update the existing Tampermonkey script to version 1.0.1. With no unfinished WME edits, reload the editor.
2. Set the tile size to 300 metres and clear every history filter. Confirm the six computed polygons render without the previous `features[3].geometry` error. For the supplied history, the panel should show 204 covered tiles and the same 256 saved records.
3. Confirm the formerly self-touching outline retains its unworked hole. Change color and opacity; the boundary should remain visible without a new validation error.
4. Check 100-metre and 50-metre tiles, then return to 300 metres. Confirm no boundary validation warnings appear.
5. Verify rejection isolation only in the synthetic browser fixture: a rejected polygon must not suppress accepted areas or subsequent batches; a successful redraw clears its warning. Display rejections must not increment GeoJSON `excludedFootprints`.

Live post-update status: pending. The original rejection was observed in WME, but browser security policy blocked access to the installed userscript manager during this run. Unit, syntax, type and browser smoke checks passed; this is separate from verifying the updated userscript in live WME.

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
| Draw a new road segment, undo it, then reload WME | The segment has one Undone outcome, no pending or Interrupted/unconfirmed outcome, and no saved boundary. Repeat while another unsaved edit remains. |
| Redo that new segment and save it | The original group remains Undone and the restored segment produces exactly one confirmed addition after its temporary ID is remapped. |
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
