/* ============================================================
   Schmoll Export/Warranty Form - Machine & Part Lookup Database
   Backend: Google Apps Script (bound to its own Spreadsheet)
   ============================================================

   This is a SEPARATE database from the WSP system - it only
   exists to power auto-fill inside index-2.html (the Export/
   Warranty PDF form). Same no-login design: a small trusted
   team, so there is no password check on the API.

   SETUP:
   1. Extensions -> Apps Script -> paste this file as Code.gs
   2. Run the function "setupMissingSheets" once (Run menu, or
      the "Lookup Admin" menu after reloading the spreadsheet) -
      this creates the Parts/Pending_Machines/Pending_Parts tabs
      automatically. Your existing "MC List" tab is used
      as-is for Machines; nothing about it needs to change.
   3. Deploy -> New deployment -> Web app
        Execute as: Me
        Who has access: Anyone
   4. Copy the deployment URL into index-2.html's LOOKUP_API_URL constant
*/

const SHEETS = {
  MACHINES: 'MC List',         // your existing tab - used as-is
  PARTS: 'Part No.',           // your existing tab - used as-is (note the trailing period)
  COMPANIONS: 'Companion'      // NEW optional tab: parts that are requisitioned together (see getCompanionGroups)
};

// Paste your Google Drive folder ID here (open the folder → copy the ID from the URL after /folders/)
const IMAGE_FOLDER_ID = '1CrTf-wl-7Bjsn4emxXViuJRi2LkSTzWA';

// Your "MC List" tab uses its own column names. This maps them to the
// standard field names the app expects, so nothing about your sheet needs to
// change. (Extra columns like "CNC version" and "Warranty Over" are simply
// carried through untouched - they don't need a mapping entry.)
const MACHINE_HEADER_MAP = {
  'Machine Serial Number': 'MachineNumber',
  'Customer name': 'CustomerName',
  'Machine Type': 'MachineType'
};
const MACHINE_HEADER_MAP_REVERSE = (function(map){
  const out = {};
  Object.keys(map).forEach(k => { out[map[k]] = k; });
  return out;
})(MACHINE_HEADER_MAP);

// "Part No." tab: only Article No. needs renaming (note the period); Description
// already matches. CNC Ver and the 9 "Suggestion word" alias columns pass
// through untouched - they're preserved in the synced data for future use
// (e.g. alias-based search), just not used by the simple exact-match
// auto-fill in index-2.html yet.
const PART_HEADER_MAP = {
  'Article No.': 'ArticleNo'
};
const PART_HEADER_MAP_REVERSE = (function(map){
  const out = {};
  Object.keys(map).forEach(k => { out[map[k]] = k; });
  return out;
})(PART_HEADER_MAP);

function doGet(e) { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

function handleRequest(e) {
  let result;
  try {
    const params = (e.postData && e.postData.contents) ? JSON.parse(e.postData.contents) : e.parameter;
    switch (params.action) {
      case 'fullSync':      result = fullSync(); break;
      case 'deltaSync':     result = deltaSync(params); break;
      case 'recordNew':     result = recordNew(params); break;
      case 'deleteRecord':  result = deleteRecord(params); break;
      case 'deleteAlias':   result = deleteAlias(params); break;
      case 'uploadImage':   result = uploadImage(params); break;
      case 'uploadPdf':     result = uploadPdf(params); break;
      case 'setImageURL':   result = setImageURL(params); break;
      case 'getImageBytes': result = getImageBytes(params); break;
      case 'repairImages':  result = repairImages(params); break;
      case 'updatePart':    result = updatePart(params); break;
      case 'updateMachine': result = updateMachine(params); break;
      case 'getEditLog':    result = getEditLog(params); break;
      case 'restorePart':   result = restorePart(params); break;
      case 'softDeletePart':     result = softDeletePart(params); break;
      case 'getRecycleBin':      result = getRecycleBin(params); break;
      case 'restoreDeletedPart': result = restoreDeletedPart(params); break;
      case 'logout':             result = logoutSession(params); break;
      case 'saveCompanionSet':   result = saveCompanionSet(params); break;
      case 'deleteCompanionSet': result = deleteCompanionSet(params); break;
      case 'recordPartUsage':    result = recordPartUsage(params); break;
      case 'getPartUsage':       result = getPartUsage(params); break;
      case 'getAllPartUsage':    result = getAllPartUsage(params); break;
      case 'recoverPartUsageDrafts': result = recoverPartUsageDrafts(params); break;
      case 'deletePartUsage':    result = deletePartUsage(params); break;
      case 'updatePartUsage':    result = updatePartUsage(params); break;
      case 'backfillPartUsageArticleNo': result = backfillPartUsageArticleNo(params); break;
      case 'addPendingPart':     result = addPendingPart(params); break;
      case 'getPendingParts':    result = getPendingParts(params); break;
      case 'deletePendingPart':  result = deletePendingPart(params); break;
      case 'getEmailRecipients':   result = getEmailRecipients(params); break;
      case 'addEmailRecipient':    result = addEmailRecipient(params); break;
      case 'deleteEmailRecipient': result = deleteEmailRecipient(params); break;
      case 'getSendEmailRecipients':   result = getSendEmailRecipients(params); break;
      case 'addSendEmailRecipient':    result = addSendEmailRecipient(params); break;
      case 'deleteSendEmailRecipient': result = deleteSendEmailRecipient(params); break;
      case 'getAppSettings':     result = getAppSettings(); break;
      case 'setAppSettings':     result = setAppSettings(params); break;
      case 'reserveExportNumber':result = reserveExportNumber(params); break;
      case 'ping':          result = { success: true, time: Date.now() }; break;
      case 'debugHeaders':  result = debugHeaders(); break;
      default:              result = { success: false, error: 'Unknown action: ' + params.action };
    }
  } catch (err) {
    result = { success: false, error: String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// APP SETTINGS (global, shared by every client) + running export number
// ------------------------------------------------------------
// Power-User feature flags and the running export-number counter live here in
// Script Properties (one JSON blob) rather than in each browser's localStorage,
// so they are "neutral": when an admin flips a flag or edits the number, every
// device picks up the same value on its next load. The number is handed out by
// reserveExportNumber() under a script lock, so two people exporting at the same
// moment can never receive the same number.
// ============================================================
const APP_SETTINGS_KEY = 'APP_SETTINGS';
function defaultAppSettings_() {
  return {
    fmtToolbar: false,        // format toolbar (B/I/U/colour) — global on/off
    runNumberEnabled: false,  // running export number — global on/off
    paSend: false,            // Power Automate direct send — global on/off
    paUrl: '',                // Power Automate HTTP trigger URL
    hideSendEmail: true,      // hide the ✉ Send to email button app-wide (default HIDDEN — a Power User reveals it from ☰)
    hideAutoEmail: true,      // hide the ⚡ Auto email button app-wide (default HIDDEN — a Power User reveals it from the ⚡ page)
    defaultInvoiceAddress: '', // remembered default invoice address for new orders ('' ⇒ frontend uses built-in company address)
    defaultShippingAddress: '',// remembered default shipping address for new orders
    runPrefix: 'TL',          // number prefix, e.g. TL2026-001
    runYear: (new Date()).getFullYear(),
    runNext: 1,               // next sequence to hand out
    // Azure app registration used by ✉ Send to email to create a real Outlook
    // draft through Microsoft Graph. ONE registration shared by the team; each
    // person signs in as themselves, so the draft lands in their OWN mailbox.
    // Empty clientId ⇒ the frontend falls back to the .eml download path.
    // Neither value is a secret: a SPA registration is a public client and the
    // client id is visible in the browser anyway.
    graphClientId: '',
    graphTenantId: 'common',
    // ✉ email draft: whether the preview's draft box can be edited per order
    // (one-off, not saved), and the shared template the draft is built from.
    // Empty template ⇒ the frontend falls back to its built-in wording.
    emailDraftEditable: false,
    emailDraftTemplate: ''
  };
}
function readAppSettings_() {
  const raw = PropertiesService.getScriptProperties().getProperty(APP_SETTINGS_KEY);
  let stored = {};
  if (raw) { try { stored = JSON.parse(raw); } catch (e) { stored = {}; } }
  const out = defaultAppSettings_();
  Object.keys(out).forEach(function(k) {
    if (stored[k] !== undefined && stored[k] !== null) out[k] = stored[k];
  });
  return out;
}
function writeAppSettings_(s) {
  PropertiesService.getScriptProperties().setProperty(APP_SETTINGS_KEY, JSON.stringify(s));
}
function pad3_(n) { n = String(n); return n.length >= 3 ? n : ('000' + n).slice(-3); }

function getAppSettings() {
  return { success: true, settings: readAppSettings_() };
}

// Merge a whitelisted patch into the global settings. Used by the Power-User
// toggles (feature on/off) and the "edit running number" control.
function setAppSettings(params) {
  const patch = (params && params.settings) || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const s = readAppSettings_();
    ['fmtToolbar', 'runNumberEnabled', 'paSend', 'paUrl', 'hideSendEmail', 'hideAutoEmail', 'defaultInvoiceAddress', 'defaultShippingAddress', 'runPrefix', 'runYear', 'runNext', 'graphClientId', 'graphTenantId', 'emailDraftEditable', 'emailDraftTemplate'].forEach(function(k) {
      if (patch[k] !== undefined) s[k] = patch[k];
    });
    s.fmtToolbar = !!s.fmtToolbar;
    s.runNumberEnabled = !!s.runNumberEnabled;
    s.paSend = !!s.paSend;
    s.paUrl = String(s.paUrl || '').trim();
    s.hideSendEmail = !!s.hideSendEmail;
    s.hideAutoEmail = !!s.hideAutoEmail;
    s.defaultInvoiceAddress = String(s.defaultInvoiceAddress || '').slice(0, 1000);
    s.defaultShippingAddress = String(s.defaultShippingAddress || '').slice(0, 1000);
    s.runPrefix = String(s.runPrefix || 'TL').trim().slice(0, 8) || 'TL';
    s.runYear = parseInt(s.runYear, 10) || (new Date()).getFullYear();
    s.runNext = Math.max(1, parseInt(s.runNext, 10) || 1);
    s.graphClientId = String(s.graphClientId || '').trim().slice(0, 100);
    s.graphTenantId = String(s.graphTenantId || 'common').trim().slice(0, 100) || 'common';
    s.emailDraftEditable = !!s.emailDraftEditable;
    // Not trimmed: leading/trailing blank lines are legitimate formatting in a
    // mail body. Generous cap — this is a whole email template, not a field.
    s.emailDraftTemplate = String(s.emailDraftTemplate || '').slice(0, 4000);
    writeAppSettings_(s);
    return { success: true, settings: s };
  } finally {
    lock.releaseLock();
  }
}

// Atomically hand out the next running export number and advance the counter.
// Rolls the sequence back to 1 whenever the calendar year changes.
function reserveExportNumber(params) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const s = readAppSettings_();
    const curYear = (new Date()).getFullYear();
    if (parseInt(s.runYear, 10) !== curYear) { s.runYear = curYear; s.runNext = 1; }
    const seq = Math.max(1, parseInt(s.runNext, 10) || 1);
    const formatted = String(s.runPrefix || 'TL') + s.runYear + '-' + pad3_(seq);
    s.runNext = seq + 1;
    writeAppSettings_(s);
    return { success: true, prefix: s.runPrefix, year: s.runYear, seq: seq, formatted: formatted, next: s.runNext };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// SHEET HELPERS
// ============================================================
function getSheet(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name);
  return sheet;
}

// Finds a column by name, tolerating extra spaces / different casing in the
// real sheet header (e.g. "Description " or "description" both match "Description").
// Falls back to an exact match first (fast path), then a normalized comparison.
function findColIdx(headers, name) {
  let idx = headers.indexOf(name);
  if (idx !== -1) return idx;
  const target = String(name).trim().toLowerCase();
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim().toLowerCase() === target) return i;
  }
  return -1;
}

