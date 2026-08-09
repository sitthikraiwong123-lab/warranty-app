import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const rootUrl = new URL('../', import.meta.url);
const html = fs.readFileSync(new URL('Warranty App.html', rootUrl), 'utf8');
const worker = fs.readFileSync(new URL('sw.js', rootUrl), 'utf8');
const backendSource = fs.readFileSync(new URL('backend/Code.gs', rootUrl), 'utf8');

test('buildUsageEvent snapshots every meaningful item, including codeless parts', async () => {
  const { buildUsageEvent } = await import('../usage-log-core.mjs');
  const order = {
    id: 'order-1', type: 'Warranty', customer: 'WUS-TH',
    items: [
      { articleNo:'A-1', description:'Pump', machineNo:'100', machineType:'MXY6', qty:2, qtyUnit:'pcs', itemDesc:'Leak', setName:'' },
      { articleNo:'', description:'Unknown hose', machineNo:'101', machineType:'EXY6', qty:1, qtyUnit:'pcs', itemDesc:'Cracked', setName:'Kit' },
      { articleNo:'', description:'', machineNo:'102', machineType:'MXY6', qty:1 }
    ]
  };

  const event = buildUsageEvent(order, {
    action:'save', eventId:'evt-1', recordedBy:'Somchai', createdAt:'2026-08-09T01:02:03.000Z'
  });

  assert.equal(event.orderId, 'order-1');
  assert.equal(event.eventId, 'evt-1');
  assert.equal(event.action, 'save');
  assert.equal(event.expectedItems, 2);
  assert.deepEqual(event.items.map(item => [item.articleNo, item.partName]), [
    ['A-1', 'Pump'], ['', 'Unknown hose']
  ]);

  order.items[0].description = 'Changed after snapshot';
  order.items.pop();
  assert.equal(event.items[0].partName, 'Pump');
  assert.equal(event.expectedItems, 2);
});

test('usage acknowledgements must prove that every item was durably accepted', async () => {
  const { usageStatusSuffix, validateUsageAck } = await import('../usage-log-core.mjs');
  const event = { eventId:'evt-2', expectedItems:3 };

  assert.deepEqual(validateUsageAck({success:true,eventId:'evt-2',written:3,revision:4}, event), {
    state:'saved', eventId:'evt-2', written:3, expectedItems:3, revision:4
  });
  assert.deepEqual(validateUsageAck({queued:true,eventId:'evt-2'}, event), {
    state:'queued', eventId:'evt-2', written:0, expectedItems:3, revision:null, error:''
  });
  assert.deepEqual(validateUsageAck({queued:true,eventId:'evt-2',error:'Unknown action: recordPartUsage'}, event), {
    state:'queued', eventId:'evt-2', written:0, expectedItems:3, revision:null,
    error:'Unknown action: recordPartUsage'
  });
  assert.throws(() => validateUsageAck({success:true,eventId:'evt-2',written:2}, event), /2\/3/);
  assert.throws(() => validateUsageAck({success:true,eventId:'wrong',written:3}, event), /event/i);
  assert.match(usageStatusSuffix({state:'failed'}), /Log/);
});

test('usage core rejects invalid events and reports saved, queued, failed, and empty states', async () => {
  const core = await import('../usage-log-core.mjs');
  assert.throws(() => core.buildUsageEvent(null), /orderId/i);
  assert.throws(() => core.buildUsageEvent({id:'x'}, {action:'made_up'}), /action/i);
  assert.throws(() => core.validateUsageAck(null, null), /event/i);

  const empty = core.buildUsageEvent({id:'empty',items:null}, {
    action:'save', eventId:'empty-event', recordedBy:'', createdAt:'2026-08-09T00:00:00.000Z'
  });
  assert.equal(empty.expectedItems, 0);
  assert.equal(empty.recordedBy, '-');
  assert.throws(() => core.validateUsageAck(null, empty), /acknowledged/i);
  assert.throws(() => core.validateUsageAck({queued:true,eventId:'other'}, empty), /event/i);
  assert.deepEqual(core.validateUsageAck({success:true,eventId:'empty-event',written:0,revision:0}, empty), {
    state:'saved', eventId:'empty-event', written:0, expectedItems:0, revision:null
  });

  assert.equal(core.usageStatusSuffix(null), '');
  assert.match(core.usageStatusSuffix({state:'queued',expectedItems:2,error:'backend outdated'}), /backend outdated/);
  assert.match(core.usageStatusSuffix({state:'saved',written:2,expectedItems:2}), /2\/2/);

  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    delete globalThis.crypto;
    assert.match(core.createUsageEventId(), /^usage-/);
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
  }
  assert.ok(core.createUsageEventId().length > 10);
});

