// Local demo data: 6 packed orders waiting in "Order handover" (3 Delhivery, 3 Bluedart). Safe to run again.
// Safety: these scripts reset logins and orders 9000-9999, so they only ever run against a database whose name contains "demo" or "local".
function dbNameOf(uri) { try { return decodeURIComponent((new URL(uri).pathname || '').replace(/^\//, '')); } catch { return ''; } }
function assertDemoDatabase(uri) {
  const name = dbNameOf(uri);
  if (!/demo|local/i.test(name)) { console.error(`\nRefusing to run: database "${name || '(none)'}" is not marked as a demo database (its name must contain demo or local).\nNothing was changed.`); process.exit(1); }
  return name;
}

const mongoose = require('mongoose');
const cfg = require('../src/config');
const { ShopifyOrder, DeskOrder } = require('../src/models');

const ROWS = [
  [9001, 'Asha Rao', 'Hyderabad', 'Delhivery'], [9002, 'Vikram Shah', 'Pune', 'Delhivery'], [9004, 'Neha Jain', 'Delhi', 'Delhivery'],
  [9003, 'Rohit Das', 'Kolkata', 'Bluedart'], [9005, 'Meera Nair', 'Kochi', 'Bluedart'], [9006, 'Imran Khan', 'Mumbai', 'Bluedart'],
];
(async () => {
  assertDemoDatabase(cfg.mongoUri); // checked before anything is written
  await mongoose.connect(cfg.mongoUri, { serverSelectionTimeoutMS: 5000 });
  const now = new Date(); const ago = (h) => new Date(now.getTime() - h * 3600e3);
  for (const [id, name, city, courier] of ROWS) {
    const at = ago(3);
    await ShopifyOrder.updateOne({ orderId: id }, { $set: {
      orderId: id, shopifyId: `demo-${id}`, name: `#${id}`, createdAt: ago(30), updatedAt: now, test: false, financialStatus: 'pending', fulfillmentStatus: null,
      paymentGateways: ['Cash on Delivery (COD)'], currency: 'INR', subtotal: 1299, shipping: 0, discounts: 0, total: 1299,
      customer: { name, email: '', phone: '9000000000' }, address: { name, line1: 'Demo street 1', city, state: 'Demo', zip: '500001', country: 'India', phone: '9000000000' },
      items: [{ title: 'Demo product', quantity: 1, price: 1299 }], itemsSummary: 'Demo product × 1', syncedAt: now,
    } }, { upsert: true });
    await DeskOrder.updateOne({ orderId: id }, { $set: {
      orderId: id, orderAt: ago(30), stage: 'dispatch', fuNo: 1, confirmedAt: ago(4), confirmedBy: 'Demo',
      dq: { step: 'handover', stepAt: at, manifest: null, manifestError: null, hold: null,
        slip: { at: ago(3.5), byName: 'Demo' }, packed: { at, byName: 'Demo', awb: `DEMO${id}00${courier[0]}`, courier, photoIds: [] } },
      assignee: null, rev: 0, log: [],
    }, $unset: { cancel: '', dispatch: '' } }, { upsert: true });
  }
  console.log('Demo data ready: 6 packed orders (#9001-#9006) in Order handover.');
  await mongoose.disconnect();
})().catch((e) => { console.error('Demo seed failed:', e.message); process.exit(1); });
