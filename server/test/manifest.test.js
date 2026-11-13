const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/lib/dispatch');
const { parseManifestReply } = require('../src/lib/manifest');

const conf = P.normaliseDispatchConfig({}, P.DEFAULT_DISPATCH_CONFIG);
const who = { id: 'u1', name: 'Ravi' };
const at = new Date('2026-10-19T09:00:00+05:30');
const packedDoc = (id, courier = 'Delhivery', extra = {}) => ({ orderId: id, stage: 'dispatch', confirmedAt: at, dq: { step: 'handover', stepAt: at, packed: { awb: `AWB${id}00`, courier }, ...extra } });
const apply = (d, t) => ({ ...d, ...t.set });
const sent = [{ orderId: 1501, shipwayId: '1501' }, { orderId: 1502, shipwayId: '1502' }, { orderId: 1503, shipwayId: '1503' }];

test('a manifest id with no rejections puts every order on the manifest', () => {
  const r = parseManifestReply({ status: 'Success', manifest_id: 'MF-77' }, sent);
  assert.equal(r.manifestId, 'MF-77');
  assert.deepEqual(r.accepted, [1501, 1502, 1503]);
  assert.deepEqual(r.rejected, []);
});

test('rejected orders (list of objects) stay out, with Shipway’s reason', () => {
  const r = parseManifestReply({ data: { manifest_id: 'MF-78' }, failed_orders: [{ order_id: '1502', msg: 'Pincode not serviceable' }] }, sent);
  assert.deepEqual(r.accepted, [1501, 1503]);
  assert.deepEqual(r.rejected, [{ orderId: 1502, reason: 'Pincode not serviceable' }]);
});

test('rejections keyed by order id, and #-prefixed ids, are understood', () => {
  const r = parseManifestReply({ manifest_id: 'MF-79', errors: { '#1503': 'AWB already manifested' } }, [{ orderId: 1503, shipwayId: '#1503' }, { orderId: 1501, shipwayId: '#1501' }]);
  assert.deepEqual(r.accepted, [1501]);
  assert.equal(r.rejected[0].reason, 'AWB already manifested');
});

test('an accepted list wins: orders missing from it are rejected', () => {
  const r = parseManifestReply({ manifest_id: 'MF-80', success_orders: ['1501', '1503'] }, sent);
  assert.deepEqual(r.accepted, [1501, 1503]);
  assert.equal(r.rejected[0].orderId, 1502);
  assert.match(r.rejected[0].reason, /left this order out/);
});

test('no manifest id means nobody is on a manifest, and the reason is shown', () => {
  const r = parseManifestReply({ status: 'Failed', message: 'Courier not enabled for this account' }, sent);
  assert.equal(r.manifestId, null);
  assert.deepEqual(r.accepted, []);
  assert.equal(r.rejected.length, 3);
  assert.equal(r.rejected[0].reason, 'Courier not enabled for this account');
  assert.equal(parseManifestReply(null, sent).rejected[0].reason, 'Shipway did not create a manifest');
});

test('a rejection without a reason still says so', () => {
  const r = parseManifestReply({ manifest_id: 'M1', failed: ['1501'] }, sent);
  assert.equal(r.rejected[0].reason, 'Shipway rejected this order (no reason given)');
});

test('manifestAssigned saves the id and keeps the order at handover', () => {
  const d = packedDoc(1501);
  const t = P.manifestAssigned(d, { manifestId: 'MF-1', courier: 'Delhivery' }, who);
  const next = apply(d, t);
  assert.equal(P.stepOf(next), 'handover');
  assert.equal(P.manifestOf(next), 'MF-1');
  assert.equal(t.entries[0].action, 'manifest');
  assert.throws(() => P.manifestAssigned(next, { manifestId: 'MF-2' }, who), /already on manifest MF-1/);
});

test('only packed, not-held, un-manifested orders can get a manifest', () => {
  assert.equal(P.eligibleForManifest(packedDoc(1)), true);
  assert.equal(P.eligibleForManifest({ ...packedDoc(1), dq: { step: 'packed' } }), false);
  assert.equal(P.eligibleForManifest(packedDoc(1, 'X', { hold: { at, note: 'x' } })), false);
  assert.equal(P.eligibleForManifest(packedDoc(1, 'X', { manifest: { id: 'M' } })), false);
  assert.throws(() => P.manifestAssigned({ ...packedDoc(1), dq: { step: 'slip' } }, { manifestId: 'M' }, who), /not “Order handover”|is at/);
  assert.throws(() => P.manifestAssigned(packedDoc(1), {}, who), /no manifest id/);
});