function sheetToObjects(name, headerMap) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];

  // Normalize the header map's keys too, so it still matches even if the real
  // sheet header has extra whitespace or different casing than expected.
  let normalizedMap = null;
  if (headerMap) {
    normalizedMap = {};
    Object.keys(headerMap).forEach(k => { normalizedMap[String(k).trim().toLowerCase()] = headerMap[k]; });
  }

  return data.slice(1)
    .filter(row => row.some(c => c !== '' && c !== null))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        const hNorm = String(h).trim().toLowerCase();
        const key = (normalizedMap && normalizedMap[hNorm]) ? normalizedMap[hNorm] : String(h).trim();
        obj[key] = row[i];
      });
      return obj;
    });
}

// ============================================================
// SYNC
// ============================================================
function fullSync() {
  return {
    success: true,
    machines: sheetToObjects(SHEETS.MACHINES, MACHINE_HEADER_MAP),
    parts: sheetToObjects(SHEETS.PARTS, PART_HEADER_MAP),
    companions: getCompanionSets(),
    syncedAt: Date.now()
  };
}

// Reads the optional "Companion" tab. Each ROW is one "requisition-as-a-set":
//   Col A = Set Name, Col B = combined-image URL, Col C onwards = part Article
//   Nos (the FIRST one is the main/trigger part). No header row.
// Example:  WATERFILTER POLYMER | https://.../img | 72656 | 72657
//   → picking 72656 suggests 72657, and the set image goes on the main part.
// Managed in-app via the "ชุดเบิก" tab (saveCompanionSet / deleteCompanionSet).
// Optional: if the tab doesn't exist, returns [].
function getCompanionSets() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.COMPANIONS);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  const sets = [];
  data.forEach(function (row) {
    const name = String(row[0] == null ? '' : row[0]).trim();
    const image = String(row[1] == null ? '' : row[1]).trim();
    const parts = row.slice(2).map(function (c) { return String(c == null ? '' : c).trim(); }).filter(function (c) { return c !== ''; });
    if (name || parts.length) sets.push({ name: name, image: image, parts: parts, trigger: parts[0] || '' });
  });
  return sets;
}

// Find the 1-based row of a set by name (case-insensitive), or -1.
function findCompanionRow_(sheet, name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return -1;
  const data = sheet.getDataRange().getValues();
  for (var r = 0; r < data.length; r++) {
    if (String(data[r][0] == null ? '' : data[r][0]).trim().toLowerCase() === key) return r + 1;
  }
  return -1;
}

// Upsert a set. params: { name, imageURL, parts:[...], origName? }
function saveCompanionSet(params) {
  const name = String(params.name || '').trim();
  if (!name) return { success: false, error: 'ต้องตั้งชื่อชุด' };
  const image = String(params.imageURL || '').trim();
  const parts = (params.parts || []).map(function (p) { return String(p || '').trim(); }).filter(function (p) { return p; });
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEETS.COMPANIONS);
  if (!sheet) sheet = ss.insertSheet(SHEETS.COMPANIONS);

  const rowValues = [name, image].concat(parts);
  const origName = String(params.origName || name).trim();
  let rowNum = findCompanionRow_(sheet, origName);
  // if renaming to a name that already exists elsewhere, block
  if (origName.toLowerCase() !== name.toLowerCase()) {
    const clash = findCompanionRow_(sheet, name);
    if (clash !== -1 && clash !== rowNum) return { success: false, error: 'มีชุดชื่อ "' + name + '" อยู่แล้ว' };
  }
  if (rowNum === -1) {
    sheet.appendRow(rowValues);
  } else {
    // clear the old row first (it may have had more parts than the new one)
    sheet.getRange(rowNum, 1, 1, Math.max(sheet.getLastColumn(), rowValues.length)).clearContent();
    sheet.getRange(rowNum, 1, 1, rowValues.length).setValues([rowValues]);
  }
  return { success: true, name: name };
}

function deleteCompanionSet(params) {
  const name = String(params.name || '').trim();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.COMPANIONS);
  if (!sheet) return { success: true };
  const rowNum = findCompanionRow_(sheet, name);
  if (rowNum !== -1) sheet.deleteRow(rowNum);
  return { success: true };
}

function deltaSync(params) {
  const since = Number(params.since) || 0;
  function filtered(name, headerMap) {
    return sheetToObjects(name, headerMap).filter(r => {
      if (!r.LastModified) return true;
      const t = new Date(r.LastModified).getTime();
      return isNaN(t) ? true : t > since;
    });
  }
  return {
    success: true,
    machines: filtered(SHEETS.MACHINES, MACHINE_HEADER_MAP),
    parts: filtered(SHEETS.PARTS, PART_HEADER_MAP),
    deletedKeys: getTombstonesSince_(since),
    companions: getCompanionSets(), // small list — always sent in full, even on delta sync
    syncedAt: Date.now()
  };
}

// ============================================================
// RECORD NEW MACHINE/PART - typed straight into index-2.html
// when the number isn't found. Per your call: write directly
// into the master sheet immediately (no separate review stage).
// If something's wrong, just delete that row directly in the
// sheet - Google Sheets' own "File > Version history" already
// shows exactly what was added and when, so no extra tooling
// is needed for that.
// ============================================================
function appendDirectToMaster(sheetName, headerMap, data) {
  const sheet = getSheet(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = headers.map(h => {
    if (h === 'LastModified') return new Date();
    const standardKey = (headerMap && headerMap[h]) ? headerMap[h] : h;
    return data[standardKey] !== undefined ? data[standardKey] : '';
  });
  sheet.appendRow(row);
}

const MASTER_SHEET_FOR_TYPE = {
  Machine: { name: SHEETS.MACHINES, map: MACHINE_HEADER_MAP },
  Part: { name: SHEETS.PARTS, map: PART_HEADER_MAP }
};

// Finds header columns that look like "Suggestion word..." regardless of exact
// spacing/numbering, so we don't depend on the sheet's exact column text.
function findAliasColumnIndexes(headers) {
  const out = [];
  headers.forEach((h, i) => { if (/suggestion\s*word/i.test(h)) out.push(i); });
  return out;
}

// Looks at the trailing number in each existing "Suggestion word" header
// (word1...word9) and returns the next number to use (10, 11, 12...).
function getNextAliasColumnNumber(headers, aliasCols) {
  let maxNum = 0;
  aliasCols.forEach(ci => {
    const m = String(headers[ci]).match(/(\d+)\s*$/);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  });
  return maxNum + 1;
}

// ============================================================
// TOMBSTONES - when something is deleted via the app, we remember
// it for a while so a delayed offline-outbox replay from someone's
// phone can't resurrect data that was deliberately removed.
// ============================================================
const TOMBSTONE_SHEET = 'DeletedKeys';
const TOMBSTONE_WINDOW_MS = 7 * 24 * 3600 * 1000; // 7 days

function getTombstoneSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(TOMBSTONE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(TOMBSTONE_SHEET);
    sheet.getRange(1, 1, 1, 3).setValues([['Type', 'Key', 'DeletedAt']]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function recordTombstone(type, key) {
  const sheet = getTombstoneSheet();
  sheet.appendRow([type, String(key).trim().toLowerCase(), new Date()]);
}

// Delta sync must carry deletions too. Without this, removing a sheet row can
// never remove the corresponding row from another device's merge-only cache.
function getTombstonesSince_(since) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TOMBSTONE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const cutoff = Number(since) || 0;
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  const out = [];
  data.forEach(function(row) {
    const deletedAt = row[2] instanceof Date ? row[2].getTime() : new Date(row[2]).getTime();
    if (!isNaN(deletedAt) && deletedAt > cutoff) {
      out.push({ Type: String(row[0] || ''), Key: String(row[1] || ''), DeletedAt: deletedAt });
    }
  });
  return out;
}

// Returns true if this key was deleted recently enough that we should refuse
// to silently re-insert it (a delayed offline sync trying to "undo" a deletion).
function wasRecentlyDeleted(type, key) {
  const sheet = getTombstoneSheet();
  const data = sheet.getDataRange().getValues();
  const keyLower = String(key).trim().toLowerCase();
  const cutoff = Date.now() - TOMBSTONE_WINDOW_MS;
  for (let r = data.length - 1; r >= 1; r--) {
    if (data[r][0] === type && String(data[r][1]).trim().toLowerCase() === keyLower) {
      const deletedAt = new Date(data[r][2]).getTime();
      if (deletedAt >= cutoff) return true;
    }
  }
  return false;
}

// ============================================================
// PART HELPERS
// ============================================================
function findRowByExactValue(data, colIdx, value) {
  const v = String(value).trim().toLowerCase();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][colIdx]).trim().toLowerCase() === v) return r;
  }
  return -1;
}

// Finds a CODELESS row (empty ArticleNo) whose Description or any alias
// column exactly matches the given text (case-insensitive).
function findCodelessRowMatching(data, articleNoColIdx, descColIdx, aliasCols, text, excludeRow) {
  const v = String(text).trim().toLowerCase();
  if (!v) return -1;
  for (let r = 1; r < data.length; r++) {
    if (r === excludeRow) continue;
    if (String(data[r][articleNoColIdx]).trim()) continue; // has a code already, skip
    if (String(data[r][descColIdx] || '').trim().toLowerCase() === v) return r;
    for (let i = 0; i < aliasCols.length; i++) {
      if (String(data[r][aliasCols[i]] || '').trim().toLowerCase() === v) return r;
    }
  }
  return -1;
}

