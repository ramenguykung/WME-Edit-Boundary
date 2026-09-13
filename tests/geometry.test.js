"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createGeometryTools } = require("../walker.user.script.js");
const touchingHole = require("./fixtures/touching-hole-300m.json");

const earthRadius = 6378137;

/** Convert independently defined metre coordinates to a GeoJSON position. */
function atMetres(x, y) {
  return [x / earthRadius * 180 / Math.PI, (2 * Math.atan(Math.exp(y / earthRadius)) - Math.PI / 2) * 180 / Math.PI];
}

function line(points) {
  return { type: "LineString", coordinates: points.map(([x, y]) => atMetres(x, y)) };
}

function ringArea(coordinates) {
  const points = coordinates.map(([longitude, latitude]) => [
    longitude * Math.PI / 180 * earthRadius,
    Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)) * earthRadius
  ]);
  let sum = 0;
  for (let index = 1; index < points.length; index += 1) {
    sum += points[index - 1][0] * points[index][1] - points[index][0] * points[index - 1][1];
  }
  return sum / 2;
}

test("Mercator conversion uses metres and round trips a real map position", () => {
  const geometry = createGeometryTools();
  const [x, y] = geometry.project([180, 0]);
  assert.ok(Math.abs(x - Math.PI * earthRadius) < 0.01);
  assert.ok(Math.abs(y) < 0.01);
  const actual = geometry.unproject(geometry.project([100.5018, 13.7563]));
  assert.ok(Math.abs(actual[0] - 100.5018) < 1e-8);
  assert.ok(Math.abs(actual[1] - 13.7563) < 1e-8);
});

test("a long road includes cells between its vertices", () => {
  const cells = createGeometryTools().geometryCells(line([[50, 50], [450, 50]]), 100);
  assert.deepEqual(cells, new Set(["0,0", "1,0", "2,0", "3,0", "4,0"]));
});

test("a diagonal road does not fill its entire bounding rectangle", () => {
  const cells = createGeometryTools().geometryCells(line([[20, 30], [280, 250]]), 100);
  assert.deepEqual(cells, new Set(["0,0", "1,0", "1,1", "2,1", "2,2"]));
});

test("negative grid coordinates use floor rather than truncation", () => {
  const geometry = { type: "Point", coordinates: atMetres(-50, -150) };
  assert.deepEqual(createGeometryTools().geometryCells(geometry, 100), new Set(["-1,-2"]));
});

test("a polygon fills its interior while preserving cells wholly inside a hole", () => {
  const geometry = {
    type: "Polygon",
    coordinates: [
      [[20, 20], [580, 20], [580, 580], [20, 580], [20, 20]].map(([x, y]) => atMetres(x, y)),
      [[120, 120], [120, 480], [480, 480], [480, 120], [120, 120]].map(([x, y]) => atMetres(x, y))
    ]
  };
  const cells = createGeometryTools().geometryCells(geometry, 100);
  assert.equal(cells.size, 32);
  for (const key of ["0,0", "5,5", "1,1", "4,4"]) assert.ok(cells.has(key), key);
  for (const key of ["2,2", "2,3", "3,2", "3,3"]) assert.ok(!cells.has(key), key);
});

test("disconnected geometry does not shade the space between pieces", () => {
  const geometry = { type: "MultiLineString", coordinates: [
    [atMetres(40, 50), atMetres(60, 50)],
    [atMetres(1040, 50), atMetres(1060, 50)]
  ] };
  assert.deepEqual(createGeometryTools().geometryCells(geometry, 100), new Set(["0,0", "10,0"]));
});

test("tile size changes derive a different grid from the same geometry", () => {
  const geometry = createGeometryTools();
  const road = line([[50, 50], [450, 50]]);
  assert.equal(geometry.geometryCells(road, 100).size, 5);
  assert.deepEqual(geometry.geometryCells(road, 300), new Set(["0,0", "1,0"]));
});