test('draft recovery snapshots only meaningful items without changing the drafts', async () => {
  const { buildDraftRecoveryBatch, buildDraftRecoveryBatches } = await import('../usage-log-core.mjs');
  const drafts = [{
    id:'draft-1', createdAt:10, updatedAt:20, type:'Warranty', customer:'WUS-TH',
    items:[
      {articleNo:'A',description:'Alpha',machineNo:'100',machineType:'MXY-6',qty:1,qtyUnit:'pcs'},
      {articleNo:'',description:'Codeless',machineNo:'101',qty:2,qtyUnit:'set'},
      {articleNo:'',description:'',machineNo:'102'}
    ]
  }];
  const batch = buildDraftRecoveryBatch(drafts, {recordedBy:'Somchai'});
  assert.equal(batch.drafts.length, 1);
  assert.equal(batch.drafts[0].items.length, 2);
  assert.equal(batch.drafts[0].recordedBy, 'Somchai');
  drafts[0].items[0].description = 'mutated later';
  assert.equal(batch.drafts[0].items[0].partName, 'Alpha');
  const defaults = buildDraftRecoveryBatch([
    null,
    {id:' ',items:[]},
    {id:'draft-defaults',items:[null,{description:'Only a name',qty:''}]}
  ]);
  assert.equal(defaults.drafts.length, 1);
  assert.equal(defaults.drafts[0].recordedBy, '-');
  assert.equal(defaults.drafts[0].items[0].qty, '');
  assert.throws(() => buildDraftRecoveryBatch(null), /array/);
  assert.throws(() => buildDraftRecoveryBatch(Array.from({length:11},(_,i)=>({id:'d'+i,items:[]}))), /10/);
  assert.throws(() => buildDraftRecoveryBatch([{id:'too-many',items:Array.from({length:9},()=>({description:'Part'}))}]), /8/);

  const manyDrafts = Array.from({length:23}, (_, index) => ({
    id:'draft-'+index, items:[{description:'Part '+index,qty:1}]
  }));
  const batches = buildDraftRecoveryBatches(manyDrafts, {recordedBy:'Somchai'});
  assert.deepEqual(batches.map(batch => batch.drafts.length), [10,10,3]);
  assert.equal(batches.flatMap(batch => batch.drafts).length, 23);
  assert.equal(manyDrafts[0].items[0].description, 'Part 0', 'batching must not mutate local drafts');
});

class FakeRange {
  constructor(sheet, row, column, rowCount = 1, columnCount = 1) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }
  getValues() {
    return Array.from({length:this.rowCount}, (_, rowOffset) =>
      Array.from({length:this.columnCount}, (_, columnOffset) =>
        this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? ''
      )
    );
  }
  setValues(values) {
    values.forEach((sourceRow, rowOffset) => {
      const targetIndex = this.row - 1 + rowOffset;
      while (this.sheet.rows.length <= targetIndex) this.sheet.rows.push([]);
      sourceRow.forEach((value, columnOffset) => {
        this.sheet.rows[targetIndex][this.column - 1 + columnOffset] = value;
      });
    });
    return this;
  }
  setValue(value) { return this.setValues([[value]]); }
}

class FakeSheet {
  constructor(name, rows = []) { this.name = name; this.rows = rows.map(row => [...row]); }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
  getRange(row, column, rowCount = 1, columnCount = 1) { return new FakeRange(this, row, column, rowCount, columnCount); }
  appendRow(row) { this.rows.push([...row]); return this; }
  deleteRow(row) { this.rows.splice(row - 1, 1); return this; }
  setFrozenRows() { return this; }
}