function recordNewPart(params, target) {
  const sheet = getSheet(target.name);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  let realArticleNoHeader = 'ArticleNo';
  Object.keys(target.map).forEach(rh => { if (target.map[rh] === 'ArticleNo') realArticleNoHeader = rh; });
  const articleNoColIdx = findColIdx(headers, realArticleNoHeader);
  const descColIdx = findColIdx(headers, "Description");
  const aliasCols = findAliasColumnIndexes(headers);

  const newArticleNo = String((params.data || {}).ArticleNo || '').trim();
  const newDesc = String((params.data || {}).Description || '').trim();

  // ----- No Article No given: codeless entry (name known, code not known yet) -----
  if (!newArticleNo) {
    if (!newDesc) return { success: true, action: 'noop_empty' };
    if (wasRecentlyDeleted('Part', newDesc)) return { success: true, action: 'blocked_recently_deleted' };
    const dup = findCodelessRowMatching(data, articleNoColIdx, descColIdx, aliasCols, newDesc, -1);
    if (dup !== -1) return { success: true, action: 'duplicate_noop' };
    appendDirectToMaster(target.name, target.map, params.data || {});
    return { success: true, action: 'inserted_codeless' };
  }

  if (wasRecentlyDeleted('Part', newArticleNo)) return { success: true, action: 'blocked_recently_deleted' };

  // ----- Article No given -----
  const existingRow = findRowByExactValue(data, articleNoColIdx, newArticleNo);

  if (existingRow === -1) {
    // Genuinely new Article No - but maybe a codeless row should "graduate" into it
    // instead of creating a duplicate-looking second entry for the same part.
    const codelessRow = findCodelessRowMatching(data, articleNoColIdx, descColIdx, aliasCols, newDesc, -1);
    if (codelessRow !== -1) {
      sheet.getRange(codelessRow + 1, articleNoColIdx + 1).setValue(newArticleNo);
      return { success: true, action: 'graduated_codeless' };
    }
    appendDirectToMaster(target.name, target.map, params.data || {});
    return { success: true, action: 'inserted' };
  }

  // Article No already exists - is the description actually new info?
  let resultAction = 'duplicate_noop';
  if (newDesc) {
    const existingDesc = String(data[existingRow][descColIdx] || '').trim();
    if (newDesc.toLowerCase() !== existingDesc.toLowerCase()) {
      const alreadyKnown = aliasCols.some(ci =>
        String(data[existingRow][ci] || '').trim().toLowerCase() === newDesc.toLowerCase());
      if (!alreadyKnown) {
        const emptyCol = aliasCols.find(ci => !String(data[existingRow][ci] || '').trim());
        if (emptyCol === undefined) {
          const nextNum = getNextAliasColumnNumber(headers, aliasCols);
          const newColIdx1Based = sheet.getLastColumn() + 1;
          sheet.getRange(1, newColIdx1Based).setValue('Suggestion word' + nextNum);
          sheet.getRange(existingRow + 1, newColIdx1Based).setValue(newDesc);
          resultAction = 'alias_added_new_column';
        } else {
          sheet.getRange(existingRow + 1, emptyCol + 1).setValue(newDesc);
          resultAction = 'alias_added';
        }
      }
    }
  }

  // Cleanup: if a separate codeless row turns out to describe this same part
  // (matches the Description we just confirmed belongs under this Article No),
  // fold it in - it's now redundant.
  const orphan = findCodelessRowMatching(data, articleNoColIdx, descColIdx, aliasCols, newDesc, existingRow);
  if (orphan !== -1) {
    sheet.deleteRow(orphan + 1);
    resultAction += '+merged_codeless_deleted';
  }

  return { success: true, action: resultAction };
}

// Diagnostic: shows the EXACT raw header text (quotes reveal hidden whitespace)
// for both sheets, so header-matching issues can be confirmed without guessing.
// Uploads a base64-encoded image to the configured Drive folder and returns a
// public view URL.  Requires IMAGE_FOLDER_ID to be set in the config above AND
// the Drive API to be authorized (Apps Script will ask on first deploy).
function uploadImage(params) {
  if (IMAGE_FOLDER_ID === 'PASTE_YOUR_DRIVE_FOLDER_ID_HERE') {
    throw new Error('IMAGE_FOLDER_ID ยังไม่ได้ตั้งค่าใน Code.gs — เปิด folder ใน Drive แล้ว copy ID จาก URL มาใส่');
  }
  const base64 = params.base64;
  const mimeType = params.mimeType || 'image/jpeg';
  const filename = params.filename || ('part_' + Date.now() + '.jpg');
  if (!base64) throw new Error('No base64 image data provided');

  const folder = DriveApp.getFolderById(IMAGE_FOLDER_ID);
  const bytes = Utilities.base64Decode(base64);
  const blob = Utilities.newBlob(bytes, mimeType, filename);
  const file = folder.createFile(blob);

  // Try to make it public, but DON'T fail the whole upload if the org's Drive
  // policy forbids link-sharing (that throws "Access denied: DriveApp." AFTER
  // the file is already created — the file's fine, only sharing was blocked).
  // When sharing is blocked the app falls back to the getImageBytes proxy,
  // which reads the file as the owner and never needs public sharing.
  const fileId = file.getId();
  const shared = shareFileAnyone_(file);

  // Use the thumbnail-friendly URL format that works reliably in <img> tags
  const url = 'https://lh3.googleusercontent.com/d/' + fileId;
  return { success: true, url: url, fileId: fileId, shared: shared };
}

// Uploads a base64 PDF to a dedicated Drive folder and returns a view link.
// Used by the app's ✉ Send-to-email flow: mailto: cannot carry an attachment,
// so the PDF rides the email as a Drive link instead.
const PDF_FOLDER_NAME = 'WarrantyApp Sent PDFs';
function getPdfFolder_() {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty('pdfFolderId');
  if (cached) {
    try { return DriveApp.getFolderById(cached); } catch (e) {}
  }
  const it = DriveApp.getFoldersByName(PDF_FOLDER_NAME);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(PDF_FOLDER_NAME);
  props.setProperty('pdfFolderId', folder.getId());
  return folder;
}

function uploadPdf(params) {
  const base64 = params.base64;
  if (!base64) throw new Error('base64 required');
  let filename = String(params.filename || '').trim() || ('export_order_' + Date.now() + '.pdf');
  if (!/\.pdf$/i.test(filename)) filename += '.pdf';
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), 'application/pdf', filename);
  const file = getPdfFolder_().createFile(blob);
  const shared = shareFileAnyone_(file);
  return {
    success: true,
    url: 'https://drive.google.com/file/d/' + file.getId() + '/view',
    fileId: file.getId(),
    shared: shared
  };
}

// Try anyone-with-link, then domain-with-link; never throws. Returns
// true / 'domain' / false so callers can tell whether public sharing worked.
function shareFileAnyone_(file) {
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); return true; }
  catch (e1) {
    try { file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); return 'domain'; }
    catch (e2) { return false; }
  }
}

// Writes an image URL into the ImageURL column for an existing coded part.
// Called after uploadImage succeeds for a part that was coded but had no image yet.
function setImageURL(params) {
  const articleNo = String(params.articleNo || '').trim();
  const url = String(params.url || '').trim();
  if (!articleNo || !url) throw new Error('articleNo and url are required');

  const sheet = getSheet(SHEETS.PARTS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  let realArticleNoHeader = 'Article No.';
  Object.keys(PART_HEADER_MAP).forEach(rh => { if (PART_HEADER_MAP[rh] === 'ArticleNo') realArticleNoHeader = rh; });
  const articleNoColIdx = findColIdx(headers, realArticleNoHeader);

  // Auto-create the ImageURL column if the sheet doesn't have one yet, so the
  // first-ever image attach (e.g. from the Add-Spare-Part form) doesn't fail.
  // This mirrors updatePart(), which also creates the column on demand.
  let imageUrlColIdx = findColIdx(headers, 'ImageURL');
  if (imageUrlColIdx === -1) {
    imageUrlColIdx = headers.length;
    sheet.getRange(1, imageUrlColIdx + 1).setValue('ImageURL');
  }
  const lastModColIdx = findColIdx(headers, 'LastModified');

  const keyLower = articleNo.toLowerCase();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][articleNoColIdx]).trim().toLowerCase() !== keyLower) continue;
    sheet.getRange(r + 1, imageUrlColIdx + 1).setValue(url);
    ensureImageShared_(url);                     // make it viewable in <img> tags
    // Bump LastModified so the next deltaSync re-emits this row with its image.
    if (lastModColIdx !== -1) sheet.getRange(r + 1, lastModColIdx + 1).setValue(new Date());
    return { success: true, updated: true, row: r + 1 };
  }
  return { success: true, updated: false, message: 'ArticleNo not found in sheet' };
}

