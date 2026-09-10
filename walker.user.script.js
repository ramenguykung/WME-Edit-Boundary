// ==UserScript==
// @name         WME Edited Boundary
// @namespace    wme-edited-boundary
// @version      0.2.0
// @description  Automatically outlines confirmed saved editing work, with local history and portable backups.
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/editor*
// @match        https://beta.waze.com/*/editor*
// @exclude      https://www.waze.com/editor/sdk/*
// @exclude      https://beta.waze.com/editor/sdk/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

// @ts-check

/**
 * @typedef {import('geojson').Point | import('geojson').LineString | import('geojson').Polygon | import('geojson').MultiLineString | import('geojson').MultiPolygon} Geometry
 * @typedef {import('geojson').Polygon} Polygon
 * @typedef {import('geojson').Position} Position
 * @typedef {import('wme-sdk-typings').WmeSDK} WmeSDK
 * @typedef {{editor:string, region:string, environment:string}} Context
 * @typedef {'addition'|'edit'|'deletion'|'unknown'|'undo'} Operation
 * @typedef {{id:string, kind:'activity'|'saved', at:string, sessionId:string, context:Context, model:string, objectType:string, objectId:string, operation:Operation, geometry:Geometry|null, beforeGeometry:Geometry|null, locationSource:string, status:string,groupId?:string}} Entry
 * @typedef {{id:string, context:Context, startedAt:string, endedAt:string|null, status:string, gaps:string[]}} Session
 * @typedef {{size:number, visible:boolean}} Settings
 * @typedef {{format:'wme-edited-boundary',version:1|2,exportedAt:string,settings:Settings,sessions:Session[],records:Entry[],groups?:WorkGroup[],provenance?:{recordId:string,importedAt:string}[]}} Backup
 * @typedef {{model:string,objectType:string,objectId:string|number,geometry:Geometry|null,isNew:boolean,isDeleted:boolean,fingerprint:string,locationSource:string,baselineFingerprint?:string,baselineGeometry?:Geometry|null,classificationKnown?:boolean}} Snapshot
 * @typedef {{key:string,revision:number}} Token
 * @typedef {{groupId:string,snapshot:Snapshot, revision:number, uncertain:boolean, baselineFingerprint:string|undefined, beforeGeometry:Geometry|null, wasNew:boolean}} Candidate
 * @typedef {{id:string,sessionId:string,context:Context,model:string,objectType:string,objectId:string,aliases:string[],state:'pending'|'saved'|'undone'|'interrupted',createdAt:string,updatedAt:string,actionIds:string[],savedRecordId:string|null,message:string,candidate:Candidate|null}} WorkGroup
 */

