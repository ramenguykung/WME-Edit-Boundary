'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {submitBoundaryFeatures}=require('../walker.user.script.js');

const polygon=()=>({type:'Polygon',coordinates:[[[100,13],[101,13],[101,14],[100,13]]]});
const validationError=()=>Object.assign(new Error('Invalid feature geometry'),{name:'ValidationError'});

function fixture(rejected=new Set()) {
  const displayed=new Map(),calls=[],removed=[];
  return {displayed,calls,removed,map:{
    addFeaturesToLayer({features}) {
      calls.push(features.map(f=>f.id));
      // Model even partial insertion so cleanup must protect stable feature IDs.
      for (const feature of features) {
        assert.ok(!displayed.has(feature.id),'no duplicate insertion');
        displayed.set(feature.id,feature);
        if (rejected.has(feature.id)) throw validationError();
      }
    },
    removeFeaturesFromLayer({featureIds}) {
      removed.push(featureIds);
      for(const id of featureIds) displayed.delete(id);
    }
  }};
}

test('valid polygons use bounded batches and no cleanup',()=>{
  const f=fixture();
  submitBoundaryFeatures(f.map,'boundary',Array.from({length:405},polygon),()=>assert.fail('unexpected rejection'));
  assert.deepEqual(f.calls.map(c=>c.length),[200,200,5]);
  assert.equal(f.displayed.size,405);assert.deepEqual(f.removed,[]);
});

test('rejection at index 9 preserves accepted polygons and later batches',()=>{
  const f=fixture(new Set(['boundary-9','boundary-203'])),failures=[];
  const polygons=Array.from({length:405},polygon);
  submitBoundaryFeatures(f.map,'boundary',polygons,error=>failures.push(error));
  assert.equal(f.displayed.size,403);assert.ok(f.displayed.has('boundary-404'));
  assert.deepEqual(failures.map(f=>[f.index,f.featureId]),[[9,'boundary-9'],[203,'boundary-203']]);
  assert.deepEqual(failures[0].geometry,polygons[9]);
  failures[0].geometry.coordinates[0][0][0]=0;
  assert.equal(polygons[9].coordinates[0][0][0],100,'diagnostics snapshot does not mutate evidence');
  assert.ok(!f.displayed.has('boundary-9'));assert.ok(!f.displayed.has('boundary-203'));
});

test('non-validation SDK errors abort visibly without retries',()=>{
  const fatal=new Error('Layer unavailable');let removals=0;
  assert.throws(()=>submitBoundaryFeatures({addFeaturesToLayer(){throw fatal;},removeFeaturesFromLayer(){removals++;}},'boundary',[polygon()],()=>assert.fail()),error=>error===fatal);
  assert.equal(removals,0);
});

test('cleanup failures stop individual retries and propagate',()=>{
  const fatal=new Error('Cleanup failed');let calls=0;
  assert.throws(()=>submitBoundaryFeatures({addFeaturesToLayer(){calls++;throw validationError();},removeFeaturesFromLayer(){throw fatal;}},'boundary',[polygon()],()=>assert.fail()),error=>error===fatal);
  assert.equal(calls,1);
});

test('a later successful submission has no stale rejection state',()=>{
  const rejected=new Set(['boundary-0']),f=fixture(rejected),first=[],second=[];
  submitBoundaryFeatures(f.map,'boundary',[polygon()],error=>first.push(error));
  rejected.clear();f.displayed.clear();
  submitBoundaryFeatures(f.map,'boundary',[polygon()],error=>second.push(error));
  assert.equal(first.length,1);assert.equal(second.length,0);assert.equal(f.displayed.size,1);
});