// Background self-heal for part images (called automatically by the app —
// there is no user-facing button). Two passes over the Part sheet:
//   1. Every row WITH an ImageURL: re-apply anyone-with-link sharing to the
//      Drive file (fixes hand-pasted private links and failed setSharing).
//   2. Every row WITHOUT an ImageURL: look in the image folder for an upload
//      whose filename starts with that Article No ("<art>_..." — the app's
//      own naming convention, incl. a legacy "#<art>_..." variant) and bind
//      the NEWEST one. This rescues photos that were uploaded but never saved
//      (upload happens instantly; the URL used to be written only on Save).
// Returns { checked, fixed, failed, bound, failures } — "fixed"/"bound" count
// only actual changes, so callers can stay quiet when there was nothing to do.
function repairImages() {
  const sheet = getSheet(SHEETS.PARTS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  let imageUrlColIdx = findColIdx(headers, 'ImageURL');
  let realArticleNoHeader = 'Article No.';
  Object.keys(PART_HEADER_MAP).forEach(rh => { if (PART_HEADER_MAP[rh] === 'ArticleNo') realArticleNoHeader = rh; });
  const articleNoColIdx = findColIdx(headers, realArticleNoHeader);
  const lastModColIdx = findColIdx(headers, 'LastModified');

  // Folder index is built lazily (only if some row actually needs binding).
  let folderFiles = null;
  function folderIndex_() {
    if (folderFiles) return folderFiles;
    folderFiles = [];
    try {
      if (IMAGE_FOLDER_ID !== 'PASTE_YOUR_DRIVE_FOLDER_ID_HERE') {
        const it = DriveApp.getFolderById(IMAGE_FOLDER_ID).getFiles();
        while (it.hasNext()) {
          const f = it.next();
          folderFiles.push({ name: String(f.getName()).toLowerCase(), id: f.getId(), created: f.getDateCreated().getTime() });
        }
      }
    } catch (e) { /* folder not configured / inaccessible → nothing to bind */ }
    return folderFiles;
  }
  function findUploadForArticle_(articleNo) {
    const a = String(articleNo).trim().toLowerCase();
    if (!a) return null;
    const hits = folderIndex_().filter(function (f) {
      return f.name === a || f.name.indexOf(a + '_') === 0 || f.name.indexOf('#' + a + '_') === 0 || f.name.indexOf(a + '.') === 0;
    });
    if (!hits.length) return null;
    hits.sort(function (x, y) { return y.created - x.created; });
    return hits[0];                                // newest upload wins
  }

  let checked = 0, fixed = 0, failed = 0, bound = 0;
  const failures = [];
  for (let r = 1; r < data.length; r++) {
    const art = articleNoColIdx !== -1 ? String(data[r][articleNoColIdx] || '').trim() : '';
    const url = imageUrlColIdx !== -1 ? String(data[r][imageUrlColIdx] || '').trim() : '';
    if (url && driveIdFromUrl_(url)) {
      checked++;
      const res = ensureImageShared_(url);
      if (res === 'fixed') fixed++;
      else if (!res) { failed++; failures.push(art || ('row ' + (r + 1))); }
    } else if (!url && art) {
      const hit = findUploadForArticle_(art);
      if (hit) {
        if (imageUrlColIdx === -1) { imageUrlColIdx = headers.length; sheet.getRange(1, imageUrlColIdx + 1).setValue('ImageURL'); }
        const newUrl = 'https://lh3.googleusercontent.com/d/' + hit.id;
        sheet.getRange(r + 1, imageUrlColIdx + 1).setValue(newUrl);
        ensureImageShared_(newUrl);
        if (lastModColIdx !== -1) sheet.getRange(r + 1, lastModColIdx + 1).setValue(new Date());
        bound++;
      }
    }
  }
  return { success: true, checked: checked, fixed: fixed, failed: failed, bound: bound, failures: failures.slice(0, 20) };
}

function debugHeaders() {
  const machinesSheet = getSheet(SHEETS.MACHINES);
  const partsSheet = getSheet(SHEETS.PARTS);
  const machinesHeaders = machinesSheet.getRange(1, 1, 1, machinesSheet.getLastColumn()).getValues()[0];
  const partsHeaders = partsSheet.getRange(1, 1, 1, partsSheet.getLastColumn()).getValues()[0];
  return {
    success: true,
    machinesSheetName: SHEETS.MACHINES,
    machinesHeadersRaw: machinesHeaders.map(h => JSON.stringify(h)),
    partsSheetName: SHEETS.PARTS,
    partsHeadersRaw: partsHeaders.map(h => JSON.stringify(h))
  };
}

function recordNew(params) {
  const target = MASTER_SHEET_FOR_TYPE[params.type];
  if (!target) throw new Error('Invalid type: ' + params.type);

  if (params.type === 'Part') {
    return recordNewPart(params, target);
  }

  // ----- Machine (no codeless/alias concept - simple key-based dedup) -----
  const keyValue = String((params.data || {}).MachineNumber || '').trim();
  if (!keyValue) throw new Error('No MachineNumber provided');
  if (wasRecentlyDeleted('Machine', keyValue)) return { success: true, action: 'blocked_recently_deleted' };

  const sheet = getSheet(target.name);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  let realKeyHeader = 'MachineNumber';
  Object.keys(target.map).forEach(rh => { if (target.map[rh] === 'MachineNumber') realKeyHeader = rh; });
  const keyColIdx = findColIdx(headers, realKeyHeader);

  const existingRow = findRowByExactValue(data, keyColIdx, keyValue);
  if (existingRow === -1) {
    appendDirectToMaster(target.name, target.map, params.data || {});
    return { success: true, action: 'inserted' };
  }
  return { success: true, action: 'duplicate_noop' };
}

// Deletes the row(s) matching the given key (MachineNumber or ArticleNo) from the
// real sheet - used when the person wants to undo something they just recorded.
// Also leaves a tombstone so a delayed offline sync can't bring it back.
function deleteRecord(params) {
  const target = MASTER_SHEET_FOR_TYPE[params.type];
  if (!target) throw new Error('Invalid type: ' + params.type);
  const keyField = params.byField === 'Description' ? 'Description' : (params.type === 'Machine' ? 'MachineNumber' : 'ArticleNo');
  const keyValue = String(params.key || '').trim().toLowerCase();
  if (!keyValue) throw new Error('No key provided to delete');

  const sheet = getSheet(target.name);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  let realHeaderName = keyField;
  Object.keys(target.map).forEach(realHeader => {
    if (target.map[realHeader] === keyField) realHeaderName = realHeader;
  });
  const colIdx = findColIdx(headers, realHeaderName);
  if (colIdx === -1) throw new Error('Could not find column: ' + realHeaderName);

  // When deleting a codeless Part by Description, only touch rows that are
  // actually codeless (empty Article No) - never delete a real coded part
  // just because its canonical name happens to match the text.
  let articleNoColIdx = -1;
  if (params.type === 'Part' && keyField === 'Description') {
    let realArticleNoHeader = 'ArticleNo';
    Object.keys(target.map).forEach(rh => { if (target.map[rh] === 'ArticleNo') realArticleNoHeader = rh; });
    articleNoColIdx = findColIdx(headers, realArticleNoHeader);
  }

  let deletedCount = 0;
  for (let r = data.length - 1; r >= 1; r--) {
    if (String(data[r][colIdx]).trim().toLowerCase() !== keyValue) continue;
    if (articleNoColIdx !== -1 && String(data[r][articleNoColIdx]).trim()) continue; // has a code now - don't delete
    sheet.deleteRow(r + 1);
    deletedCount++;
  }
  if (deletedCount > 0) {
    recordTombstone(params.type, keyValue);
    SpreadsheetApp.flush();
  }
  return { success: true, deletedCount: deletedCount };
}

// Clears a single Suggestion-word cell for a given Article No.
// params: { articleNo, columnName } - columnName is the exact header of the alias column to clear.
function deleteAlias(params) {
  const target = MASTER_SHEET_FOR_TYPE['Part'];
  const articleNo = String(params.articleNo || '').trim();
  const colName   = String(params.columnName || '').trim();
  if (!articleNo || !colName) throw new Error('articleNo and columnName are required');

  const sheet = getSheet(target.name);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  let realArticleNoHeader = 'ArticleNo';
  Object.keys(target.map).forEach(rh => { if (target.map[rh] === 'ArticleNo') realArticleNoHeader = rh; });
  const articleNoColIdx = findColIdx(headers, realArticleNoHeader);
  const aliasColIdx     = findColIdx(headers, colName);
  if (aliasColIdx === -1) throw new Error('Column not found: ' + colName);

  const keyLower = articleNo.toLowerCase();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][articleNoColIdx]).trim().toLowerCase() !== keyLower) continue;
    sheet.getRange(r + 1, aliasColIdx + 1).setValue('');
    return { success: true, cleared: colName };
  }
  return { success: true, cleared: null };
}

// ============================================================
// AUDITED PART EDIT — updatePart / getEditLog / restorePart
// Every edit here (a) requires an editor name, (b) backs up the previous row
// to the "EditLog" tab BEFORE changing, and (c) can be restored later.
// ============================================================
const EDITLOG_SHEET = 'EditLog';
const EDITLOG_HEADERS = ['Timestamp', 'Editor', 'Action', 'ArticleNo', 'NewArticleNo', 'OldData', 'NewData'];

function getEditLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(EDITLOG_SHEET);
  if (!sh) { sh = ss.insertSheet(EDITLOG_SHEET); sh.appendRow(EDITLOG_HEADERS); }
  return sh;
}

function safeParse_(s) { try { return JSON.parse(s); } catch (e) { return null; } }

function partsSheetInfo_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PARTS);
  if (!sheet) throw new Error('Sheet not found: ' + SHEETS.PARTS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  let realArticleNoHeader = 'Article No.';
  Object.keys(PART_HEADER_MAP).forEach(function (rh) { if (PART_HEADER_MAP[rh] === 'ArticleNo') realArticleNoHeader = rh; });
  return {
    sheet: sheet, data: data, headers: headers,
    articleNoCol: findColIdx(headers, realArticleNoHeader),
    descCol: findColIdx(headers, 'Description'),
    imageCol: findColIdx(headers, 'ImageURL'),
    aliasCols: findAliasColumnIndexes(headers)
  };
}

// Returns { rowIndex0, obj } for the row whose ArticleNo matches (case-insensitive), else null.
function findPartRow_(info, articleNo) {
  const key = String(articleNo || '').trim().toLowerCase();
  if (!key) return null;
  for (let r = 1; r < info.data.length; r++) {
    if (String(info.data[r][info.articleNoCol]).trim().toLowerCase() === key) {
      const obj = {};
      info.headers.forEach(function (h, i) { obj[String(h).trim()] = info.data[r][i]; });
      return { rowIndex0: r, obj: obj };
    }
  }
  return null;
}

// Extracts a Drive file id from any URL shape we store/produce:
//   https://lh3.googleusercontent.com/d/FILEID
//   https://drive.google.com/file/d/FILEID/view
//   https://drive.google.com/uc?export=view&id=FILEID
function driveIdFromUrl_(url) {
  const s = String(url || '');
  let m = s.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  return '';
}

// Best-effort: move a replaced image to Drive trash so overwritten files don't
// pile up as orphans. Uses trash (recoverable for ~30 days) rather than a hard
// delete, and NEVER throws — a missing / foreign / inaccessible file is fine.
function trashDriveImage_(url) {
  try {
    const id = driveIdFromUrl_(url);
    if (!id) return false;
    DriveApp.getFileById(id).setTrashed(true);   // getFileById throws if gone → caught below
    return true;
  } catch (e) {
    return false;                                 // cleanup is optional; ignore failures
  }
}

// Best-effort: make sure the Drive file behind an image URL is viewable by
// anyone with the link. Without this, a URL pasted by hand from the Drive app
// (e.g. .../view?usp=drivesdk on a private file) is stored fine but can NEVER
// render in an <img> tag for other people — the exact "uploaded but no
// preview" symptom. Called whenever we store an image URL. Never throws.
// Returns 'already' (was fine), 'fixed' (sharing applied), or false (failed) —
// callers that only care about success can treat any truthy value as OK.
function ensureImageShared_(url) {
  try {
    const id = driveIdFromUrl_(url);
    if (!id) return false;
    const file = DriveApp.getFileById(id);
    const acc = file.getSharingAccess();
    if (acc === DriveApp.Access.ANYONE_WITH_LINK || acc === DriveApp.Access.DOMAIN_WITH_LINK) return 'already';
    return shareFileAnyone_(file) ? 'fixed' : false;   // org may block public sharing
  } catch (e) {
    return false;                                 // foreign/missing file → leave as-is
  }
}

// Image proxy for locked-down Workspace domains. When the org forbids public
// link-sharing, no lh3/Drive URL can ever render in an <img>, but the web app
// runs as the file's OWNER and can always read the bytes. Returns the image as
// base64 so the frontend can show it as a data: URL. Accepts { id } (Drive
// file id) or { url } (any stored image URL). Size-guarded to protect quota.
function getImageBytes(params) {
  var id = String((params && params.id) || '').trim();
  if (!id && params && params.url) id = driveIdFromUrl_(params.url);
  if (!id) throw new Error('id or url required');
  var blob = DriveApp.getFileById(id).getBlob();   // as owner → no sharing needed
  var bytes = blob.getBytes();
  if (bytes.length > 8 * 1024 * 1024) return { success: false, error: 'image too large to proxy' };
  return {
    success: true,
    id: id,
    mimeType: blob.getContentType() || 'image/jpeg',
    base64: Utilities.base64Encode(bytes)
  };
}