function loadBackendWithUsageSheet(initialRows) {
  const usageSheet = new FakeSheet('PartUsage', initialRows);
  const sheets = new Map([['PartUsage', usageSheet]]);
  const spreadsheet = {
    getSheetByName(name) { return sheets.get(name) || null; },
    insertSheet(name) { const sheet = new FakeSheet(name); sheets.set(name, sheet); return sheet; }
  };
  let uuidSequence = 0;
  const context = vm.createContext({
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => `generated-${++uuidSequence}`,
      formatDate: () => '2026-08-09',
      base64Decode: () => [],
      newBlob: () => ({})
    },
    ContentService: { MimeType:{JSON:'json'}, createTextOutput: value => ({ setMimeType: () => value }) },
    DriveApp: {},
    PropertiesService: { getScriptProperties: () => ({getProperty(){return null;},setProperty(){}}) }
  });
  vm.runInContext(backendSource + `
    ;globalThis.__usageApi={recordPartUsage,getAllPartUsage,getPartUsageEvent,apiInfo,PARTUSAGE_HEADERS,
      handleRequest:typeof handleRequest==='function'?handleRequest:null,
      recoverPartUsageDrafts:typeof recoverPartUsageDrafts==='function'?recoverPartUsageDrafts:null,
      recoveryHeaders:typeof PARTUSAGE_RECOVERY_HEADERS==='undefined'?null:PARTUSAGE_RECOVERY_HEADERS};`, context);
  return { usageSheet, sheets, api:context.__usageApi };
}

test('backend keeps every revision of the same order and retries are idempotent', () => {
  const legacyHeaders = [
    'Timestamp','OrderId','Type','Customer','MachineNo','MachineType',
    'ArticleNo','PartName','Qty','Unit','Note','SetName','RecordedBy'
  ];
  const { usageSheet, api } = loadBackendWithUsageSheet([legacyHeaders]);
  const base = { orderId:'order-9', type:'Warranty', customer:'WUS-TH', recordedBy:'Somchai' };
  const firstItems = [
    {articleNo:'A',partName:'=IMPORTXML("https://example.invalid")',qty:1},
    {articleNo:'B',partName:'Beta',qty:2},
    {articleNo:'',partName:'Codeless',qty:1}
  ];

  const first = api.recordPartUsage({...base,eventId:'evt-first',action:'save',items:firstItems});
  assert.equal(first.written, 3);
  assert.equal(first.revision, 1);
  assert.equal(usageSheet.rows.length, 4);
  assert.deepEqual(Array.from(usageSheet.rows[0]), Array.from(api.PARTUSAGE_HEADERS));

  const second = api.recordPartUsage({...base,eventId:'evt-second',action:'pdf_preview',items:[firstItems[0]]});
  assert.equal(second.written, 1);
  assert.equal(second.revision, 2);
  assert.equal(usageSheet.rows.length, 5, 'a new revision must append instead of deleting the first three rows');

  const retry = api.recordPartUsage({...base,eventId:'evt-second',action:'pdf_preview',items:[firstItems[0]]});
  assert.equal(retry.written, 1);
  assert.equal(retry.revision, 2);
  assert.equal(retry.idempotent, true);
  assert.equal(usageSheet.rows.length, 5, 'retrying the same event must not duplicate rows');
  assert.throws(
    () => api.recordPartUsage({...base,eventId:'evt-second',action:'pdf_preview',expectedItems:2,items:[firstItems[0],firstItems[1]]}),
    /count mismatch/i,
    'an idempotent retry must not acknowledge a different item count'
  );

  const eventIndex = api.PARTUSAGE_HEADERS.indexOf('EventId');
  const revisionIndex = api.PARTUSAGE_HEADERS.indexOf('Revision');
  const actionIndex = api.PARTUSAGE_HEADERS.indexOf('Action');
  assert.deepEqual(usageSheet.rows.slice(1).map(row => row[eventIndex]), ['evt-first','evt-first','evt-first','evt-second']);
  assert.deepEqual(usageSheet.rows.slice(1).map(row => row[revisionIndex]), [1,1,1,2]);
  assert.deepEqual(usageSheet.rows.slice(1).map(row => row[actionIndex]), ['save','save','save','pdf_preview']);
  assert.match(usageSheet.rows[1][7], /^'=/,
    'spreadsheet formulas from user-controlled text must be stored as text');
  const newest = api.getAllPartUsage({limit:1}).rows[0];
  assert.equal(newest.EventId, 'evt-second');
  assert.equal(newest.Revision, 2);
  assert.equal(newest.Action, 'pdf_preview');
  const confirmed = api.getPartUsageEvent({eventId:'evt-first',expectedItems:3});
  assert.equal(confirmed.success, true);
  assert.equal(confirmed.written, 3);
  assert.equal(confirmed.eventId, 'evt-first');
  assert.equal(api.apiInfo().usageLogVersion, 3);
});