test('a rejection is stored on the order and cleared when a manifest accepts it later', () => {
  let d = packedDoc(1502);
  d = apply(d, P.manifestRejected(d, { reason: 'Pincode not serviceable', courier: 'Delhivery' }, who));
  assert.equal(P.manifestError(d).message, 'Pincode not serviceable');
  assert.equal(P.manifestOf(d), '');
  d = apply(d, P.manifestAssigned(d, { manifestId: 'MF-9', courier: 'Delhivery' }, who));
  assert.equal(P.manifestError(d), null);
});

test('Handover groups by manifest id; orders without one stay loose', () => {
  const cards = [
    { orderId: 1, dq: { manifest: { id: 'A', courier: 'Delhivery', at: '2026-10-19T10:00:00Z' } } },
    { orderId: 2, dq: { manifest: { id: 'B', courier: 'Bluedart', at: '2026-10-19T11:00:00Z' } } },
    { orderId: 3, dq: { manifest: { id: 'A', courier: 'Delhivery', at: '2026-10-19T10:00:00Z' } } },
    { orderId: 4, dq: { manifest: null } },
  ];
  const g = P.groupByManifest(cards);
  assert.deepEqual(g.groups.map((x) => [x.manifestId, x.orders.map((o) => o.orderId)]), [['B', [2]], ['A', [1, 3]]]);
  assert.deepEqual(g.loose.map((o) => o.orderId), [4]);
});

test('manifestCouriers counts only eligible orders, merging spellings', () => {
  const docs = [packedDoc(1, 'Delhivery'), packedDoc(2, 'delhivery '), packedDoc(3, 'Bluedart'), packedDoc(4, 'Delhivery', { manifest: { id: 'M' } }), packedDoc(5, '')];
  const mc = P.manifestCouriers(docs);
  assert.deepEqual(mc.map((x) => [x.courier, x.count]), [['Delhivery', 2], ['Bluedart', 1]]);
  assert.deepEqual(mc[0].orders.map((o) => o.orderId), [1, 2]); // each courier lists its orders so the team can tick the ones really packed
});

test('handover records the manifest id and still needs the one photo', () => {
  const d = packedDoc(1501, 'Delhivery', { manifest: { id: 'MF-1' } });
  assert.throws(() => P.handoverDone(d, {}, conf, who), /photo of the manifest/);
  const t = P.handoverDone(d, { manifestIds: ['photo1'] }, conf, who);
  assert.equal(t.set.dq.handover.manifestRef, 'MF-1');
  assert.equal(t.set.stage, 'dispatched');
});

test('an error message can never become a manifest id', () => {
  const sent1 = [{ orderId: 1501, shipwayId: '1501' }];
  const bad = parseManifestReply({ status: 'Failed', message: 'Manifest id missing' }, sent1);
  assert.equal(bad.manifestId, null); assert.equal(bad.accepted.length, 0); assert.equal(bad.rejected[0].orderId, 1501);
  const noDigit = parseManifestReply({ status: 'Success', message: 'Manifest id missing' }, sent1);
  assert.equal(noDigit.manifestId, null);
  const ok = parseManifestReply({ status: 'Success', message: 'Manifest created. Manifest ID: MF20261' }, sent1);
  assert.equal(ok.manifestId, 'MF20261');
});

test('“Manifest created successfully” with no readable id is not a rejection', () => {
  const r = parseManifestReply({ success: 1, message: 'Manifest created successfully.' }, sent);
  assert.equal(r.manifestId, null); assert.equal(r.noId, true);
  assert.deepEqual(r.rejected, []); assert.deepEqual(r.accepted, []);
  // but a real refusal is still a refusal
  const no = parseManifestReply({ message: 'Manifest is already Created.' }, sent);
  assert.equal(no.noId, undefined); assert.equal(no.rejected.length, 3);
});

test('Shipway’s real reply: manifest_ids as a string is the manifest id', () => {
  const r = parseManifestReply({ status: true, message: 'Manifest created successfully.', manifest_ids: '5732701' }, sent);
  assert.equal(r.manifestId, '5732701');
  assert.deepEqual(r.accepted, [1501, 1502, 1503]); assert.deepEqual(r.rejected, []); assert.equal(r.noId, undefined);
  assert.equal(parseManifestReply({ manifest_ids: [5732701] }, sent).manifestId, '5732701');
  assert.equal(parseManifestReply({ manifest_ids: 5732701 }, sent).manifestId, '5732701');
});

test('several manifest ids in one reply are not guessed', () => {
  const r = parseManifestReply({ status: true, message: 'Manifest created successfully.', manifest_ids: '5732701, 5732702' }, sent);
  assert.equal(r.manifestId, null); assert.equal(r.noId, true); assert.deepEqual(r.manyIds, ['5732701', '5732702']); assert.deepEqual(r.accepted, []);
});