function updatePart(params) {
  const editor = String(params.editor || '').trim();
  if (!editor) return { success: false, error: 'ต้องระบุชื่อผู้แก้ไขก่อน (editor required)' };
  const origArticleNo = String(params.origArticleNo || '').trim();
  if (!origArticleNo) return { success: false, error: 'origArticleNo required' };

  const info = partsSheetInfo_();
  const found = findPartRow_(info, origArticleNo);
  if (!found) return { success: false, error: 'ไม่พบอะไหล่รหัส ' + origArticleNo };
  const rowNum = found.rowIndex0 + 1;
  const oldData = found.obj;

  const newArticleNo = (params.newArticleNo !== undefined) ? String(params.newArticleNo).trim() : origArticleNo;
  const renaming = newArticleNo && newArticleNo.toLowerCase() !== origArticleNo.toLowerCase();
  if (renaming && findPartRow_(info, newArticleNo)) {
    return { success: false, error: 'รหัส ' + newArticleNo + ' มีอยู่แล้ว เปลี่ยนไม่ได้' };
  }

  // ----- back up BEFORE changing -----
  const imgHeader = info.imageCol >= 0 ? String(info.headers[info.imageCol]).trim() : null;
  const newDataPreview = {
    ArticleNo: newArticleNo,
    Description: (params.newDescription !== undefined) ? String(params.newDescription) : oldData['Description'],
    ImageURL: (params.imageURL !== undefined) ? String(params.imageURL) : (imgHeader ? oldData[imgHeader] : ''),
    aliases: (params.aliases !== undefined) ? params.aliases : undefined
  };
  getEditLogSheet_().appendRow([new Date(), editor, 'update', origArticleNo, newArticleNo, JSON.stringify(oldData), JSON.stringify(newDataPreview)]);

  // ----- apply -----
  if (params.newDescription !== undefined && info.descCol >= 0)
    info.sheet.getRange(rowNum, info.descCol + 1).setValue(String(params.newDescription));

  if (params.imageURL !== undefined) {
    const oldImageUrl = imgHeader ? String(oldData[imgHeader] || '') : '';
    const newImageUrl = String(params.imageURL);
    let imgCol = info.imageCol;
    if (imgCol < 0) { imgCol = info.headers.length; info.sheet.getRange(1, imgCol + 1).setValue('ImageURL'); }
    info.sheet.getRange(rowNum, imgCol + 1).setValue(newImageUrl);
    ensureImageShared_(newImageUrl);             // make it viewable in <img> tags
    // Orphan cleanup: if the image actually changed to a different Drive file
    // (or was cleared), trash the previous one so it doesn't linger forever.
    if (oldImageUrl && driveIdFromUrl_(oldImageUrl) && driveIdFromUrl_(oldImageUrl) !== driveIdFromUrl_(newImageUrl)) {
      trashDriveImage_(oldImageUrl);
    }
  }

  if (params.aliases !== undefined) {
    const aliases = (params.aliases || []).map(function (a) { return String(a || '').trim(); }).filter(function (a) { return a; });
    info.aliasCols.forEach(function (ci) { info.sheet.getRange(rowNum, ci + 1).setValue(''); });
    let headers = info.sheet.getRange(1, 1, 1, info.sheet.getLastColumn()).getValues()[0];
    let aliasCols = findAliasColumnIndexes(headers);
    for (let i = 0; i < aliases.length; i++) {
      if (i < aliasCols.length) {
        info.sheet.getRange(rowNum, aliasCols[i] + 1).setValue(aliases[i]);
      } else {
        const nextNum = getNextAliasColumnNumber(headers, aliasCols);
        const newColIdx1 = info.sheet.getLastColumn() + 1;
        info.sheet.getRange(1, newColIdx1).setValue('Suggestion word' + nextNum);
        info.sheet.getRange(rowNum, newColIdx1).setValue(aliases[i]);
        headers = info.sheet.getRange(1, 1, 1, info.sheet.getLastColumn()).getValues()[0];
        aliasCols = findAliasColumnIndexes(headers);
      }
    }
  }

  // rename LAST, so all the lookups above matched on the original key
  if (renaming) info.sheet.getRange(rowNum, info.articleNoCol + 1).setValue(newArticleNo);

  // Stamp LastModified so the next deltaSync re-emits this row on every device
  // (without this, an edited image/description silently fails to propagate).
  const lastModCol = findColIdx(info.headers, 'LastModified');
  if (lastModCol !== -1) info.sheet.getRange(rowNum, lastModCol + 1).setValue(new Date());

  // Echo the stored image path back so the caller can confirm/rebind without
  // waiting for the next sync.
  const finalImageURL = (params.imageURL !== undefined)
    ? String(params.imageURL)
    : (imgHeader ? String(oldData[imgHeader] || '') : '');
  return { success: true, articleNo: newArticleNo, imageURL: finalImageURL };
}

function updateMachine(params) {
  const editor = String(params.editor || '').trim();
  if (!editor) return { success: false, error: 'editor required' };
  const origMachineNo = String(params.origMachineNo || '').trim();
  if (!origMachineNo) return { success: false, error: 'origMachineNo required' };

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MACHINES);
  if (!sheet) throw new Error('Sheet not found: ' + SHEETS.MACHINES);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  var machineNoCol = -1, customerCol = -1, typeCol = -1;
  headers.forEach(function(h, i) {
    var mapped = MACHINE_HEADER_MAP[String(h).trim()] || String(h).trim();
    if (mapped === 'MachineNumber') machineNoCol = i;
    else if (mapped === 'CustomerName') customerCol = i;
    else if (mapped === 'MachineType') typeCol = i;
  });
  if (machineNoCol < 0) return { success: false, error: 'MachineNumber column not found' };

  var foundRow = -1;
  var origKey = origMachineNo.toLowerCase();
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][machineNoCol]).trim().toLowerCase() === origKey) { foundRow = r; break; }
  }
  if (foundRow < 0) return { success: false, error: 'ไม่พบเครื่อง ' + origMachineNo };

  var newMachineNo = (params.newMachineNo !== undefined) ? String(params.newMachineNo).trim() : origMachineNo;
  if (newMachineNo.toLowerCase() !== origKey) {
    for (var r2 = 1; r2 < data.length; r2++) {
      if (r2 !== foundRow && String(data[r2][machineNoCol]).trim().toLowerCase() === newMachineNo.toLowerCase()) {
        return { success: false, error: 'เครื่อง ' + newMachineNo + ' มีอยู่แล้ว' };
      }
    }
  }

  getEditLogSheet_().appendRow([new Date(), editor, 'update-machine', origMachineNo, newMachineNo,
    JSON.stringify({ MachineNumber: String(data[foundRow][machineNoCol]), CustomerName: customerCol >= 0 ? String(data[foundRow][customerCol]) : '', MachineType: typeCol >= 0 ? String(data[foundRow][typeCol]) : '' }),
    JSON.stringify({ MachineNumber: newMachineNo, CustomerName: params.newCustomerName !== undefined ? String(params.newCustomerName) : undefined, MachineType: params.newMachineType !== undefined ? String(params.newMachineType) : undefined })
  ]);

  var rowNum = foundRow + 1;
  if (params.newCustomerName !== undefined && customerCol >= 0) sheet.getRange(rowNum, customerCol + 1).setValue(String(params.newCustomerName));
  if (params.newMachineType !== undefined && typeCol >= 0) sheet.getRange(rowNum, typeCol + 1).setValue(String(params.newMachineType));
  if (newMachineNo.toLowerCase() !== origKey) sheet.getRange(rowNum, machineNoCol + 1).setValue(newMachineNo);

  var lastModCol = findColIdx(headers, 'LastModified');
  if (lastModCol !== -1) sheet.getRange(rowNum, lastModCol + 1).setValue(new Date());

  return { success: true, machineNo: newMachineNo };
}

function getEditLog(params) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EDITLOG_SHEET);
  if (!sh) return { success: true, entries: [] };
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { success: true, entries: [] };
  const wantArticle = params && params.articleNo ? String(params.articleNo).trim().toLowerCase() : null;
  const limit = Number(params && params.limit) || 100;
  const out = [];
  for (let r = data.length - 1; r >= 1 && out.length < limit; r--) {
    const artA = String(data[r][3] || '').trim().toLowerCase();
    const artB = String(data[r][4] || '').trim().toLowerCase();
    if (wantArticle && artA !== wantArticle && artB !== wantArticle) continue;
    out.push({
      rowIndex: r + 1,
      timestamp: data[r][0] ? new Date(data[r][0]).getTime() : null,
      editor: data[r][1], action: data[r][2],
      articleNo: data[r][3], newArticleNo: data[r][4],
      oldData: safeParse_(data[r][5]), newData: safeParse_(data[r][6])
    });
  }
  return { success: true, entries: out };
}

function restorePart(params) {
  const editor = String(params.editor || '').trim();
  if (!editor) return { success: false, error: 'ต้องระบุชื่อผู้แก้ไขก่อน (editor required)' };
  const logRow = Number(params.rowIndex);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EDITLOG_SHEET);
  if (!sh || !logRow) return { success: false, error: 'ไม่พบรายการสำรอง' };
  const logVals = sh.getRange(logRow, 1, 1, EDITLOG_HEADERS.length).getValues()[0];
  const oldData = safeParse_(logVals[5]);
  const origArticleNo = String(logVals[3] || '').trim();
  const newArticleNo = String(logVals[4] || '').trim() || origArticleNo;
  if (!oldData) return { success: false, error: 'ข้อมูลสำรองเสียหาย' };

  const info = partsSheetInfo_();
  const found = findPartRow_(info, newArticleNo) || findPartRow_(info, origArticleNo);
  if (!found) return { success: false, error: 'ไม่พบอะไหล่ที่จะกู้คืน' };
  const rowNum = found.rowIndex0 + 1;
  const curArticle = String(found.obj[String(info.headers[info.articleNoCol]).trim()] || '').trim();

  getEditLogSheet_().appendRow([new Date(), editor, 'restore', curArticle, origArticleNo, JSON.stringify(found.obj), JSON.stringify(oldData)]);

  info.headers.forEach(function (h, i) {
    const key = String(h).trim();
    if (Object.prototype.hasOwnProperty.call(oldData, key)) info.sheet.getRange(rowNum, i + 1).setValue(oldData[key]);
  });
  return { success: true, articleNo: origArticleNo };
}

// ============================================================
// SOFT DELETE + RECYCLE BIN (BACKUP) — softDeletePart / getRecycleBin /
//   restoreDeletedPart
// Deleting a part from the edit page does NOT remove it for good. The whole
// original row is copied into a "RecycleBin" tab (with who/when), then the row
// is removed from the live "Part No." sheet. From the app's ถังขยะ (Recycle
// Bin) tab it can be restored back into the live sheet at any time.
// ============================================================
const RECYCLEBIN_SHEET = 'RecycleBin';
// RowData = JSON of the whole original row (header -> value), so a restore can
// rebuild every column exactly, even columns the app doesn't otherwise use.
const RECYCLEBIN_HEADERS = ['DeletedAt', 'DeletedBy', 'ArticleNo', 'Description', 'RowData'];

function getRecycleBinSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(RECYCLEBIN_SHEET);
  if (!sh) {
    sh = ss.insertSheet(RECYCLEBIN_SHEET);
    sh.appendRow(RECYCLEBIN_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

// Move ONE part into the recycle bin (backup + remove from live sheet).
// params: { articleNo, editor }
function softDeletePart(params) {
  const editor = String(params.editor || '').trim();
  if (!editor) return { success: false, error: 'ต้องลงชื่อผู้แก้ไขก่อน (editor required)' };
  const articleNo = String(params.articleNo || '').trim();
  const description = String(params.description || '').trim();
  if (!articleNo && !description) return { success: false, error: 'articleNo or description required' };

  const info = partsSheetInfo_();
  var found = null;
  if (articleNo) {
    found = findPartRow_(info, articleNo);
  } else {
    var descLower = description.toLowerCase();
    for (var r = 1; r < info.data.length; r++) {
      if (String(info.data[r][info.articleNoCol] || '').trim()) continue;
      if (String(info.data[r][info.descCol] || '').trim().toLowerCase() === descLower) {
        var obj = {};
        info.headers.forEach(function(h, i) { obj[String(h).trim()] = info.data[r][i]; });
        found = { rowIndex0: r, obj: obj };
        break;
      }
    }
  }
  if (!found) return { success: false, error: 'ไม่พบอะไหล่' + (articleNo ? ' รหัส ' + articleNo : ' ชื่อ ' + description) };
  const rowNum = found.rowIndex0 + 1;
  const oldData = found.obj;
  var key = articleNo || description;

  getRecycleBinSheet_().appendRow([
    new Date(), editor, articleNo, String(oldData['Description'] || ''), JSON.stringify(oldData)
  ]);
  getEditLogSheet_().appendRow([new Date(), editor, 'delete', key, '', JSON.stringify(oldData), '']);
  info.sheet.deleteRow(rowNum);
  recordTombstone('Part', key);
  // Make the deletion and its tombstone visible before the client performs the
  // authoritative refresh, so that refresh cannot read the pre-delete state.
  SpreadsheetApp.flush();

  return { success: true, articleNo: articleNo, description: description };
}

// List everything currently in the recycle bin, newest first.
function getRecycleBin(params) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RECYCLEBIN_SHEET);
  if (!sh) return { success: true, entries: [] };
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { success: true, entries: [] };
  const limit = Number(params && params.limit) || 200;
  const out = [];
  for (let r = data.length - 1; r >= 1 && out.length < limit; r--) {
    // skip blank rows (e.g. after a restore removed the row)
    if (!String(data[r][2] || '').trim() && !String(data[r][4] || '').trim()) continue;
    out.push({
      rowIndex: r + 1,
      deletedAt: data[r][0] ? new Date(data[r][0]).getTime() : null,
      deletedBy: data[r][1],
      articleNo: data[r][2],
      description: data[r][3]
    });
  }
  return { success: true, entries: out };
}

// Put a recycle-bin row back into the live "Part No." sheet, then remove it
// from the bin. Rejects if that Article No. already exists live again.
// params: { rowIndex, editor }
function restoreDeletedPart(params) {
  const editor = String(params.editor || '').trim();
  if (!editor) return { success: false, error: 'ต้องลงชื่อผู้แก้ไขก่อน (editor required)' };
  const binRow = Number(params.rowIndex);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RECYCLEBIN_SHEET);
  if (!sh || !binRow) return { success: false, error: 'ไม่พบรายการในถังขยะ' };

  const vals = sh.getRange(binRow, 1, 1, RECYCLEBIN_HEADERS.length).getValues()[0];
  const articleNo = String(vals[2] || '').trim();
  const rowData = safeParse_(vals[4]);
  if (!rowData) return { success: false, error: 'ข้อมูลสำรองเสียหาย' };

  const info = partsSheetInfo_();
  if (articleNo && findPartRow_(info, articleNo)) {
    return { success: false, error: 'รหัส ' + articleNo + ' มีอยู่ในฐานข้อมูลแล้ว กู้คืนไม่ได้' };
  }

  // rebuild the row in the live sheet's column order; stamp LastModified so it
  // flows back out on the next delta sync.
  const sheet = getSheet(SHEETS.PARTS);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const newRow = headers.map(function (h) {
    const key = String(h).trim();
    if (key === 'LastModified') return new Date();
    return Object.prototype.hasOwnProperty.call(rowData, key) ? rowData[key] : '';
  });
  sheet.appendRow(newRow);

  // audit + clear the bin row
  getEditLogSheet_().appendRow([new Date(), editor, 'restore-deleted', articleNo, '', '', JSON.stringify(rowData)]);
  sh.deleteRow(binRow);

  return { success: true, articleNo: articleNo };
}

// Called (best-effort, via navigator.sendBeacon) when the app page is closed.
// There is no server-side session token to invalidate in this app — the client
// clears its own remembered editor identity — so here we just record that the
// editing session ended, giving a full sign-in/edit/sign-out audit timeline.
function logoutSession(params) {
  const editor = String((params && params.editor) || '').trim();
  getEditLogSheet_().appendRow([new Date(), editor || '(unknown)', 'logout', '', '', '', '']);
  return { success: true };
}

// ============================================================
// PART USAGE LEDGER — recordPartUsage / getPartUsage
// "Where has this part been requisitioned to?"  One FLAT row per
// (order x part), denormalized on purpose: Customer / MachineNo /
// MachineType / PartName are copied onto every row so the sheet can be
// filtered or pivoted by hand in Google Sheets with no joins. Every explicit
// Save / Preview / Download / Share / Email action is appended as an immutable
// EventId + Revision snapshot. Editing the same OrderId never removes history.
// ============================================================
const PARTUSAGE_SHEET = 'PartUsage';
const PARTUSAGE_HEADERS = [
  'Timestamp', 'OrderId', 'Type', 'Customer', 'MachineNo', 'MachineType',
  'ArticleNo', 'PartName', 'Qty', 'Unit', 'Note', 'SetName', 'RecordedBy',
  'EventId', 'Revision', 'Action'
];
const PARTUSAGE_MAX_ITEMS = 200;
const PARTUSAGE_ACTIONS = {
  save:true, pdf_preview:true, download:true, share:true,
  email_share:true, email_graph:true, email_deeplink:true,
  auto_email:true, legacy_export:true
};

function usageText_(value, maxLength) {
  var out = String(value == null ? '' : value).slice(0, maxLength || 500);
  if (/^[=+@]/.test(out) || /^-\d/.test(out)) out = "'" + out;
  return out;
}

function ensurePartUsageHeaders_(sh) {
  if (sh.getLastRow() < 1) {
    sh.appendRow(PARTUSAGE_HEADERS);
    sh.setFrozenRows(1);
    return sh;
  }
  var current = sh.getRange(1, 1, 1, PARTUSAGE_HEADERS.length).getValues()[0];
  var differs = PARTUSAGE_HEADERS.some(function (header, index) { return current[index] !== header; });
  if (differs) sh.getRange(1, 1, 1, PARTUSAGE_HEADERS.length).setValues([PARTUSAGE_HEADERS]);
  sh.setFrozenRows(1);
  return sh;
}

function getPartUsageSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(PARTUSAGE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(PARTUSAGE_SHEET);
  }
  return ensurePartUsageHeaders_(sh);
}

