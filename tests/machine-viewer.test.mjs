import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  MACHINE_MODELS,
  createMachineViewState,
  toggleDoor,
  toggleShellVisibility,
  selectComponent,
  switchMachineModel,
  findComponent,
  findMatchingDatabaseParts
} from '../machine-viewer-core.mjs';

const appUrl = new URL('../Warranty App.html', import.meta.url);
const viewerUrl = new URL('../machine-viewer.js', import.meta.url);
const workerUrl = new URL('../sw.js', import.meta.url);
const html = fs.readFileSync(appUrl, 'utf8');
const viewer = fs.readFileSync(viewerUrl, 'utf8');
const worker = fs.readFileSync(workerUrl, 'utf8');
assert.match(html, /v2\.12\.7 · 09-Aug-2026/);

// The 3D feature is Power User-only. Its heavyweight renderer is loaded only
// when an authenticated operator opens it.
assert.match(html, /<button class="tm-item tm-admin" id="btnMachine3D"[^>]*style="display:none;"[^>]*>[\s\S]*?Machine 3D Parts View[\s\S]*?<\/button>/);
assert.ok(
  html.indexOf('id="btnMachine3D"') > html.indexOf('ผู้ดูแลระบบ'),
  'Machine 3D Parts View belongs inside the Power User section'
);
assert.match(html, /import\('\.\/machine-viewer\.js'\)/);
assert.doesNotMatch(html, /<script[^>]+src="[^"]*three/i);
assert.match(html, /getParts:\s*\(\)=>[\s\S]{0,900}_pendingPartsCache/,
  'viewer receives live coded and pending/codeless parts');
assert.match(html, /onChoosePart:\s*\(part\)=>[\s\S]{0,1200}order\.items\.push/,
  'a database result selected in 3D can be added to the requisition');
assert.match(html, /if\(part\.PendingId\) autofillFromPending\(idx, part\)/,
  'pending-part photos follow the existing reliable photo path');

// Both requested six-station machine families are available as reference
// models. The labels and component metadata are UI/data, not hidden in meshes.
assert.deepEqual(Object.keys(MACHINE_MODELS).sort(), ['EXY6', 'MXY6']);
for (const model of Object.values(MACHINE_MODELS)) {
  assert.equal(model.stationCount, 6);
  assert.ok(model.components.some((part) => part.kind === 'spindle'));
  assert.ok(model.components.some((part) => part.kind === 'ccd'));
}
assert.deepEqual(MACHINE_MODELS.MXY6.visual, {
  profile: 'photo-reference-v2',
  referencePhotoCount: 5,
  frontDoorCount: 3,
  hasServiceBay: true,
  bodyAspect: 3.1,
  detailLevel: 2,
  hasPaintedMetalMaterial: true
});
assert.equal(MACHINE_MODELS.EXY6.visual.profile, 'procedural-reference',
  'EXY-6 remains on the existing generic model until its own photos arrive');

// Door/shell interactions are reversible and model switching starts clean.
let state = createMachineViewState('MXY6');
assert.equal(state.modelId, 'MXY6');
assert.equal(state.shellVisible, true);
assert.equal(state.doorsOpen, false);
state = toggleDoor(state);
assert.equal(state.doorsOpen, true);
state = toggleDoor(state);
assert.equal(state.doorsOpen, false);
state = toggleShellVisibility(state);
assert.equal(state.shellVisible, false);
state = selectComponent(state, 'station-3-spindle');
assert.equal(state.selectedComponentId, 'station-3-spindle');
state = switchMachineModel(state, 'EXY6');
assert.equal(state.modelId, 'EXY6');
assert.equal(state.selectedComponentId, '', 'switching models clears stale selection');
assert.equal(switchMachineModel(state, 'UNKNOWN').modelId, 'EXY6');
assert.equal(createMachineViewState('UNKNOWN').modelId, 'MXY6');
assert.equal(findComponent('EXY6', 'station-6-ccd').kind, 'ccd');
assert.equal(findComponent('UNKNOWN', 'missing-part'), null);

// A 3D hotspot can surface coded and codeless DB rows. Matching is based on
// useful Thai/English search terms rather than requiring Article No.
const rows = [
  { ArticleNo:'SP-100', Description:'Main spindle motor', ImageURL:'https://example.test/sp.jpg' },
  { ArticleNo:'', Description:'กล้อง CCD หัว 2', ImageURL:'https://example.test/ccd.jpg' },
  { ArticleNo:'P-9', Description:'Vacuum pump', ImageURL:'' }
];
assert.deepEqual(
  findMatchingDatabaseParts(rows, ['spindle']).map((row) => row.ArticleNo),
  ['SP-100']
);
assert.deepEqual(
  findMatchingDatabaseParts(rows, ['ccd', 'กล้อง']).map((row) => row.Description),
  ['กล้อง CCD หัว 2']
);
assert.deepEqual(findMatchingDatabaseParts(null, ['ccd']), []);
assert.deepEqual(findMatchingDatabaseParts(rows, []), []);
assert.deepEqual(findMatchingDatabaseParts(rows, ['vacuum'], 0), []);

