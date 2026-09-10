"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { validateBackup, mergeRecords } = require("../walker.user.script.js");

/** A complete portable record retains the original editor and session context. */
function fixture() {
  const context = { editor: "1234", region: "row", environment: "production" };
  const at = "2026-09-10T10:00:00.000Z";
  return {
    format: "wme-edited-boundary",
    version: 1,
    exportedAt: at,
    settings: { size: 300, visible: true },
    sessions: [{ id: "session-a", context, startedAt: at, endedAt: null, status: "interrupted", gaps: ["An object location was unavailable."] }],
    records: [{
      id: "record-a",
      kind: "saved",
      at,
      sessionId: "session-a",
      context: { ...context },
      model: "segments",
      objectType: "segment",
      objectId: "101",
      operation: "edit",
      geometry: { type: "LineString", coordinates: [[100.5, 13.75], [100.51, 13.76]] },
      beforeGeometry: null,
      locationSource: "object geometry",
      status: "confirmed"
    }]
  };
}

test('import provenance survives backups and cannot refer to absent records', () => {
  const backup = fixture();
  backup.provenance = [{recordId:'record-a', importedAt:'2026-09-10T10:00:00.000Z'}];
  assert.deepEqual(validateBackup(backup).provenance, backup.provenance);
  backup.provenance[0].recordId = 'missing';
  assert.throws(() => validateBackup(backup), /provenance/);
});

test('duplicate provenance and invalid import dates are rejected', () => {
  const backup = fixture();
  backup.provenance = [{recordId:'record-a', importedAt:'invalid'}];
  assert.throws(() => validateBackup(backup), /provenance/);
  backup.provenance = [{recordId:'record-a', importedAt:backup.exportedAt}, {recordId:'record-a', importedAt:backup.exportedAt}];
  assert.throws(() => validateBackup(backup), /provenance/);
});

test("a JSON backup round trip retains evidence, context and settings", () => {
  const original = fixture();
  const restored = validateBackup(JSON.parse(JSON.stringify(original)));
  assert.deepEqual(restored, original);
  assert.notEqual(restored, original);
});

test("importing the same records twice is idempotent", () => {
  const first = fixture().records;
  const twice = mergeRecords(first, structuredClone(first));
  assert.deepEqual(twice, first);
  assert.equal(twice.length, 1);
});

test("record equality is independent of object property insertion order", () => {
  const first = fixture().records;
  const reordered = Object.fromEntries(Object.entries(first[0]).reverse());
  reordered.context = Object.fromEntries(Object.entries(reordered.context).reverse());
  assert.deepEqual(mergeRecords(first, [reordered]), first);
});

test("distinct immutable record IDs merge without losing prior history", () => {
  const first = fixture().records;
  const second = [{ ...structuredClone(first[0]), id: "record-b", objectId: "102" }];
  const merged = mergeRecords(first, second);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(record => record.id), ["record-a", "record-b"]);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
});

test("a late import conflict leaves both input collections unchanged", () => {
  const existing = fixture().records;
  const incoming = [
    { ...structuredClone(existing[0]), id: "record-b" },
    { ...structuredClone(existing[0]), objectId: "different object" }
  ];
  const existingBefore = structuredClone(existing);
  const incomingBefore = structuredClone(incoming);
  assert.throws(() => mergeRecords(existing, incoming), /conflict/i);
  assert.deepEqual(existing, existingBefore);
  assert.deepEqual(incoming, incomingBefore);
});

test("duplicate identical records inside a backup normalize to one", () => {
  const backup = fixture();
  backup.records.push(structuredClone(backup.records[0]));
  assert.equal(validateBackup(backup).records.length, 1);
  assert.equal(backup.records.length, 2);
});

test("conflicting record IDs inside one backup reject the whole file", () => {
  const backup = fixture();
  backup.records.push({ ...structuredClone(backup.records[0]), operation: "deletion" });
  assert.throws(() => validateBackup(backup), /conflict/i);
});

test("unsupported backup formats and versions are rejected", () => {
  for (const invalid of [null, [], {}, { ...fixture(), version: 3 }, { ...fixture(), version: "1" }, { ...fixture(), format: "other-app" }]) {
    assert.throws(() => validateBackup(invalid), /format|version/i);
  }
});

function groupedFixture(state='saved') {
  const backup=fixture();
  backup.version=2;
  const saved=backup.records[0];
  saved.groupId='group-a';
  const activity={...structuredClone(saved),id:'activity-a',kind:'activity',status:'observed'};
  backup.records=state==='saved'?[activity,saved]:[activity];
  backup.groups=[{id:'group-a',sessionId:saved.sessionId,context:{...saved.context},model:saved.model,objectType:saved.objectType,objectId:saved.objectId,aliases:[saved.objectId],state,createdAt:saved.at,updatedAt:saved.at,actionIds:[activity.id],savedRecordId:state==='saved'?saved.id:null,message:'',candidate:null}];
  return backup;
}

test('version 2 groups round trip with immutable action and outcome references',()=>{
  const backup=groupedFixture();
  assert.deepEqual(validateBackup(JSON.parse(JSON.stringify(backup))),backup);
  assert.equal(validateBackup({...fixture(),version:2,groups:[]}).groups.length,0);
});

test('version 2 portable unfinished groups retain unconfirmed status without candidates',()=>{
  for(const state of ['pending','undone','interrupted']){
    const backup=groupedFixture(state);
    assert.deepEqual(validateBackup(backup),backup);
    backup.groups[0].candidate={snapshot:{}};
    assert.throws(()=>validateBackup(backup),/work group/i);
  }
});