test('backend validates action and caps a single usage event', () => {
  const headers = [
    'Timestamp','OrderId','Type','Customer','MachineNo','MachineType',
    'ArticleNo','PartName','Qty','Unit','Note','SetName','RecordedBy'
  ];
  const { api } = loadBackendWithUsageSheet([headers]);
  assert.throws(() => api.recordPartUsage({orderId:'x',eventId:'e',action:'made_up',items:[{partName:'A'}]}), /action/i);
  assert.throws(() => api.recordPartUsage({orderId:'x',eventId:'e',action:'save',items:Array.from({length:201},()=>({partName:'A'}))}), /200/);
});

test('backend skips an exact duplicate event only inside the short duplicate window', () => {
  const headers = [
    'Timestamp','OrderId','Type','Customer','MachineNo','MachineType',
    'ArticleNo','PartName','Qty','Unit','Note','SetName','RecordedBy',
    'EventId','Revision','Action'
  ];
  const recent = new Date(Date.now() - 30000);
  const old = new Date(Date.now() - 5 * 60 * 1000);
  const duplicateItem = {
    articleNo:'63598', partName:'LASER DLS5', machineNo:'M1', machineType:'MXY-6',
    qty:1, unit:'pcs', note:'', setName:''
  };
  const { usageSheet, api } = loadBackendWithUsageSheet([headers, [
    recent, 'order-dedupe', 'Warranty', 'WUS-TH', 'M1', 'MXY-6', '63598', 'LASER DLS5',
    '1', 'pcs', '', '', '-', 'evt-recent', 1, 'pdf_preview'
  ]]);

  const duplicate = api.recordPartUsage({
    orderId:'order-dedupe', eventId:'evt-new-duplicate', action:'pdf_preview',
    type:'Warranty', customer:'WUS-TH', recordedBy:'', expectedItems:1, items:[duplicateItem]
  });

  assert.equal(duplicate.written, 1);
  assert.equal(duplicate.duplicateSkipped, true);
  assert.equal(usageSheet.rows.length, 2, 'exact duplicate inside the window must not append a row');

  const changed = api.recordPartUsage({
    orderId:'order-dedupe', eventId:'evt-new-changed', action:'pdf_preview',
    type:'Warranty', customer:'WUS-TH', recordedBy:'', expectedItems:1,
    items:[{...duplicateItem, note:'changed'}]
  });
  assert.equal(changed.duplicateSkipped, false);
  assert.equal(usageSheet.rows.length, 3, 'a changed field must still create a new log');

  const { usageSheet: oldSheet, api: oldApi } = loadBackendWithUsageSheet([headers, [
    old, 'order-dedupe', 'Warranty', 'WUS-TH', 'M1', 'MXY-6', '63598', 'LASER DLS5',
    '1', 'pcs', '', '', '-', 'evt-old', 1, 'pdf_preview'
  ]]);
  const later = oldApi.recordPartUsage({
    orderId:'order-dedupe', eventId:'evt-later', action:'pdf_preview',
    type:'Warranty', customer:'WUS-TH', recordedBy:'', expectedItems:1, items:[duplicateItem]
  });
  assert.equal(later.duplicateSkipped, false);
  assert.equal(oldSheet.rows.length, 3, 'the same data outside the short window must be logged');
});

