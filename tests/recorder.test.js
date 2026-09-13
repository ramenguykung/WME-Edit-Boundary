"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Recorder } = require("../walker.user.script.js");

const originalGeometry = { type: "Point", coordinates: [100.50, 13.75] };
const editedGeometry = { type: "Point", coordinates: [100.51, 13.76] };
const finalGeometry = { type: "Point", coordinates: [100.52, 13.77] };

/** Supply deterministic identity and time without involving browser storage. */
function setup(armed = true) {
  const activity = [];
  const saved = [];
  const activityGroups = [];
  const savedGroups = [];
  const updates = [];
  let sequence = 0;
  const recorder = new Recorder({
    onActivity: (record, group) => { activity.push(record); activityGroups.push(group); },
    onSaved: (record, group) => { saved.push(record); savedGroups.push(group); },
    onGroup: group => updates.push(group),
    context: { editor: 'editor-1', region: 'row', environment: 'production' },
    sessionId: 'session-1',
    now: () => "2026-09-10T10:00:00.000Z",
    id: () => `record-${++sequence}`
  });
  recorder.setArmed(armed);
  return { recorder, activity, saved, activityGroups, savedGroups, updates };
}

function snapshot(overrides = {}) {
  return {
    model: "segments",
    objectType: "segment",
    objectId: 101,
    geometry: structuredClone(editedGeometry),
    isNew: false,
    isDeleted: false,
    fingerprint: "edited",
    baselineFingerprint: "original",
    baselineGeometry: structuredClone(originalGeometry),
    locationSource: "object geometry",
    ...overrides
  };
}

test('a missing operation classification does not block individually confirmed geometry', () => {
  const {recorder, saved, activity} = setup();
  recorder.observe(snapshot({fingerprint:'unavailable', classificationKnown:false, geometry:null}));
  assert.equal(activity[0].operation, 'unknown');
  assert.equal(recorder.saved('segments', 101, snapshot({fingerprint:'loaded after save'})), true);
  assert.equal(saved[0].operation, 'unknown');
  assert.deepEqual(saved[0].geometry, editedGeometry);
});

test("unarmed tracking does not observe or confirm edits", () => {
  const { recorder, activity, saved } = setup(false);
  assert.equal(recorder.observe(snapshot()), null);
  recorder.saved("segments", 101, snapshot());
  assert.equal(activity.length, 0);
  assert.equal(saved.length, 0);
  assert.equal(recorder.pending.size, 0);
});

test("an observed edit is not saved coverage until that object is confirmed", () => {
  const { recorder, activity, saved } = setup();
  recorder.observe(snapshot());
  assert.equal(activity.length, 1);
  assert.equal(activity[0].kind, "activity");
  assert.equal(saved.length, 0);
  recorder.saved("segments", 101, snapshot());
  assert.equal(saved.length, 1);
  assert.equal(saved[0].kind, "saved");
  assert.equal(saved[0].objectId, "101");
  assert.equal(saved[0].operation, "edit");
});

test("one saved ID does not confirm other pending IDs or models", () => {
  const { recorder, saved } = setup();
  recorder.observe(snapshot());
  recorder.observe(snapshot({ objectId: 102 }));
  recorder.observe(snapshot({ model: "venues", objectType: "venue" }));
  recorder.saved("segments", 101, snapshot());
  assert.equal(saved.length, 1);
  assert.equal(recorder.pending.size, 2);
  recorder.saved("segments", 999, snapshot({ objectId: 999 }));
  assert.equal(saved.length, 1);
});

test("a duplicate persistence event cannot produce duplicate saved records", () => {
  const { recorder, saved } = setup();
  recorder.observe(snapshot());
  recorder.saved("segments", 101, snapshot());
  recorder.saved("segments", 101, snapshot());
  assert.equal(saved.length, 1);
});

test("multiple edits retain activity while saved geometry uses the final outcome", () => {
  const { recorder, activity, saved } = setup();
  recorder.observe(snapshot());
  recorder.observe(snapshot({ fingerprint: "second edit", geometry: finalGeometry }));
  recorder.saved("segments", 101, snapshot({ fingerprint: "second edit", geometry: finalGeometry }));
  assert.equal(activity.length, 2);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].geometry, finalGeometry);
  assert.deepEqual(saved[0].beforeGeometry, originalGeometry);
});