test('group links cannot be dangling, cross-session, cross-model or mismatched kinds',()=>{
  const invalidations=[
    b=>b.groups[0].actionIds.push('absent'),
    b=>b.groups[0].actionIds.push('record-a'),
    b=>b.groups[0].actionIds=[],
    b=>b.groups[0].savedRecordId='activity-a',
    b=>b.groups[0].savedRecordId=null,
    b=>b.groups[0].state='pending',
    b=>b.groups[0].sessionId='absent',
    b=>b.groups[0].context.editor='foreign-editor',
    b=>b.groups[0].model='venues',
    b=>b.groups[0].objectType='venue',
    b=>b.groups[0].aliases=['foreign-object'],
    b=>b.records[0].groupId='missing-group',
    b=>delete b.records[0].groupId,
    b=>b.records[1].groupId='missing-group',
    b=>b.groups.push(structuredClone(b.groups[0])),
    b=>b.groups[0].updatedAt='2020-01-01T00:00:00.000Z'
  ];
  for(const mutate of invalidations){const backup=groupedFixture();mutate(backup);assert.throws(()=>validateBackup(backup),/group/i);}
});

test('remapped identity aliases preserve activities with temporary object IDs',()=>{
  const backup=groupedFixture();
  backup.records[0].objectId='-1';
  backup.groups[0].aliases.unshift('-1');
  assert.deepEqual(validateBackup(backup),backup);
});

test('backup validation drops unrecognized metadata at every portable level',()=>{
  const backup=groupedFixture();
  backup.provenance=[{recordId:'record-a',importedAt:backup.exportedAt,unsafe:true}];
  backup.unsafe=true;
  backup.settings.unsafe=true;
  backup.sessions[0].unsafe=true;
  backup.records[0].unsafe=true;
  backup.records[0].geometry.unsafe=true;
  backup.groups[0].unsafe=true;
  for(const row of [...backup.sessions,...backup.records,...backup.groups])row.context.unsafe=true;
  const restored=validateBackup(backup);
  assert.equal(JSON.stringify(restored).includes('unsafe'),false);
});

test('version 1 never invents or accepts work-group associations',()=>{
  const backup=fixture();
  assert.equal(validateBackup(backup).groups,undefined);
  backup.records[0].groupId='unexpected';
  assert.throws(()=>validateBackup(backup),/group/i);
});

test("invalid tile settings are rejected before importing history", () => {
  for (const size of [0, 49, 5001, "300", NaN, Infinity]) {
    const backup = fixture();
    backup.settings.size = size;
    assert.throws(() => validateBackup(backup), /settings/i);
  }
  const backup = fixture();
  backup.settings.visible = "true";
  assert.throws(() => validateBackup(backup), /settings/i);
});

test("records cannot refer to an absent or foreign-context session", () => {
  const missing = fixture();
  missing.records[0].sessionId = "missing-session";
  assert.throws(() => validateBackup(missing));
  const foreign = fixture();
  foreign.records[0].context.environment = "beta";
  assert.throws(() => validateBackup(foreign), /context/i);
});

test("duplicate sessions are rejected", () => {
  const backup = fixture();
  backup.sessions.push(structuredClone(backup.sessions[0]));
  assert.throws(() => validateBackup(backup), /duplicate session/i);
});

test("pending activity remains unconfirmed after backup validation", () => {
  const backup = fixture();
  backup.records[0].kind = "activity";
  backup.records[0].status = "observed";
  const restored = validateBackup(backup);
  assert.equal(restored.records[0].kind, "activity");
  assert.equal(restored.records[0].status, "observed");
  assert.deepEqual(restored.records[0].context, backup.records[0].context);
});

test("a saved record cannot claim an unconfirmed or undo status", () => {
  const pending = fixture();
  pending.records[0].status = "observed";
  assert.throws(() => validateBackup(pending), /saved record status/i);
  const undo = fixture();
  undo.records[0].operation = "undo";
  assert.throws(() => validateBackup(undo), /saved record status/i);
});

test("unlocated records retain null geometry without a fabricated fallback", () => {
  const backup = fixture();
  backup.records[0].geometry = null;
  backup.records[0].beforeGeometry = null;
  backup.records[0].locationSource = "unresolved";
  const restored = validateBackup(backup);
  assert.equal(restored.records[0].geometry, null);
  assert.equal(restored.records[0].beforeGeometry, null);
});

test("invalid coordinates, open polygons and unsupported geometries are rejected", () => {
  const invalid = [
    { type: "Point", coordinates: [181, 10] },
    { type: "Point", coordinates: [100, 90] },
    { type: "Point", coordinates: [100, NaN] },
    { type: "LineString", coordinates: [[100, 10]] },
    { type: "Polygon", coordinates: [[[100, 10], [101, 10], [101, 11], [100, 11]]] },
    { type: "GeometryCollection", geometries: [] }
  ];
  for (const geometry of invalid) {
    const backup = fixture();
    backup.records[0].geometry = geometry;
    assert.throws(() => validateBackup(backup), /geometry/i);
  }
});

test("invalid dates and unknown operation types do not enter history", () => {
  const badDate = fixture();
  badDate.records[0].at = "not a date";
  assert.throws(() => validateBackup(badDate));
  const badOperation = fixture();
  badOperation.records[0].operation = "arbitrary-operation";
  assert.throws(() => validateBackup(badOperation));
});