test('usage API routing preserves the user action instead of sending it as the endpoint action', () => {
  const headers = [
    'Timestamp','OrderId','Type','Customer','MachineNo','MachineType',
    'ArticleNo','PartName','Qty','Unit','Note','SetName','RecordedBy',
    'EventId','Revision','Action'
  ];
  const { usageSheet, api } = loadBackendWithUsageSheet([headers]);
  const result = api.recordPartUsage({
    orderId:'order-route',
    eventId:'evt-route',
    action:'recordPartUsage',
    usageAction:'pdf_preview',
    expectedItems:1,
    items:[{articleNo:'63598',partName:'LASER DLS5'}]
  });

  assert.equal(result.success, true);
  assert.equal(result.written, 1);
  assert.equal(usageSheet.rows[1][headers.indexOf('Action')], 'pdf_preview');
  assert.match(html, /body\.usageAction\s*=\s*body\.action/,
    'recordPartUsage payloads must move event.action out of the API routing field');
  assert.match(html, /body\.action\s*=\s*action/,
    'the backend endpoint action must win after the payload is copied');
});

test('backend accepts queued v2.12.4 usage events whose action reached the router directly', () => {
  const headers = [
    'Timestamp','OrderId','Type','Customer','MachineNo','MachineType',
    'ArticleNo','PartName','Qty','Unit','Note','SetName','RecordedBy',
    'EventId','Revision','Action'
  ];
  const { usageSheet, api } = loadBackendWithUsageSheet([headers]);
  const responseText = api.handleRequest({postData:{contents:JSON.stringify({
    action:'pdf_preview',
    orderId:'order-legacy-router',
    eventId:'evt-legacy-router',
    expectedItems:1,
    items:[{articleNo:'63598',partName:'LASER DLS5'}]
  })}});
  const response = JSON.parse(responseText);

  assert.equal(response.success, true);
  assert.equal(response.written, 1);
  assert.equal(usageSheet.rows[1][headers.indexOf('Action')], 'pdf_preview');
  assert.match(backendSource, /case 'pdf_preview':[\s\S]{0,500}recordPartUsage\(params\)/,
    'backend must drain old queued events that were routed with the user action name');
});