test("add then edit then save remains a saved addition", () => {
  const { recorder, saved } = setup();
  recorder.observe(snapshot({ objectId: -1, isNew: true, baselineFingerprint: undefined, baselineGeometry: null }));
  recorder.observe(snapshot({ objectId: -1, isNew: true, fingerprint: "new edited", baselineFingerprint: undefined, baselineGeometry: null }));
  recorder.remap("segments", -1, 500);
  recorder.saved("segments", 500, snapshot({ objectId: 500, fingerprint: "new edited", baselineFingerprint: undefined, baselineGeometry: null }));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].objectId, "500");
  assert.equal(saved[0].operation, "addition");
  assert.equal(saved[0].beforeGeometry, null);
});

test("add then delete before a save creates no persisted footprint", () => {
  const { recorder, saved } = setup();
  const added = snapshot({ objectId: -1, isNew: true, baselineFingerprint: undefined, baselineGeometry: null });
  recorder.observe(added);
  recorder.observe({ ...added, isDeleted: true, geometry: null, fingerprint: "deleted" });
  recorder.saved("segments", -1, { ...added, isDeleted: true, geometry: null, fingerprint: "deleted" });
  assert.equal(saved.length, 0);
});

test("a confirmed deletion retains captured prior geometry", () => {
  const { recorder, saved } = setup();
  const deleted = snapshot({ isDeleted: true, geometry: null, fingerprint: "deleted" });
  recorder.observe(deleted);
  recorder.saved("segments", 101, deleted);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].operation, "deletion");
  assert.deepEqual(saved[0].beforeGeometry, originalGeometry);
});

test("moving an existing object then deleting it does not shade its unsaved destination", () => {
  const { recorder, saved } = setup();
  recorder.observe(snapshot({ geometry: finalGeometry, fingerprint: "moved" }));
  const deleted = snapshot({ isDeleted: true, geometry: finalGeometry, fingerprint: "deleted" });
  recorder.observe(deleted);
  recorder.saved("segments", 101, deleted);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].operation, "deletion");
  assert.deepEqual(saved[0].geometry, originalGeometry);
  assert.deepEqual(saved[0].beforeGeometry, originalGeometry);
});

test("unknown location remains null after persistence confirmation", () => {
  const { recorder, saved } = setup();
  const unknown = snapshot({ geometry: null, baselineGeometry: null, locationSource: "unresolved" });
  recorder.observe(unknown);
  recorder.saved("segments", 101, unknown);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].geometry, null);
  assert.equal(saved[0].beforeGeometry, null);
});

test("undo makes affected candidates uncertain until their current state is reconciled", () => {
  const { recorder, saved } = setup();
  recorder.observe(snapshot());
  recorder.undo();
  recorder.saved("segments", 101);
  assert.equal(saved.length, 0);
});

test("reconciliation after undo excludes an object restored to its baseline", () => {
  const { recorder, saved } = setup();
  recorder.observe(snapshot());
  recorder.undo();
  const restored = snapshot({ fingerprint: "original", geometry: originalGeometry });
  recorder.reconcile(restored);
  recorder.saved("segments", 101, restored);
  assert.equal(saved.length, 0);
});

test("reconciliation after a partial undo can confirm an object that still differs", () => {
  const { recorder, saved } = setup();
  recorder.observe(snapshot());
  recorder.observe(snapshot({ objectId: 102 }));
  recorder.undo();
  const restored = snapshot({ fingerprint: "original", geometry: originalGeometry });
  recorder.reconcile(restored);
  recorder.reconcile(snapshot({ objectId: 102 }));
  recorder.saved("segments", 101, restored);
  recorder.saved("segments", 102, snapshot({ objectId: 102 }));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].objectId, "102");
});

test("undo settles a missing negative-ID creation without allowing late callbacks to revive it", () => {
  const { recorder, saved, updates } = setup();
  const created = snapshot({ objectId: -1, isNew: true, baselineFingerprint: undefined, baselineGeometry: null });
  const token = recorder.observe(created);
  recorder.undo();
  const undoRevision = recorder.pending.get("segments:-1").revision;
  assert.equal(recorder.reconcileMissingCreation("segments", -1, undoRevision - 1), false, "stale undo evidence is rejected");
  assert.equal(recorder.reconcileMissingCreation("segments", -1, undoRevision), true);
  assert.equal(recorder.pending.size, 0);
  assert.equal(updates.at(-1).state, "undone");
  assert.equal(updates.at(-1).candidate, null);
  assert.equal(recorder.resolve(token, finalGeometry, "late lookup"), false);
  assert.equal(recorder.saved("segments", -1, created), false);
  assert.equal(saved.length, 0);
});

