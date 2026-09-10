'use strict';

// Optional real-browser smoke test using a simulated SDK, not the live map.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = fs.readFileSync(path.join(__dirname, '../walker.user.script.js'), 'utf8');

const fixture = `<!doctype html><html><head><title>Edited Boundary SDK simulation</title></head>
<body style="font-family:system-ui;background:#eef2f5;margin:0"><main style="display:flex;gap:24px;padding:24px"><aside style="width:370px;background:white"><div id="label"></div><div id="pane"></div></aside><section><h1>WME SDK simulation</h1><p>This page uses synthetic data. No Waze edits are made.</p><div id="map" style="width:700px;height:600px;background:#dce8df"></div></section></main><script>
const listeners = new Map();
if(location.search.includes('no-worker'))window.Worker=class{constructor(){throw new Error('Worker blocked for fallback test')}};
const models = new Map();
const original = {id:1,geometry:{type:'LineString',coordinates:[[100.5001,13.7001],[100.5101,13.7001]]},name:'Before'};
models.set('segments', new Map([[1,original]]));
let unsaved = location.search.includes('dirty')?1:0, redo = 0, savingMode = 'IDLE', edits=0, rejectSavedWrites=false;
const newIds = new Set(), deletedIds = new Set();
const features = new Map();
let layerStyle = {fillColor:'#12aabb',fillOpacity:.13,strokeColor:'#12aabb',strokeWidth:2};
const originalPut=IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put=function(value,...args){const request=originalPut.call(this,value,...args);if(rejectSavedWrites&&this.name==='groups'&&value.state==='saved')this.transaction.abort();return request;};
function drawMap(){
 const root=document.querySelector('#map');root.replaceChildren();
 const caption=document.createElement('p');caption.textContent=features.size+' boundary polygons (simulated map)';root.append(caption);
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 700 520');svg.style.width='100%';root.append(svg);
 for(const feature of features.values()){
  const shape=document.createElementNS(svg.namespaceURI,'path');
  shape.setAttribute('d',feature.geometry.coordinates.map(ring=>ring.map(([lon,lat],i)=>(i?'L':'M')+((lon-100.49)*16000)+','+(400-(lat-13.69)*20000)).join(' ')+' Z').join(' '));
  shape.setAttribute('fill',layerStyle.fillColor);shape.setAttribute('fill-opacity',String(layerStyle.fillOpacity));shape.setAttribute('fill-rule','evenodd');shape.setAttribute('stroke',layerStyle.strokeColor);shape.setAttribute('stroke-width',String(layerStyle.strokeWidth));svg.append(shape);
 }
}
const sdk = {
 State:{isReady:()=>true,getUserInfo:()=>({userName:location.search.includes('foreign')?'other-editor':'test-editor'})},
 Settings:{getRegionCode:()=> 'row'},isBetaEnvironment:()=>false,
 Editing:{getUnsavedChangesCount:()=>unsaved,getRedoChangesCount:()=>redo,isPracticeModeOn:()=>false,isSnapshotModeOn:()=>false,getCurrentSaveMode:()=>savingMode},
 Sidebar:{registerScriptTab:async()=>({tabLabel:document.querySelector('#label'),tabPane:document.querySelector('#pane')}),removeScriptTab:()=>document.querySelector('#pane').replaceChildren()},
 Events:{on:({eventName,eventHandler})=>{const set=listeners.get(eventName)||new Set();set.add(eventHandler);listeners.set(eventName,set);return()=>set.delete(eventHandler)},once:({eventName})=>new Promise(resolve=>{const off=sdk.Events.on({eventName,eventHandler:data=>{off();resolve(data)}})}),trackDataModelEvents:()=>{},stopDataModelEventsTracking:()=>{}},
 Map:{getMapCenter:()=>({lat:13.7,lon:100.5}),addLayer:({styleRules})=>{layerStyle={...layerStyle,...styleRules?.[0]?.style};drawMap()},removeLayer:()=>{features.clear();drawMap()},setLayerVisibility:({visibility})=>{document.querySelector('#map').style.opacity=visibility?'1':'.25'},removeAllFeaturesFromLayer:()=>{features.clear();drawMap()},addFeaturesToLayer:({features:rows})=>{rows.forEach(row=>features.set(row.id,row));drawMap()},centerMapOnGeometry:()=>{}}
};
sdk.DataModel={isNew:({dataModelName,objectId})=>newIds.has(dataModelName+':'+objectId),isDeleted:({dataModelName,objectId})=>deletedIds.has(dataModelName+':'+objectId)};
for (const [moduleName,modelName] of Object.entries({Segments:'segments',Nodes:'nodes',Venues:'venues',MapComments:'mapComments',BigJunctions:'bigJunctions',RoadClosures:'roadClosures',MapUpdateRequests:'mapUpdateRequests',MapProblems:'mapProblems',Cities:'cities',Streets:'streets',Countries:'countries',States:'states',MajorTrafficEvents:'majorTrafficEvents',SegmentSuggestions:'segmentSuggestions',TurnClosures:'turnClosures',PermanentHazards:'permanentHazards',RestrictedDrivingAreas:'restrictedDrivingAreas'})) {
 if(!models.has(modelName))models.set(modelName,new Map());
 sdk.DataModel[moduleName]={getAll:()=>Array.from(models.get(modelName).values()),getById:args=>models.get(modelName).get(Object.values(args)[0])||null};
}
sdk.DataModel.Segments.findSegment=async()=>({id:99,geometry:{type:'LineString',coordinates:[[100.52,13.7],[100.525,13.7]]}});
const emit=(name,payload)=>{for(const handler of listeners.get(name)||[])handler(payload)};
window.__test={
 edit(id=1){unsaved++;savingMode='EDITING';const obj=models.get('segments').get(id);if(obj)obj.name='Edited '+(++edits);emit('wme-after-edit',{affectedObjects:[{objectType:'segment',objectId:id}]})},
 save(id=1,options={}){const obj=models.get('segments').get(id);if(obj)obj.length=1000+edits;newIds.delete('segments:'+id);if(!options.delayedClean){unsaved=0;redo=0;savingMode='IDLE';}if(options.objectEvent!==false)emit('wme-data-model-objects-saved',{dataModelName:'segments',objectIds:[id]});emit('wme-save-finished',{success:true});if(!options.delayedClean)emit('wme-no-edits')},
 clean(){unsaved=0;redo=0;savingMode='IDLE';emit('wme-no-edits')},
 add(id=-1){models.get('segments').set(id,{...structuredClone(original),id,name:'New'});newIds.add('segments:'+id);this.edit(id)},
 remap(oldID,newID,savedFirst=false){const obj=models.get('segments').get(oldID);models.get('segments').delete(oldID);obj.id=newID;models.get('segments').set(newID,obj);newIds.delete('segments:'+oldID);if(savedFirst)emit('wme-data-model-objects-saved',{dataModelName:'segments',objectIds:[newID]});emit('wme-data-model-object-changed-id',{dataModelName:'segments',objectIds:{oldID,newID}})},
 failWrites(value){rejectSavedWrites=value},
 fail(){emit('wme-save-finished',{success:false})},
 features:()=>Array.from(features.values()),
 emit,
 records:(name='records')=>new Promise((resolve,reject)=>{const r=indexedDB.open('wme-edited-boundary');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const q=r.result.transaction(name).objectStore(name).getAll();q.onsuccess=()=>{resolve(q.result);r.result.close()};q.onerror=()=>reject(q.error)}})
};
window.SDK_INITIALIZED=Promise.resolve();window.getWmeSdk=()=>sdk;
</script><script src="/userscript.js"></script></body></html>`;

