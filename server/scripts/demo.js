// ONE-COMMAND DEMO.  npm run demo   (from the project folder)
// - uses its own database (mysoul_demo), so your real data is never touched
// - pretend Shipway (SHIPWAY_MOCK=1): no real Shipway call is ever made
// - no Google Sheet, no Shopify needed
// - creates logins and test orders in every column, then starts the server on http://localhost:4000
// Run it again any time to reset the demo to the same starting point.
process.env.MONGO_URI = process.env.DEMO_MONGO_URI || 'mongodb://127.0.0.1:27017/mysoul_demo';
Object.assign(process.env, { SHIPWAY_MOCK: '1', SHIPWAY_USERNAME: '', SHIPWAY_LICENSE_KEY: '', SHEET_SOURCE: 'none', SHEET_ID: '', SHOPIFY_SHOP: '', SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '' });

// Safety: these scripts reset logins and orders 9000-9999, so they only ever run against a database whose name contains "demo" or "local".
function dbNameOf(uri) { try { return decodeURIComponent((new URL(uri).pathname || '').replace(/^\//, '')); } catch { return ''; } }
function assertDemoDatabase(uri) {
  const name = dbNameOf(uri);
  if (!/demo|local/i.test(name)) { console.error(`\nRefusing to run: database "${name || '(none)'}" is not marked as a demo database (its name must contain demo or local).\nNothing was changed.`); process.exit(1); }
  return name;
}

const mongoose = require('mongoose');
const cfg = require('../src/config');
const { ShopifyOrder, DeskOrder, ShipwayShipment, ShipCase, DispatchProof, StaffUser } = require('../src/models');
const A = require('../src/lib/staffAuth');

const H = 3600e3; const now = new Date(); const ago = (h) => new Date(now.getTime() - h * H);
const NAMES = ['Asha Rao', 'Vikram Shah', 'Neha Jain', 'Rohit Das', 'Meera Nair', 'Imran Khan', 'Priya Menon', 'Arjun Reddy', 'Sana Iqbal', 'Kiran Patel', 'Divya Iyer', 'Rahul Verma'];
const CITIES = ['Hyderabad', 'Pune', 'Delhi', 'Kolkata', 'Kochi', 'Mumbai', 'Chennai', 'Jaipur', 'Lucknow', 'Surat', 'Indore', 'Bhopal'];
const nameOf = (id) => NAMES[id % NAMES.length]; const cityOf = (id) => CITIES[id % CITIES.length];

const shop = (id, hoursAgo) => ({ orderId: id, shopifyId: `demo-${id}`, name: `#${id}`, createdAt: ago(hoursAgo), updatedAt: now, test: false, financialStatus: 'pending', paymentGateways: ['Cash on Delivery (COD)'], currency: 'INR', subtotal: 1299, shipping: 0, discounts: 0, total: 1299,
  customer: { name: nameOf(id), email: '', phone: '9000000000' }, address: { name: nameOf(id), line1: 'Demo street 1', city: cityOf(id), state: 'Demo', zip: '500001', country: 'India', phone: '9000000000' },
  items: [{ title: 'Soul Calm Candle', quantity: 1, price: 1299 }], itemsSummary: 'Soul Calm Candle × 1', syncedAt: now });
const ship = (id, courier, status, group, hoursAgo, extra = {}) => ({ orderId: id, found: true, shipwayOrderId: String(id), statusCode: status.slice(0, 3).toUpperCase(), status, group, final: false, carrier: courier, awb: `DEMO${id}${courier[0]}`, from: 'Hyderabad', to: cityOf(id), statusAt: ago(hoursAgo), changedAt: ago(hoursAgo), checkedAt: now, ...extra });
const desk = (id, dq, confirmedHrs = 5) => ({ orderId: id, orderAt: ago(30), stage: 'dispatch', fuNo: 1, confirmedAt: ago(confirmedHrs), confirmedBy: 'Demo', dq, assignee: null, rev: 0, log: [] });
const packed = (id, courier, hrs) => ({ at: ago(hrs), byName: 'Pack One', awb: `DEMO${id}${courier[0]}`, courier, photoIds: [] });

(async () => {
  const dbName = assertDemoDatabase(cfg.mongoUri); // checked before anything is written
  await mongoose.connect(cfg.mongoUri, { serverSelectionTimeoutMS: 5000 });
  console.log(`Database: ${dbName}`);

  // logins
  for (const [username, password, roles, name] of [['admin', 'admin12345', ['admin'], 'Admin'], ['confirm1', 'confirm12345', ['confirmation'], 'Confirm One'], ['pack1', 'pack12345', ['packing'], 'Pack One']]) {
    const r = A.normaliseRoles(roles);
    await StaffUser.updateOne({ username }, { $set: { name, role: r.role, roles: r.roles, passwordHash: A.hashPassword(password), active: true, mustChangePassword: false, createdBy: 'demo' }, $setOnInsert: { username } }, { upsert: true });
  }

  // wipe the demo orders (9000-9999) so every run starts the same
  const range = { $gte: 9000, $lt: 10000 };
  await Promise.all([DeskOrder, ShopifyOrder, ShipwayShipment, ShipCase].map((M) => M.deleteMany({ orderId: range })));
  await DispatchProof.deleteMany({ $or: [{ orderId: range }, { orderIds: { $elemMatch: range } }] });

  const shops = []; const desks = []; const ships = [];
  // Order handover: 3 Delhivery + 3 Bluedart, packed, waiting for a manifest (#9004 will be rejected by the pretend Shipway: its number ends in 4)
  for (const [id, c] of [[9001, 'Delhivery'], [9002, 'Delhivery'], [9004, 'Delhivery'], [9003, 'Bluedart'], [9005, 'Bluedart'], [9006, 'Bluedart']]) {
    shops.push(shop(id, 30)); desks.push(desk(id, { step: 'handover', stepAt: ago(2), slip: { at: ago(4), byName: 'Pack One' }, packed: packed(id, c, 2) }));
  }
  // Order packed: Shipway already has the AWB, so the sheet fills it in
  for (const id of [9111, 9112, 9113]) { const c = id === 9113 ? 'Bluedart' : 'Delhivery'; shops.push(shop(id, 28)); ships.push(ship(id, c, 'Booked', 'other', 3)); desks.push(desk(id, { step: 'packed', stepAt: ago(1), slip: { at: ago(2), byName: 'Pack One' } })); }
  // Packing slip
  for (const id of [9101, 9102, 9103]) { shops.push(shop(id, 26)); desks.push(desk(id, { step: 'slip', stepAt: ago(1) }, 1)); }
  // NDR (courier could not deliver) and RTO (coming back): orders older than a week so they stay out of the confirm queue
  for (const id of [9201, 9202, 9203]) { shops.push(shop(id, 24 * 12)); ships.push(ship(id, 'Delhivery', ['Undelivered: customer not available', 'Undelivered: address incomplete', 'Undelivered: customer asked to reschedule'][id - 9201], 'ndr', 2 + (id - 9201))); }
  for (const id of [9301, 9302, 9303, 9304]) { shops.push(shop(id, 24 * 14)); ships.push(ship(id, id % 2 ? 'Bluedart' : 'Delhivery', id === 9304 ? 'RTO Delivered to origin' : 'RTO In Transit', 'rto', 20 + (id - 9301) * 6)); }
  // Confirm queue: new orders waiting for a call
  for (const id of [9401, 9402, 9403]) shops.push(shop(id, 1 + (id - 9401)));

  await ShopifyOrder.insertMany(shops); await DeskOrder.insertMany(desks); await ShipwayShipment.insertMany(ships);
  console.log(`Test orders ready: ${desks.length} in the dispatch queue (slip 3, packed 3, handover 6), 3 NDR, 4 RTO, 3 waiting for confirmation.\n`);
  console.log('Sign in at http://localhost:4000/team (or :5173/team) with:\n  admin    / admin12345   (sees everything)\n  pack1    / pack12345    (packing team)\n  confirm1 / confirm12345 (confirmation team)\n');
  await mongoose.disconnect();
  require('../src/index.js'); // start the server
})().catch((e) => { console.error(`\nDemo setup failed: ${e.message}\nIs MongoDB running? Start it first (see the steps).`); process.exit(1); });