// Append one immutable usage event. Reusing EventId is an idempotent retry;
// reusing OrderId with a new EventId creates the next revision and preserves
// every earlier row.
function recordPartUsage(params) {
  const orderId = usageText_((params && params.orderId) || '', 200).trim();
  if (!orderId) throw new Error('orderId required');
  const items = Array.isArray(params && params.items) ? params.items : [];
  if (items.length > PARTUSAGE_MAX_ITEMS) throw new Error('items exceeds 200');
  const eventId = usageText_((params && params.eventId) || Utilities.getUuid(), 200).trim();
  if (!eventId) throw new Error('eventId required');
  const action = String((params && params.action) || 'legacy_export').trim();
  if (!PARTUSAGE_ACTIONS[action]) throw new Error('invalid usage action');

  const sh = getPartUsageSheet_();
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { throw new Error('busy, try again'); }
  try {
    const last = sh.getLastRow();
    const eventCol = PARTUSAGE_HEADERS.indexOf('EventId');
    const revisionCol = PARTUSAGE_HEADERS.indexOf('Revision');
    let revision = 1;
    if (last > 1) {
      const existing = sh.getRange(2, 1, last - 1, PARTUSAGE_HEADERS.length).getValues();
      let existingCount = 0;
      let existingRevision = 0;
      existing.forEach(function (row) {
        if (String(row[eventCol] || '').trim() === eventId) {
          existingCount++;
          existingRevision = Math.max(existingRevision, Number(row[revisionCol]) || 0);
        }
        if (String(row[1] || '').trim() === orderId) {
          revision = Math.max(revision, (Number(row[revisionCol]) || 0) + 1);
        }
      });
      if (existingCount) {
        const expectedItems = Number(params && params.expectedItems);
        if (isFinite(expectedItems) && expectedItems >= 0 && expectedItems !== existingCount) {
          throw new Error('usage item count mismatch: ' + existingCount + '/' + expectedItems);
        }
        return {
          success:true, orderId:orderId, eventId:eventId,
          revision:existingRevision || 1, written:existingCount, idempotent:true
        };
      }
    }

    const now = new Date();
    const type = usageText_((params && params.type) || '', 100);
    const customer = usageText_((params && params.customer) || '', 250);
    const recordedBy = usageText_((params && params.recordedBy) || '(unknown)', 150) || '(unknown)';
    const rows = [];
    items.forEach(function (it) {
      const art = usageText_((it && it.articleNo) || '', 150).trim();
      const name = usageText_((it && it.partName) || '', 500).trim();
      if (!art && !name) return;
      rows.push([
        now, orderId, type, customer,
        usageText_(it.machineNo || '', 150), usageText_(it.machineType || '', 250),
        art, name,
        it.qty === '' || it.qty == null ? '' : usageText_(it.qty, 50),
        usageText_(it.unit || '', 50), usageText_(it.note || '', 2000), usageText_(it.setName || '', 250),
        recordedBy, eventId, revision, action
      ]);
    });
    const expectedItems = Number(params && params.expectedItems);
    if (isFinite(expectedItems) && expectedItems >= 0 && expectedItems !== rows.length) {
      throw new Error('usage item count mismatch: ' + rows.length + '/' + expectedItems);
    }
    if (rows.length) {
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, PARTUSAGE_HEADERS.length).setValues(rows);
    }
    return {
      success:true, orderId:orderId, eventId:eventId,
      revision:revision, written:rows.length, idempotent:false
    };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Backfill the Article No onto ledger rows that were written BEFORE the code
// was known. A codeless part is logged by name only (see recordPartUsage), so
// once the ⏳ pending queue finally gets its real code, the history rows it
// already produced would otherwise stay blank forever.
//
// Only rows whose ArticleNo is still EMPTY are touched — a row that already
// carries a code belongs to a different part that happens to share a name, and
// overwriting it would corrupt real history. Timestamp is deliberately left
// alone so the entries keep their original position when the Log is sorted.
//
// PendingParts holds one row per part NAME while the ledger holds one row per
// order, so a single fill-in can legitimately update several rows at once.
// params: { partName, articleNo }
function backfillPartUsageArticleNo(params) {
  const name = String((params && params.partName) || '').trim();
  const articleNo = String((params && params.articleNo) || '').trim();
  if (!name) throw new Error('partName required');
  if (!articleNo) throw new Error('articleNo required');

  const sh = getPartUsageSheet_();
  if (sh.getLastRow() < 2) return { success: true, updated: 0 };

  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { throw new Error('busy, try again'); }
  try {
    const last = sh.getLastRow();
    const artCol = PARTUSAGE_HEADERS.indexOf('ArticleNo') + 1;   // G
    const nameCol = PARTUSAGE_HEADERS.indexOf('PartName') + 1;   // H
    const arts = sh.getRange(2, artCol, last - 1, 1).getValues();
    const names = sh.getRange(2, nameCol, last - 1, 1).getValues();
    const target = name.toLowerCase();
    let updated = 0;
    for (var i = 0; i < names.length; i++) {
      if (String(arts[i][0]).trim()) continue;                       // already coded
      if (String(names[i][0]).trim().toLowerCase() !== target) continue;
      arts[i][0] = articleNo;
      updated++;
    }
    // One write for the whole column — far cheaper than a setValue per row.
    if (updated) sh.getRange(2, artCol, last - 1, 1).setValues(arts);
    return { success: true, updated: updated };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Usage history for ONE part (newest first). Queried on demand so the whole
// ledger never has to be synced to the client. Look up by articleNo (coded
// parts, col G) OR by name (still-codeless parts, matched on PartName col H) —
// so a part that was requisitioned before it had a code still shows its history.
function getPartUsage(params) {
  const articleNo = String((params && params.articleNo) || '').trim().toLowerCase();
  const name = String((params && params.name) || '').trim().toLowerCase();
  if (!articleNo && !name) throw new Error('articleNo or name required');
  const limit = Number((params && params.limit) || 200);

  const sh = getPartUsageSheet_();
  if (sh.getLastRow() < 2) return { success: true, articleNo: articleNo, rows: [] };

  const values = sh.getRange(2, 1, sh.getLastRow() - 1, PARTUSAGE_HEADERS.length).getValues();
  const out = [];
  for (var i = values.length - 1; i >= 0 && out.length < limit; i--) {
    const v = values[i];
    var match = articleNo
      ? String(v[6]).trim().toLowerCase() === articleNo      // col G = ArticleNo
      : String(v[7]).trim().toLowerCase() === name;          // col H = PartName
    if (!match) continue;
    const o = {};
    PARTUSAGE_HEADERS.forEach(function (h, c) { o[h] = v[c] instanceof Date ? v[c].toISOString() : v[c]; });
    out.push(o);
  }
  return { success: true, articleNo: articleNo, rows: out };
}

function getAllPartUsage(params) {
  var limit = Number((params && params.limit) || 500);
  var sh = getPartUsageSheet_();
  if (sh.getLastRow() < 2) return { success: true, rows: [] };
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, PARTUSAGE_HEADERS.length).getValues();
  var out = [];
  for (var i = values.length - 1; i >= 0 && out.length < limit; i--) {
    var o = {};
    PARTUSAGE_HEADERS.forEach(function (h, c) { o[h] = values[i][c] instanceof Date ? values[i][c].toISOString() : values[i][c]; });
    o._row = i + 2;                 // actual sheet row, so a client can edit/delete this exact entry
    out.push(o);
  }
  return { success: true, rows: out };
}

// ============================================================
// PART USAGE RECOVERY — conservative reconstruction from local Drafts
// ------------------------------------------------------------
// Recovery NEVER writes, updates, or deletes PartUsage. It reads the current
// ledger only to skip exact item occurrences that are already present, then
// writes missing snapshots to a separate PartUsageRecovery sheet for review.
// Re-running the same Draft snapshot is idempotent via RecoveryId.
// ============================================================
const PARTUSAGE_RECOVERY_SHEET = 'PartUsageRecovery';
const PARTUSAGE_RECOVERY_HEADERS = [
  'RecoveredAt', 'DraftCreatedAt', 'DraftUpdatedAt', 'OrderId', 'Type', 'Customer',
  'MachineNo', 'MachineType', 'ArticleNo', 'PartName', 'Qty', 'Unit', 'Note',
  'SetName', 'RecordedBy', 'RecoveryId', 'Source'
];

function recoveryComparable_(value) {
  var out = String(value == null ? '' : value).trim().toLowerCase();
  if (/^'[=+@]/.test(out) || /^'-\d/.test(out)) out = out.slice(1);
  return out;
}

function recoverySignature_(orderId, item) {
  item = item || {};
  return [
    orderId, item.articleNo, item.partName, item.machineNo, item.machineType,
    item.qty, item.unit, item.note, item.setName
  ].map(recoveryComparable_).join('\u001f');
}

function recoverySheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(PARTUSAGE_RECOVERY_SHEET);
  if (!sh) sh = ss.insertSheet(PARTUSAGE_RECOVERY_SHEET);
  if (sh.getLastRow() < 1) {
    sh.appendRow(PARTUSAGE_RECOVERY_HEADERS);
  } else {
    var current = sh.getRange(1, 1, 1, PARTUSAGE_RECOVERY_HEADERS.length).getValues()[0];
    var differs = PARTUSAGE_RECOVERY_HEADERS.some(function(header, index) { return current[index] !== header; });
    if (differs) sh.getRange(1, 1, 1, PARTUSAGE_RECOVERY_HEADERS.length).setValues([PARTUSAGE_RECOVERY_HEADERS]);
  }
  sh.setFrozenRows(1);
  return sh;
}

function recoveryDate_(value) {
  var millis = Number(value);
  return isFinite(millis) && millis > 0 ? new Date(millis) : '';
}

function recoverPartUsageDrafts(params) {
  var drafts = params && params.drafts;
  if (!Array.isArray(drafts)) throw new Error('drafts array required');
  if (drafts.length > 10) throw new Error('draft recovery exceeds 10 drafts');
  drafts.forEach(function(draft) {
    var items = Array.isArray(draft && draft.items) ? draft.items : [];
    if (items.length > 8) throw new Error('draft recovery exceeds 8 items per draft');
  });

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { throw new Error('busy, try again'); }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var currentCounts = {};
    var currentSheet = ss.getSheetByName(PARTUSAGE_SHEET); // read-only by design
    if (currentSheet && currentSheet.getLastRow() > 1) {
      var currentRows = currentSheet.getRange(2, 1, currentSheet.getLastRow() - 1, PARTUSAGE_HEADERS.length).getValues();
      currentRows.forEach(function(row) {
        var signature = recoverySignature_(row[1], {
          machineNo:row[4], machineType:row[5], articleNo:row[6], partName:row[7],
          qty:row[8], unit:row[9], note:row[10], setName:row[11]
        });
        currentCounts[signature] = (currentCounts[signature] || 0) + 1;
      });
    }

    var recovery = recoverySheet_();
    var recoveredIds = {};
    if (recovery.getLastRow() > 1) {
      var idColumn = PARTUSAGE_RECOVERY_HEADERS.indexOf('RecoveryId') + 1;
      recovery.getRange(2, idColumn, recovery.getLastRow() - 1, 1).getValues().forEach(function(row) {
        recoveredIds[String(row[0] || '')] = true;
      });
    }

    var rows = [];
    var skippedCurrent = 0;
    var skippedRecovered = 0;
    var skippedEmpty = 0;
    var recoveredAt = new Date();
    drafts.forEach(function(draft) {
      draft = draft || {};
      var orderId = usageText_(draft.orderId || '', 200).trim();
      if (!orderId) { skippedEmpty++; return; }
      var items = Array.isArray(draft.items) ? draft.items : [];
      items.forEach(function(item, itemIndex) {
        item = item || {};
        var articleNo = usageText_(item.articleNo || '', 150).trim();
        var partName = usageText_(item.partName || '', 500).trim();
        if (!articleNo && !partName) { skippedEmpty++; return; }
        var normalizedItem = {
          articleNo:articleNo, partName:partName,
          machineNo:usageText_(item.machineNo || '', 150),
          machineType:usageText_(item.machineType || '', 250),
          qty:item.qty === '' || item.qty == null ? '' : usageText_(item.qty, 50),
          unit:usageText_(item.unit || '', 50), note:usageText_(item.note || '', 2000),
          setName:usageText_(item.setName || '', 250)
        };
        var signature = recoverySignature_(orderId, normalizedItem);
        if (currentCounts[signature] > 0) {
          currentCounts[signature]--;
          skippedCurrent++;
          return;
        }
        var recoveryId = usageText_([
          recoveryComparable_(orderId), Number(draft.updatedAt) || 0, itemIndex, signature
        ].join('|'), 1000);
        if (recoveredIds[recoveryId]) { skippedRecovered++; return; }
        recoveredIds[recoveryId] = true;
        rows.push([
          recoveredAt, recoveryDate_(draft.createdAt), recoveryDate_(draft.updatedAt),
          orderId, usageText_(draft.type || '', 100), usageText_(draft.customer || '', 250),
          normalizedItem.machineNo, normalizedItem.machineType, articleNo, partName,
          normalizedItem.qty, normalizedItem.unit, normalizedItem.note, normalizedItem.setName,
          usageText_(draft.recordedBy || '(unknown)', 150) || '(unknown)', recoveryId, 'local_draft'
        ]);
      });
    });
    if (rows.length) {
      recovery.getRange(recovery.getLastRow() + 1, 1, rows.length, PARTUSAGE_RECOVERY_HEADERS.length).setValues(rows);
    }
    return {
      success:true, sheet:PARTUSAGE_RECOVERY_SHEET, inserted:rows.length,
      skippedCurrent:skippedCurrent, skippedRecovered:skippedRecovered, skippedEmpty:skippedEmpty
    };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Guard for edit/delete: confirm the sheet row is still the exact record the
// client saw. Every available field is compared so a shifted row can be found
// safely without deleting another occurrence of the same part.
function usageRowMatches_(vals, match) {
  if (!match) return true;
  function n(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
  function time(v) {
    var t = v instanceof Date ? v.getTime() : new Date(v).getTime();
    return isNaN(t) ? n(v) : String(t);
  }
  for (var i = 0; i < PARTUSAGE_HEADERS.length; i++) {
    var key = PARTUSAGE_HEADERS[i];
    if (match[key] == null) continue;
    if (key === 'Timestamp') {
      if (time(vals[i]) !== time(match[key])) return false;
    } else if (n(vals[i]) !== n(match[key])) return false;
  }
  return true;
}

// Delete one PartUsage row (a wrong / test entry). params: { row, match }
function deletePartUsage(params) {
  var row = Number(params && params.row);
  if (!row || row < 2) throw new Error('row required');
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PARTUSAGE_SHEET);
  if (!sh || sh.getLastRow() < 2) return { success: true, action: 'already_deleted' };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { throw new Error('busy, try again'); }
  try {
    var match = params && params.match;
    var rowNum = row <= sh.getLastRow() ? row : -1;
    if (rowNum !== -1) {
      var current = sh.getRange(rowNum, 1, 1, PARTUSAGE_HEADERS.length).getValues()[0];
      if (!usageRowMatches_(current, match)) rowNum = -1;
    }
    // Another user may have deleted a row above this one, shifting its number.
    // Locate the same record by identity instead of failing or touching the row
    // that now happens to occupy the old index.
    if (rowNum === -1 && match) {
      var values = sh.getRange(2, 1, sh.getLastRow() - 1, PARTUSAGE_HEADERS.length).getValues();
      for (var i = values.length - 1; i >= 0; i--) {
        if (usageRowMatches_(values[i], match)) { rowNum = i + 2; break; }
      }
    }
    if (rowNum === -1) return { success: true, action: 'already_deleted' };
    sh.deleteRow(rowNum);
    SpreadsheetApp.flush();
    return { success: true, action: 'deleted', row: rowNum };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// Edit fields of one PartUsage row. params: { row, match, updates:{Header:value} }
function updatePartUsage(params) {
  var row = Number(params && params.row);
  if (!row || row < 2) throw new Error('row required');
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PARTUSAGE_SHEET);
  if (!sh || row > sh.getLastRow()) return { success: false, error: 'ไม่พบแถว — โหลดใหม่แล้วลองอีกครั้ง' };
  var vals = sh.getRange(row, 1, 1, PARTUSAGE_HEADERS.length).getValues()[0];
  if (!usageRowMatches_(vals, params && params.match)) return { success: false, error: 'ข้อมูลเปลี่ยนไป — โหลดใหม่แล้วลองอีกครั้ง' };
  var updates = (params && params.updates) || {};
  PARTUSAGE_HEADERS.forEach(function (h, c) {
    if (Object.prototype.hasOwnProperty.call(updates, h)) sh.getRange(row, c + 1).setValue(updates[h]);
  });
  return { success: true };
}

// ============================================================
// PENDING PARTS — parts that were requisitioned but aren't in "Part No." yet
// The requisitioner usually knows the part by sight and by a local name, not by
// its Article No. Previously those went straight into "Part No." as rows with an
// empty Article No, which polluted the master list and threw away the context
// (machine / customer) needed to identify them later. They're queued here
// instead, with a photo and that context, until the real code turns up.
// Resolving one is done by the client with the existing recordNew action, then
// deletePendingPart — no separate "promote" action needed here.
// ============================================================
const PENDINGPARTS_SHEET = 'PendingParts';
const PENDINGPARTS_HEADERS = [
  'PendingId', 'CreatedAt', 'RequisitionName', 'ImageURL',
  'MachineNo', 'MachineType', 'Customer', 'OrderId', 'RecordedBy'
];

function getPendingPartsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(PENDINGPARTS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(PENDINGPARTS_SHEET);
    sh.appendRow(PENDINGPARTS_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

// Upserts by RequisitionName: the same unknown part asked for on three orders is
// still ONE part to create, so it stays one row. The newest requisition's
// context wins, but an existing photo is never wiped by a later blank one.
function addPendingPart(params) {
  const name = String((params && params.requisitionName) || '').trim();
  if (!name) throw new Error('requisitionName required');

  const sh = getPendingPartsSheet_();
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { throw new Error('busy, try again'); }
  try {
    const last = sh.getLastRow();
    let rowNum = -1;
    if (last > 1) {
      const names = sh.getRange(2, 3, last - 1, 1).getValues(); // col C = RequisitionName
      for (var i = 0; i < names.length; i++) {
        if (String(names[i][0]).trim().toLowerCase() === name.toLowerCase()) { rowNum = i + 2; break; }
      }
    }
    const isNew = rowNum === -1;
    const pendingId = isNew ? ('p-' + Utilities.getUuid().slice(0, 8))
                            : String(sh.getRange(rowNum, 1).getValue());
    const row = [
      pendingId,
      isNew ? new Date() : (sh.getRange(rowNum, 2).getValue() || new Date()),
      name,
      String((params.imageURL) || '') || (isNew ? '' : String(sh.getRange(rowNum, 4).getValue() || '')),
      String((params.machineNo) || ''),
      String((params.machineType) || ''),
      String((params.customer) || ''),
      String((params.orderId) || ''),
      String((params.recordedBy) || '')
    ];
    if (isNew) sh.appendRow(row);
    else sh.getRange(rowNum, 1, 1, PENDINGPARTS_HEADERS.length).setValues([row]);
    return { success: true, pendingId: pendingId, action: isNew ? 'added' : 'updated' };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

function getPendingParts(params) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PENDINGPARTS_SHEET);
  if (!sh || sh.getLastRow() < 2) return { success: true, rows: [] };
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, PENDINGPARTS_HEADERS.length).getValues();
  const rows = [];
  for (var i = values.length - 1; i >= 0; i--) {   // newest first
    if (!String(values[i][0]).trim()) continue;
    const o = {};
    PENDINGPARTS_HEADERS.forEach(function (h, c) {
      o[h] = values[i][c] instanceof Date ? values[i][c].toISOString() : values[i][c];
    });
    rows.push(o);
  }
  return { success: true, rows: rows };
}

function deletePendingPart(params) {
  const id = String((params && params.pendingId) || '').trim();
  if (!id) throw new Error('pendingId required');
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PENDINGPARTS_SHEET);
  if (!sh || sh.getLastRow() < 2) return { success: true, action: 'noop' };
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { throw new Error('busy, try again'); }
  try {
    const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    for (var i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0]).trim() === id) { sh.deleteRow(i + 2); return { success: true, action: 'deleted' }; }
    }
    return { success: true, action: 'not_found' };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// ============================================================
// EMAIL RECIPIENTS — saved To/Cc addresses for the Power Automate send flow
// A small shared directory so the team doesn't retype the same addresses on
// every order. Read is open to anyone (the send-review modal offers them as
// autocomplete); add/delete is UI-gated to Power User in the frontend, same
// trust model as the other global settings in this app.
// ============================================================
const EMAILRECIPIENTS_SHEET = 'EmailRecipients';
// Type: 'to' | 'cc' — the send flow addresses every saved 'to' recipient and
// copies every 'cc' one; there is no per-order picking in the app anymore.
const EMAILRECIPIENTS_HEADERS = ['Email', 'Name', 'Type', 'AddedBy', 'AddedAt'];

function getEmailRecipientsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(EMAILRECIPIENTS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(EMAILRECIPIENTS_SHEET);
    sh.appendRow(EMAILRECIPIENTS_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function getEmailRecipients(params) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EMAILRECIPIENTS_SHEET);
  if (!sh || sh.getLastRow() < 2) return { success: true, rows: [] };
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, EMAILRECIPIENTS_HEADERS.length).getValues();
  const rows = [];
  values.forEach(function (v) {
    if (!String(v[0]).trim()) return;
    rows.push({ Email: String(v[0]), Name: String(v[1] || ''),
      Type: String(v[2] || '').toLowerCase() === 'cc' ? 'cc' : 'to',
      AddedBy: String(v[3] || ''),
      AddedAt: v[4] instanceof Date ? v[4].toISOString() : v[4] });
  });
  rows.sort(function (a, b) {
    if (a.Type !== b.Type) return a.Type === 'to' ? -1 : 1;   // To ก่อน CC
    return a.Name.localeCompare(b.Name) || a.Email.localeCompare(b.Email);
  });
  return { success: true, rows: rows };
}

// Upserts by email (case-insensitive) so re-adding just updates the name.
function addEmailRecipient(params) {
  const email = String((params && params.email) || '').trim();
  if (!email || email.indexOf('@') === -1) throw new Error('valid email required');
  const name = String((params && params.name) || '').trim();
  const type = String((params && params.type) || '').toLowerCase() === 'cc' ? 'cc' : 'to';
  const addedBy = String((params && params.addedBy) || '').trim();

  const sh = getEmailRecipientsSheet_();
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) { throw new Error('busy, try again'); }
  try {
    const last = sh.getLastRow();
    let rowNum = -1;
    if (last > 1) {
      const emails = sh.getRange(2, 1, last - 1, 1).getValues();
      for (var i = 0; i < emails.length; i++) {
        if (String(emails[i][0]).trim().toLowerCase() === email.toLowerCase()) { rowNum = i + 2; break; }
      }
    }
    const row = [email, name, type, addedBy, new Date()];
    if (rowNum === -1) sh.appendRow(row);
    else sh.getRange(rowNum, 1, 1, EMAILRECIPIENTS_HEADERS.length).setValues([row]);
    return { success: true, action: rowNum === -1 ? 'added' : 'updated' };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

function deleteEmailRecipient(params) {
  const email = String((params && params.email) || '').trim().toLowerCase();
  if (!email) throw new Error('email required');
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EMAILRECIPIENTS_SHEET);
  if (!sh || sh.getLastRow() < 2) return { success: true, action: 'noop' };
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) { throw new Error('busy, try again'); }
  try {
    const emails = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    for (var i = emails.length - 1; i >= 0; i--) {
      if (String(emails[i][0]).trim().toLowerCase() === email) { sh.deleteRow(i + 2); return { success: true, action: 'deleted' }; }
    }
    return { success: true, action: 'not_found' };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// ============================================================
// SEND-EMAIL RECIPIENTS — saved To/Cc addresses for the ✉ Send to email
// button (opens an Outlook web draft). Deliberately a SEPARATE sheet/list from
// EmailRecipients above (which feeds ⚡ Auto email / the Power Automate send)
// — the two buttons are independent features with independent directories, by
// explicit request, even though the row shape is identical. Same trust model:
// read open to anyone, add/delete Power-User gated in the frontend UI.
// ============================================================
const SENDEMAILRECIPIENTS_SHEET = 'SendEmailRecipients';
const SENDEMAILRECIPIENTS_HEADERS = ['Email', 'Name', 'Type', 'AddedBy', 'AddedAt'];

function getSendEmailRecipientsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SENDEMAILRECIPIENTS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SENDEMAILRECIPIENTS_SHEET);
    sh.appendRow(SENDEMAILRECIPIENTS_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function getSendEmailRecipients(params) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SENDEMAILRECIPIENTS_SHEET);
  if (!sh || sh.getLastRow() < 2) return { success: true, rows: [] };
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, SENDEMAILRECIPIENTS_HEADERS.length).getValues();
  const rows = [];
  values.forEach(function (v) {
    if (!String(v[0]).trim()) return;
    rows.push({ Email: String(v[0]), Name: String(v[1] || ''),
      Type: String(v[2] || '').toLowerCase() === 'cc' ? 'cc' : 'to',
      AddedBy: String(v[3] || ''),
      AddedAt: v[4] instanceof Date ? v[4].toISOString() : v[4] });
  });
  rows.sort(function (a, b) {
    if (a.Type !== b.Type) return a.Type === 'to' ? -1 : 1;   // To ก่อน CC
    return a.Name.localeCompare(b.Name) || a.Email.localeCompare(b.Email);
  });
  return { success: true, rows: rows };
}

