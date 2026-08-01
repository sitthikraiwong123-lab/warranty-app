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

// The 3D feature is discoverable from the existing slide-out menu, but the
// heavyweight renderer is loaded only when the operator opens it.
assert.match(html, /id="btnMachine3D"/);
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

// No runtime dependency on third-party image hosts: Three.js is vendored and
// the full viewer shell is cached for the installed PWA.
assert.match(viewer, /from '\.\/vendor\/three\.module\.min\.js'/);
assert.match(viewer, /from '\.\/vendor\/OrbitControls\.js'/);
assert.doesNotMatch(viewer, /https?:\/\//);
assert.match(worker, /machine-viewer\.js/);
assert.match(worker, /machine-viewer-core\.mjs/);
assert.match(worker, /vendor\/three\.module\.min\.js/);
assert.match(worker, /vendor\/three\.core\.min\.js/);

// Responsive controls and an explicit no-WebGL recovery path are part of the
// user-visible contract, not optional polish.
assert.match(viewer, /@media\s*\(max-width:\s*720px\)/);
assert.match(viewer, /ไม่รองรับ WebGL|WebGL is unavailable/);

console.log('interactive MXY-6 / EXY-6 machine viewer tests passed');