test("adjacent cells merge without their internal shared edge", () => {
  const polygons = createGeometryTools().cellsToPolygons(new Set(["0,0", "1,0"]), 100);
  assert.equal(polygons.length, 1);
  assert.equal(polygons[0].type, "Polygon");
  assert.equal(polygons[0].coordinates.length, 1);
  assert.ok(Math.abs(ringArea(polygons[0].coordinates[0]) - 20000) < 0.01);
  assert.deepEqual(polygons[0].coordinates[0][0], polygons[0].coordinates[0].at(-1));
});

test("distant cells produce separate boundary polygons", () => {
  const polygons = createGeometryTools().cellsToPolygons(new Set(["0,0", "10,0"]), 100);
  assert.equal(polygons.length, 2);
  for (const polygon of polygons) assert.ok(Math.abs(ringArea(polygon.coordinates[0]) - 10000) < 0.01);
});

test("diagonally touching cells remain separate valid polygons", () => {
  const polygons = createGeometryTools().cellsToPolygons(new Set(["0,0", "1,1"]), 100);
  assert.equal(polygons.length, 2);
  for (const polygon of polygons) {
    assert.equal(polygon.coordinates.length, 1);
    assert.ok(Math.abs(ringArea(polygon.coordinates[0]) - 10000) < 0.01);
  }
});

test("a ring of worked cells retains its unworked hole", () => {
  const cells = new Set();
  for (let x = 0; x < 3; x += 1) {
    for (let y = 0; y < 3; y += 1) if (x !== 1 || y !== 1) cells.add(`${x},${y}`);
  }
  const polygons = createGeometryTools().cellsToPolygons(cells, 100);
  assert.equal(polygons.length, 1);
  assert.equal(polygons[0].coordinates.length, 2);
  const areas = polygons[0].coordinates.map(ringArea);
  assert.ok(Math.abs(areas[0] - 90000) < 0.01);
  assert.ok(Math.abs(areas[1] + 10000) < 0.01);
  assert.ok(Math.abs(areas.reduce((sum, area) => sum + area, 0) - 80000) < 0.01);
});

test("an empty history produces no boundary", () => {
  assert.deepEqual(createGeometryTools().cellsToPolygons(new Set(), 300), []);
});

test("date-line crossing geometry fails visibly instead of shading most of the world", () => {
  const geometry = { type: "LineString", coordinates: [[179.9, 10], [-179.9, 10]] };
  assert.throws(() => createGeometryTools().geometryCells(geometry, 300), /date line/i);
});

test("excessive geometry work raises a bounded-processing error", () => {
  const geometry = { type: "LineString", coordinates: [[-100, 10], [70, 10]] };
  assert.throws(() => createGeometryTools().geometryCells(geometry, 50), /limit|250,000/i);
});

test("unsupported coordinates and tile sizes cannot produce misleading coverage", () => {
  const geometry = createGeometryTools();
  for (const coordinates of [[181, 0], [0, 90], [NaN, 0], [0, Infinity]]) {
    assert.throws(() => geometry.geometryCells({ type: "Point", coordinates }, 300));
  }
  for (const size of [0, 49, 5001, NaN, Infinity]) {
    assert.throws(() => geometry.geometryCells({ type: "Point", coordinates: [0, 0] }, size));
  }
});