// Upserts by email (case-insensitive) so re-adding just updates the name.
function addSendEmailRecipient(params) {
  const email = String((params && params.email) || '').trim();
  if (!email || email.indexOf('@') === -1) throw new Error('valid email required');
  const name = String((params && params.name) || '').trim();
  const type = String((params && params.type) || '').toLowerCase() === 'cc' ? 'cc' : 'to';
  const addedBy = String((params && params.addedBy) || '').trim();

  const sh = getSendEmailRecipientsSheet_();
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) { throw new Error('busy, try again'); }
  try {
    const last = sh.getLastRow();
    let rowNum = -1;
    if (last > 1) {
      const emails = sh.getRange(2, 1, last - 1, 1).getValues();
      for (var i = 0; i < emails.length; i++) {
        if (String(emails[i][0]).trim().toLowerCase() === email.toLowerCase()) { rowNum = i + 2; break; }
      }
    }
    const row = [email, name, type, addedBy, new Date()];
    if (rowNum === -1) sh.appendRow(row);
    else sh.getRange(rowNum, 1, 1, SENDEMAILRECIPIENTS_HEADERS.length).setValues([row]);
    return { success: true, action: rowNum === -1 ? 'added' : 'updated' };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

function deleteSendEmailRecipient(params) {
  const email = String((params && params.email) || '').trim().toLowerCase();
  if (!email) throw new Error('email required');
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SENDEMAILRECIPIENTS_SHEET);
  if (!sh || sh.getLastRow() < 2) return { success: true, action: 'noop' };
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) { throw new Error('busy, try again'); }
  try {
    const emails = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    for (var i = emails.length - 1; i >= 0; i--) {
      if (String(emails[i][0]).trim().toLowerCase() === email) { sh.deleteRow(i + 2); return { success: true, action: 'deleted' }; }
    }
    return { success: true, action: 'not_found' };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}