test("missing existing or remapped objects are not classified as undone creations", () => {
  const existing = setup();
  existing.recorder.observe(snapshot());
  existing.recorder.undo();
  assert.equal(existing.recorder.reconcileMissingCreation("segments", 101, existing.recorder.pending.get("segments:101").revision), false);
  assert.equal(existing.recorder.pending.get("segments:101").uncertain, true);

  const remapped = setup();
  remapped.recorder.observe(snapshot({ objectId: -1, isNew: true, baselineFingerprint: undefined, baselineGeometry: null }));
  remapped.recorder.remap("segments", -1, 501);
  remapped.recorder.undo();
  assert.equal(remapped.recorder.reconcileMissingCreation("segments", 501, remapped.recorder.pending.get("segments:501").revision), false);
  assert.equal(remapped.recorder.pending.get("segments:501").uncertain, true);
});

test("redo after a missing creation undo starts a new group that can be saved", () => {
  const { recorder, activityGroups, saved, updates } = setup();
  const created = snapshot({ objectId: -1, isNew: true, baselineFingerprint: undefined, baselineGeometry: null });
  recorder.observe(created);
  recorder.undo();
  const undoRevision = recorder.pending.get("segments:-1").revision;
  assert.equal(recorder.reconcileMissingCreation("segments", -1, undoRevision), true);
  recorder.observe(created);
  recorder.remap("segments", -1, 501);
  assert.equal(recorder.saved("segments", 501, snapshot({ objectId: 501, isNew: false })), true);
  assert.equal(activityGroups.length, 2);
  assert.notEqual(activityGroups[0].id, activityGroups[1].id);
  assert.equal(updates.find(group => group.id === activityGroups[0].id && group.state === "undone")?.candidate, null);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].operation, "addition");
});

test("a delayed location lookup cannot overwrite a more recent observation", () => {
  const { recorder, saved } = setup();
  const obsolete = recorder.observe(snapshot({ geometry: null, locationSource: "unresolved" }));
  recorder.observe(snapshot({ geometry: finalGeometry, fingerprint: "newer" }));
  assert.equal(recorder.resolve(obsolete, originalGeometry, "segment lookup"), false);
  recorder.saved("segments", 101, snapshot({ geometry: finalGeometry, fingerprint: "newer" }));
  assert.deepEqual(saved[0].geometry, finalGeometry);
});

test("a current location lookup can resolve an otherwise unlocated candidate", () => {
  const { recorder, saved } = setup();
  const current = recorder.observe(snapshot({ geometry: null, baselineGeometry: null, locationSource: "unresolved" }));
  assert.equal(recorder.resolve(current, editedGeometry, "segment lookup"), true);
  recorder.saved("segments", 101);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].geometry, editedGeometry);
  assert.equal(saved[0].locationSource, "segment lookup");
});

test("clean state invalidates pending saves and asynchronous location results", () => {
  const { recorder, saved } = setup();
  const token = recorder.observe(snapshot({ geometry: null }));
  recorder.clean();
  assert.equal(recorder.pending.size, 0);
  assert.equal(recorder.resolve(token, editedGeometry, "segment lookup"), false);
  recorder.saved("segments", 101, snapshot());
  assert.equal(saved.length, 0);
});

test("disarming after logout cancels pending work and stale lookup results", () => {
  const { recorder, saved } = setup();
  const token = recorder.observe(snapshot());
  recorder.setArmed(false);
  assert.equal(recorder.pending.size, 0);
  assert.equal(recorder.resolve(token, finalGeometry, "segment lookup"), false);
  recorder.saved("segments", 101, snapshot());
  assert.equal(saved.length, 0);
});

test("an old token cannot resolve a new candidate for the same object after clean", () => {
  const { recorder } = setup();
  const obsolete = recorder.observe(snapshot({ geometry: null }));
  recorder.clean();
  const current = recorder.observe(snapshot({ geometry: null, fingerprint: "later session" }));
  assert.equal(recorder.resolve(obsolete, originalGeometry, "old lookup"), false);
  assert.equal(recorder.resolve(current, finalGeometry, "new lookup"), true);
});