test('draft recovery writes only missing rows to a separate idempotent sheet', () => {
  const headers = [
    'Timestamp','OrderId','Type','Customer','MachineNo','MachineType',
    'ArticleNo','PartName','Qty','Unit','Note','SetName','RecordedBy',
    'EventId','Revision','Action'
  ];
  const current = [new Date('2026-08-01T00:00:00Z'),'draft-1','Warranty','WUS-TH','100','MXY-6','A','Alpha',1,'pcs','','','User','e1',1,'pdf_preview'];
  const { usageSheet, sheets, api } = loadBackendWithUsageSheet([headers,current]);
  const before = usageSheet.rows.map(row=>[...row]);
  const params = { drafts:[
    {orderId:'draft-1',createdAt:10,updatedAt:20,type:'Warranty',customer:'WUS-TH',recordedBy:'Somchai',items:[
      {articleNo:'A',partName:'Alpha',machineNo:'100',machineType:'MXY-6',qty:1,unit:'pcs',note:'',setName:''},
      {articleNo:'B',partName:'Beta',machineNo:'100',machineType:'MXY-6',qty:2,unit:'pcs',note:'missing',setName:''}
    ]},
    {orderId:'draft-2',createdAt:30,updatedAt:40,type:'Purchase',customer:'KCEE',recordedBy:'Somchai',items:[
      {articleNo:'C',partName:'=IMPORTXML("https://example.invalid")',machineNo:'200',machineType:'EXY-6',qty:1,unit:'set',note:'',setName:''}
    ]}
  ]};

  const first = api.recoverPartUsageDrafts(params);
  assert.equal(first.inserted, 2);
  assert.equal(first.skippedCurrent, 1);
  assert.deepEqual(usageSheet.rows, before, 'recovery must never modify PartUsage');
  const recovery = sheets.get('PartUsageRecovery');
  assert.ok(recovery);
  assert.deepEqual(Array.from(recovery.rows[0]), Array.from(api.recoveryHeaders));
  assert.equal(recovery.rows.length, 3);
  assert.match(recovery.rows[2][9], /^'=/, 'recovered sheet values must be formula-safe');

  const retry = api.recoverPartUsageDrafts(params);
  assert.equal(retry.inserted, 0);
  assert.equal(retry.skippedCurrent, 1);
  assert.equal(retry.skippedRecovered, 2);
  assert.equal(recovery.rows.length, 3, 'retry must not duplicate recovery rows');
  assert.deepEqual(usageSheet.rows, before, 'retry must still leave PartUsage unchanged');

  assert.throws(() => api.recoverPartUsageDrafts({drafts:Array.from({length:11},()=>({items:[]}))}), /10/);
  assert.throws(() => api.recoverPartUsageDrafts({drafts:[{orderId:'x',items:Array.from({length:9},()=>({partName:'A'}))}]}), /8/);
});

test('every user-visible order action is wired to an append-only usage event', () => {
  assert.match(html, /<script type="module" src="\.\/usage-log-core\.mjs\?v=2\.12\.8"><\/script>/);
  assert.match(worker, /'\.\/usage-log-core\.mjs\?v=2\.12\.8'/);
  assert.match(worker, /schmoll-export-v15/,
    'service worker cache must be bumped so clients receive the new logging module');
  assert.match(html, /usageAction[\s\S]{0,160}: 'save'/,
    'ordinary saves default to a save usage event');
  assert.match(html, /recordOrderPartUsage\(usageAction \|\| 'save'\)/);
  assert.match(html, /recordOrderPartUsage\('pdf_preview'/);
  for (const action of ['download','share','email_share','email_graph','email_deeplink','auto_email']) {
    assert.match(html, new RegExp(`commitPdfAction\\('${action}'\\)`), `${action} must write a distinct event`);
  }
  assert.doesNotMatch(html, /recordPartUsage failed[\s\S]{0,80}console\.error/,
    'usage failures must not be swallowed as console-only errors');
  assert.match(html, /usageLogOutboxFallbackV1/,
    'outbox must have a persistent fallback when IndexedDB is unavailable');
  assert.match(html, /usageLogCoreReady/,
    'startup outbox replay must wait for the usage module');
  assert.match(html, /Usage log module failed to load/,
    'a missing logging module must surface an error instead of hanging forever');
  assert.match(html, /Promise\.allSettled\(\[recordOrderPartUsage\(action\),commitExportNumberOnSend\(\)\]\)/,
    'a usage failure after an output must not cancel the independent running-number commit');
  assert.doesNotMatch(backendSource, /function recordPartUsageLegacy_/,
    'the destructive OrderId replacement implementation must not remain callable');
  assert.match(backendSource, /case 'recoverPartUsageDrafts'/);
  assert.match(backendSource, /case 'getPartUsageEvent'/);
  assert.match(backendSource, /case 'apiInfo'/);
  assert.match(html, /recoverPartUsageDrafts/);
  assert.match(html, /buildDraftRecoveryBatches/);
  assert.match(html, /ซิงค์ Log ที่รอ/);
  assert.match(html, /usageLogVersion/);
  assert.match(html, /PartUsageRecovery/);
});

test('pdf ready card does not expose duplicate open or download controls', () => {
  assert.match(html, /id="previewCard"/);
  assert.doesNotMatch(html, /id="btnOpenPdf"/,
    'the standalone PDF Ready card must not keep a second open-PDF button');
  assert.doesNotMatch(html, /id="btnDownloadPdf"/,
    'the standalone PDF Ready card must not keep a second download-PDF button');
  assert.doesNotMatch(html, /document\.getElementById\('btnOpenPdf'\)/);
  assert.doesNotMatch(html, /document\.getElementById\('btnDownloadPdf'\)/);
  assert.match(html, /id="pmSavePdf"/,
    'the PDF preview menu still needs its save/download action');
});

test('pdf photo layout supports multi-photo items and optional extra photo pages', () => {
  assert.match(html, /function collectOrderPhotoSlots\(ord\)/,
    'PDF export needs to flatten every item photo into ordered photo slots');
  assert.match(html, /function itemPhotoEditGroups\(it\)/,
    'the edit UI needs the same per-item grouping that the PDF uses');
  assert.match(html, /itemPhotoEditGroups\(it\)\.forEach/,
    'ticking combine-two must immediately render paired photos in the same editable canvas');
  assert.match(html, /itemPhotoPack[\s\S]{0,260}renderItemPhoto\(idx\)/,
    'changing the combine-two checkbox must immediately redraw the item photo editor');
  assert.match(html, /packPhotosTwoPerBox/,
    'each item needs an opt-in flag for combining two photos in one PDF box');
  assert.match(html, /autoExtraPhotoPages/,
    'orders need a switch to disable automatic extra photo pages');
  assert.match(html, /function renderPhotoTableHtml\(photoSlots,\s*opts\)/,
    'the original 4-box photo table must be reusable on later pages');
  assert.match(html, /class="pdoc pdoc-photo-extra"/,
    'extra photo pages should be lightweight photo-only pages, not repeat the full form header');
  assert.match(html, /renderPhotoTableHtml\(slots,\s*\{showTitle:false\}\)/,
    'extra photo pages should add the next four boxes without repeating a title row');
  assert.match(html, /root\.querySelectorAll\('\.pdoc'\)/,
    'PDF generation must render every generated page, not just the first .pdoc');
  assert.match(html, /doc\.addPage\(\)/,
    'multi-page photo output must add jsPDF pages after the first');
  assert.match(html, /_pdfPreviewPageImgData\s*=/,
    'the preview modal must keep every rendered PDF page image, not only the first');
  assert.match(html, /function renderPdfPreviewPages\(\)/,
    'the preview modal must render page 2+ when the PDF has extra photo pages');
  assert.match(html, /id="pdfModalPages"/,
    'the PDF preview modal needs a multi-page container');
  assert.match(html, /id="extraPhotoPagesControl"/,
    'Main Info must expose the auto-extra-pages toggle only when it matters');
  assert.match(html, /itemPhotoPack/,
    'each item row needs its own combine-two-photos checkbox');
  assert.doesNotMatch(html, /slice\(0,4\)/,
    'photo export must not silently drop photos at the old four-photo cap');
});

test('queued usage logs retry automatically without relying on an end-user button', () => {
  assert.match(html, /const USAGE_OUTBOX_RETRY_DELAYS_MS\s*=\s*\[5000,\s*15000,\s*60000,\s*300000\]/,
    'automatic retries must back off instead of polling the backend continuously');
  assert.match(html, /async function flushUsageOutboxAutomatically\(\)/,
    'usage outbox needs a dedicated guarded automatic flush');
  assert.match(html, /lookupFlushOutbox\(\{usageOnly:true\}\)/,
    'automatic replay must only operate on queued usage events');
  assert.match(html, /outboxAdd\(\{action:'recordPartUsage'[\s\S]{0,500}scheduleUsageOutboxRetry\(\)/,
    'a newly queued usage event must schedule its own retry');
  assert.match(html, /document\.addEventListener\('visibilitychange'[\s\S]{0,300}flushUsageOutboxAutomatically\(\)/,
    'returning to the app must retry queued usage immediately');
  assert.match(html, /window\.addEventListener\('focus'[\s\S]{0,250}flushUsageOutboxAutomatically\(\)/,
    'focusing the app must retry queued usage immediately');
  assert.match(html, /window\.addEventListener\('online'[\s\S]{0,300}lookupStartupSync\(\)/,
    'network reconnection must run the startup sync pipeline');
  assert.match(html, /isPowerUser\(\)\?'<button type="button" class="btn log-sync-pending"/,
    'the manual diagnostic control must not be required or shown to ordinary users');
});