// No runtime dependency on third-party image hosts: Three.js is vendored. The
// large 3D bundle must not compete with startup sync; it is cached lazily after
// the Power User opens the viewer for the first time.
assert.match(viewer, /from '\.\/vendor\/three\.module\.min\.js'/);
assert.match(viewer, /from '\.\/vendor\/OrbitControls\.js'/);
assert.doesNotMatch(viewer, /https?:\/\//);
assert.match(viewer, /buildMXY6PhotoReference\(/);
assert.match(viewer, /model\.id === 'MXY6'/);
assert.match(viewer, /mxy-granite-base/);
assert.match(viewer, /mxy-front-door-/);
assert.match(viewer, /mxy-service-bay/);
assert.match(viewer, /mxy-side-service-door-/,
  'photo 2 service-door seams and handles are represented');
assert.match(viewer, /mxy-door-handle-/,
  'each glazed front door has its visible pull handle');
assert.match(viewer, /mxy-gas-strut-/,
  'front doors include visible opening hardware');
assert.match(viewer, /mxy-roof-vent-/,
  'top ventilation slots follow the open-side reference photo');
assert.match(viewer, /mxy-cable-chain-/,
  'the six-station cable routing is represented');
assert.match(viewer, /mxy-bellows-/,
  'linear-axis bellows are visible below the station bed');
assert.match(viewer, /MeshPhysicalMaterial/,
  'painted panels use a physical material instead of flat plastic shading');
assert.doesNotMatch(viewer, /SpriteMaterial\(\{ map: texture, depthTest: false \}\)/,
  'station labels must not render through the solid rear service doors');
assert.match(viewer, /stationLabels\.forEach[\s\S]{0,220}camera\.position\.z/,
  'station labels are hidden when the operator rotates behind the machine');
assert.match(viewer, /rotationAxis[^\n]*'x'/,
  'photo-reference front glass opens upward around its top hinge');
assert.doesNotMatch(viewer, /PCFSoftShadowMap/,
  'viewer avoids the deprecated Three.js soft-shadow mode');
assert.doesNotMatch(viewer, /mxy-common-bed[^\n]*station-3-table/,
  'the shared bed must not incorrectly select station 3');
const shell = worker.match(/const SHELL = \[([\s\S]*?)\];/)?.[1] || '';
assert.doesNotMatch(shell, /machine-viewer|vendor\/three|OrbitControls/);
assert.match(worker, /const CACHE = 'schmoll-export-v14'/);
assert.match(worker, /url\.origin === self\.location\.origin[\s\S]{0,200}c\.put\(req, copy\)/,
  'same-origin 3D assets are cached lazily after first use');

// Read-only sync survives transient mobile-network failures. Mutation calls do
// not use this retry path, preventing duplicate writes.
assert.match(html, /const LOOKUP_SYNC_MAX_ATTEMPTS\s*=\s*3/);
assert.match(html, /async function lookupSyncApiCall\(/);
assert.match(html, /lookupSyncApiCall\(action,\s*\{since:\s*lookupCache\.syncedAt\}\)/);

// Startup gives the database sync exclusive priority instead of making Apps
// Script serve settings, outbox and pending-part requests at the same time.
// Cached settings are still applied immediately without a network call.
assert.match(html, /loadAppSettings\(\{cacheOnly:true\}\)/);
assert.match(html, /async function lookupStartupSync\(\)[\s\S]{0,900}await lookupSync\(\)[\s\S]{0,700}Promise\.allSettled\(\[\s*lookupFlushOutbox\(\{excludeUsage:true\}\),\s*flushUsageOutboxAutomatically\(\),\s*loadAppSettings\(\)\s*\]\)/);
assert.match(html, /if\(lookupOnline\) lookupStartupSync\(\)/);
const initLookup = html.match(/\(async function initLookupDb\(\)\{([\s\S]*?)\}\)\(\);/)?.[1] || '';
assert.doesNotMatch(initLookup, /_loadPendingParts|lookupFlushOutbox|loadAppSettings/,
  'startup must not issue competing or duplicate API calls beside the prioritized sync pipeline');

// Responsive controls and an explicit no-WebGL recovery path are part of the
// user-visible contract, not optional polish.
assert.match(viewer, /@media\s*\(max-width:\s*720px\)/);
assert.match(viewer, /ไม่รองรับ WebGL|WebGL is unavailable/);

console.log('interactive MXY-6 / EXY-6 machine viewer tests passed');