(function () {
  'use strict';

  /** Shared grid implementation, also instantiated inside the geometry worker. */
  function createGeometryTools() {
    // Web Mercator radius, latitude limit, and per-operation resource ceiling.
    const R = 6378137;
    const MAX_LAT = 85.0511287798066;
    const MAX_CELLS = 250000;

    /** @param {Position} p @returns {Position} */
    function project(p) {
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > MAX_LAT) {
        throw new Error('Coordinates are outside the supported map range.');
      }
      return [R * p[0] * Math.PI / 180, R * Math.log(Math.tan(Math.PI / 4 + p[1] * Math.PI / 360))];
    }

    /** @param {Position} p @returns {Position} */
    function unproject(p) {
      return [Math.max(-180, Math.min(180, p[0] / R * 180 / Math.PI)), (2 * Math.atan(Math.exp(p[1] / R)) - Math.PI / 2) * 180 / Math.PI];
    }

    /** @param {number} size */
    function checkSize(size) {
      if (!Number.isFinite(size) || size < 50 || size > 5000) throw new Error('Tile size must be between 50 and 5,000 metres.');
    }

    /** @param {Position} p @param {Position[]} ring */
    function inRing(p, ring) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i];
        const b = ring[j];
        if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
      return inside;
    }

    /**
     * Rasterize actual geometry, including the cells between line vertices.
     * Boundary cells are included. Large or unsupported footprints fail visibly.
     * @param {Geometry} geometry @param {number} size @returns {Set<string>}
     */
    function geometryCells(geometry, size) {
      checkSize(size);
      /** @type {Set<string>} */
      const cells = new Set();
      /** @param {number} x @param {number} y */
      const add = (x, y) => {
        cells.add(`${x},${y}`);
        if (cells.size > MAX_CELLS) throw new Error('This footprint exceeds 250,000 cells. Increase the tile size.');
      };
      /** @param {Position[]} points @returns {Position[]} */
      const line = (points) => {
        const projected = points.map(project).map(p => [p[0] / size, p[1] / size]);
        for (let i = 0; i < projected.length; i++) {
          const a = projected[i];
          add(Math.floor(a[0]), Math.floor(a[1]));
          if (!i) continue;
          if (Math.abs(points[i][0] - points[i - 1][0]) > 180) throw new Error('A footprint crosses the date line; it is retained in history without an outline.');
          const b = projected[i - 1];
          let x = Math.floor(b[0]);
          let y = Math.floor(b[1]);
          const endX = Math.floor(a[0]);
          const endY = Math.floor(a[1]);
          const dx = a[0] - b[0];
          const dy = a[1] - b[1];
          const sx = Math.sign(dx);
          const sy = Math.sign(dy);
          const stepX = dx ? Math.abs(1 / dx) : Infinity;
          const stepY = dy ? Math.abs(1 / dy) : Infinity;
          let tx = dx ? ((sx > 0 ? x + 1 : x) - b[0]) / dx : Infinity;
          let ty = dy ? ((sy > 0 ? y + 1 : y) - b[1]) / dy : Infinity;
          let steps = 0;
          while (x !== endX || y !== endY) {
            if (++steps > MAX_CELLS) throw new Error('A line exceeds the cell processing limit.');
            if (Math.abs(tx - ty) < 1e-12) {
              add(x + sx, y);
              add(x, y + sy);
              x += sx; y += sy; tx += stepX; ty += stepY;
            } else if (tx < ty) { x += sx; tx += stepX; }
            else { y += sy; ty += stepY; }
            add(x, y);
          }
        }
        return projected;
      };
      /** @param {Position[][]} rings */
      const polygon = (rings) => {
        const projected = rings.map(line);
        const outer = projected[0];
        if (!outer?.length) throw new Error('Polygon has no outer ring.');
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const p of outer) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
        if ((maxX - minX + 1) * (maxY - minY + 1) > MAX_CELLS) throw new Error('Polygon is too large at this tile size.');
        for (let y = Math.floor(minY); y <= Math.floor(maxY); y++) {
          for (let x = Math.floor(minX); x <= Math.floor(maxX); x++) {
            const centre = [x + 0.5, y + 0.5];
            if (inRing(centre, outer) && !projected.slice(1).some(hole => inRing(centre, hole))) add(x, y);
          }
        }
      };
      switch (geometry.type) {
        case 'Point': line([geometry.coordinates]); break;
        case 'LineString': line(geometry.coordinates); break;
        case 'MultiLineString': geometry.coordinates.forEach(line); break;
        case 'Polygon': polygon(geometry.coordinates); break;
        case 'MultiPolygon': geometry.coordinates.forEach(polygon); break;
        default: throw new Error('Unsupported geometry.');
      }
      return cells;
    }

    /**
     * Trace exposed tile edges into polygons, retaining holes and disconnected areas.
     * @param {Set<string>} cells @param {number} size @returns {Polygon[]}
     */
    function cellsToPolygons(cells, size) {
      checkSize(size);
      if (cells.size > MAX_CELLS) throw new Error('Boundary exceeds 250,000 cells. Narrow the history filter or increase tile size.');
      /** @typedef {{a:Position,b:Position,dir:number,key:string}} Edge */
      /** @type {Map<string,Edge[]>} */
      const outgoing = new Map();
      /** @type {Map<string,Edge>} */
      const edges = new Map();
      /** @param {number} x @param {number} y @param {number} ex @param {number} ey @param {number} dir */
      const edge = (x, y, ex, ey, dir) => {
        const key = `${x},${y},${dir}`;
        const e = {a:[x,y], b:[ex,ey], dir, key};
        edges.set(key, e);
        const vertex = `${x},${y}`;
        const list = outgoing.get(vertex) || [];
        list.push(e); outgoing.set(vertex, list);
      };
      for (const cell of cells) {
        const [x,y] = cell.split(',').map(Number);
        if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('Invalid tile key.');
        if (!cells.has(`${x},${y-1}`)) edge(x,y,x+1,y,0);
        if (!cells.has(`${x+1},${y}`)) edge(x+1,y,x+1,y+1,1);
        if (!cells.has(`${x},${y+1}`)) edge(x+1,y+1,x,y+1,2);
        if (!cells.has(`${x-1},${y}`)) edge(x,y+1,x,y,3);
      }
      /** @type {{ring:Position[],area:number}[]} */
      const rings = [];
      while (edges.size) {
        const first = edges.values().next().value;
        if (!first) break;
        let current = first;
        const ring = [first.a];
        let guard = 0;
        while (true) {
          edges.delete(current.key);
          ring.push(current.b);
          if (current.b[0] === first.a[0] && current.b[1] === first.a[1]) break;
          const choices = (outgoing.get(current.b.join(',')) || []).filter(e => edges.has(e.key));
          // Prefer a left turn at diagonal contacts, keeping touching islands separate.
          const order = [1,0,3,2];
          choices.sort((a,b) => order.indexOf((a.dir-current.dir+4)%4) - order.indexOf((b.dir-current.dir+4)%4));
          if (!choices[0] || ++guard > cells.size * 4) throw new Error('Boundary could not be closed.');
          current = choices[0];
        }
        const compact = ring.slice(0,-1).filter((p,i,a) => {
          const before = a[(i+a.length-1)%a.length];
          const after = a[(i+1)%a.length];
          return (p[0]-before[0])*(after[1]-p[1]) !== (p[1]-before[1])*(after[0]-p[0]);
        });
        if (compact.length < 3) continue;
        compact.push(compact[0]);
        let area = 0;
        for (let i=1;i<compact.length;i++) area += compact[i-1][0]*compact[i][1]-compact[i][0]*compact[i-1][1];
        rings.push({ring:compact,area:area/2});
      }
      const outer = rings.filter(r=>r.area>0).sort((a,b)=>a.area-b.area);
      /** @type {Position[][][]} */
      const groups = outer.map(r=>[r.ring]);
      for (const hole of rings.filter(r=>r.area<0)) {
        const owner = outer.findIndex(r=>inRing(hole.ring[0], r.ring));
        if (owner < 0) throw new Error('Boundary hole has no surrounding polygon.');
        groups[owner].push(hole.ring);
      }
      return groups.map(rings=>({type:'Polygon',coordinates:rings.map(r=>r.map(p=>unproject([p[0]*size,p[1]*size])))}));
    }
    return {project,unproject,geometryCells,cellsToPolygons};
  }

  /** Stable property ordering for identity checks; no executable content is accepted. @param {unknown} value @returns {string} */
  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(/** @type {Record<string,unknown>} */(value)[k])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
  }

  /** @param {unknown} value @returns {value is Record<string,unknown>} */
  function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

  /** Validate geometry before storage/import; support only the shapes the grid handles. @param {unknown} value @returns {value is Geometry} */
  function validGeometry(value) {
    if (!object(value) || !Array.isArray(value.coordinates)) return false;
    let vertices = 0;
    /** @param {unknown} p */
    const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0])<=180 && Math.abs(p[1])<=85.0511287798066 && ++vertices<=100000;
    /** @param {unknown} r */
    const line = r => Array.isArray(r) && r.length>=2 && r.every(point);
    /** @param {unknown} r */
    const ring = r => Array.isArray(r) && r.length>=4 && r.every(point) && stable(r[0])===stable(r[r.length-1]);
    /** @param {unknown} p */
    const polygon = p => Array.isArray(p) && p.length>0 && p.every(ring);
    switch (value.type) {
      case 'Point': return point(value.coordinates);
      case 'LineString': return line(value.coordinates);
      case 'Polygon': return polygon(value.coordinates);
      case 'MultiLineString': return value.coordinates.length>0 && value.coordinates.every(line);
      case 'MultiPolygon': return value.coordinates.length>0 && value.coordinates.every(polygon);
      default: return false;
    }
  }

  /** @param {unknown} value @returns {value is Context} */
  function validContext(value) { return object(value) && ['editor','region','environment'].every(k=>typeof value[k]==='string' && value[k].length>0 && value[k].length<200); }

  /** Validate an entire backup before any database mutation. @param {unknown} input @returns {Backup} */
  function validateBackup(input) {
    if (!object(input) || input.format!=='wme-edited-boundary' || ![1,2].includes(Number(input.version)) || typeof input.version!=='number') throw new Error('Unsupported backup format or version.');
    if (!object(input.settings) || typeof input.settings.size!=='number' || input.settings.size<50 || input.settings.size>5000 || !Number.isFinite(input.settings.size) || typeof input.settings.visible!=='boolean') throw new Error('Invalid backup settings.');
    if (!Array.isArray(input.records) || !Array.isArray(input.sessions) || input.records.length>200000 || input.sessions.length>20000) throw new Error('Backup exceeds the import limits.');
    /** @param {unknown} x */
    const text = x => typeof x==='string' && x.length>0 && x.length<=2000;
    /** @param {unknown} x */
    const date = x => text(x) && Number.isFinite(Date.parse(String(x)));
    /** @param {Context} context @returns {Context} */
    const contextCopy = context => ({editor:context.editor,region:context.region,environment:context.environment});
    /** @param {Geometry|null} geometry @returns {Geometry|null} */
    const geometryCopy = geometry => geometry ? {type:geometry.type,coordinates:JSON.parse(JSON.stringify(geometry.coordinates))} : null;
    if (!date(input.exportedAt)) throw new Error('Invalid export date.');
    /** @type {Map<unknown,Record<string,unknown>>} */
    const sessions = new Map();
    for (const s of input.sessions) {
      if (!object(s) || !text(s.id) || !validContext(s.context) || !date(s.startedAt) || (s.endedAt!==null && !date(s.endedAt)) || !text(s.status) || !Array.isArray(s.gaps) || s.gaps.length>1000 || !s.gaps.every(text) || sessions.has(s.id)) throw new Error('Invalid or duplicate session.');
      sessions.set(s.id,s);
    }
    for (const r of input.records) {
      if (!object(r) || !text(r.id) || !date(r.at) || !text(r.sessionId) || !sessions.has(r.sessionId) || !validContext(r.context) || !['activity','saved'].includes(String(r.kind)) || !['addition','edit','deletion','unknown','undo'].includes(String(r.operation)) || !['model','objectType','objectId','locationSource','status'].every(k=>typeof r[k]==='string' && String(r[k]).length<=2000) || (r.geometry!==null&&!validGeometry(r.geometry)) || (r.beforeGeometry!==null&&!validGeometry(r.beforeGeometry))) throw new Error('Invalid history record or geometry.');
      const session = sessions.get(r.sessionId);
      if (stable(session?.context)!==stable(r.context)) throw new Error('Record context differs from its session.');
      if (r.kind==='saved' && (r.status!=='confirmed' || r.operation==='undo')) throw new Error('Invalid saved record status.');
      if (r.groupId!==undefined && (input.version!==2 || !text(r.groupId))) throw new Error('Invalid history group reference.');
    }
    // Normalize away extra object keys and prototypes at the trusted boundary.
    /** @type {Backup} */
    const backup = {
      format:'wme-edited-boundary',version:/** @type {1|2} */(input.version),exportedAt:String(input.exportedAt),
      settings:{size:input.settings.size,visible:input.settings.visible},
      sessions:input.sessions.map(s=>({id:s.id,context:contextCopy(s.context),startedAt:s.startedAt,endedAt:s.endedAt,status:s.status,gaps:[...s.gaps]})),
      records:mergeRecords([],input.records.map(r=>({
        id:r.id,kind:r.kind,at:r.at,sessionId:r.sessionId,context:contextCopy(r.context),model:r.model,objectType:r.objectType,objectId:r.objectId,
        operation:r.operation,geometry:geometryCopy(r.geometry),beforeGeometry:geometryCopy(r.beforeGeometry),locationSource:r.locationSource,status:r.status,
        ...(r.groupId===undefined?{}:{groupId:r.groupId})
      })))
    };
    if (input.version===2) {
      if (!Array.isArray(input.groups) || input.groups.length>200000) throw new Error('Invalid work-group journal.');
      const records=new Map(backup.records.map(r=>[r.id,r]));
      /** @type {Map<string,WorkGroup>} */
      const groups=new Map();
      for (const g of input.groups) {
        if (!object(g) || !text(g.id) || !text(g.sessionId) || !sessions.has(g.sessionId) || !validContext(g.context) || !['model','objectType','objectId'].every(k=>text(g[k])) || !['pending','saved','undone','interrupted'].includes(String(g.state)) || !date(g.createdAt) || !date(g.updatedAt) || Date.parse(String(g.updatedAt))<Date.parse(String(g.createdAt)) || typeof g.message!=='string' || g.message.length>2000 || g.candidate!==null || !Array.isArray(g.aliases) || !g.aliases.length || g.aliases.length>200000 || !g.aliases.every(text) || new Set(g.aliases).size!==g.aliases.length || !g.aliases.includes(g.objectId) || !Array.isArray(g.actionIds) || g.actionIds.length>200000 || !g.actionIds.every(text) || new Set(g.actionIds).size!==g.actionIds.length || (g.savedRecordId!==null&&!text(g.savedRecordId)) || groups.has(String(g.id))) throw new Error('Invalid or duplicate work group.');
        if (stable(sessions.get(g.sessionId)?.context)!==stable(g.context)) throw new Error('Work-group context differs from its session.');
        if ((g.state==='saved')!==(g.savedRecordId!==null) || (g.savedRecordId!==null&&g.actionIds.includes(g.savedRecordId))) throw new Error('Invalid work-group saved outcome.');
        const group=/** @type {WorkGroup} */({id:g.id,sessionId:g.sessionId,context:contextCopy(g.context),model:g.model,objectType:g.objectType,objectId:g.objectId,aliases:[...g.aliases],state:g.state,createdAt:g.createdAt,updatedAt:g.updatedAt,actionIds:[...g.actionIds],savedRecordId:g.savedRecordId,message:g.message,candidate:null});
        groups.set(group.id,group);
        const linkedIds=[...group.actionIds,...(group.savedRecordId?[group.savedRecordId]:[])];
        for (const id of linkedIds) {
          const record=records.get(id);
          if (!record || record.groupId!==group.id || record.sessionId!==group.sessionId || stable(record.context)!==stable(group.context) || record.model!==group.model || record.objectType!==group.objectType || !group.aliases.includes(record.objectId) || record.kind!==(id===group.savedRecordId?'saved':'activity')) throw new Error('Invalid work-group record link.');
        }
      }
      for (const record of backup.records) {
        if (record.groupId===undefined) continue;
        const group=groups.get(record.groupId);
        if (!group || (record.kind==='saved'?group.savedRecordId!==record.id:!group.actionIds.includes(record.id))) throw new Error('Invalid history group reference.');
      }
      backup.groups=Array.from(groups.values());
    }
    if(input.provenance!==undefined){
      const recordIds=new Set(backup.records.map(r=>r.id));
      if(!Array.isArray(input.provenance)||input.provenance.length>backup.records.length||!input.provenance.every(p=>object(p)&&recordIds.has(String(p.recordId))&&date(p.importedAt)))throw new Error('Invalid import provenance.');
      if(new Set(input.provenance.map(p=>p.recordId)).size!==input.provenance.length)throw new Error('Duplicate import provenance.');
      backup.provenance=input.provenance.map(p=>({recordId:p.recordId,importedAt:p.importedAt}));
    }
    return backup;
  }

  /** Merge immutable records, rejecting conflicting IDs before storage. @template {{id:string}} T @param {T[]} existing @param {T[]} incoming @returns {T[]} */
  function mergeRecords(existing,incoming) {
    const result = new Map(existing.map(r=>[r.id,r]));
    for (const record of incoming) {
      const prior = result.get(record.id);
      if (prior && stable(prior)!==stable(record)) throw new Error(`Conflicting record: ${record.id}`);
      if (!prior) result.set(record.id,record);
    }
    return Array.from(result.values());
  }

  /** Reconcile observed work with persistence evidence; has no WME side effects. */
  class Recorder {
    /** @param {{onActivity:(record:Entry,group?:WorkGroup)=>void,onSaved:(record:Entry,group?:WorkGroup)=>void,onGroup?:(group:WorkGroup)=>void,context?:Context,sessionId?:string,now?:()=>string,id?:()=>string}} options */
    constructor(options) {
      this.options=options;
      this.now=options.now||(()=>new Date().toISOString());
      this.id=options.id||(()=>crypto.randomUUID());
      /** @type {Map<string,Candidate>} */
      this.pending=new Map();
      /** @type {Map<string,WorkGroup>} */
      this.groups=new Map();
      /** @type {Map<string,number>|null} Exact revisions covered by a received successful save. */
      this.successfulSave=null;
      /** @type {Map<string,{snapshot:Snapshot|undefined,groups:Map<string,number>}>} Saved signals received before explicit ID remapping. */
      this.unmatchedSaved=new Map();
      this.armed=false;
      this.revision=0;
    }
    /** @param {string} model @param {string|number} id */
    key(model,id) { return `${model}:${String(id)}`; }
    /** @param {boolean} armed */
    setArmed(armed) { this.armed=armed; if (!armed) this.clean(); }
    /** @param {Snapshot} snapshot @returns {Token|null} */
    observe(snapshot) {
      if (!this.armed) return null;
      this.invalidateSuccessfulSave();
      const key=this.key(snapshot.model,snapshot.objectId);
      const prior=this.pending.get(key);
      const group=prior?this.groups.get(prior.groupId):this.newGroup(snapshot);
      if (!group) return null;
      /** @type {Candidate} */
      const candidate={groupId:group.id,snapshot:structuredClone(snapshot),revision:++this.revision,uncertain:false,baselineFingerprint:prior?prior.baselineFingerprint:snapshot.baselineFingerprint,beforeGeometry:prior?prior.beforeGeometry:snapshot.baselineGeometry??null,wasNew:prior?prior.wasNew:snapshot.isNew};
      this.pending.set(key,candidate);
      const operation=snapshot.classificationKnown===false?'unknown':snapshot.isDeleted?'deletion':(!prior&&snapshot.isNew?'addition':'edit');
      const record=this.entry(snapshot,'activity',operation,'observed',snapshot.geometry,snapshot.baselineGeometry??null);
      record.groupId=group.id;
      group.actionIds.push(record.id);
      group.candidate=candidate;group.updatedAt=record.at;group.message='';
      this.options.onActivity(record,structuredClone(group));
      return {key,revision:candidate.revision};
    }
    /** Resolve delayed geometry only for the exact captured revision. @param {Token} token @param {Geometry} geometry @param {string} source */
    resolve(token,geometry,source) {
      const candidate=this.pending.get(token.key);
      if (!candidate || candidate.revision!==token.revision || candidate.uncertain) return false;
      candidate.snapshot.geometry=structuredClone(geometry);
      candidate.snapshot.locationSource=source;
      this.publish(candidate);
      return true;
    }
    /** @param {string} model @param {string|number} oldId @param {string|number} newId */
    remap(model,oldId,newId) {
      const key=this.key(model,oldId);
      const c=this.pending.get(key);
      if (!c) return;
      const nextKey=this.key(model,newId);
      if (nextKey===key) return;
      // An ambiguous identity collision must not overwrite either object's work.
      if (this.pending.has(nextKey)) { this.invalidateSuccessfulSave();c.uncertain=true;this.publish(c,'Object identity remapping is unresolved.');return; }
      const previousRevision=c.revision;
      this.pending.delete(key);
      c.snapshot.objectId=newId;
      c.revision=++this.revision;
      this.pending.set(nextKey,c);
      const group=this.groups.get(c.groupId);
      if (group) { group.objectId=String(newId);group.aliases=Array.from(new Set([...group.aliases,String(oldId),String(newId)])); }
      if (this.successfulSave?.get(key)===previousRevision) { this.successfulSave.delete(key);this.successfulSave.set(nextKey,c.revision); }
      // Remapping does not constitute another edit, so preserve the captured revision relationship.
      for (const evidence of this.unmatchedSaved.values()) if (evidence.groups.get(c.groupId)===previousRevision) evidence.groups.set(c.groupId,c.revision);
      this.publish(c);
      const evidence=this.unmatchedSaved.get(nextKey);
      if (evidence?.groups.get(c.groupId)===c.revision) { this.unmatchedSaved.delete(nextKey);this.saved(model,newId,evidence.snapshot,c.revision); }
    }
    /** Undo carries no affected IDs. Require fresh snapshots before confirmation. */
    undo() {
      this.invalidateSuccessfulSave();this.unmatchedSaved.clear();
      for (const c of this.pending.values()) { c.uncertain=true;c.revision=++this.revision;this.publish(c,'Undo result awaiting reconciliation.'); }
    }
    /** Reconcile an existing candidate after undo without manufacturing new activity. @param {Snapshot} snapshot */
    reconcile(snapshot) {
      const key=this.key(snapshot.model,snapshot.objectId);
      const c=this.pending.get(key);
      if (!c || !c.uncertain) return;
      if ((c.baselineFingerprint!==undefined&&snapshot.fingerprint===c.baselineFingerprint) || (c.wasNew&&snapshot.isDeleted)) { this.finishWithoutSave(key,c,'undone','Changes were undone before saving.');return; }
      if (snapshot.classificationKnown===false) { this.publish(c,'Undo result cannot be established.');return; }
      c.snapshot=structuredClone(snapshot); c.uncertain=false; c.revision=++this.revision;
      this.publish(c,'');
    }
    /** @param {string} model @param {string|number} id @param {Snapshot} [snapshot] @param {number} [expectedRevision] @returns {boolean} */
    saved(model,id,snapshot,expectedRevision) {
      if (!this.armed) return false;
      let key=this.key(model,id);
      let c=this.pending.get(key);
      if (!c) {
        // The event may use a previous ID after an already-observed explicit remapping.
        const aliases=Array.from(this.pending.entries()).filter(([,item])=>item.snapshot.model===model&&this.groups.get(item.groupId)?.aliases.includes(String(id)));
        if (aliases.length===1) [key,c]=aliases[0];
      }
      if (!c) {
        // Retain only real evidence tied to groups that already existed when it arrived.
        const groups=new Map(Array.from(this.pending.values()).filter(item=>item.snapshot.model===model&&item.wasNew&&Number(item.snapshot.objectId)<0).map(item=>[item.groupId,item.revision]));
        if (groups.size&&expectedRevision===undefined) {
          this.unmatchedSaved.set(key,{snapshot:snapshot?structuredClone(snapshot):undefined,groups});
          if (this.unmatchedSaved.size>128) this.unmatchedSaved.delete(/** @type {string} */(this.unmatchedSaved.keys().next().value));
        }
        return false;
      }
      if (c.uncertain || (expectedRevision!==undefined&&c.revision!==expectedRevision)) return false;
      const final=structuredClone(snapshot||c.snapshot);
      if (final.model!==model) return false;
      final.objectId=c.snapshot.objectId;
      if (c.wasNew&&final.isDeleted) { this.finishWithoutSave(key,c,'undone','New object was deleted before saving.');return false; }
      const operation=c.snapshot.classificationKnown===false||final.classificationKnown===false?'unknown':final.isDeleted?'deletion':(c.wasNew?'addition':'edit');
      const geometry=final.isDeleted?(c.beforeGeometry||c.snapshot.geometry):(final.geometry||c.snapshot.geometry);
      const group=this.groups.get(c.groupId);
      if (!group) return false;
      const record=this.entry(final,'saved',operation,'confirmed',geometry,c.wasNew?null:c.beforeGeometry);
      record.id=`saved:${group.id}`;record.groupId=group.id;
      group.state='saved';group.updatedAt=record.at;group.savedRecordId=record.id;group.candidate=null;group.message='';
      this.pending.delete(key);
      this.forgetEvidence(c.groupId);
      this.options.onSaved(record,structuredClone(group));
      return true;
    }
    /** Capture the exact work covered by this received successful save event. */
    saveSucceeded() { this.successfulSave=this.armed?new Map(Array.from(this.pending,([key,c])=>[key,c.revision])):null; }
    /** Confirm only known main-editor work after the successful save reaches a clean state.
     * @param {boolean} clean @param {(model:string,id:string|number)=>Snapshot|null} readSnapshot @param {ReadonlySet<string>} allowedModels @returns {number} */
    reconcileSuccessfulSave(clean,readSnapshot,allowedModels) {
      const batch=this.successfulSave;
      if (!this.armed || !clean || !batch) return 0;
      /** @type {{key:string,candidate:Candidate,snapshot:Snapshot}[]} */
      const confirmed=[];
      for (const [key,revision] of batch) {
        const c=this.pending.get(key);
        if (!c || c.revision!==revision || c.uncertain || !allowedModels.has(c.snapshot.model) || c.snapshot.classificationKnown===false) { batch.delete(key);continue; }
        if (!/^\d+$/.test(String(c.snapshot.objectId)) || Number(c.snapshot.objectId)<=0) continue;
        const final=readSnapshot(c.snapshot.model,c.snapshot.objectId)||(c.snapshot.isDeleted?c.snapshot:null);
        if (this.successfulSave!==batch) return 0;
        if (!final || final.isNew || final.classificationKnown===false || final.model!==c.snapshot.model || String(final.objectId)!==String(c.snapshot.objectId)) continue;
        confirmed.push({key,candidate:c,snapshot:final});
      }
      let count=0;
      for (const {key,candidate,snapshot} of confirmed) { batch.delete(key);if (this.pending.get(key)===candidate&&this.saved(snapshot.model,snapshot.objectId,snapshot,candidate.revision)) ++count; }
      if(!batch.size&&this.successfulSave===batch)this.successfulSave=null;
      return count;
    }
    /** @param {string} [message] */
    saveFailed(message='Save failed. Changes are still pending; retry saving in WME.') {
      this.invalidateSuccessfulSave();this.unmatchedSaved.clear();
      for (const c of this.pending.values()) this.publish(c,message);
    }
    /** Any new edit, undo, or editor-mode transition invalidates deferred global evidence. */
    invalidateSuccessfulSave() { this.successfulSave=null; }
    /** @param {Snapshot} snapshot @returns {WorkGroup} */
    newGroup(snapshot) {
      const at=this.now();
      /** @type {WorkGroup} */
      const group={id:this.id(),sessionId:this.options.sessionId||'',context:structuredClone(this.options.context||{editor:'',region:'',environment:''}),model:snapshot.model,objectType:snapshot.objectType,objectId:String(snapshot.objectId),aliases:[String(snapshot.objectId)],state:'pending',createdAt:at,updatedAt:at,actionIds:[],savedRecordId:null,message:'',candidate:null};
      this.groups.set(group.id,group);return group;
    }
    /** Persist a candidate-only transition as a detached snapshot. @param {Candidate} candidate @param {string} [message] */
    publish(candidate,message) {
      const group=this.groups.get(candidate.groupId);
      if (!group) return;
      group.candidate=candidate;group.updatedAt=this.now();if(message!==undefined)group.message=message;
      this.options.onGroup?.(structuredClone(group));
    }
    /** @param {string} key @param {Candidate} candidate @param {'undone'|'interrupted'} state @param {string} message */
    finishWithoutSave(key,candidate,state,message) {
      const group=this.groups.get(candidate.groupId);
      this.pending.delete(key);this.forgetEvidence(candidate.groupId);
      if (!group) return;
      group.state=state;group.updatedAt=this.now();group.message=message;
      // Interrupted candidates remain inspectable in the journal but never resume as active work.
      group.candidate=state==='interrupted'?candidate:null;
      this.options.onGroup?.(structuredClone(group));
    }
    /** @param {string} groupId */
    forgetEvidence(groupId) {
      for (const [key,evidence] of this.unmatchedSaved) { evidence.groups.delete(groupId);if(!evidence.groups.size)this.unmatchedSaved.delete(key); }
    }
    /** @param {Snapshot} s @param {'activity'|'saved'} kind @param {Operation} operation @param {string} status @param {Geometry|null} geometry @param {Geometry|null} beforeGeometry @returns {Entry} */
    entry(s,kind,operation,status,geometry,beforeGeometry) {
      return {id:this.id(),kind,at:this.now(),sessionId:this.options.sessionId||'',context:structuredClone(this.options.context||{editor:'',region:'',environment:''}),model:s.model,objectType:s.objectType,objectId:String(s.objectId),operation,geometry:geometry?structuredClone(geometry):null,beforeGeometry:beforeGeometry?structuredClone(beforeGeometry):null,locationSource:s.locationSource,status};
    }
    /** Invalidate all unresolved revisions at a known session boundary. */
    clean() {
      this.invalidateSuccessfulSave();this.unmatchedSaved.clear();
      for (const [key,c] of this.pending) this.finishWithoutSave(key,c,'interrupted','Tracking ended before saving could be confirmed.');
      ++this.revision;
    }
  }

  /** IndexedDB storage with atomic imports and immutable history entries. */
  class HistoryStore {
    /** @param {IDBDatabase} db */
    constructor(db) { this.db=db; }
    /** @returns {Promise<HistoryStore>} */
    static open() {
      return new Promise((resolve,reject)=>{
        const request=indexedDB.open('wme-edited-boundary',2);
        request.onupgradeneeded=()=>{
          const db=request.result;
          if (!db.objectStoreNames.contains('records')) {
            const records=db.createObjectStore('records',{keyPath:'id'});
            records.createIndex('sessionId','sessionId');
            records.createIndex('at','at');
          }
          if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions',{keyPath:'id'});
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta',{keyPath:'id'});
          if (!db.objectStoreNames.contains('groups')) db.createObjectStore('groups',{keyPath:'id'}).createIndex('sessionId','sessionId');
        };
        request.onsuccess=()=>{ request.result.onversionchange=()=>request.result.close(); resolve(new HistoryStore(request.result)); };
        request.onerror=()=>reject(request.error||new Error('Local history could not be opened.'));
        request.onblocked=()=>reject(new Error('Close other WME tabs to finish opening history.'));
      });
    }
    /** @template T @param {string} store @returns {Promise<T[]>} */
    all(store) {
      return new Promise((resolve,reject)=>{
        const tx=this.db.transaction(store,'readonly');
        const request=tx.objectStore(store).getAll();
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
    }
    /** @param {string} store @param {unknown[]} records @returns {Promise<void>} */
    put(store,records) {
      return new Promise((resolve,reject)=>{
        const tx=this.db.transaction(store,'readwrite');
        records.forEach(r=>tx.objectStore(store).put(r));
        tx.oncomplete=()=>resolve(); tx.onabort=()=>reject(tx.error||new Error('Local write failed.')); tx.onerror=()=>{};
      });
    }
    /** Commit a journal transition and its immutable evidence together, including recovery after refresh. @param {Entry|null} record @param {WorkGroup} group @param {Entry[]} [activities] @returns {Promise<void>} */
    commitWork(record,group,activities=[]) {
      return new Promise((resolve,reject)=>{
        // Check the receipt before opening a transaction; no partial writes may escape validation.
        let rows;
        try {
          rows=mergeRecords([],activities.concat(record?[record]:[]));
          if (activities.some(r=>r.kind!=='activity'||r.groupId!==group.id||!group.actionIds.includes(r.id)) || (record&&(record.kind!=='saved'||record.groupId!==group.id||group.state!=='saved'||group.savedRecordId!==record.id))) throw new Error('Invalid work-group confirmation receipt.');
        } catch(error) { reject(error); return; }
        const tx=this.db.transaction(['records','groups'],'readwrite');
        /** @type {Error|null} */
        let conflict=null;
        const records=tx.objectStore('records'), groups=tx.objectStore('groups');
        const priorGroup=groups.get(group.id);
        priorGroup.onsuccess=()=>{
          if (conflict) return;
          const prior=/** @type {WorkGroup|undefined} */(priorGroup.result);
          if (prior && (prior.sessionId!==group.sessionId || stable(prior.context)!==stable(group.context) || prior.model!==group.model || (prior.savedRecordId && prior.savedRecordId!==group.savedRecordId))) {
            conflict=new Error(`Conflicting work group: ${group.id}`); tx.abort(); return;
          }
          groups.put(group);
        };
        for (const row of rows) {
          const prior=records.get(row.id);
          prior.onsuccess=()=>{
            if (conflict) return;
            if (prior.result&&stable(prior.result)!==stable(row)) { conflict=new Error(`Conflicting record: ${row.id}`); tx.abort(); return; }
            if (!prior.result) records.add(row);
          };
        }
        tx.oncomplete=()=>resolve(); tx.onabort=()=>reject(conflict||tx.error||new Error('Saved work could not be committed locally.')); tx.onerror=()=>{};
      });
    }
    /** Validate conflicts inside one transaction so another tab cannot race the import. @param {Backup} backup @param {boolean} restoreSettings @returns {Promise<void>} */
    import(backup,restoreSettings) {
      return new Promise((resolve,reject)=>{
        const tx=this.db.transaction(['records','sessions','groups','meta'],'readwrite');
        const origins=new Map((backup.provenance||[]).map(p=>[p.recordId,p.importedAt]));
        /** @type {Error|null} */
        let conflict=null;
        /** @param {string} name @param {{id:string}[]} rows */
        const merge=(name,rows)=>{
          const store=tx.objectStore(name);
          for (const row of rows) {
            const request=store.get(row.id);
            request.onsuccess=()=>{
              if (conflict) return;
              if (request.result && stable(request.result)!==stable(row)) { conflict=new Error(`Conflicting ${name} entry: ${row.id}`); tx.abort(); return; }
              if (!request.result) {
                store.add(row);
                if (name==='records') tx.objectStore('meta').put({id:`import:${row.id}`,at:origins.get(row.id)||new Date().toISOString()});
              }
            };
          }
        };
        merge('sessions',backup.sessions); merge('records',backup.records);
        // Journal rows are mutable: retain local revisions and never resurrect them from a backup.
        for (const group of backup.groups||[]) {
          const request=tx.objectStore('groups').get(group.id);
          request.onsuccess=()=>{
            if (conflict) return;
            if (request.result) {
              const prior=/** @type {WorkGroup} */(request.result);
              if (prior.sessionId!==group.sessionId || stable(prior.context)!==stable(group.context) || prior.model!==group.model || group.actionIds.some(id=>!prior.actionIds.includes(id)) || (group.savedRecordId&&prior.savedRecordId!==group.savedRecordId)) { conflict=new Error(`Conflicting groups entry: ${group.id}`); tx.abort(); }
              return;
            }
            tx.objectStore('groups').add({...group,candidate:null});
            tx.objectStore('meta').put({id:`import-group:${group.id}`,at:new Date().toISOString()});
          };
        }
        if (restoreSettings) tx.objectStore('meta').put({id:'settings',...backup.settings});
        tx.oncomplete=()=>resolve(); tx.onabort=()=>reject(conflict||tx.error||new Error('Import failed.')); tx.onerror=()=>{};
      });
    }
    /** Delete one stored session and its history together. @param {string} sessionId @returns {Promise<void>} */
    deleteSession(sessionId) {
      return new Promise((resolve,reject)=>{
        const tx=this.db.transaction(['records','sessions','groups','meta'],'readwrite');
        tx.objectStore('sessions').delete(sessionId);
        const cursor=tx.objectStore('records').index('sessionId').openCursor(IDBKeyRange.only(sessionId));
        cursor.onsuccess=()=>{
          const row=cursor.result;
          if (!row) return;
          tx.objectStore('meta').delete(`import:${row.primaryKey}`); row.delete(); row.continue();
        };
        const groups=tx.objectStore('groups').index('sessionId').openCursor(IDBKeyRange.only(sessionId));
        groups.onsuccess=()=>{
          const row=groups.result;
          if (!row) return;
          tx.objectStore('meta').delete(`import-group:${row.primaryKey}`); row.delete(); row.continue();
        };
        tx.oncomplete=()=>resolve(); tx.onabort=()=>reject(tx.error||new Error('Deletion failed.')); tx.onerror=()=>{};
      });
    }
  }

  // Node exercises the shipped core and storage without starting WME integration.
  if (typeof module!=='undefined' && module.exports) {
    module.exports={createGeometryTools,validateBackup,mergeRecords,Recorder,HistoryStore,validGeometry,stable};
    return;
  }

  /**
   * Boundary message processor, usable in a worker or scheduled fallback.
   * @param {{onmessage:((event:MessageEvent<{request:number,size:number,remove:string[],add:{id:string,geometries:Geometry[]}[]}>)=>void)|null,postMessage:(message:unknown)=>void}} [host]
   */
  function boundaryWorker(host=self) {
    // The worker owns derived tile contributions, leaving stored evidence unchanged.
    const tools=createGeometryTools();
    /** @type {Map<string,Set<string>>} */
    const contributions=new Map();
    /** @type {Map<string,number>} */
    const counts=new Map();
    /** @type {Map<string,string>} */
    const errors=new Map();
    let size=300;
    /** @param {MessageEvent<{request:number,size:number,remove:string[],add:{id:string,geometries:Geometry[]}[]}>} event */
    host.onmessage=(event)=>{
      const message=event.data;
      try {
        if (message.size!==size) { contributions.clear(); counts.clear(); errors.clear(); size=message.size; }
        for (const id of message.remove) {
          for (const cell of contributions.get(id)||[]) { const n=(counts.get(cell)||0)-1; if(n) counts.set(cell,n); else counts.delete(cell); }
          contributions.delete(id); errors.delete(id);
        }
        for (const row of message.add) {
          if (contributions.has(row.id)) continue;
          try {
            const cells=new Set(row.geometries.flatMap(g=>Array.from(tools.geometryCells(g,size))));
            let additions=0;for(const cell of cells)if(!counts.has(cell))additions++;
            if (counts.size+additions>250000) throw new Error('Boundary limit reached. Narrow the date filter or increase tile size.');
            contributions.set(row.id,cells);
            for (const cell of cells) counts.set(cell,(counts.get(cell)||0)+1);
            errors.delete(row.id);
          } catch(error) { errors.set(row.id,error instanceof Error?error.message:String(error)); }
        }
        const polygons=tools.cellsToPolygons(new Set(counts.keys()),size);
        host.postMessage({request:message.request,polygons,cells:counts.size,errors:Array.from(errors.entries())});
      } catch(error) { host.postMessage({request:message.request,error:error instanceof Error?error.message:String(error)}); }
    };
  }

  /**
   * Mount the UI, read models, and subscribe to SDK events. WME edits are never changed.
   * @param {WmeSDK} sdk
   */
  async function startApp(sdk) {
    const {tabLabel,tabPane}=await sdk.Sidebar.registerScriptTab();
    tabLabel.textContent='Edited Boundary';
    const store=await HistoryStore.open();
    const user=sdk.State.getUserInfo();
    /** @type {Context} Identity and environment are preserved on every record. */
    const context={editor:user?.userName||'unknown',region:sdk.Settings.getRegionCode()||'unknown',environment:sdk.isBetaEnvironment()?'beta':'production'};
    /** @type {Session} Each document has an independent automatic session. */
    const session={id:crypto.randomUUID(),context,startedAt:new Date().toISOString(),endedAt:null,status:'waiting',gaps:[]};
    /** @type {Entry[]} */
    let records=await store.all('records');
    /** @type {Session[]} */
    let sessions=await store.all('sessions');
    /** @type {WorkGroup[]} */
    let groups=await store.all('groups');
    /** @type {{id:string,size?:number,visible?:boolean,at?:string}[]} */
    let metadata=await store.all('meta');
    let importedIds=new Set(metadata.filter(m=>m.id.startsWith('import:')).map(m=>m.id.slice(7)));
    let importedGroupIds=new Set(metadata.filter(m=>m.id.startsWith('import-group:')).map(m=>m.id.slice(13)));
    const savedSettings=metadata.find(m=>m.id==='settings');
    /** @type {Settings} */
    let settings={size:savedSettings?.size&&savedSettings.size>=50&&savedSettings.size<=5000?savedSettings.size:300,visible:savedSettings?.visible??true};
    // A reload can identify its previous session without interrupting another tab.
    const priorSessionId=sessionStorage.getItem('wme-edited-boundary-session');
    const priorSession=sessions.find(s=>s.id===priorSessionId&&!s.endedAt);
    if (priorSession) { priorSession.status='interrupted'; priorSession.endedAt=new Date().toISOString(); await store.put('sessions',[priorSession]); }
    sessionStorage.setItem('wme-edited-boundary-session',session.id);
    sessions.push(session); await store.put('sessions',[session]);

    /** @type {Promise<void>} Serialized storage work preserves event order. */
    let writes=Promise.resolve();
    /** @type {Entry[]} Volatile retry queue retained until successful database commit. */
    const unsavedLocal=[];
    /** @typedef {{record:Entry|null,group:WorkGroup,actions:Entry[]}} WorkWrite */
    /** @type {Map<string,WorkWrite>} Latest full journal updates retained for retries. */
    const workWrites=new Map();
    /** @type {Map<string,WorkWrite>} Synchronous same-tab receipts, cleared after commit. */
    const receipts=new Map();
    const receiptKey=`wme-edited-boundary-receipts:${stable(context)}`;
    let storageFailed=false;
    let closed=false;
    let ready=false;
    let mounted=false;
    let updating=false;
    let cellCount=0;
    let workerGeneration=0;
    let renderTimer=0;
    let cacheTimer=0;
    let historyLimit=100;
    /** @type {Polygon[]} */
    let outlines=[];
    /** @type {Map<string,string>} */
    let boundaryErrors=new Map();
    /** @type {Map<string,Snapshot>} Last clean model observations, bounded independently of pending work. */
    const cache=new Map();
    /** @type {Set<string>} Models with successfully registered SDK tracking. */
    const tracked=new Set();
    /** @type {Map<string,Promise<Geometry|null>>} Deduplicated current segment lookups. */
    const lookups=new Map();
    /** @type {Set<string>} Record IDs sent to the geometry worker for the current filter. */
    let renderedIds=new Set();
    let renderedSize=settings.size;
    /** @type {(()=>void)[]} */
    const cleanups=[];
    const layerName='wme-edited-boundary';
    // Channel messages signal other tabs to reload committed local history only.
    const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('wme-edited-boundary'):null;

    /** @param {string} tag @param {string} [text] @returns {HTMLElement} */
    const element=(tag,text='')=>{const e=document.createElement(tag);e.textContent=text;return e;};
    /** @param {string} text @param {()=>void|Promise<void>} action */
    const button=(text,action)=>{
      const e=document.createElement('button'); e.type='button'; e.textContent=text;
      e.addEventListener('click',()=>{Promise.resolve().then(action).catch(showError);}); return e;
    };
    /** @param {string} label @param {[string,string][]} options */
    const select=(label,options)=>{
      const wrapper=element('label',label);const control=document.createElement('select');control.setAttribute('aria-label',label);
      for(const [value,text] of options){const option=document.createElement('option');option.value=value;option.textContent=text;control.append(option);}
      wrapper.append(control);filters.append(wrapper);control.onchange=()=>{historyLimit=100;requestRender();};return control;
    };
    const root=element('section');root.className='weboundary';
    const style=document.createElement('style');style.textContent=`
      .weboundary{font:13px/1.5 system-ui,sans-serif;color:inherit;padding:12px;max-width:100%;box-sizing:border-box}
      .weboundary *{box-sizing:border-box}.weboundary h2{font-size:18px;margin:0 0 6px}.weboundary h3{font-size:14px;margin:14px 0 5px}
      .weboundary p{margin:5px 0 10px}.weboundary label{display:block;margin:7px 0}.weboundary input,.weboundary select{max-width:100%;padding:5px;border:1px solid #99a3ac;border-radius:4px;color:inherit;background:transparent}
      .weboundary select,.weboundary input[type=date]{display:block;width:100%}.weboundary button{font:inherit;padding:5px 9px;margin:3px 5px 3px 0;border:1px solid #78909c;border-radius:4px;cursor:pointer;background:#edf7fa;color:#183b47}.weboundary button:disabled{opacity:.5;cursor:default}
      .weboundary .notice{padding:8px;border-left:3px solid #b06a00;background:#ffbd441a;white-space:pre-wrap}.weboundary .filters{display:grid;grid-template-columns:1fr 1fr;gap:0 8px}.weboundary .record{border-top:1px solid #9996;padding:8px 0;overflow-wrap:anywhere}.weboundary small{display:block;opacity:.8}
      .weboundary details{margin:10px 0}.weboundary summary{cursor:pointer}.weboundary input[type=number]{width:100px;margin-right:6px}.weboundary .status{font-weight:600}.weboundary .error{color:#b32b14}.weboundary progress{width:100%}
      .weboundary .session-controls{grid-column:1/-1}.weboundary button.delete-session{display:block;color:#b32b14;text-decoration:underline;background:transparent;border:0;padding:2px 0;margin:4px 0;text-align:left}.weboundary button.delete-session:focus-visible{outline:2px solid currentColor;outline-offset:3px}.weboundary .actions{padding:4px 0 0 12px;border-left:2px solid #9995}.weboundary .outcome{font-weight:600}.weboundary .history-note{margin:4px 0 10px}.weboundary .record>summary{overflow-wrap:anywhere}
    `;
    root.append(style,element('h2','Edited Boundary'));
    const status=element('p');status.className='status';status.setAttribute('role','status');root.append(status);
    const intro=element('p','Outlines show approximate areas containing confirmed saved work. Tracking continues when the outline is hidden.');root.append(intro);
    const summary=element('p');root.append(summary);
    const errorBox=element('p');errorBox.className='notice error';errorBox.hidden=true;errorBox.setAttribute('role','alert');root.append(errorBox);
    const warning=element('p');warning.className='notice';root.append(warning);
    const visibleLabel=element('label');const visible=document.createElement('input');visible.type='checkbox';visible.checked=settings.visible;visibleLabel.append(visible,document.createTextNode(' Show boundary'));root.append(visibleLabel);
    visible.onchange=()=>{settings.visible=visible.checked;sdk.Map.setLayerVisibility({layerName,visibility:settings.visible});saveSettings();};
    const sizeLabel=element('label','Approximate tile size, metres ');const sizeInput=document.createElement('input');sizeInput.type='number';sizeInput.min='50';sizeInput.max='5000';sizeInput.step='1';sizeInput.value=String(settings.size);
    const applySize=button('Apply',()=>{const n=Number(sizeInput.value);if(!Number.isFinite(n)||n<50||n>5000)throw new Error('Choose a tile size between 50 and 5,000 metres.');settings.size=n;saveSettings();requestRender();});
    sizeLabel.append(sizeInput,applySize);root.append(sizeLabel);
    const localSize=element('small');root.append(localSize);
    const historySection=element('section');historySection.className='history-section';historySection.append(element('h3','History'));root.append(historySection);
    const filters=element('div');filters.className='filters';historySection.append(filters);
    const periodStartLabel=element('label','From');const from=document.createElement('input');from.type='date';periodStartLabel.append(from);filters.append(periodStartLabel);
    const periodEndLabel=element('label','Through');const through=document.createElement('input');through.type='date';periodEndLabel.append(through);filters.append(periodEndLabel);
    from.onchange=through.onchange=()=>{historyLimit=100;requestRender();};
    const category=select('Object',[['','All objects'],['segment','Road segments'],['venue','Places'],['node','Nodes'],['roadClosure','Road closures'],['houseNumber','House numbers'],['mapComment','Map comments'],['other','Other objects']]);
    const operation=select('Work type',[['','All operations'],['addition','Addition'],['edit','Edit'],['deletion','Deletion'],['unknown','Unknown'],['undo','Undo observed']]);
    const resultFilter=select('Status (history only)',[['','All'],['saved','Saved'],['pending','Pending'],['undone','Undone'],['interrupted','Interrupted/unconfirmed']]);
    const sourceFilter=select('Source',[['','Local and imported'],['local','Local'],['imported','Imported']]);
    const sessionFilter=select('Session',[['','All sessions']]);
    const deleteSessionButton=button('Delete selected session',deleteSelectedSession);deleteSessionButton.className='delete-session';deleteSessionButton.disabled=true;
    const sessionControls=element('div');sessionControls.className='session-controls';const sessionLabel=sessionFilter.parentElement;if(sessionLabel){sessionLabel.replaceWith(sessionControls);sessionControls.append(sessionLabel,deleteSessionButton);}
    sessionFilter.onchange=()=>{historyLimit=100;updateDeleteState();requestRender();};
    const historyNote=element('small','Status filters history only. The boundary includes saved outcomes matching the other filters.');historyNote.className='history-note';historySection.append(historyNote);
    const progress=document.createElement('progress');progress.hidden=true;historySection.append(progress);
    const transfer=element('div');root.append(element('h3','Import and export'),transfer);
    const restoreLabel=element('label');const restoreSettings=document.createElement('input');restoreSettings.type='checkbox';restoreLabel.append(restoreSettings,document.createTextNode(' Restore display settings when importing'));transfer.append(restoreLabel);
    const importInput=document.createElement('input');importInput.type='file';importInput.accept='.json,application/json';importInput.hidden=true;transfer.append(importInput);
    transfer.append(button('Import backup',()=>importInput.click()),button('Export backup',exportBackup),button('Export GeoJSON',exportGeoJSON));
    const retryButton=button('Retry local storage',retryStorage);retryButton.hidden=true;root.append(retryButton);
    const support=element('details');support.append(element('summary','Coverage support and limitations'));
    const supportBody=element('div');support.append(supportBody);root.append(support);
    supportBody.append(element('p','Saved outcomes use object confirmation or a successful save followed by a clean editor for tracked map work. Refresh alone does not confirm a save. Suggestions remain separate.'));
    supportBody.append(element('p','Roads, nodes, places, map comments, junction boxes, road closures and other tracked models: capture with individual saved evidence. Deletion needs a cached prior location and a saved notification.'));
    supportBody.append(element('p','House numbers, turns, turn closures, requests/comments, suggestions, hazards and other workflows may lack enough passive SDK evidence. Observable activity is retained, but unconfirmed work does not create outlines.'));
    const gapsList=element('div');supportBody.append(gapsList);
    const history=element('div');history.className='history-results';historySection.append(history);
    const more=button('Show 100 more',()=>{historyLimit+=100;drawHistory();});historySection.append(more);
    tabPane.append(root);

    /** @param {unknown} error */
    function showError(error) { errorBox.hidden=false;errorBox.textContent=error instanceof Error?error.message:String(error);console.error('[Edited Boundary]',error); }
    /** Record a category-level gap without inventing a number of missed edits. @param {string} message */
    function gap(message) {
      if (!session.gaps.includes(message)) {session.gaps.push(message);queue(()=>store.put('sessions',[session]));}
      drawStatus();
    }
    /** @param {()=>Promise<void>} job */
    function queue(job) {
      writes=writes.then(job).catch(error=>{storageFailed=true;showError(error);retryButton.hidden=false;drawStatus();});
    }
    function saveSettings(){queue(()=>store.put('meta',[{id:'settings',...settings}]));}
    /** @param {WorkGroup} group */
    function updateGroup(group){const i=groups.findIndex(g=>g.id===group.id);if(i<0)groups.push(group);else groups[i]=group;}
    /** @param {Entry} record */
    function addRecord(record){if(!records.some(r=>r.id===record.id))records.push(record);}
    function flushReceipts(){if(receipts.size)sessionStorage.setItem(receiptKey,JSON.stringify(Array.from(receipts.values())));else sessionStorage.removeItem(receiptKey);}
    /** @param {WorkWrite} job */
    async function commitWork(job){
      await store.commitWork(job.record,job.group,job.actions);
      const committed=new Set(job.actions.map(r=>r.id));if(job.record)committed.add(job.record.id);
      for(let i=unsavedLocal.length-1;i>=0;i--)if(committed.has(unsavedLocal[i].id))unsavedLocal.splice(i,1);
      if(job.record)addRecord(job.record);
      if(workWrites.get(job.group.id)===job){updateGroup(job.group);workWrites.delete(job.group.id);}
      if(job.group.state==='saved'&&receipts.get(job.group.id)?.record?.id===job.record?.id){receipts.delete(job.group.id);flushReceipts();}
      requestRender();channel?.postMessage('history');
    }
    /** @param {Entry|null} record @param {WorkGroup} group */
    function writeWork(record,group){
      const actionIds=new Set(group.actionIds);
      const job={record,group:structuredClone(group),actions:records.filter(r=>actionIds.has(r.id))};
      workWrites.set(group.id,job);
      // A receipt is written before yielding, so a normal page refresh can replay
      // confirmation even when the IndexedDB transaction has not completed yet.
      if(record?.kind==='saved'){
        receipts.set(group.id,job);
        try{flushReceipts();}catch(error){storageFailed=true;retryButton.hidden=false;showError(new Error(`Save recovery receipt could not be stored: ${String(error)}`));}
      }else updateGroup(job.group);
      queue(()=>commitWork(job));requestRender();
    }
    /** @param {Entry} record @param {WorkGroup} [group] */
    function append(record,group) {
      record.sessionId=session.id;record.context={...context};
      addRecord(record);unsavedLocal.push(record);
      if(group)writeWork(null,group);
      else queue(async()=>{await store.put('records',[record]);const i=unsavedLocal.indexOf(record);if(i>=0)unsavedLocal.splice(i,1);channel?.postMessage('history');});
      requestRender();
    }
    function retryStorage(){
      queue(async()=>{
        await store.put('sessions',[session]);
        for(const job of Array.from(workWrites.values()))await commitWork(job);
        await store.put('records',unsavedLocal.slice());unsavedLocal.splice(0);flushReceipts();
        storageFailed=false;retryButton.hidden=true;errorBox.hidden=true;drawStatus();channel?.postMessage('history');
      });return writes;
    }
    const recorder=new Recorder({context,sessionId:session.id,onActivity:append,onGroup:group=>writeWork(null,group),onSaved:(record,group)=>{
      if(!group)throw new Error('Saved work is missing its history group.');
      writeWork(record,group);if(!record.geometry)gap(`${record.objectType}: saved work has no established location.`);
    }});
    async function recoverWork(){
      try{
        const raw=sessionStorage.getItem(receiptKey);
        if(raw){
          const pending=JSON.parse(raw);if(!Array.isArray(pending))throw new Error('Invalid local save recovery receipt.');
          for(const value of pending){
            const previous=sessions.find(s=>s.id===value?.group?.sessionId);
            if(!previous||stable(previous.context)!==stable(context)||importedGroupIds.has(value?.group?.id))throw new Error('Save recovery receipt belongs to an unknown session.');
            const checked=validateBackup({format:'wme-edited-boundary',version:2,exportedAt:new Date().toISOString(),settings,sessions:[previous],records:[...(value.actions||[]),value.record],groups:[value.group]});
            const group=checked.groups?.[0],record=checked.records.find(r=>r.kind==='saved');
            if(!group||group.state!=='saved'||!record)throw new Error('Save recovery receipt has no confirmed outcome.');
            const job={group,record,actions:checked.records.filter(r=>r.kind==='activity')};receipts.set(group.id,job);workWrites.set(group.id,job);
          }
          for(const job of Array.from(receipts.values()))await commitWork(job);
          records=mergeRecords(/** @type {Entry[]} */(await store.all('records')),unsavedLocal);groups=await store.all('groups');
        }
      }catch(error){storageFailed=true;retryButton.hidden=false;showError(error);}
      for(const group of groups.filter(g=>g.sessionId===priorSessionId&&g.state==='pending'&&!importedGroupIds.has(g.id)&&stable(g.context)===stable(context))){
        if(receipts.has(group.id))continue;
        const interrupted={...group,state:/** @type {const} */('interrupted'),candidate:null,message:'The page closed before save confirmation was received.',updatedAt:new Date().toISOString()};
        updateGroup(interrupted);queue(()=>store.commitWork(null,interrupted));
      }
    }
    await recoverWork();

    /** @typedef {{type:string,model:import('wme-sdk-typings').DataModelName|null,read:(id:string|number)=>unknown,all:()=>unknown[], geographic:boolean}} Reader */
    /** Explicit SDK adapters prevent guessed function names or access to WME internals. @type {Reader[]} */
    const readers=[
      {type:'segment',model:'segments',read:id=>sdk.DataModel.Segments.getById({segmentId:Number(id)}),all:()=>sdk.DataModel.Segments.getAll(),geographic:true},
      {type:'node',model:'nodes',read:id=>sdk.DataModel.Nodes.getById({nodeId:Number(id)}),all:()=>sdk.DataModel.Nodes.getAll(),geographic:true},
      {type:'venue',model:'venues',read:id=>sdk.DataModel.Venues.getById({venueId:String(id)}),all:()=>sdk.DataModel.Venues.getAll(),geographic:true},
      {type:'mapComment',model:'mapComments',read:id=>sdk.DataModel.MapComments.getById({mapCommentId:String(id)}),all:()=>sdk.DataModel.MapComments.getAll(),geographic:true},
      {type:'bigJunction',model:'bigJunctions',read:id=>sdk.DataModel.BigJunctions.getById({bigJunctionId:Number(id)}),all:()=>sdk.DataModel.BigJunctions.getAll(),geographic:true},
      {type:'roadClosure',model:'roadClosures',read:id=>sdk.DataModel.RoadClosures.getById({roadClosureId:String(id)}),all:()=>sdk.DataModel.RoadClosures.getAll(),geographic:true},
      {type:'mapUpdateRequest',model:'mapUpdateRequests',read:id=>sdk.DataModel.MapUpdateRequests.getById({mapUpdateRequestId:Number(id)}),all:()=>sdk.DataModel.MapUpdateRequests.getAll(),geographic:true},
      {type:'mapProblem',model:'mapProblems',read:id=>sdk.DataModel.MapProblems.getById({mapProblemId:String(id)}),all:()=>sdk.DataModel.MapProblems.getAll(),geographic:true},
      {type:'city',model:'cities',read:id=>sdk.DataModel.Cities.getById({cityId:Number(id)}),all:()=>sdk.DataModel.Cities.getAll(),geographic:false},
      {type:'street',model:'streets',read:id=>sdk.DataModel.Streets.getById({streetId:Number(id)}),all:()=>sdk.DataModel.Streets.getAll(),geographic:false},
      {type:'country',model:'countries',read:id=>sdk.DataModel.Countries.getById({countryId:Number(id)}),all:()=>sdk.DataModel.Countries.getAll(),geographic:false},
      {type:'state',model:'states',read:id=>sdk.DataModel.States.getById({stateId:Number(id)}),all:()=>sdk.DataModel.States.getAll(),geographic:false},
      {type:'majorTrafficEvent',model:'majorTrafficEvents',read:id=>sdk.DataModel.MajorTrafficEvents.getById({majorTrafficEventId:String(id)}),all:()=>sdk.DataModel.MajorTrafficEvents.getAll(),geographic:false},
      {type:'segmentSuggestion',model:null,read:id=>sdk.DataModel.SegmentSuggestions.getById({segmentSuggestionId:Number(id)}),all:()=>sdk.DataModel.SegmentSuggestions.getAll(),geographic:true},
      {type:'turnClosure',model:null,read:id=>sdk.DataModel.TurnClosures.getById({turnClosureId:String(id)}),all:()=>sdk.DataModel.TurnClosures.getAll(),geographic:true},
      {type:'permanentHazard',model:null,read:id=>sdk.DataModel.PermanentHazards.getById({hazardId:Number(id)}),all:()=>sdk.DataModel.PermanentHazards.getAll(),geographic:true},
      {type:'restrictedDrivingArea',model:null,read:id=>sdk.DataModel.RestrictedDrivingAreas.getById({restrictedDrivingAreaId:Number(id)}),all:()=>sdk.DataModel.RestrictedDrivingAreas.getAll(),geographic:true}
    ];
    const byType=new Map(readers.map(r=>[r.type,r]));
    const byModel=new Map(readers.filter(r=>r.model).map(r=>[String(r.model),r]));
    const mainSaveModels=new Set(['segments','nodes','venues','mapComments','bigJunctions']);
    /** @type {Map<string,{model:string,id:string|number,final:Snapshot|null,revision:number|undefined}>} */
    const objectConfirmations=new Map();

    /** Strip host metadata from the comparison without changing the host object. @param {Record<string,unknown>} raw */
    function fingerprint(raw) {
      const copy={...raw};
      for(const k of ['id','oldId','modificationData','createdBy','createdOn','updatedBy','updatedOn','isSelected','isDeleted','isUnchanged'])delete copy[k];
      return stable(copy);
    }
    /** Read direct or documented related geometry and retain a serializable snapshot. @param {Reader} reader @param {string|number} id @param {unknown} [supplied] @returns {Snapshot|null} */
    function snapshot(reader,id,supplied) {
      try {
        const raw=supplied===undefined?reader.read(id):supplied;
        if(!object(raw))return null;
        /** @type {Geometry|null} */
        let geometry=reader.geographic&&validGeometry(raw.geometry)?structuredClone(raw.geometry):null;
        let source=geometry?'direct':'unlocated';
        if(!geometry&&reader.geographic){
          const ids=[raw.segmentId,raw.fromSegmentId,raw.toSegmentId].filter(v=>typeof v==='number');
          const lines=ids.map(segmentId=>sdk.DataModel.Segments.getById({segmentId:Number(segmentId)})?.geometry).filter(g=>g!==undefined);
          if(lines.length){geometry=lines.length===1?structuredClone(lines[0]):{type:'MultiLineString',coordinates:lines.map(g=>structuredClone(g.coordinates))};source='related segment';}
        }
        let isNew=false,isDeleted=false;
        if(reader.model){isNew=sdk.DataModel.isNew({dataModelName:reader.model,objectId:id});isDeleted=sdk.DataModel.isDeleted({dataModelName:reader.model,objectId:id});}
        return {model:reader.model||reader.type,objectType:reader.type,objectId:id,geometry,isNew,isDeleted,fingerprint:fingerprint(raw),locationSource:source};
      }catch(error){console.debug('[Edited Boundary] Snapshot unavailable',reader.type,id,error);return null;}
    }
    /** Cache only unchanged objects; pending candidates pin their own prior snapshots. */
    function seedCache() {
      for(const reader of readers){
        if(!reader.model)continue;
        try{for(const raw of reader.all()){
          if(!object(raw)||(typeof raw.id!=='number'&&typeof raw.id!=='string'))continue;
          const key=recorder.key(reader.model,raw.id);
          if(recorder.pending.has(key))continue;
          const s=snapshot(reader,raw.id,raw);
          if(s&&!s.isNew&&!s.isDeleted){cache.delete(key);cache.set(key,s);}
        }}catch(error){gap(`${reader.type}: cached geometry is incomplete.`);}
      }
      while(cache.size>20000){const oldest=cache.keys().next().value;if(oldest===undefined)break;cache.delete(oldest);}
    }
    /** @returns {boolean} */
    function cleanState(){return sdk.Editing.getUnsavedChangesCount()===0&&sdk.Editing.getRedoChangesCount()===0;}
    function mayArm(){
      if(closed||ready)return;
      if(sdk.Editing.isPracticeModeOn()||sdk.Editing.isSnapshotModeOn()||sdk.Editing.getCurrentSaveMode()==='SUGGESTING')return;
      if(!cleanState())return;
      seedCache();ready=true;recorder.setArmed(true);session.status='tracking';queue(()=>store.put('sessions',[session]));drawStatus();
    }
    /** @param {{affectedObjects:{objectType:string,objectId:string|number|null}[]}} event */
    function afterEdit(event){
      if(closed)return;
      objectConfirmations.clear();
      if(!ready){gap('Editing began before a clean baseline was available. This initial batch is excluded.');return;}
      if(sdk.Editing.getCurrentSaveMode()==='SUGGESTING'){gap('Suggestion work is observed separately and is not confirmed map editing.');return;}
      for(const affected of event.affectedObjects){
        const reader=byType.get(affected.objectType);
        if(affected.objectId===null){gap(`${affected.objectType}: SDK supplied no object ID.`);continue;}
        const model=reader?.model||affected.objectType;
        const key=recorder.key(model,affected.objectId);
        const baseline=cache.get(key);
        const s=reader?snapshot(reader,affected.objectId):null;
        if(!reader||!reader.model||!tracked.has(reader.model)){
          const activity=recorder.entry(s||{model,objectType:affected.objectType,objectId:affected.objectId,geometry:null,isNew:false,isDeleted:false,fingerprint:'',locationSource:'unlocated'},'activity','unknown','confirmation unavailable',s?.geometry||null,null);
          append(activity);gap(`${affected.objectType}: passive save confirmation is unavailable.`);continue;
        }
        const current=s||{model,objectType:affected.objectType,objectId:affected.objectId,geometry:null,isNew:false,isDeleted:false,fingerprint:'unavailable',locationSource:'unlocated',classificationKnown:false};
        current.baselineFingerprint=baseline?.fingerprint;current.baselineGeometry=baseline?.geometry??null;
        const token=recorder.observe(current);
        if(!s)gap(`${affected.objectType}: current state is unavailable; operation type is unknown.`);
        if(token&&!current.geometry&&reader.type==='segment'&&!current.isNew&&!current.isDeleted&&Number(affected.objectId)>0)void resolveSegment(token,Number(affected.objectId));
      }
      drawStatus();
    }
    /** Bounded read queue for unloaded segments; retrieved geometry never proves persistence. @param {Token} token @param {number} segmentId */
    async function resolveSegment(token,segmentId){
      const key=String(segmentId);
      while(lookups.size>=2&&!lookups.has(key)){await new Promise(resolve=>setTimeout(resolve,100));if(closed||recorder.pending.get(token.key)?.revision!==token.revision)return;}
      let lookup=lookups.get(key);
      if(!lookup){lookup=sdk.DataModel.Segments.findSegment({segmentId}).then(s=>validGeometry(s.geometry)?structuredClone(s.geometry):null).catch(()=>null);lookups.set(key,lookup);}
      const geometry=await lookup;lookups.delete(key);
      if(geometry)recorder.resolve(token,geometry,'SDK segment lookup');else gap('Some affected segments could not be located.');
    }
    /** Only listed object IDs can become confirmed work. Capture final state synchronously. @param {{dataModelName:string,objectIds:(string|number)[]}} event */
    function objectsSaved(event){
      if(!ready||closed)return;
      const reader=byModel.get(event.dataModelName);if(!reader)return;
      console.debug('[Edited Boundary] object save',event.dataModelName,event.objectIds);
      for(const id of event.objectIds){
        const key=recorder.key(event.dataModelName,id);const c=recorder.pending.get(key);
        const final=snapshot(reader,id);
        // Main-editor saves can notify before the edit counters reset. Waiting for
        // clean state also prevents a delayed duplicate from confirming a newer edit.
        if(mainSaveModels.has(event.dataModelName)&&!cleanState()){
          objectConfirmations.set(key,{model:event.dataModelName,id,final,revision:c?.revision});continue;
        }
        // A deleted object may no longer be readable, but must have prior deleted-state evidence.
        if(c&&!final&&!c.snapshot.isDeleted&&!c.snapshot.geometry)gap(`${reader.type}: confirmed saved work has no established location.`);
        if(recorder.saved(event.dataModelName,id,final||undefined)&&final&&!final.isDeleted)cache.set(key,final);
      }
      drawStatus();
    }
    function reconcileSave(){
      if(!ready||closed)return;
      if(cleanState()){
        for(const [key,evidence] of objectConfirmations){
          objectConfirmations.delete(key);const reader=byModel.get(evidence.model);
          recorder.saved(evidence.model,evidence.id,evidence.final||undefined,evidence.revision);
          if(reader){const final=snapshot(reader,evidence.id);if(final&&!final.isDeleted)cache.set(recorder.key(evidence.model,evidence.id),final);}
        }
      }
      const confirmed=recorder.reconcileSuccessfulSave(cleanState(),(model,id)=>{const reader=byModel.get(model);return reader?snapshot(reader,id):null;},mainSaveModels);
      if(confirmed){console.debug('[Edited Boundary] successful save reconciled',confirmed);seedCache();}
    }

    /** @param {Entry} r */
    function inContext(r){return stable(r.context)===stable(context);}
    /** @param {Entry} r @param {boolean} [boundary] */
    function matches(r,boundary=false){
      if(!inContext(r))return false;
      if(boundary&&r.kind!=='saved')return false;
      if(from.value&&r.at<new Date(`${from.value}T00:00:00`).toISOString())return false;
      if(through.value&&r.at>=new Date(new Date(`${through.value}T00:00:00`).setDate(new Date(`${through.value}T00:00:00`).getDate()+1)).toISOString())return false;
      if(operation.value&&r.operation!==operation.value)return false;
      const known=['segment','venue','node','roadClosure','houseNumber','mapComment'];
      if(category.value==='other'&&known.includes(r.objectType))return false;
      if(category.value&&category.value!=='other'&&r.objectType!==category.value)return false;
      if(sessionFilter.value&&r.sessionId!==sessionFilter.value)return false;
      const imported=importedIds.has(r.id);
      if(sourceFilter.value==='imported'&&!imported||sourceFilter.value==='local'&&imported)return false;
      return true;
    }
    function drawStatus(){
      status.textContent=closed?'Session ended':storageFailed?'Storage error — recent work is held in memory':ready?'Tracking automatically':'Waiting for a clean edit state';
      const rows=historyRows();const pending=rows.filter(r=>r.state==='pending').length;const interrupted=rows.filter(r=>r.state==='interrupted').length;
      summary.textContent=`${records.filter(r=>r.kind==='saved'&&inContext(r)).length.toLocaleString()} saved records · ${pending.toLocaleString()} pending objects · ${interrupted.toLocaleString()} unconfirmed history groups · ${cellCount.toLocaleString()} displayed tiles`;
      warning.textContent='Coverage is incomplete for workflows without SDK save evidence. ' + (session.gaps.length?`${session.gaps.length} coverage notes are listed below. `:'')+(boundaryErrors.size?`${boundaryErrors.size} footprints could not be outlined.`:'');
      gapsList.replaceChildren(...session.gaps.map(g=>element('p',g)),...Array.from(new Set(boundaryErrors.values())).slice(0,10).map(g=>element('p',g)));
      try{const latitude=sdk.Map.getMapCenter().lat;localSize.textContent=`At this latitude: about ${Math.round(settings.size*Math.cos(latitude*Math.PI/180))} metres per tile. Grid edges are approximate.`;}catch{localSize.textContent='Ground distance varies with latitude. Grid edges are approximate.';}
      progress.hidden=!updating;
    }
    function updateSessionChoices(){
      const value=sessionFilter.value;sessionFilter.replaceChildren();const all=document.createElement('option');all.value='';all.textContent='All sessions';sessionFilter.append(all);
      for(const s of sessions.filter(s=>stable(s.context)===stable(context)).sort((a,b)=>b.startedAt.localeCompare(a.startedAt))){const o=document.createElement('option');o.value=s.id;o.textContent=`${new Date(s.startedAt).toLocaleString()}${s.id===session.id?' (current)':''}`;sessionFilter.append(o);}
      sessionFilter.value=value;
      updateDeleteState();
    }
    function updateDeleteState(){deleteSessionButton.disabled=!sessionFilter.value||(sessionFilter.value===session.id&&!closed);}
    /** @typedef {{id:string,entry:Entry,actions:Entry[],state:WorkGroup['state'],message:string}} HistoryRow */
    /** Derive current outcomes without changing immutable activity records. @returns {HistoryRow[]} */
    function historyRows(){
      const byId=new Map(records.map(r=>[r.id,r]));const linked=new Set();
      /** @type {HistoryRow[]} */ const rows=[];
      for(const group of groups){
        if(stable(group.context)!==stable(context))continue;
        const actions=group.actionIds.map(id=>byId.get(id)).filter(r=>r!==undefined);
        const entry=(group.savedRecordId?byId.get(group.savedRecordId):undefined)||actions.at(-1);if(!entry)continue;
        for(const r of actions)linked.add(r.id);if(group.savedRecordId)linked.add(group.savedRecordId);
        const state=group.state==='pending'&&(group.sessionId!==session.id||closed||importedGroupIds.has(group.id))?'interrupted':group.state;
        rows.push({id:group.id,entry:{...entry,objectId:group.objectId},actions,state,message:group.message||(state==='interrupted'?'Save confirmation is unavailable.':'')});
      }
      for(const entry of records){
        if(!inContext(entry)||linked.has(entry.id))continue;
        rows.push({id:entry.id,entry,actions:entry.kind==='activity'?[entry]:[],state:entry.kind==='saved'?'saved':'interrupted',message:entry.kind==='saved'?'':'This historical observation has no linked save confirmation.'});
      }
      return rows;
    }
    /** @param {Entry} record */
    function locationButton(record){
      const geometry=record.geometry||record.beforeGeometry;if(!geometry)return null;
      return button('Show location',()=>{const atomic=geometry.type==='MultiLineString'?{type:'LineString',coordinates:geometry.coordinates[0]}:geometry.type==='MultiPolygon'?{type:'Polygon',coordinates:geometry.coordinates[0]}:geometry;sdk.Map.centerMapOnGeometry({geometry:/** @type {import('geojson').Point|import('geojson').LineString|Polygon} */(atomic)});});
    }
    function drawHistory(){
      const expanded=new Set(Array.from(history.querySelectorAll('details[open]')).map(e=>/** @type {HTMLElement} */(e).dataset.groupId));
      const filtered=historyRows().filter(row=>matches(row.entry)&&(!resultFilter.value||row.state===resultFilter.value)).sort((a,b)=>b.entry.at.localeCompare(a.entry.at));history.replaceChildren();
      const labels={pending:'Pending',saved:'Saved',undone:'Undone',interrupted:'Interrupted/unconfirmed'};
      for(const item of filtered.slice(0,historyLimit)){
        const r=item.entry,row=document.createElement('details');row.className='record';row.dataset.groupId=item.id;row.dataset.state=item.state;row.open=expanded.has(item.id);
        const heading=element('summary');heading.append(element('strong',`${labels[item.state]} · ${r.operation} · ${r.objectType} ${r.objectId}`),element('small',`${new Date(r.at).toLocaleString()} · ${item.actions.length} ${item.actions.length===1?'action':'actions'}${importedIds.has(r.id)?' · imported':''}`),element('small',r.geometry?`Location: ${r.locationSource}`:'Location unavailable'));row.append(heading);
        if(item.message)row.append(element('small',item.message));const show=locationButton(r);if(show)row.append(show);
        const actions=element('div');actions.className='actions';
        for(const action of item.actions){const detail=element('div');detail.append(element('small',`${new Date(action.at).toLocaleString()} · ${action.operation} · ${action.objectType} ${action.objectId}`));actions.append(detail);}
        row.append(actions);history.append(row);
      }
      if(!filtered.length)history.append(element('p','No matching records yet. Make and save a supported edit to create a boundary.'));
      more.hidden=filtered.length<=historyLimit;
    }
    function requestRender(){if(!mounted)return;clearTimeout(renderTimer);renderTimer=window.setTimeout(render,150);}
    /** @type {Worker|null} */
    let worker=null;
    /** @param {MessageEvent} event */
    function receiveBoundary(event){
        /** @type {{request:number,polygons?:Polygon[],cells?:number,errors?:[string,string][],error?:string}} */
        const result=event.data;if(result.request!==workerGeneration)return;
        updating=false;
        if(result.error){outlines=[];cellCount=0;boundaryErrors=new Map([['boundary',result.error]]);try{sdk.Map.removeAllFeaturesFromLayer({layerName});}catch{}showError(result.error);drawStatus();return;}
        outlines=result.polygons||[];cellCount=result.cells||0;boundaryErrors=new Map(result.errors||[]);
        try{
          sdk.Map.removeAllFeaturesFromLayer({layerName});
          const features=outlines.map((geometry,i)=>({type:/** @type {const} */('Feature'),id:`boundary-${i}`,geometry,properties:{kind:'saved boundary'}}));
          for(let i=0;i<features.length;i+=200)sdk.Map.addFeaturesToLayer({layerName,features:features.slice(i,i+200)});
        }catch(error){showError(error);}drawStatus();
    }
    /** @type {NonNullable<Parameters<typeof boundaryWorker>[0]>} */
    const fallback={onmessage:null,postMessage:data=>receiveBoundary(new MessageEvent('message',{data}))};
    boundaryWorker(fallback);
    try{
      const workerUrl=URL.createObjectURL(new Blob([`${createGeometryTools.toString()}\n(${boundaryWorker.toString()})();`],{type:'text/javascript'}));
      worker=new Worker(workerUrl);URL.revokeObjectURL(workerUrl);worker.onmessage=receiveBoundary;
      worker.onerror=()=>{worker?.terminate();worker=null;updating=false;renderedIds.clear();gap('Background processing is unavailable. Boundary calculations use a bounded fallback.');requestRender();};
    }catch(error){gap('Background processing is unavailable. Boundary calculations use a bounded fallback.');}
    function render(){
      clearTimeout(renderTimer);renderTimer=0;
      drawHistory();drawStatus();
      const eligible=records.filter(r=>matches(r,true));
      const ids=new Set(eligible.map(r=>r.id));
      const reset=settings.size!==renderedSize;
      const remove=Array.from(renderedIds).filter(id=>reset||!ids.has(id));
      const add=eligible.filter(r=>reset||!renderedIds.has(r.id)).map(r=>({id:r.id,geometries:[r.geometry,r.operation==='edit'?r.beforeGeometry:null].filter(g=>g!==null)}));
      if(!reset&&!remove.length&&!add.length)return;
      renderedIds=ids;renderedSize=settings.size;updating=true;drawStatus();const message={request:++workerGeneration,size:settings.size,remove,add};
      if(worker)worker.postMessage(message);else window.setTimeout(()=>{if(!closed)fallback.onmessage?.(new MessageEvent('message',{data:message}));},0);
    }
    /** @param {unknown} data @param {string} name */
    function download(data,name){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    async function exportBackup(){
      await writes;
      if(storageFailed)throw new Error('Retry local storage before exporting a complete backup.');
      /** @type {Session[]} */const allSessions=await store.all('sessions');
      /** @type {Entry[]} */const allRecords=await store.all('records');
      /** @type {{id:string,at?:string}[]} */const allMeta=await store.all('meta');
      const recordIds=new Set(allRecords.map(r=>r.id));
      const provenance=allMeta.filter(m=>m.id.startsWith('import:')&&recordIds.has(m.id.slice(7))&&m.at).map(m=>({recordId:m.id.slice(7),importedAt:m.at}));
      const allGroups=/** @type {WorkGroup[]} */(await store.all('groups')).map(g=>({...g,candidate:null}));
      const backup=validateBackup({format:'wme-edited-boundary',version:2,exportedAt:new Date().toISOString(),settings,sessions:allSessions,records:allRecords,groups:allGroups,provenance});
      download(backup,`wme-boundary-backup-${new Date().toISOString().slice(0,10)}.json`);
    }
    function exportGeoJSON(){
      if(renderTimer)render();
      if(updating)throw new Error('Wait for the current boundary to finish updating.');
      download({type:'FeatureCollection',features:outlines.map(geometry=>({type:'Feature',geometry,properties:{editor:context.editor,region:context.region,environment:context.environment,gridSizeMetres:settings.size,from:from.value||null,through:through.value||null,operation:operation.value||null,objectType:category.value||null,sessionId:sessionFilter.value||null,source:sourceFilter.value||'all',coverage:'confirmed saved work; SDK coverage incomplete',excludedFootprints:boundaryErrors.size}}))},`wme-boundary-${new Date().toISOString().slice(0,10)}.geojson`);
    }
    importInput.onchange=()=>{void(async()=>{
      const file=importInput.files?.[0];if(!file)return;
      if(file.size>50*1024*1024)throw new Error('Backup files must be 50 MB or smaller.');
      const backup=validateBackup(JSON.parse(await file.text()));await writes;
      await store.import(backup,restoreSettings.checked);
      records=mergeRecords(/** @type {Entry[]} */(await store.all('records')),unsavedLocal);sessions=await store.all('sessions');metadata=await store.all('meta');groups=await store.all('groups');
      importedIds=new Set(metadata.filter(m=>m.id.startsWith('import:')).map(m=>m.id.slice(7)));
      importedGroupIds=new Set(metadata.filter(m=>m.id.startsWith('import-group:')).map(m=>m.id.slice(13)));
      if(restoreSettings.checked){settings={...backup.settings};visible.checked=settings.visible;sizeInput.value=String(settings.size);sdk.Map.setLayerVisibility({layerName,visibility:settings.visible});}
      updateSessionChoices();requestRender();channel?.postMessage('history');importInput.value='';
    })().catch(showError);};
    async function deleteSelectedSession(){
      const id=sessionFilter.value;if(!id)throw new Error('Choose one session in the Session filter first.');
      if(id===session.id&&!closed)throw new Error('The current automatic session cannot be deleted while tracking.');
      const selected=sessions.find(s=>s.id===id);if(!selected)return;
      if(!confirm(`Delete the stored session from ${new Date(selected.startedAt).toLocaleString()} and its history? This does not change WME edits.`))return;
      await writes;await store.deleteSession(id);records=records.filter(r=>r.sessionId!==id);sessions=sessions.filter(s=>s.id!==id);groups=groups.filter(g=>g.sessionId!==id);
      for(const [key,job] of receipts)if(job.group.sessionId===id)receipts.delete(key);for(const [key,job] of workWrites)if(job.group.sessionId===id)workWrites.delete(key);flushReceipts();
      updateSessionChoices();requestRender();channel?.postMessage('history');
    }

    sdk.Map.addLayer({layerName,styleRules:[{style:{strokeColor:'#007c91',strokeWidth:2,fillColor:'#12aabb',fillOpacity:0.13,pointerEvents:'none'}}]});
    sdk.Map.setLayerVisibility({layerName,visibility:settings.visible});
    for(const reader of readers){if(reader.model){try{sdk.Events.trackDataModelEvents({dataModelName:reader.model});tracked.add(reader.model);}catch(error){gap(`${reader.type}: SDK model tracking unavailable.`);}}}
    const capabilities=document.createElement('table');capabilities.style.cssText='width:100%;font-size:12px;border-collapse:collapse';
    const headings=document.createElement('tr');for(const text of ['Workflow','Location','Save evidence']){const th=document.createElement('th');th.textContent=text;th.style.textAlign='left';headings.append(th);}capabilities.append(headings);
    for(const reader of readers){const row=document.createElement('tr');for(const text of [reader.type,reader.geographic?'Direct or related':'Related objects only',reader.model&&tracked.has(reader.model)?'Object event required':'Unavailable']){const cell=document.createElement('td');cell.textContent=text;cell.style.cssText='vertical-align:top;border-top:1px solid #8885;padding:4px 3px';row.append(cell);}capabilities.append(row);}
    supportBody.insertBefore(capabilities,gapsList);
    cleanups.push(sdk.Events.on({eventName:'wme-after-edit',eventHandler:afterEdit}));
    cleanups.push(sdk.Events.on({eventName:'wme-data-model-objects-saved',eventHandler:objectsSaved}));
    cleanups.push(sdk.Events.on({eventName:'wme-data-model-object-changed-id',eventHandler:event=>{
      const {oldID,newID}=event.objectIds;if(oldID===null||newID===null)return;
      console.debug('[Edited Boundary] object ID remap',event.dataModelName,oldID,newID);
      recorder.remap(event.dataModelName,oldID,newID);const oldKey=recorder.key(event.dataModelName,oldID);const newKey=recorder.key(event.dataModelName,newID);
      const evidence=objectConfirmations.get(oldKey)||objectConfirmations.get(newKey);if(evidence){objectConfirmations.delete(oldKey);objectConfirmations.set(newKey,{...evidence,id:newID,revision:recorder.pending.get(newKey)?.revision});}
      const s=cache.get(oldKey);if(s){cache.delete(oldKey);cache.set(newKey,{...s,objectId:newID});}reconcileSave();
    }}));
    cleanups.push(sdk.Events.on({eventName:'wme-data-model-object-state-deleted',eventHandler:event=>{
      const reader=byModel.get(event.dataModelName);if(!reader)return;
      for(const id of event.objectIds){const c=recorder.pending.get(recorder.key(event.dataModelName,id));if(c){const s=snapshot(reader,id);if(s){c.snapshot={...s,geometry:c.beforeGeometry||s.geometry||c.snapshot.geometry};recorder.publish(c);}}}
    }}));
    cleanups.push(sdk.Events.on({eventName:'wme-after-undo',eventHandler:()=>{
      if(!ready)return;objectConfirmations.clear();recorder.undo();
      append(recorder.entry({model:'editor',objectType:'editor',objectId:'',geometry:null,isNew:false,isDeleted:false,fingerprint:'',locationSource:'unlocated'},'activity','undo','affected objects unavailable',null,null));
      for(const c of Array.from(recorder.pending.values())){const r=byModel.get(c.snapshot.model);if(!r)continue;const s=snapshot(r,c.snapshot.objectId);if(s)recorder.reconcile(s);else gap(`${r.type}: undo result cannot be attributed.`);}
      drawStatus();
    }}));
    cleanups.push(sdk.Events.on({eventName:'wme-no-edits',eventHandler:()=>{mayArm();reconcileSave();drawStatus();}}));
    cleanups.push(sdk.Events.on({eventName:'wme-save-finished',eventHandler:event=>{
      console.debug('[Edited Boundary] save finished',event.success,'pending',recorder.pending.size,'unsaved',sdk.Editing.getUnsavedChangesCount());
      if(event.success){recorder.saveSucceeded();reconcileSave();}else{objectConfirmations.clear();recorder.saveFailed();gap('A save attempt failed. Unconfirmed changes remain pending.');}
      mayArm();drawStatus();
    }}));
    cleanups.push(sdk.Events.on({eventName:'wme-save-mode-changed',eventHandler:event=>{
      if(event.saveMode!=='IDLE'){objectConfirmations.clear();recorder.invalidateSuccessfulSave();}
      if(event.saveMode==='SUGGESTING'){if(recorder.pending.size)gap('Switching to suggestion mode left pending changes unconfirmed.');ready=false;recorder.setArmed(false);}else mayArm();drawStatus();
    }}));
    cleanups.push(sdk.Events.on({eventName:'wme-map-data-loaded',eventHandler:()=>{clearTimeout(cacheTimer);cacheTimer=window.setTimeout(()=>{if(ready){reconcileSave();seedCache();}else mayArm();},200);}}));
    cleanups.push(sdk.Events.on({eventName:'wme-map-move-end',eventHandler:drawStatus}));
    // Dedicated house-number events can preserve observed activity, but supply no parent segment.
    for(const eventName of /** @type {const} */(['wme-house-number-added','wme-house-number-deleted','wme-house-number-updated','wme-house-number-moved'])){
      cleanups.push(sdk.Events.on({eventName,eventHandler:event=>{
        if(!ready||closed)return;
        const op=eventName==='wme-house-number-added'?'addition':eventName==='wme-house-number-deleted'?'deletion':'edit';
        append(recorder.entry({model:'segmentHouseNumbers',objectType:'houseNumber',objectId:event.houseNumberId,geometry:null,isNew:false,isDeleted:false,fingerprint:'',locationSource:'unlocated'},'activity',op,'confirmation unavailable',null,null));gap('House-number events provide no parent segment or reliable saved-object mapping.');
      }}));
    }
    /** @param {'logout'|'pagehide'} reason */
    function end(reason){
      if(closed)return;closed=true;ready=false;objectConfirmations.clear();session.endedAt=new Date().toISOString();session.status='ended';
      if(recorder.pending.size)session.gaps.push('Session ended with unconfirmed observations.');
      recorder.setArmed(false);queue(()=>store.put('sessions',[session]));cleanups.forEach(clean=>clean());
      for(const reader of readers)if(reader.model&&tracked.has(reader.model))try{sdk.Events.stopDataModelEventsTracking({dataModelName:reader.model});}catch{}
      worker?.terminate();channel?.close();clearTimeout(renderTimer);clearTimeout(cacheTimer);drawStatus();
      if(reason==='logout')void sdk.Events.once({eventName:'wme-logged-in'}).then(async()=>{
        await writes;
        try{sdk.Sidebar.removeScriptTab();sdk.Map.removeLayer({layerName});}catch(error){console.debug('[Edited Boundary] Old UI cleanup',error);}
        await startApp(sdk);
      }).catch(showError);
    }
    cleanups.push(sdk.Events.on({eventName:'wme-logged-out',eventHandler:()=>end('logout')}));
    window.addEventListener('pagehide',()=>end('pagehide'),{once:true});
    if(channel)channel.onmessage=()=>{void writes.then(async()=>{records=mergeRecords(/** @type {Entry[]} */(await store.all('records')),unsavedLocal);sessions=await store.all('sessions');metadata=await store.all('meta');groups=await store.all('groups');for(const job of workWrites.values())if(job.group.state!=='saved')updateGroup(job.group);importedIds=new Set(metadata.filter(m=>m.id.startsWith('import:')).map(m=>m.id.slice(7)));importedGroupIds=new Set(metadata.filter(m=>m.id.startsWith('import-group:')).map(m=>m.id.slice(13)));updateSessionChoices();requestRender();}).catch(showError);};
    updateSessionChoices();
    if(!cleanState())gap('The script started with unsaved edits or redo history. Waiting for a clean baseline.');
    mounted=true;mayArm();drawStatus();requestRender();
  }

  /** Start the script only once in this document, without relying on WME page selectors. */
  async function bootstrap() {
    if(!/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?editor\/?$/i.test(location.pathname))return;
    const marker='data-wme-edited-boundary';
    if (document.documentElement.hasAttribute(marker)) return;
    document.documentElement.setAttribute(marker,'loading');
    try {
      // Some userscript injection timings precede publication of SDK_INITIALIZED.
      const deadline=Date.now()+30000;
      while (!window.SDK_INITIALIZED || !window.getWmeSdk) {
        if (Date.now()>deadline) throw new Error('WME SDK is unavailable. Reload WME after it finishes loading.');
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      await window.SDK_INITIALIZED;
      const sdk=window.getWmeSdk({scriptId:'wme-edited-boundary',scriptName:'Edited Boundary'});
      if (!sdk.State.isReady()) await sdk.Events.once({eventName:'wme-ready'});
      await startApp(sdk);
      document.documentElement.setAttribute(marker,'ready');
    } catch(error) {
      document.documentElement.removeAttribute(marker);
      console.error('[Edited Boundary]',error);
      const notice=document.createElement('div');
      notice.setAttribute('role','alert');
      notice.style.cssText='position:fixed;bottom:16px;right:16px;z-index:10000;padding:14px;max-width:360px;background:#fff4e5;color:#402500;border:1px solid #a65f00;border-radius:6px;font:14px sans-serif';
      notice.textContent=`Edited Boundary: ${error instanceof Error?error.message:String(error)}`;
      const close=document.createElement('button'); close.textContent='Dismiss'; close.onclick=()=>notice.remove(); notice.append(close); document.body.append(notice);
    }
  }

  // Browser integration uses SDK-owned containers and documented read/event methods.
  void bootstrap();
})();
