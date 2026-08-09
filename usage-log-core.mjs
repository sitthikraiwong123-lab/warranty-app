export const USAGE_ACTIONS = Object.freeze([
  'save',
  'pdf_preview',
  'download',
  'share',
  'email_share',
  'email_graph',
  'email_deeplink',
  'auto_email',
  'legacy_export'
]);

const actionSet = new Set(USAGE_ACTIONS);

function text(value) {
  return String(value == null ? '' : value);
}

function recordedByText(value) {
  return text(value).trim() || '-';
}

function usageImageUrlList(source) {
  const out = [];
  const add = (value) => {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach(add); return; }
    if (typeof value === 'object') {
      add(value.driveUrl || value.logUrl || value.imageURL || value.imageUrl || value.url || value.src);
      return;
    }
    const raw = text(value).trim();
    if (!raw) return;
    if (/^data:/i.test(raw)) return;
    if (raw[0] === '[') {
      try { add(JSON.parse(raw)); return; } catch (e) {}
    }
    raw.split(/\s*(?:\n|\||,)\s*/).forEach(part => {
      const url = part.trim();
      if (url && !out.includes(url)) out.push(url);
    });
  };
  add(source && (source.imageURLs || source.imageUrls || source.images || source.photos));
  add(source && (source.imageURL || source.imageUrl || source.driveUrl || source.logUrl || source.url));
  return out;
}

export function createUsageEventId() {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  return 'usage-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

export function buildUsageEvent(order, options = {}) {
  if (!order || !text(order.id).trim()) throw new Error('orderId required');
  const action = text(options.action || '').trim();
  if (!actionSet.has(action)) throw new Error('Invalid usage action: ' + action);

  const items = (Array.isArray(order.items) ? order.items : [])
    .filter(item => item && (text(item.articleNo).trim() || text(item.description).trim()))
    .map(item => ({
      articleNo: text(item.articleNo).trim(),
      partName: text(item.description),
      machineNo: text(item.machineNo),
      machineType: text(item.machineType),
      qty: item.qty === '' || item.qty == null ? '' : item.qty,
      unit: text(item.qtyUnit),
      note: text(item.itemDesc),
      setName: text(item.setName),
      imageURLs: usageImageUrlList(item)
    }));

  return {
    orderId: text(order.id).trim(),
    eventId: text(options.eventId || createUsageEventId()).trim(),
    action,
    eventCreatedAt: text(options.createdAt || new Date().toISOString()),
    type: text(order.type),
    customer: text(order.customer),
    recordedBy: recordedByText(options.recordedBy),
    expectedItems: items.length,
    items
  };
}

export function buildDraftRecoveryBatch(drafts, options = {}) {
  if (!Array.isArray(drafts)) throw new Error('Drafts must be an array');
  if (drafts.length > 10) throw new Error('Draft recovery is limited to 10 drafts');
  const recordedBy = recordedByText(options.recordedBy);
  return {
    drafts: drafts
      .filter(draft => draft && text(draft.id).trim())
      .map(draft => {
        const sourceItems = Array.isArray(draft.items) ? draft.items : [];
        if (sourceItems.length > 8) throw new Error('Draft recovery is limited to 8 items per draft');
        const items = sourceItems
          .filter(item => item && (text(item.articleNo).trim() || text(item.description).trim()))
          .map(item => ({
            articleNo:text(item.articleNo).trim(),
            partName:text(item.description),
            machineNo:text(item.machineNo),
            machineType:text(item.machineType),
            qty:item.qty === '' || item.qty == null ? '' : item.qty,
            unit:text(item.qtyUnit),
            note:text(item.itemDesc),
            setName:text(item.setName)
          }));
        return {
          orderId:text(draft.id).trim(),
          createdAt:Number(draft.createdAt) || 0,
          updatedAt:Number(draft.updatedAt) || 0,
          type:text(draft.type),
          customer:text(draft.customer),
          recordedBy,
          items
        };
      })
      .filter(draft => draft.items.length > 0)
  };
}

export function buildDraftRecoveryBatches(drafts, options = {}) {
  if (!Array.isArray(drafts)) throw new Error('Drafts must be an array');
  const batches = [];
  for (let index = 0; index < drafts.length; index += 10) {
    const batch = buildDraftRecoveryBatch(drafts.slice(index, index + 10), options);
    if (batch.drafts.length) batches.push(batch);
  }
  return batches;
}

export function validateUsageAck(response, event) {
  if (!event || !event.eventId) throw new Error('Usage event required');
  const expectedItems = Number(event.expectedItems) || 0;
  if (response && response.queued === true) {
    if (response.eventId && response.eventId !== event.eventId) throw new Error('Usage event acknowledgement mismatch');
    return {
      state:'queued', eventId:event.eventId, written:0, expectedItems, revision:null,
      error:text(response.error).trim()
    };
  }
  if (!response || response.success !== true) throw new Error('Usage log was not acknowledged');
  if (response.eventId !== event.eventId) throw new Error('Usage event acknowledgement mismatch');
  const written = Number(response.written);
  if (written !== expectedItems) throw new Error(`Usage log incomplete: ${written}/${expectedItems}`);
  return {
    state:'saved',
    eventId:event.eventId,
    written,
    expectedItems,
    revision:Number(response.revision) || null
  };
}

export function usageStatusSuffix(result) {
  if (!result) return '';
  if (result.state === 'failed') {
    const error = text(result.error).trim();
    return ' · ⚠ Log ยังไม่ถูกบันทึก' + (error ? ' — ' + error.slice(0, 160) : '');
  }
  return result.state === 'queued'
    ? ' · Log รอซิงค์ (' + result.expectedItems + ' รายการ)' +
      (result.error ? ' — ' + text(result.error).slice(0, 160) : '')
    : ' · Log บันทึกแล้ว ' + result.written + '/' + result.expectedItems;
}

globalThis.UsageLogCore = Object.freeze({
  USAGE_ACTIONS,
  createUsageEventId,
  buildUsageEvent,
  buildDraftRecoveryBatch,
  buildDraftRecoveryBatches,
  validateUsageAck,
  usageStatusSuffix
});

if (typeof globalThis.dispatchEvent === 'function' && typeof globalThis.Event === 'function') {
  globalThis.dispatchEvent(new globalThis.Event('usage-log-core-ready'));
}
