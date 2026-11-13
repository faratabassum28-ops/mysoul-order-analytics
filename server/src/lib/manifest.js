// Reading Shipway's reply to "create a manifest". Pure functions (no network, no database) so every shape can be unit-tested.
// Shipway's reply layout is not fixed in its docs, so this reads the usual places and names. Rule of thumb: an order is in the
// manifest only if a manifest id came back AND Shipway did not reject that order. Anything unclear counts as rejected, with the reason shown.
const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());
const bare = (v) => clean(v).replace(/^#/, '');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

const ID_KEYS = ['manifest_ids', 'manifestIds', 'manifest_id', 'manifestId', 'manifest_no', 'manifestNo', 'manifest_number', 'manifestNumber'];
// Shipway's real reply: {"status":true,"message":"Manifest created successfully.","manifest_ids":"5732701"} (a string, or a list / comma-separated text)
const idList = (v) => (Array.isArray(v) ? v.flatMap(idList) : (typeof v === 'string' || typeof v === 'number') ? String(v).split(/[,;\s]+/).map(clean).filter(Boolean) : []);
function readManifestIds(list) { for (const o of list) for (const k of ID_KEYS) { const ids = idList(o[k]); if (ids.length) return ids; } return []; }
const REJECT_KEYS = ['failed', 'failed_orders', 'failed_order_ids', 'errors', 'error_orders', 'invalid_orders', 'rejected', 'not_created', 'unprocessed'];
const ACCEPT_KEYS = ['success_orders', 'successful_orders', 'accepted', 'processed', 'created_orders', 'manifest_orders'];
const REASON_KEYS = ['msg', 'message', 'reason', 'error', 'status_message'];
const ORDER_KEYS = ['order_id', 'orderid', 'orderId', 'order', 'id'];

const roots = (d) => [d, d && d.data, d && d.response, d && d.result, d && isObj(d.message) ? d.message : null].filter(isObj);
const firstOf = (list, keys) => { for (const o of list) for (const k of keys) if (o[k] !== undefined && o[k] !== null && clean(o[k]) !== '' && typeof o[k] !== 'object') return clean(o[k]); return ''; };
const arrayOf = (list, keys) => { for (const o of list) for (const k of keys) if (o[k] !== undefined && o[k] !== null && typeof o[k] === 'object') return o[k]; return null; };

// -> [{ id, reason }] from a list of ids, a list of objects, or an object keyed by order id
function entries(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.map((i) => (isObj(i) ? { id: bare(firstOf([i], ORDER_KEYS)), reason: firstOf([i], REASON_KEYS) } : { id: bare(i), reason: '' }));
  if (isObj(x)) return Object.entries(x).map(([k, v]) => (isObj(v) ? { id: bare(k), reason: firstOf([v], REASON_KEYS) } : { id: bare(k), reason: clean(v) }));
  return [];
}

// sent: [{ orderId, shipwayId }]  ->  { manifestId, accepted: [orderId], rejected: [{ orderId, reason }], message }
function parseManifestReply(data, sent) {
  const d = isObj(data) ? data : {};
  const rs = roots(d);
  const byShipway = new Map(sent.map((s) => [bare(s.shipwayId), s.orderId]));
  const byNumber = new Map(sent.map((s) => [String(s.orderId), s.orderId]));
  const find = (id) => (byShipway.has(id) ? byShipway.get(id) : byNumber.has(id) ? byNumber.get(id) : null);

  let message = ['msg', 'message', 'error'].map((k) => d[k]).find((v) => typeof v === 'string' && v.trim()) || '';
  message = clean(message);
  const foundIds = readManifestIds(rs);
  // One request is for one courier, so one manifest id is expected. Several would not tell us which order is on which manifest: stop and say so.
  if (foundIds.length > 1) return { manifestId: null, accepted: [], rejected: [], message: `Shipway returned several manifest IDs (${foundIds.join(', ')}) for one request`, noId: true, manyIds: foundIds };
  let manifestId = foundIds[0] || '';
  // Last resort: an id written inside a success message. Never for a failure reply, and the id must contain a digit,
  // so words from an error such as "manifest id missing" can never become a manifest id.
  const failed = /fail|error|invalid|reject|denied|unauthori[sz]ed/i.test(clean(d.status) + ' ' + clean(d.success === false ? 'fail' : ''));
  if (!manifestId && message && !failed) { const m = message.match(/manifest\s*(?:id|no\.?|number)\s*[:#-]?\s*([A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)/i); if (m && m[1].length >= 3) manifestId = m[1]; }

  const why = new Map(); const general = [];
  for (const e of entries(arrayOf(rs, REJECT_KEYS))) {
    const o = find(e.id);
    if (o === null) { if (e.id || e.reason) general.push(e.reason || e.id); } else why.set(o, e.reason || '');
  }
  const acceptList = arrayOf(rs, ACCEPT_KEYS);
  const acceptedSet = acceptList ? new Set(entries(acceptList).map((e) => find(e.id)).filter((o) => o !== null)) : null;

  // Shipway says it worked but sent no id we can read: this is NOT a rejection. Nothing is blamed on the orders; the screen explains it.
  const saidCreated = !manifestId && !why.size && !general.length && /success|created/i.test(message) && !/already|fail|error|invalid|reject|not\s/i.test(message);
  if (saidCreated) return { manifestId: null, accepted: [], rejected: [], message, noId: true };
  const base = general.length ? general.join('; ') : (manifestId ? '' : message);
  const accepted = []; const rejected = [];
  for (const s of sent) {
    const o = s.orderId;
    if (!manifestId) { rejected.push({ orderId: o, reason: why.get(o) || base || 'Shipway did not create a manifest' }); continue; }
    if (why.has(o)) { rejected.push({ orderId: o, reason: why.get(o) || base || 'Shipway rejected this order (no reason given)' }); continue; }
    if (acceptedSet && !acceptedSet.has(o)) { rejected.push({ orderId: o, reason: base || 'Shipway left this order out of the manifest (no reason given)' }); continue; }
    accepted.push(o);
  }
  return { manifestId: manifestId || null, accepted, rejected, message };
}

module.exports = { parseManifestReply };
