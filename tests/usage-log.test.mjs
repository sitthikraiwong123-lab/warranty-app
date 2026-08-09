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
    state:'queued', eventId:'evt-2', written:0, expectedItems:3, revision:null
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
  assert.equal(empty.recordedBy, '(unknown)');
  assert.throws(() => core.validateUsageAck(null, empty), /acknowledged/i);
  assert.throws(() => core.validateUsageAck({queued:true,eventId:'other'}, empty), /event/i);
  assert.deepEqual(core.validateUsageAck({success:true,eventId:'empty-event',written:0,revision:0}, empty), {
    state:'saved', eventId:'empty-event', written:0, expectedItems:0, revision:null
  });

  assert.equal(core.usageStatusSuffix(null), '');
  assert.match(core.usageStatusSuffix({state:'queued',expectedItems:2}), /รอซิงค์/);
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
  const spreadsheet = {
    getSheetByName(name) { return name === 'PartUsage' ? usageSheet : null; },
    insertSheet(name) { assert.equal(name, 'PartUsage'); return usageSheet; }
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
  vm.runInContext(backendSource + '\n;globalThis.__usageApi={recordPartUsage,getAllPartUsage,PARTUSAGE_HEADERS};', context);
  return { usageSheet, api:context.__usageApi };
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

test('every user-visible order action is wired to an append-only usage event', () => {
  assert.match(html, /<script type="module" src="\.\/usage-log-core\.mjs"><\/script>/);
  assert.match(worker, /'\.\/usage-log-core\.mjs'/);
  assert.match(worker, /schmoll-export-v8/,
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
});