test('server-normalized fingerprints and baseline equality do not veto specific save evidence', () => {
  for (const fingerprint of ['server normalized', 'original']) {
    const { recorder, saved, savedGroups } = setup();
    recorder.observe(snapshot());
    assert.equal(recorder.saved('segments', 101, snapshot({ fingerprint, geometry: finalGeometry })), true);
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].geometry, finalGeometry);
    assert.equal(savedGroups[0].state, 'saved');
    assert.equal(saved[0].id, `saved:${savedGroups[0].id}`);
  }
});

test('each object save groups immutable action snapshots and subsequent work gets a new group', () => {
  const { recorder, activity, saved, activityGroups, savedGroups } = setup();
  recorder.observe(snapshot());
  recorder.observe(snapshot({ fingerprint: 'edited again' }));
  recorder.saved('segments', 101, snapshot({ fingerprint: 'normalized' }));
  recorder.observe(snapshot({ fingerprint: 'next save', baselineFingerprint: 'normalized' }));
  recorder.saved('segments', 101, snapshot({ fingerprint: 'next normalized' }));
  assert.deepEqual(activityGroups[0].actionIds, [activity[0].id]);
  assert.equal(activityGroups[0].state, 'pending');
  assert.equal(activity[0].groupId, activity[1].groupId);
  assert.deepEqual(savedGroups[0].actionIds, activity.slice(0, 2).map(record => record.id));
  assert.notEqual(savedGroups[0].id, savedGroups[1].id);
  assert.equal(savedGroups[1].id, activity[2].groupId);
  assert.notEqual(saved[0].id, saved[1].id);
  assert.deepEqual(saved[0].context, savedGroups[0].context);
  assert.equal(saved[0].sessionId, 'session-1');
  activityGroups[0].candidate.snapshot.fingerprint = 'externally mutated';
  assert.equal(recorder.groups.get(savedGroups[0].id).state, 'saved');
});

test('a captured object-save revision cannot confirm a newer unsaved revision', () => {
  const { recorder, saved } = setup();
  const beforeSave = recorder.observe(snapshot());
  recorder.observe(snapshot({ fingerprint: 'new work after save' }));
  assert.equal(recorder.saved('segments', 101, snapshot({ fingerprint: 'first normalized' }), beforeSave.revision), false);
  assert.equal(saved.length, 0);
  assert.equal(recorder.pending.size, 1);
});

const mainSaveModels = new Set(['segments', 'venues']);

test('a clean editor alone is not confirmation; a received global success can confirm known work', () => {
  const { recorder, saved } = setup();
  recorder.observe(snapshot());
  assert.equal(recorder.reconcileSuccessfulSave(true, () => snapshot(), mainSaveModels), 0);
  assert.equal(saved.length, 0);
  recorder.saveSucceeded();
  assert.equal(recorder.reconcileSuccessfulSave(true, () => snapshot({ fingerprint: 'server value' }), mainSaveModels), 1);
  assert.equal(saved.length, 1);
  assert.equal(recorder.reconcileSuccessfulSave(true, () => snapshot(), mainSaveModels), 0);
});

test('global success waits for the delayed clean-state event', () => {
  const { recorder, saved } = setup();
  recorder.observe(snapshot());
  recorder.saveSucceeded();
  assert.equal(recorder.reconcileSuccessfulSave(false, () => snapshot(), mainSaveModels), 0);
  assert.equal(recorder.pending.size, 1);
  assert.equal(recorder.reconcileSuccessfulSave(true, () => snapshot({ fingerprint: 'normalized' }), mainSaveModels), 1);
  assert.equal(saved.length, 1);
});

test('either order of object evidence and global success produces one saved outcome', () => {
  for (const globalFirst of [true, false]) {
    const { recorder, saved } = setup();
    recorder.observe(snapshot());
    if (globalFirst) recorder.saveSucceeded();
    recorder.saved('segments', 101, snapshot({ fingerprint: 'normalized' }));
    if (!globalFirst) recorder.saveSucceeded();
    recorder.reconcileSuccessfulSave(true, () => snapshot(), mainSaveModels);
    recorder.saved('segments', 101, snapshot({ fingerprint: 'normalized' }));
    assert.equal(saved.length, 1);
  }
});

