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
      { articleNo:'A-1', description:'Pump', machineNo:'100', machineType:'MXY6', qty:2, qtyUnit:'pcs', itemDesc:'Leak', setName:'',
        photos:[{driveUrl:'https://drive.test/a.jpg'},{src:'https://drive.test/b.jpg'}] },
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
  assert.deepEqual(event.items[0].imageURLs, ['https://drive.test/a.jpg','https://drive.test/b.jpg']);

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
      getPartUsage:typeof getPartUsage==='function'?getPartUsage:null,
      handleRequest:typeof handleRequest==='function'?handleRequest:null,
      queuePartUsageEvent:typeof queuePartUsageEvent==='function'?queuePartUsageEvent:null,
      replayPartUsageOutbox:typeof replayPartUsageOutbox==='function'?replayPartUsageOutbox:null,
      outboxHeaders:typeof PARTUSAGE_OUTBOX_HEADERS==='undefined'?null:PARTUSAGE_OUTBOX_HEADERS,
      deleteRecoveredPartUsage:typeof deleteRecoveredPartUsage==='function'?deleteRecoveredPartUsage:null,
      recoverPartUsageDrafts:typeof recoverPartUsageDrafts==='function'?recoverPartUsageDrafts:null,
      recoveryHeaders:typeof PARTUSAGE_RECOVERY_HEADERS==='undefined'?null:PARTUSAGE_RECOVERY_HEADERS};`, context);
  return { usageSheet, sheets, api:context.__usageApi };
}

function apiHeaders() {
  return [
    'Timestamp','OrderId','Type','Customer','MachineNo','MachineType',
    'ArticleNo','PartName','Qty','Unit','Note','SetName','RecordedBy',
    'EventId','Revision','Action','ImageURLs'
  ];
}

test('backend keeps every revision of the same order and retries are idempotent', () => {
  const legacyHeaders = [
    'Timestamp','OrderId','Type','Customer','MachineNo','MachineType',
    'ArticleNo','PartName','Qty','Unit','Note','SetName','RecordedBy'
  ];
  const { usageSheet, api } = loadBackendWithUsageSheet([legacyHeaders]);
  const base = { orderId:'order-9', type:'Warranty', customer:'WUS-TH', recordedBy:'Somchai' };
  const firstItems = [
    {articleNo:'A',partName:'=IMPORTXML("https://example.invalid")',qty:1,imageURLs:['https://drive.test/a.jpg','https://drive.test/b.jpg']},
    {articleNo:'B',partName:'Beta',qty:2},
    {articleNo:'',partName:'Codeless',qty:1}
  ];

  const first = api.recordPartUsage({...base,eventId:'evt-first',action:'save',items:firstItems});
  assert.equal(first.written, 3);
  assert.equal(first.revision, 1);
  assert.equal(usageSheet.rows.length, 4);
  assert.deepEqual(Array.from(usageSheet.rows[0]), Array.from(api.PARTUSAGE_HEADERS));
  assert.equal(usageSheet.rows[1][api.PARTUSAGE_HEADERS.indexOf('ImageURLs')], '["https://drive.test/a.jpg","https://drive.test/b.jpg"]');

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

test('recovered draft usage is visible in history without mutating current PartUsage', () => {
  const headers = [
    'Timestamp','OrderId','Type','Customer','MachineNo','MachineType',
    'ArticleNo','PartName','Qty','Unit','Note','SetName','RecordedBy',
    'EventId','Revision','Action','ImageURLs'
  ];
  const current = [new Date('2026-08-01T00:00:00Z'),'live-1','Warranty','WUS-TH','100','MXY-6','A','Alpha',1,'pcs','','','User','e1',1,'pdf_preview',''];
  const { usageSheet, api } = loadBackendWithUsageSheet([headers,current]);
  const before = usageSheet.rows.map(row=>[...row]);
  api.recoverPartUsageDrafts({drafts:[{
    orderId:'draft-8',createdAt:30,updatedAt:40,type:'Warranty',customer:'KCEE',recordedBy:'Somchai',
    items:[{articleNo:'B',partName:'Beta',machineNo:'200',machineType:'EXY-6',qty:2,unit:'pcs',note:'missing',setName:''}]
  }]});

  const allRows = api.getAllPartUsage({limit:10, includeRecovered:true}).rows;
  const recovered = allRows.find(row => row.Source === 'local_draft');
  assert.ok(recovered, 'full usage history should include PartUsageRecovery rows');
  assert.equal(recovered.ArticleNo, 'B');
  assert.equal(recovered.Action, 'draft_recovery');
  assert.equal(recovered.Revision, 'Recovered');
  assert.equal(recovered._recovered, true);

  const partRows = api.getPartUsage({articleNo:'B', includeRecovered:true}).rows;
  assert.equal(partRows.length, 1, 'per-part history should include recovered rows too');
  assert.equal(partRows[0].OrderId, 'draft-8');
  assert.deepEqual(usageSheet.rows, before, 'showing recovery in history must still leave PartUsage unchanged');

  assert.match(html, /getAllPartUsage'[\s\S]{0,80}includeRecovered:\s*true/,
    'full log modal must explicitly request recovered draft rows');
  assert.match(html, /getAllPartUsage'[\s\S]{0,80}includeRecovered:\s*false/,
    'full log modal must fall back to the current ledger if recovered rows fail to merge');
  assert.match(html, /getPartUsage'[\s\S]{0,80}includeRecovered:\s*true/,
    'per-part usage modal must explicitly request recovered draft rows');
  assert.match(html, /getPartUsage'[\s\S]{0,80}includeRecovered:\s*false/,
    'per-part usage modal must still load current history if recovered rows fail to merge');
  assert.match(html, /usage recovery merge failed, retrying current ledger only/,
    'recovery merge failures should not blank the whole usage log');
  const deleteResult = api.deleteRecoveredPartUsage({
    row: recovered._recoveryRow,
    match: { OrderId: recovered.OrderId, ArticleNo: recovered.ArticleNo, PartName: recovered.PartName, EventId: recovered.EventId, Action: recovered.Action }
  });
  assert.equal(deleteResult.action, 'deleted');
  assert.equal(api.getAllPartUsage({limit:10, includeRecovered:true}).rows.some(row => row.OrderId === 'draft-8'), false,
    'deleting a recovered row should remove it from PartUsageRecovery history');
  assert.deepEqual(usageSheet.rows, before, 'deleting recovery must still leave current PartUsage untouched');

  assert.match(backendSource, /case 'deleteRecoveredPartUsage'/,
    'Apps Script router must expose a separate delete action for recovered draft rows');
  assert.match(html, /deleteRecoveredPartUsage/,
    'the log modal must delete recovered rows through the recovery endpoint');
  assert.doesNotMatch(html, /r\._recovered[\s\S]{0,140}lt-edit/,
    'recovered rows should not expose the normal PartUsage edit button');
});

test('online PartUsage outbox can be replayed by another device', () => {
  const { usageSheet, sheets, api } = loadBackendWithUsageSheet([apiHeaders()]);
  const event = {
    orderId:'order-online-1', eventId:'evt-online-1', action:'save',
    expectedItems:2, type:'Warranty', customer:'WUS-TH', recordedBy:'m',
    items:[
      {articleNo:'A',partName:'Alpha',qty:1,unit:'pcs',machineType:'MXY6'},
      {articleNo:'B',partName:'Beta',qty:2,unit:'pcs',machineType:'EXY6'}
    ]
  };
  assert.ok(api.queuePartUsageEvent, 'backend must expose queuePartUsageEvent');
  assert.ok(api.replayPartUsageOutbox, 'backend must expose replayPartUsageOutbox');
  assert.deepEqual(Array.from(api.outboxHeaders || []), [
    'QueuedAt','EventId','Status','OrderId','ExpectedItems','RecordedBy','LastError','PayloadJson','ReplayedAt'
  ]);

  const queued = api.queuePartUsageEvent({ event, lastError:'timeout' });
  assert.equal(queued.success, true);
  assert.equal(queued.onlineQueued, true);
  assert.equal(sheets.get('PartUsageOutbox').rows.length, 2, 'outbox sheet should keep the pending event online');
  assert.equal(usageSheet.rows.length, 1, 'queueing online must not pretend the ledger row is already written');
  const queuedAgain = api.queuePartUsageEvent({ event, lastError:'timeout again' });
  assert.equal(queuedAgain.idempotent, true, 'same EventId must not duplicate the online queue');

  const replayed = api.replayPartUsageOutbox({ limit:10 });
  assert.equal(replayed.success, true);
  assert.equal(replayed.replayed, 1);
  assert.equal(replayed.written, 2);
  assert.equal(usageSheet.rows.length, 3, 'replay should append one PartUsage row per item');
  assert.equal(sheets.get('PartUsageOutbox').rows[1][2], 'done');
  const replayedAgain = api.replayPartUsageOutbox({ limit:10 });
  assert.equal(replayedAgain.replayed, 0, 'done outbox rows should not replay again');
});

test('every user-visible order action is wired to an append-only usage event', () => {
  assert.match(html, /<script type="module" src="\.\/usage-log-core\.mjs\?v=2\.12\.23"><\/script>/);
  assert.match(worker, /'\.\/usage-log-core\.mjs\?v=2\.12\.23'/);
  assert.match(worker, /schmoll-export-v30/,
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
  assert.match(html, /function chunkPhotoSlots\(slots,\s*size\)/,
    'photo chunking must support 4 slots on page 1 and 8 slots on later pages');
  assert.match(html, /firstPhotoPage\s*=\s*photoSlotsForPdf\.slice\(0,\s*4\)/,
    'page 1 keeps the original four photo boxes below the order form');
  assert.match(html, /extraPhotoPages\s*=\s*chunkPhotoSlots\(photoSlotsForPdf\.slice\(4\),\s*8\)/,
    'page 2 onwards must continue with eight photos per page');
  assert.match(html, /class="pdoc pdoc-photo-extra"/,
    'extra photo pages should be lightweight photo-only pages, not repeat the full form header');
  assert.match(html, /renderExtraPhotoPageHtml\(slots,\s*pageIndex\)/,
    'extra photo pages need a dedicated 8-photo layout');
  assert.match(html, /renderPhotoTableHtml\(slots\.slice\(0,\s*4\),\s*\{showTitle:true\}\)/,
    'the first extra photo page section should still show the Photo heading');
  assert.match(html, /renderPhotoTableHtml\(slots\.slice\(4,\s*8\),\s*\{showTitle:false\}\)/,
    'the lower half of each extra page should continue the next four boxes without a duplicate heading');
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

test('database, pending queue, log, and Excel export preserve multiple part photos', () => {
  assert.match(html, /function imageUrlList\(source\)/,
    'all DB/log views need one shared parser for ImageURL + ImageURLs');
  assert.ok(
    html.indexOf('function imageUrlList(source)') < html.indexOf("document.addEventListener('DOMContentLoaded'"),
    'imageUrlList must be global, not scoped inside a modal boot block, because combo/log/save code calls it later'
  );
  assert.ok(
    html.indexOf('function imageUrlList(source)') < html.indexOf('function itemUsagePhotoUrls(it)'),
    'usage log snapshotting calls imageUrlList before the later app boot script runs, so the helper must live in the same earlier script block'
  );
  assert.match(html, /function imageStripHtml\(source/,
    'database and pending cards should render multiple thumbnails, not only the first image');
  assert.match(html, /function addPendingPartImage\(key,\s*payload\)/,
    'new order photos must append to the pending upload bucket instead of overwriting it');
  assert.match(html, /pendingPartImageList\(articleNo,desc,it\)/,
    'save/export must collect every queued photo for the part');
  assert.match(html, /for\(const pending of pendingList\)/,
    'recordCodelessPartsOnSave must upload every pending image payload');
  assert.match(html, /imageURLs:urls/,
    'frontend DB writes must send the full image URL list to Apps Script');
  assert.match(html, /resolveUsageImageUrls/,
    'usage log rows must resolve a list of matching images');
  assert.match(html, /data-gallery=/,
    'multi-photo log thumbnails should open as a gallery, not isolated single images');
  assert.match(html, /class="lt-photo-more"[^>]*data-full=/,
    'the +N overflow badge in Log must also open the same gallery, otherwise users cannot reach hidden photos');
  assert.match(html, /querySelectorAll\('\.lt-photo \[data-full\]'\)/,
    'Log photo wiring must attach to both thumbnail images and the +N overflow badge');
  assert.match(html, /function openImageLightbox\(url,\s*gallery,\s*startIndex\)/,
    'the image lightbox must support browsing several photos from the same item');
  assert.match(html, /lightbox-next/,
    'the image lightbox needs next/previous controls for multi-photo rows');
  assert.match(html, /function buildXlsxBytes\(rows,[\s\S]*?<sheetViews><sheetView workbookViewId="0"><pane ySplit="\$\{headerRow\}" topLeftCell="A\$\{headerRow\+1\}" activePane="bottomLeft" state="frozen"\/><\/sheetView><\/sheetViews>/,
    'normal Excel exports, including Log without embedded images, must freeze the header row');
  assert.match(html, /function buildXlsxBytes\(rows,[\s\S]*?<autoFilter ref="A\$\{headerRow\}:\$\{colLetter\(ncol-1\)\}\$\{lastDataRow\}"\/>/,
    'normal Excel exports should keep the filter dropdown on the frozen header row');
  assert.match(html, /buildXlsxBytesWithImages\(rows,\s*imageGroups/,
    'Excel export must accept multiple image groups per row');
  assert.match(html, /rowIndex,photoIndex/,
    'embedded XLSX media must keep each photo distinct inside a row');
  assert.match(html, /const XLSX_IMAGE_COLUMN_WIDTH\s*=\s*260/,
    'Excel image exports should reserve a wider photo column for multi-photo rows');
  assert.match(html, /const XLSX_IMAGE_SINGLE_ROW_HEIGHT\s*=\s*220/,
    'Excel image exports should use taller rows so embedded photos are readable');
  assert.match(html, /slotW\s*=\s*multi\s*\?\s*Math\.floor\(imageColPx\s*\/\s*gridCols\)\s*:\s*imageColPx/,
    'Excel embedded photos should scale from the actual image column width, not a tiny fixed thumbnail');
  assert.match(backendSource, /ImageURLs/,
    'backend must have a durable ImageURLs field alongside legacy ImageURL');
  assert.match(backendSource, /imageUrlList_\(params\.imageURLs/,
    'Apps Script must parse imageURLs arrays/JSON when writing sheets');
  assert.match(backendSource, /appendImageUrlsToPart_/,
    'setImageURL should append new Drive URLs instead of replacing previous photos');
  assert.match(backendSource, /PENDINGPARTS_HEADERS[\s\S]*'ImageURLs'/,
    'pending parts queue must store multiple image URLs too');
  assert.match(backendSource, /PARTUSAGE_HEADERS[\s\S]*'ImageURLs'/,
    'PartUsage log rows must store image snapshots instead of relying on later DB lookup guesses');
  assert.match(html, /function usageOrderSnapshotForLog\(sourceOrder\)/,
    'usage events should snapshot the photo URLs currently attached to each order item');
  assert.match(html, /typeof findPart\s*===\s*'function'\s*\?\s*findPart\(img\.fromDbArticle\)\s*:\s*null/,
    'log photo snapshotting must not fail the whole usage event when DB helper findPart is unavailable');
  assert.match(html, /const direct\s*=\s*imageUrlList\(row\);\s*if\(direct\.length\) return direct;/,
    'new log rows with ImageURLs must prefer the immutable snapshot saved with the log row');
  assert.match(html, /function uniqueUsageFallbackImageMatch\(rows,\s*predicate\)/,
    'older log rows without ImageURLs still need a guarded fallback image resolver');
  assert.match(html, /matches\.length\s*===\s*1\s*\?\s*matches\[0\]\.urls\s*:\s*\[\]/,
    'fallback by part name must only be used when it resolves to one unambiguous photo source');
  assert.match(html, /rowMachineCustomerMatches\(row,\s*p\)/,
    'pending-queue fallback should use machine/customer context to avoid borrowing photos from another order');
  assert.match(html, /function usageLegacyNameMatches\(candidate,\s*query\)/,
    'legacy rows with codeless or shortened part names should recover photos by a guarded unique prefix match');
  assert.match(html, /function usageLegacySearchTexts\(row\)/,
    'legacy image recovery must search part aliases/search fields, not only the main Description column');
  assert.match(html, /usageLegacySearchTexts\(p\)\.some\(candidate=>usageLegacyNameMatches\(candidate,\s*name\)\)/,
    'master DB fallback should match unique alias/search text such as Eaton PKZM0-16, not only exact Description text');
});

test('pending DB queue can add multiple photos at once', () => {
  assert.match(html, /class="pend-img-input"[^>]*multiple/,
    'pending queue thumbnails must accept multiple selected photos');
  assert.match(html, /class="rp-img-input"[^>]*multiple/,
    'resolve-pending modal must accept multiple selected photos');
  assert.match(html, /for\(const f of files\)[\s\S]{0,900}addPendingPart/,
    'pending queue upload must append every selected file to ImageURLs');
  assert.match(html, /imageUrls = imageUrlList\(imageUrls\.concat\(uploadedUrls\)\)/,
    'resolve-pending modal must merge all uploaded photo URLs');
});

test('part autocomplete ignores image metadata and supports rich part-name fields', () => {
  assert.match(html, /const NON_SEARCH_COLS\s*=\s*\/\^\(imageurl\|imageurls\|image_url\|image_urls\|image url\|image urls\)\$\/i/,
    'search suggestions must ignore both legacy ImageURL and multi-photo ImageURLs metadata');
  assert.match(html, /function fieldTextValue\(el\)/,
    'autocomplete needs one reader that works for input and contenteditable fields');
  assert.match(html, /renderValueSuggestions[\s\S]{0,180}fieldTextValue\(inputEl\)/,
    'generic dropdowns must not assume every field exposes .value');
  assert.match(html, /openPartSuggestions\(ac,\s*idx,\s*\(\)=>fieldTextValue\(el\)\)/,
    'Part Name focus should use the rich-field text content when showing suggestions');
  assert.match(html, /async function ensurePartSuggestionsReady\(\)/,
    'part suggestions should warm the lookup cache when the user opens the combo before sync finishes');
  assert.match(html, /function showPartSuggestionsLoading\(ac\)/,
    'Article / Part Name combos should show a visible dropdown while the parts cache is warming');
  assert.match(html, /กำลังโหลดรายการอะไหล่/,
    'the parts combo must not disappear silently when the cache is still empty');
  assert.match(html, /function openPartSuggestions\(ac,\s*idx,\s*getQuery\)/,
    'Article and Part Name focus handlers need a shared warm-and-rerender path');
  assert.match(html, /openPartSuggestions\(ac,\s*idx,\s*\(\)=>fieldTextValue\(el\)\)/,
    'Part Name focus should re-render suggestions after a late cache warm-up');
  assert.match(html, /openPartSuggestions\(ac,\s*idx,\s*\(\)=>fieldTextValue\(el\)\)/,
    'Article/Part combos should not stay empty just because the cache was initially empty');
  assert.doesNotMatch(html, /k === 'Description' \|\| k === 'ArticleNo'\) continue;\s*if\(NON_SEARCH_COLS/,
    'alias matching must skip non-search image fields before treating them as predict words');
});

test('part editor can append and delete multiple stored photos', () => {
  assert.match(html, /let imageUrls\s*=\s*imageUrlList\(part\)/,
    'edit modal must start from the complete stored image list');
  assert.match(html, /let pendingImages\s*=\s*\[\]/,
    'edit modal must queue multiple new photos before save');
  assert.match(html, /class="epm-img-input"[^>]*multiple/,
    'edit modal file picker must accept multiple files');
  assert.match(html, /epm-img-grid/,
    'edit modal must render a grid/list of all current and newly added photos');
  assert.match(html, /epm-img-del[^}]+data-kind="existing"/,
    'edit modal must allow deleting one existing stored photo without clearing every photo');
  assert.match(html, /epm-img-del[^}]+data-kind="pending"/,
    'edit modal must allow deleting one newly-added pending photo before save');
  assert.match(html, /for\(const pending of pendingImages\)/,
    'save must upload every newly-added image');
  assert.match(html, /payload\.imageURLs\s*=\s*finalImageUrls/,
    'updatePart must receive the full final image list');
  assert.match(html, /applyImageUrlsToRecord\(part,\s*finalImageUrls\)/,
    'local database view must immediately reflect append/delete image changes');
  assert.match(backendSource, /var oldImageUrls\s*=\s*mergeImageUrls_/,
    'backend updatePart must compare the old multi-photo list');
  assert.match(backendSource, /removedImageUrls\.forEach\(function \(url\) \{ trashDriveImage_\(url\); \}\)/,
    'backend should trash Drive files removed from the multi-photo list');
  assert.match(html, /class="item-photo-img"[\s\S]{0,140}object-fit:contain/,
    'order photo editor must keep auto-fit contain inline so images do not stretch');
  assert.match(html, /function naturalContainBox\(img,\s*boxRatio\)/,
    'photo rendering must calculate natural-aspect fit boxes instead of stretching images to the cell shape');
  assert.match(html, /aspect:\s*w\s*\/\s*h/,
    'newly-added photos must remember their real aspect ratio for editor/PDF rendering');
  assert.match(html, /function attachFocusDrag\(el,\s*box,\s*idx\)[\s\S]{0,500}HOLD_MS_MOVE/,
    'long-pressing the center focus handle should be able to move the whole photo box');
  assert.match(html, /boxMoveActive[\s\S]{0,700}img\.x\s*=\s*toFrac\(nl,\s*rect\.width\)/,
    'the long-press focus-handle path must update the photo box x/y freely');
});

test('database and pending queues can filter/export parts by machine model usage', () => {
  assert.match(html, /async function ensureDbPartMachineUsageIndex\(\)/,
    'parts DB filtering must build a machine-model index from usage history');
  assert.match(html, /const DB_PART_MACHINE_USAGE_LIMIT\s*=\s*2000/,
    'the machine-model index should cover more than the visible log page while staying bounded for mobile performance');
  assert.match(html, /lookupApiCall\('getAllPartUsage',\s*\{\s*limit:\s*DB_PART_MACHINE_USAGE_LIMIT,\s*includeRecovered:\s*false\s*\}\)/,
    'the machine-model index should use current PartUsage rows, not recovered-only local draft data');
  assert.match(html, /function dbPartMachineTypes\(part\)/,
    'each master part needs derived machine types used by that Article/Part name');
  assert.match(html, /pending:\s*\{\s*data:\(\)=>_pendingPartsCache\|\|pending,\s*fields:\['RequisitionName','MachineType','MachineNo','Customer'\]/,
    'the pending DB tab must expose MachineType as a searchable/filterable field');
  assert.match(html, /parts:\s*\{\s*data:\(\)=>partsWithMachineUsage\(lookupCache\.parts\),\s*fields:\['ArticleNo','Description','_MachineTypes'\]/,
    'the parts DB tab must filter master parts by machine models they were used with');
  assert.match(html, /groups:\(\)=>\[\s*\{\s*label:'รุ่นเครื่อง',\s*values:dbPartMachineTypeValues\(\)/,
    'parts search dropdown should offer machine-model chips/groups');
  assert.match(html, /_MachineTypes:dbPartMachineTypes\(row\)\.join\(' '\)/,
    'parts export rows should keep the derived machine-model field so exports follow the active filter');
  assert.match(html, /if\(dbActiveTab === 'pending'\)\{\s*const cfg = FILTER_CFG\.pending;[\s\S]{0,420}renderPendingTable\(filtered\)/,
    'pending rows should be filtered before rendering so users can isolate one machine model');
  assert.match(html, /if\(tab==='parts' \|\| tab==='pending'\)/,
    'changing the machine-model filter should refresh the parts export batch count for parts and pending views');
  assert.match(html, /function filterTerms\(query\)/,
    'DB search must support several selected filters at once instead of replacing the previous chip');
  assert.match(html, /function toggleFilterTerm\(current,\s*term\)/,
    'clicking a chip/dropdown value should add or remove that one filter term');
  assert.match(html, /qTerms\.every\(w=>hay\.includes\(w\)\)/,
    'multi-filter matching should narrow results with AND semantics');
  assert.match(html, /const activeTerms\s*=\s*filterTerms\(inp\.value\)/,
    'chip rendering should derive the currently selected multi-filter terms once');
  assert.match(html, /chipRow\.querySelectorAll\('\.cbx-chip'\)[\s\S]{0,220}activeTerms\.includes\(c\.dataset\.val\.toLowerCase\(\)\)/,
    'several quick chips can stay active at the same time');
  assert.match(html, /o\.onmousedown[\s\S]{0,120}toggleFilterTerm\(inp\.value,\s*v\)/,
    'dropdown picks should append to the current filter instead of replacing it');
  assert.match(html, /class="part-machine-used"/,
    'part cards should briefly show which machine models the part has been used with');
  assert.match(html, /รุ่นที่เคยใช้/,
    'machine usage text should be explicit enough for future part compatibility work');
});

test('DB and pending photo lists can choose the primary image', () => {
  assert.match(html, /function moveImageUrlFirst\(urls,\s*index\)/,
    'choosing a primary image should move that URL to the front of ImageURLs');
  assert.match(html, /class="epm-img-main/,
    'part editor image tiles need a primary-image button');
  assert.match(html, /imageUrls\s*=\s*moveImageUrlFirst\(imageUrls,\s*i\)/,
    'part editor primary selection should reorder existing DB image URLs');
  assert.match(html, /pendingImages\s*=\s*moveImageUrlFirst\(pendingImages,\s*i\)/,
    'part editor primary selection should reorder newly-added images before upload');
  assert.match(html, /class="rp-img-main/,
    'pending DB resolver should expose a primary-image button too');
  assert.match(html, /imageUrls\s*=\s*moveImageUrlFirst\(imageUrls,\s*i\)[\s\S]{0,220}applyImageUrlsToRecord\(row,\s*imageUrls\)/,
    'pending primary selection should update the cached row so preview/export uses the chosen main image');
});

test('queued usage logs retry automatically without relying on an end-user button', () => {
  assert.match(html, /const LOOKUP_API_TIMEOUT_MS\s*=\s*20000/,
    'ordinary API calls such as Log loading must have a timeout so the UI cannot stay loading forever');
  assert.match(html, /if\(ownsController\)\s*init\.signal\s*=\s*controller\.signal/,
    'lookupApiCall should attach its own timeout signal when the caller did not provide one');
  assert.match(html, /lookupApiCall\('getAllPartUsage'[\s\S]{0,180}includeRecovered:\s*false/,
    'full Log loading must load current PartUsage rows first so the modal never waits on recovery merge');
  assert.match(html, /loadRecoveredUsageRowsInBackground/,
    'recovered rows should be a background enhancement after current logs are visible');
  assert.match(html, /const USAGE_OUTBOX_RETRY_DELAYS_MS\s*=\s*\[5000,\s*15000,\s*60000,\s*300000\]/,
    'automatic retries must back off instead of polling the backend continuously');
  assert.match(html, /async function flushUsageOutboxAutomatically\(\)/,
    'usage outbox needs a dedicated guarded automatic flush');
  assert.match(html, /lookupFlushOutbox\(\{usageOnly:true\}\)/,
    'automatic replay must only operate on queued usage events');
  assert.match(html, /outboxAdd\(\{action:'recordPartUsage'[\s\S]{0,500}scheduleUsageOutboxRetry\(\)/,
    'a newly queued usage event must schedule its own retry');
  assert.match(html, /emergencyUsageOutboxAdd\(\{action:'recordPartUsage'/,
    'if IndexedDB/localStorage queueing fails mid-export, usage events need a final emergency copy instead of being reported as lost');
  assert.match(html, /state:'queued'[\s\S]{0,180}emergencyQueued:true/,
    'an emergency local copy should still be shown to the user as queued, not as permanently unsaved');
  assert.match(html, /UsageLogCoreFallback/,
    'the app must keep a built-in usage-log core fallback if the module file is stale or fails to load');
  assert.match(html, /usageCoreSync\(\)\.usageStatusSuffix\(previewUsage\)/,
    'PDF preview status must not depend on a possibly missing module global');
  assert.match(html, /previewUsage\s*=\s*\{state:'failed',\s*error:logError\}/,
    'PDF preview log failures must surface the real error in the toast');
  assert.match(backendSource, /const PARTUSAGE_OUTBOX_SHEET\s*=\s*'PartUsageOutbox'/,
    'usage events that cannot reach PartUsage should have an online queue sheet');
  assert.match(backendSource, /case 'queuePartUsageEvent'/,
    'Apps Script must expose a durable online usage queue endpoint');
  assert.match(backendSource, /case 'replayPartUsageOutbox'/,
    'any device should be able to replay the online usage queue');
  assert.match(html, /async function queueUsageEventOnline\(event,\s*error\)/,
    'frontend failed usage events should try to land in the online outbox before falling back to local-only storage');
  assert.match(html, /lookupApiCall\('replayPartUsageOutbox'/,
    'manual and automatic Log sync should replay the shared online queue');
  assert.match(html, /document\.addEventListener\('visibilitychange'[\s\S]{0,300}flushUsageOutboxAutomatically\(\)/,
    'returning to the app must retry queued usage immediately');
  assert.match(html, /window\.addEventListener\('focus'[\s\S]{0,250}flushUsageOutboxAutomatically\(\)/,
    'focusing the app must retry queued usage immediately');
  assert.match(html, /window\.addEventListener\('online'[\s\S]{0,300}lookupStartupSync\(\)/,
    'network reconnection must run the startup sync pipeline');
  assert.match(html, /isPowerUser\(\)\?'<button type="button" class="btn log-sync-pending"/,
    'the manual diagnostic control must not be required or shown to ordinary users');
  assert.match(html, /class="epm-actions log-actions sticky-log-actions"/,
    'the Log export/action footer should stay visible while the Log rows scroll');
  assert.match(html, /\.sticky-log-actions\{[\s\S]{0,160}position:sticky[\s\S]{0,160}bottom:0/,
    'the sticky footer should be pinned to the bottom of the modal, not just the Excel file header');
});