(async()=>{
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/userscript.js'?'text/javascript; charset=utf-8':'text/html; charset=utf-8');res.end(req.url==='/userscript.js'?source:fixture);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'msedge'});
    const base='http://127.0.0.1:'+server.address().port;
    const page=await browser.newPage({viewport:{width:1200,height:950}});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:'+server.address().port+'/editor');
    await page.getByText('Tracking automatically',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Delete selected session',exact:true}).isDisabled(),true);
    const hierarchy=await page.evaluate(()=>Array.from(document.querySelectorAll('.weboundary h3')).map(e=>e.textContent));
    assert.deepEqual(hierarchy,['History','Import and export']);
    const deletionStyle=await page.getByRole('button',{name:'Delete selected session',exact:true}).evaluate(e=>({inFilters:!!e.closest('.filters'),underlined:getComputedStyle(e).textDecorationLine,color:getComputedStyle(e).color,border:getComputedStyle(e).borderTopWidth,background:getComputedStyle(e).backgroundColor}));
    assert.deepEqual(deletionStyle,{inFilters:true,underlined:'underline',color:'rgb(179, 43, 20)',border:'0px',background:'rgba(0, 0, 0, 0)'});
    await page.evaluate(()=>window.__test.edit());
    await page.waitForFunction(async()=> (await window.__test.records()).length===1);
    assert.equal(await page.evaluate(()=>window.__test.features().length),0,'observed work must not render');
    await page.locator('.record[data-state=pending]').waitFor();
    await page.evaluate(()=>window.__test.fail());
    assert.equal(await page.evaluate(()=>window.__test.features().length),0,'failed save must not render');
    await page.evaluate(()=>window.__test.save());
    await page.waitForFunction(()=>window.__test.features().length>0);
    assert.equal(await page.evaluate(async()=>(await window.__test.records()).filter(r=>r.kind==='saved').length),1);
    assert.equal(await page.locator('.record[data-state=saved]').count(),1);
    assert.equal(await page.locator('#map svg path').count()>0,true);
    const colorControl=page.getByLabel('Boundary color',{exact:true});const opacityControl=page.getByLabel('Fill opacity',{exact:true});
    assert.equal(await colorControl.inputValue(),'#12aabb');assert.equal(await opacityControl.inputValue(),'13');
    await colorControl.fill('#cc3366');await opacityControl.fill('42');
    assert.equal(await page.locator('#map svg path').first().getAttribute('fill'),'#cc3366');
    assert.equal(await page.locator('#map svg path').first().getAttribute('stroke'),'#cc3366');
    assert.equal(await page.locator('#map svg path').first().getAttribute('fill-opacity'),'0.42');
    assert.equal(await page.locator('.range-row output').textContent(),'42%');
    await page.getByRole('checkbox',{name:'Show boundary',exact:true}).uncheck();
    await page.evaluate(()=>{window.__test.edit(99)});
    await page.waitForTimeout(250);
    await page.evaluate(()=>window.__test.save(99));
    await page.waitForFunction(async()=>(await window.__test.records()).filter(r=>r.kind==='saved').length===2);
    const recovered=await page.evaluate(async()=>(await window.__test.records()).find(r=>r.kind==='saved'&&r.objectId==='99'));
    assert.ok(recovered.geometry,'unloaded segment is located via findSegment');
    assert.equal(recovered.operation,'unknown');
    await page.getByRole('checkbox',{name:'Show boundary',exact:true}).check();
    await page.locator('input[type=number]').fill('150');
    await page.getByRole('button',{name:'Apply',exact:true}).click();
    await page.locator('progress').waitFor({state:'hidden'});
    const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export backup',exact:true}).click()]);
    const backup=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
    assert.equal(backup.records.filter(r=>r.kind==='saved').length,2);
    assert.equal(backup.version,2);assert.equal(backup.groups.length,2);assert.ok(backup.groups.every(g=>g.candidate===null));
    assert.deepEqual(backup.settings,{size:150,visible:true,color:'#cc3366',opacity:.42});
    const count=backup.records.length;
    await page.locator('input[type=file]').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(async()=>(await window.__test.records()).length),count,'reimport is idempotent');
    const incoming=structuredClone(backup);
    incoming.sessions=incoming.sessions.map(s=>({...s,id:'imported-'+s.id,status:'ended',endedAt:s.startedAt}));
    incoming.records=incoming.records.map(r=>({...r,id:'imported-'+r.id,sessionId:'imported-'+r.sessionId,groupId:'imported-'+r.groupId}));
    incoming.groups=incoming.groups.map(g=>({...g,id:'imported-'+g.id,sessionId:'imported-'+g.sessionId,actionIds:g.actionIds.map(id=>'imported-'+id),savedRecordId:g.savedRecordId?'imported-'+g.savedRecordId:null}));
    incoming.provenance=[];
    await page.locator('input[type=file]').setInputFiles({name:'other-browser.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(incoming))});
    await page.waitForFunction(async expected=>(await window.__test.records()).length===expected,count*2);
    const [withImports]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export backup',exact:true}).click()]);
    const portable=JSON.parse(fs.readFileSync(await withImports.path(),'utf8'));
    assert.equal(portable.provenance.length,count,'import provenance is retained by export');
    const [geoDownload]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export GeoJSON',exact:true}).click()]);
    const geo=JSON.parse(fs.readFileSync(await geoDownload.path(),'utf8'));
    assert.equal(geo.type,'FeatureCollection');assert.ok(geo.features.length);
    assert.ok(geo.features.every(f=>f.geometry.type==='Polygon'));
    const tilesBeforeStatus=await page.evaluate(()=>JSON.stringify(window.__test.features()));
    await page.getByLabel('Status (history only)',{exact:true}).selectOption('pending');
    await page.waitForFunction(()=>document.querySelectorAll('.history-results .record').length===0);
    assert.equal(await page.evaluate(()=>JSON.stringify(window.__test.features())),tilesBeforeStatus,'history status does not alter saved boundary');
    await page.getByLabel('Status (history only)',{exact:true}).selectOption('');
    await page.reload();
    await page.getByText('Tracking automatically',{exact:true}).waitFor();
    await page.waitForFunction(()=>window.__test.features().length>0);
    assert.equal(await page.getByLabel('Boundary color',{exact:true}).inputValue(),'#cc3366');assert.equal(await page.getByLabel('Fill opacity',{exact:true}).inputValue(),'42');
    assert.equal(await page.evaluate(async()=>(await window.__test.records()).length),count*2,'history survives reload');
    await page.evaluate(()=>window.__test.emit('wme-logged-out'));
    await page.getByText('Session ended',{exact:true}).waitFor();
    await page.evaluate(()=>window.__test.emit('wme-logged-in'));
    await page.getByText('Tracking automatically',{exact:true}).waitFor();
    assert.equal(await page.locator('.weboundary').count(),1,'relogin replaces the old panel');
    const dirty=await browser.newPage();
    await dirty.goto('http://127.0.0.1:'+server.address().port+'/editor?dirty');
    await dirty.getByText('Waiting for a clean edit state',{exact:true}).waitFor();
    await dirty.evaluate(()=>window.__test.save());
    await dirty.getByText('Tracking automatically',{exact:true}).waitFor();
    assert.equal(await dirty.evaluate(async()=>(await window.__test.records()).length),0,'preexisting batch is excluded');
    await dirty.close();
    const fallback=await browser.newPage();
    await fallback.goto('http://127.0.0.1:'+server.address().port+'/editor?no-worker');
    await fallback.getByText('Tracking automatically',{exact:true}).waitFor();
    await fallback.evaluate(()=>{window.__test.edit();window.__test.save()});
    await fallback.waitForFunction(()=>window.__test.features().length>0);
    await fallback.close();
    const scenario=async()=>{const p=await browser.newPage();p.on('pageerror',error=>errors.push(error.message));await p.goto(base+'/editor');await p.getByText('Tracking automatically',{exact:true}).waitFor();return p;};
    const savedCount=(p,n)=>p.waitForFunction(async expected=>(await window.__test.records()).filter(r=>r.kind==='saved').length===expected,n);

    const globalOnly=await scenario();
    await globalOnly.evaluate(()=>{window.__test.edit();window.__test.edit();window.__test.save(1,{objectEvent:false,delayedClean:true})});
    await globalOnly.waitForFunction(async()=>(await window.__test.records()).length===2);
    assert.equal(await globalOnly.evaluate(()=>window.__test.features().length),0,'success without clean state must wait');
    await globalOnly.evaluate(()=>window.__test.clean());await savedCount(globalOnly,1);
    await globalOnly.locator('.record[data-state=saved]').waitFor();
    assert.equal(await globalOnly.locator('.record').count(),1,'multiple actions form one outcome');
    await globalOnly.locator('.record summary').click();assert.equal(await globalOnly.locator('.actions>div').count(),2);
    await globalOnly.evaluate(()=>window.__test.emit('wme-data-model-objects-saved',{dataModelName:'segments',objectIds:[1]}));
    await savedCount(globalOnly,1);
    await globalOnly.evaluate(()=>{window.__test.edit();window.__test.save(1,{objectEvent:false,delayedClean:true});window.__test.edit();window.__test.clean()});
    await globalOnly.waitForFunction(async()=>(await window.__test.records()).filter(r=>r.kind==='activity').length===4);
    assert.equal(await globalOnly.evaluate(async()=>(await window.__test.records()).filter(r=>r.kind==='saved').length),1,'new edit invalidates deferred success');
    await globalOnly.evaluate(()=>window.__test.save(1,{objectEvent:false}));await savedCount(globalOnly,2);
    assert.equal(await globalOnly.evaluate(async()=>(await window.__test.records('groups')).length),2,'later save starts another group');
    await globalOnly.evaluate(()=>{window.__test.edit();window.__test.emit('wme-data-model-objects-saved',{dataModelName:'segments',objectIds:[1]})});
    await globalOnly.waitForFunction(async()=>(await window.__test.records('groups')).filter(g=>g.state==='pending').length===1);
    assert.equal(await globalOnly.evaluate(async()=>(await window.__test.records()).filter(r=>r.kind==='saved').length),2,'late duplicate cannot immediately confirm a newer dirty revision');
    await globalOnly.evaluate(()=>{window.__test.edit();window.__test.clean()});
    assert.equal(await globalOnly.evaluate(async()=>(await window.__test.records()).filter(r=>r.kind==='saved').length),2,'intervening edit cancels deferred object confirmation');
    await globalOnly.evaluate(()=>window.__test.save());await savedCount(globalOnly,3);
    await globalOnly.close();

    const remapped=await scenario();
    await remapped.evaluate(()=>{window.__test.add(-1);window.__test.remap(-1,501,true);window.__test.save(501)});await savedCount(remapped,1);
    const remapGroup=await remapped.evaluate(async()=>(await window.__test.records('groups'))[0]);
    assert.deepEqual(remapGroup.aliases,['-1','501']);assert.equal(remapGroup.objectId,'501');
    await remapped.close();

    const interrupted=await scenario();
    await interrupted.evaluate(()=>window.__test.edit());
    await interrupted.waitForFunction(async()=>(await window.__test.records('groups')).length===1);
    await interrupted.reload();await interrupted.getByText('Tracking automatically',{exact:true}).waitFor();
    await interrupted.locator('.record[data-state=interrupted]').waitFor();
    assert.equal(await interrupted.evaluate(()=>window.__test.features().length),0,'refresh does not confirm work');
    await interrupted.evaluate(()=>window.__test.save(1,{objectEvent:false}));
    assert.equal(await interrupted.evaluate(async()=>(await window.__test.records()).filter(r=>r.kind==='saved').length),0,'unrelated save does not recover interrupted work');
    const oldSession=await interrupted.evaluate(async()=>(await window.__test.records('groups'))[0].sessionId);
    await interrupted.getByLabel('Session',{exact:true}).selectOption(oldSession);
    assert.equal(await interrupted.getByRole('button',{name:'Delete selected session',exact:true}).isEnabled(),true);
    interrupted.once('dialog',dialog=>dialog.accept());await interrupted.getByRole('button',{name:'Delete selected session',exact:true}).click();
    await interrupted.waitForFunction(async()=>(await window.__test.records('groups')).length===0);
    assert.equal(await interrupted.evaluate(async()=>(await window.__test.records()).length),0,'session deletion removes linked actions');
    await interrupted.close();

    const storage=await scenario();
    await storage.evaluate(()=>{window.__test.edit();window.__test.failWrites(true);window.__test.save()});
    await storage.getByText('Storage error — recent work is held in memory',{exact:true}).waitFor();
    assert.equal(await storage.evaluate(async()=>(await window.__test.records()).filter(r=>r.kind==='saved').length),0);
    assert.equal(await storage.evaluate(()=>window.__test.features().length),0,'uncommitted records do not draw saved coverage');
    await storage.evaluate(()=>window.__test.failWrites(false));await storage.getByRole('button',{name:'Retry local storage',exact:true}).click();await savedCount(storage,1);
    await storage.evaluate(()=>{window.__test.edit();window.__test.failWrites(true);window.__test.save()});
    await storage.getByText('Storage error — recent work is held in memory',{exact:true}).waitFor();
    await storage.reload();await storage.getByText('Tracking automatically',{exact:true}).waitFor();await savedCount(storage,2);
    await storage.waitForFunction(()=>window.__test.features().length>0);
    await storage.reload();await storage.getByText('Tracking automatically',{exact:true}).waitFor();await savedCount(storage,2);
    assert.equal(await storage.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('wme-edited-boundary-receipts:')).length),0,'replayed receipts are removed after commit');
    await storage.close();

    const immediate=await scenario();
    await Promise.all([immediate.waitForEvent('load'),immediate.evaluate(()=>{window.__test.edit();window.__test.save();location.reload()})]);
    await immediate.getByText('Tracking automatically',{exact:true}).waitFor();await savedCount(immediate,1);
    assert.equal(await immediate.evaluate(async()=>(await window.__test.records()).filter(r=>r.kind==='activity').length),1,'receipt recovers actions as well as the saved outcome');
    await immediate.close();

    const shared=await browser.newContext();const tabA=await shared.newPage(),tabB=await shared.newPage();
    await tabA.goto(base+'/editor');await tabA.getByText('Tracking automatically',{exact:true}).waitFor();
    await tabB.goto(base+'/editor');await tabB.getByText('Tracking automatically',{exact:true}).waitFor();
    await tabA.evaluate(()=>window.__test.edit());await tabA.waitForFunction(async()=>(await window.__test.records('groups')).length===1);
    await tabB.evaluate(()=>window.__test.save(1,{objectEvent:false}));
    assert.equal(await tabA.evaluate(async()=>(await window.__test.records()).filter(r=>r.kind==='saved').length),0,'another tab cannot confirm pending work');
    await tabA.evaluate(()=>window.__test.save());await savedCount(tabA,1);await tabB.waitForFunction(()=>window.__test.features().length>0);
    await shared.close();

    const legacy=await browser.newPage();await legacy.goto(base+'/seed');
    const legacyBackup={...structuredClone(backup),version:1};delete legacyBackup.groups;legacyBackup.records.forEach(r=>delete r.groupId);
    await legacy.evaluate(data=>new Promise((resolve,reject)=>{const r=indexedDB.open('wme-edited-boundary',1);r.onupgradeneeded=()=>{const db=r.result;const records=db.createObjectStore('records',{keyPath:'id'});records.createIndex('sessionId','sessionId');records.createIndex('at','at');db.createObjectStore('sessions',{keyPath:'id'});db.createObjectStore('meta',{keyPath:'id'});};r.onsuccess=()=>{const tx=r.result.transaction(['records','sessions','meta'],'readwrite');data.records.forEach(row=>tx.objectStore('records').put(row));data.sessions.forEach(row=>tx.objectStore('sessions').put(row));tx.objectStore('meta').put({id:'settings',size:150,visible:true});tx.oncomplete=()=>{r.result.close();resolve()};tx.onerror=()=>reject(tx.error);};r.onerror=()=>reject(r.error);}),legacyBackup);
    await legacy.goto(base+'/editor');await legacy.getByText('Tracking automatically',{exact:true}).waitFor();await legacy.waitForFunction(()=>window.__test.features().length>0);
    assert.equal(await legacy.evaluate(async()=>(await window.__test.records('groups')).length),0,'v1 upgrade does not invent associations');
    assert.equal(await legacy.locator('input[type=number]').inputValue(),'150','v1 settings survive upgrade');
    await legacy.close();

    const importedPending=await scenario();const unfinished=structuredClone(incoming);
    unfinished.records=unfinished.records.filter(r=>r.kind==='activity');unfinished.groups.forEach(g=>{g.state='pending';g.savedRecordId=null;});
    await importedPending.locator('input[type=file]').setInputFiles({name:'unfinished.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(unfinished))});
    await importedPending.waitForFunction(async()=>(await window.__test.records('groups')).length===2);
    await importedPending.waitForFunction(()=>document.querySelectorAll('.record[data-state=interrupted]').length===2);
    await importedPending.evaluate(()=>window.__test.save(1,{objectEvent:false}));
    assert.equal(await importedPending.evaluate(async()=>(await window.__test.records()).filter(r=>r.kind==='saved').length),0,'imported unfinished work never joins a live save');
    await importedPending.close();

    const isolated=await scenario();
    await isolated.evaluate(()=>{window.__test.edit();window.__test.failWrites(true);window.__test.save()});
    await isolated.getByText('Storage error — recent work is held in memory',{exact:true}).waitFor();
    await isolated.goto(base+'/editor?foreign');await isolated.getByText('Tracking automatically',{exact:true}).waitFor();
    assert.equal(await isolated.evaluate(()=>window.__test.features().length),0,'another editor does not replay the first editor receipt');
    assert.equal(await isolated.evaluate(async()=>(await window.__test.records()).filter(r=>r.kind==='saved').length),0);
    await isolated.goto(base+'/editor');await isolated.getByText('Tracking automatically',{exact:true}).waitFor();await savedCount(isolated,1);
    await isolated.close();
    await page.screenshot({path:path.join(__dirname,'browser-smoke.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('Browser smoke passed: normalized saves, global/deferred confirmation, revision guards, remaps, grouped history, filter layout, deletion, v2 backup, v1 migration, local write retry, immediate refresh receipts, interrupted work, tab isolation, polygon SVG rendering, reload/relogin, exports and worker fallback. Simulated SDK; live WME acceptance is separate.');
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