test('global confirmation excludes independently persisted models, uncertainty, unknown classification, and unresolved IDs', () => {
  const { recorder, saved } = setup();
  const values = [
    snapshot({ objectId: 102, model: 'roadClosures', objectType: 'roadClosure' }),
    snapshot({ objectId: 103, classificationKnown: false }),
    snapshot({ objectId: -1, isNew: true }),
    snapshot({ objectId: 104 }),
    snapshot({ objectId: 105 })
  ];
  for (const value of values) recorder.observe(value);
  recorder.pending.get('segments:104').uncertain = true;
  recorder.saveSucceeded();
  const reader = (model, id) => values.find(value => value.model === model && value.objectId === id) || null;
  assert.equal(recorder.reconcileSuccessfulSave(true, reader, mainSaveModels), 1);
  assert.equal(saved[0].objectId, '105');
  assert.equal(recorder.pending.size, 4);
});

test('any intervening edit, undo, mode transition, or disarm cancels delayed global success', () => {
  for (const invalidate of [
    recorder => recorder.observe(snapshot({ objectId: 202 })),
    recorder => recorder.undo(),
    recorder => recorder.invalidateSuccessfulSave(),
    recorder => recorder.setArmed(false)
  ]) {
    const { recorder, saved } = setup();
    recorder.observe(snapshot());
    recorder.saveSucceeded();
    invalidate(recorder);
    assert.equal(recorder.reconcileSuccessfulSave(true, () => snapshot(), mainSaveModels), 0);
    assert.equal(saved.length, 0);
  }
});

test('a changed editor while obtaining fresh snapshots invalidates the entire global batch', () => {
  const { recorder, saved } = setup();
  recorder.observe(snapshot());
  recorder.saveSucceeded();
  const reader = () => { recorder.observe(snapshot({ objectId: 202 })); return snapshot(); };
  assert.equal(recorder.reconcileSuccessfulSave(true, reader, mainSaveModels), 0);
  assert.equal(saved.length, 0);
});

test('an explicit ID remap preserves deferred global success and alias history', () => {
  const { recorder, saved, savedGroups } = setup();
  recorder.observe(snapshot({ objectId: -1, isNew: true, baselineFingerprint: undefined, baselineGeometry: null }));
  recorder.saveSucceeded();
  recorder.remap('segments', -1, 501);
  assert.equal(recorder.reconcileSuccessfulSave(true, () => snapshot({ objectId: 501 }), mainSaveModels), 1);
  assert.equal(saved[0].operation, 'addition');
  assert.equal(saved[0].beforeGeometry, null);
  assert.deepEqual(savedGroups[0].aliases, ['-1', '501']);
});

test('save evidence arriving before the explicit temporary ID remap is applied once', () => {
  const { recorder, saved, savedGroups } = setup();
  recorder.observe(snapshot({ objectId: -1, isNew: true, baselineFingerprint: undefined, baselineGeometry: null }));
  assert.equal(recorder.saved('segments', 501, snapshot({ objectId: 501, fingerprint: 'normalized' })), false);
  assert.equal(saved.length, 0);
  recorder.remap('segments', -1, 501);
  recorder.saved('segments', 501, snapshot({ objectId: 501, fingerprint: 'normalized' }));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].objectId, '501');
  assert.deepEqual(savedGroups[0].aliases, ['-1', '501']);
});

test('saved events using an explicitly mapped old alias resolve to the current object ID', () => {
  const { recorder, saved } = setup();
  recorder.observe(snapshot({ objectId: -1, isNew: true }));
  recorder.remap('segments', -1, 501);
  assert.equal(recorder.saved('segments', -1), true);
  assert.equal(saved[0].objectId, '501');
});

test('unmatched evidence cannot confirm an edited revision or a later independent group', () => {
  for (const replaceGroup of [false, true]) {
    const { recorder, saved } = setup();
    recorder.observe(snapshot({ objectId: -1, isNew: true }));
    recorder.saved('segments', 501, snapshot({ objectId: 501 }));
    if (replaceGroup) recorder.clean();
    recorder.observe(snapshot({ objectId: -1, isNew: true, fingerprint: 'later work' }));
    recorder.remap('segments', -1, 501);
    assert.equal(saved.length, 0);
    assert.equal(recorder.pending.size, 1);
  }
});

test('an ambiguous ID remap retains both groups and cannot confirm uncertain work', () => {
  const { recorder, saved, updates } = setup();
  recorder.observe(snapshot({ objectId: -1, isNew: true }));
  recorder.observe(snapshot({ objectId: 501 }));
  recorder.remap('segments', -1, 501);
  assert.equal(recorder.pending.size, 2);
  assert.match(updates.at(-1).message, /unresolved/);
  assert.equal(recorder.saved('segments', -1), false);
  assert.equal(saved.length, 0);
});