/** Check topology and coverage independently in exact integer grid coordinates. */
function assertGridCoverage(polygons, cells, size) {
  const tools = createGeometryTools();
  const grid = polygons.map(polygon => {
    assert.equal(polygon.type, "Polygon");
    return polygon.coordinates.map(ring => ring.map(point => {
      assert.equal(point.length, 2);
      assert.ok(point.every(Number.isFinite));
      return tools.project(point).map(n => Math.round(n / size));
    }));
  });
  let totalArea = 0;
  const between = (n, a, b) => n >= Math.min(a, b) && n <= Math.max(a, b);
  const onSegment = (p, a, b) => (p[0]-a[0])*(b[1]-a[1]) === (p[1]-a[1])*(b[0]-a[0]) && between(p[0],a[0],b[0]) && between(p[1],a[1],b[1]);
  for (const polygon of grid) for (const [ringIndex, ring] of polygon.entries()) {
    assert.ok(ring.length >= 4);
    assert.deepEqual(ring[0], ring.at(-1));
    assert.equal(new Set(ring.slice(0,-1).map(p => p.join(','))).size, ring.length-1, 'ring cannot self-touch');
    const area = ring.slice(1).reduce((sum,p,i) => sum+ring[i][0]*p[1]-p[0]*ring[i][1],0)/2;
    assert.ok(ringIndex === 0 ? area > 0 : area < 0, 'shell/hole winding');
    totalArea += area;
    for (let i=0;i<ring.length-1;i++) for (let j=i+2;j<ring.length-1;j++) {
      if (i===0 && j===ring.length-2) continue;
      const a=ring[i], b=ring[i+1], c=ring[j], d=ring[j+1];
      const crossing = a[0]===b[0] && c[1]===d[1] && between(a[0],c[0],d[0]) && between(c[1],a[1],b[1]) || a[1]===b[1] && c[0]===d[0] && between(c[0],a[0],b[0]) && between(a[1],c[1],d[1]);
      assert.ok(!crossing && !onSegment(a,c,d) && !onSegment(b,c,d) && !onSegment(c,a,b) && !onSegment(d,a,b), 'nonadjacent edges cannot intersect');
    }
  }
  assert.equal(totalArea, cells.size);
  const inside = (p, ring) => {
    let result=false;
    for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
      const a=ring[i],b=ring[j];
      if ((a[1]>p[1])!==(b[1]>p[1]) && p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) result=!result;
    }
    return result;
  };
  const points=[...cells].map(key=>key.split(',').map(Number));
  for (let x=Math.min(...points.map(p=>p[0]))-1;x<=Math.max(...points.map(p=>p[0]))+1;x++) {
    for (let y=Math.min(...points.map(p=>p[1]))-1;y<=Math.max(...points.map(p=>p[1]))+1;y++) {
      const p=[x+.5,y+.5];
      const owners=grid.filter(polygon=>inside(p,polygon[0])&&!polygon.slice(1).some(ring=>inside(p,ring))).length;
      assert.equal(owners,cells.has(`${x},${y}`)?1:0,`coverage of ${x},${y}`);
    }
  }
}

test("reported 300-metre boundary retains its tangent hole as two simple rings", () => {
  for (const [dx,dy] of [[0,0],[37111,5210],[-120,-80]]) {
    const cells=new Set(touchingHole.cells.map(([x,y])=>`${x+dx},${y+dy}`));
    const polygons=createGeometryTools().cellsToPolygons(cells,touchingHole.size);
    assert.equal(polygons.length,1);
    assert.deepEqual(polygons[0].coordinates.map(r=>r.length),touchingHole.expectedRingLengths);
    assertGridCoverage(polygons,cells,touchingHole.size);
  }
});

test("diagonal holes remain separate and an island keeps its own boundary", () => {
  const diagonal=new Set(),island=new Set();
  for(let x=0;x<5;x++) for(let y=0;y<5;y++) {
    if (!(x===1&&y===1) && !(x===2&&y===2)) diagonal.add(`${x},${y}`);
    if (x===0||x===4||y===0||y===4||x===2&&y===2) island.add(`${x},${y}`);
  }
  const holes=createGeometryTools().cellsToPolygons(diagonal,100);
  assert.equal(holes.length,1);assert.equal(holes[0].coordinates.length,3);
  assertGridCoverage(holes,diagonal,100);
  const islands=createGeometryTools().cellsToPolygons(island,100);
  assert.equal(islands.length,2);
  assertGridCoverage(islands,island,100);
});

test("all nonempty 3-by-3 tile patterns preserve simple rings and exact coverage", () => {
  for (let mask=1;mask<512;mask++) {
    const cells=new Set();
    for(let bit=0;bit<9;bit++) if(mask&(1<<bit)) cells.add(`${bit%3},${Math.floor(bit/3)}`);
    assertGridCoverage(createGeometryTools().cellsToPolygons(cells,100),cells,100);
    const reversed=new Set([...cells].reverse());
    assertGridCoverage(createGeometryTools().cellsToPolygons(reversed,100),reversed,100);
  }
});