test('failed saves retain pending work with an error and can be retried', () => {
  const { recorder, saved, updates, savedGroups } = setup();
  recorder.observe(snapshot());
  recorder.saveSucceeded();
  recorder.saveFailed();
  assert.equal(recorder.pending.size, 1);
  assert.equal(updates.at(-1).state, 'pending');
  assert.match(updates.at(-1).message, /Save failed/);
  assert.equal(recorder.reconcileSuccessfulSave(true, () => snapshot(), mainSaveModels), 0);
  recorder.saveSucceeded();
  assert.equal(recorder.reconcileSuccessfulSave(true, () => snapshot(), mainSaveModels), 1);
  assert.equal(saved.length, 1);
  assert.equal(savedGroups[0].message, '');
});

test('undo transitions to undone only with known baseline evidence and preserves partial work', () => {
  const { recorder, updates } = setup();
  recorder.observe(snapshot());
  recorder.observe(snapshot({ objectId: 102 }));
  recorder.undo();
  recorder.reconcile(snapshot({ fingerprint: 'original' }));
  recorder.reconcile(snapshot({ objectId: 102, fingerprint: 'partial edit' }));
  assert.equal(recorder.pending.size, 1);
  assert.equal(updates.find(group => group.objectId === '101' && group.state === 'undone').candidate, null);
  assert.equal(updates.at(-1).state, 'pending');
  assert.equal(updates.at(-1).candidate.uncertain, false);
});

test('unknown undo snapshots remain uncertain instead of becoming eligible for global confirmation', () => {
  const { recorder, saved } = setup();
  recorder.observe(snapshot());
  recorder.undo();
  recorder.reconcile(snapshot({ classificationKnown: false, fingerprint: 'unknown' }));
  recorder.saveSucceeded();
  assert.equal(recorder.reconcileSuccessfulSave(true, () => snapshot(), mainSaveModels), 0);
  assert.equal(recorder.saved('segments', 101, snapshot()), false);
  assert.equal(saved.length, 0);
});

test('add then delete has an undone outcome and no saved boundary record', () => {
  const { recorder, saved, updates } = setup();
  recorder.observe(snapshot({ objectId: -1, isNew: true, baselineFingerprint: undefined, baselineGeometry: null }));
  recorder.observe(snapshot({ objectId: -1, isNew: true, isDeleted: true, geometry: null }));
  recorder.saved('segments', -1);
  assert.equal(saved.length, 0);
  assert.equal(updates.at(-1).state, 'undone');
  assert.equal(updates.at(-1).savedRecordId, null);
});

test('global success can confirm a known deletion absent from the post-save model', () => {
  const { recorder, saved } = setup();
  recorder.observe(snapshot({ isDeleted: true, geometry: null }));
  recorder.saveSucceeded();
  assert.equal(recorder.reconcileSuccessfulSave(true, () => null, mainSaveModels), 1);
  assert.equal(saved[0].operation, 'deletion');
  assert.deepEqual(saved[0].geometry, originalGeometry);
});

test('a clean successful save remains attributable when ID remapping arrives later', () => {
  const {recorder,saved}=setup();
  recorder.observe(snapshot({objectId:-1,isNew:true,baselineFingerprint:undefined,baselineGeometry:null}));
  recorder.saveSucceeded();
  assert.equal(recorder.reconcileSuccessfulSave(true,()=>null,mainSaveModels),0);
  recorder.remap('segments',-1,501);
  assert.equal(recorder.reconcileSuccessfulSave(true,()=>snapshot({objectId:501,isNew:false}),mainSaveModels),1);
  assert.equal(saved[0].operation,'addition');
});

test('ending tracking journals interrupted candidates and prevents their later confirmation', () => {
  const { recorder, activityGroups, updates, saved } = setup();
  recorder.observe(snapshot());
  const originalGroupId = activityGroups[0].id;
  recorder.setArmed(false);
  assert.equal(updates.at(-1).state, 'interrupted');
  assert.equal(updates.at(-1).id, originalGroupId);
  assert.equal(updates.at(-1).candidate.snapshot.objectId, 101);
  assert.equal(recorder.pending.size, 0);
  recorder.setArmed(true);
  recorder.saveSucceeded();
  recorder.reconcileSuccessfulSave(true, () => snapshot(), mainSaveModels);
  assert.equal(saved.length, 0);
});
