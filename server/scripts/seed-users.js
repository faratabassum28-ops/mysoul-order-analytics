// Creates (or resets) team logins directly in MongoDB, for local use.
//   npm --prefix server run seed                       -> admin / admin12345, confirm1 / confirm12345, pack1 / pack12345 (demo/local/test databases only)
//   node scripts/seed-users.js <username> <password> <roles> [Name]
//        roles: admin | confirmation | packing | confirmation,packing
// Running it again for the same username resets that person's password and roles.
// Safety: these scripts reset logins and orders 9000-9999, so they only ever run against a database whose name contains "demo" or "local".
function dbNameOf(uri) { try { return decodeURIComponent((new URL(uri).pathname || '').replace(/^\//, '')); } catch { return ''; } }
function assertDemoDatabase(uri) {
  const name = dbNameOf(uri);
  if (!/demo|local/i.test(name)) { console.error(`\nRefusing to run: database "${name || '(none)'}" is not marked as a demo database (its name must contain demo or local).\nNothing was changed.`); process.exit(1); }
  return name;
}

const mongoose = require('mongoose');
const cfg = require('../src/config');
const { StaffUser } = require('../src/models');
const A = require('../src/lib/staffAuth');

const DEFAULTS = [
  ['admin', 'admin12345', ['admin'], 'Admin'],
  ['confirm1', 'confirm12345', ['confirmation'], 'Confirm One'],
  ['pack1', 'pack12345', ['packing'], 'Pack One'],
];

async function upsert(username, password, roles, name) {
  username = A.normaliseUsername(username);
  if (!A.USERNAME_RE.test(username)) throw new Error(`Username “${username}” must be 3 to 32 letters, digits, . _ -`);
  const problem = A.passwordProblem(password); if (problem) throw new Error(problem);
  const picked = A.normaliseRoles(roles);
  const set = { name: name || username, role: picked.role, roles: picked.roles, passwordHash: A.hashPassword(password), active: true, mustChangePassword: false, createdBy: 'local seed' };
  const existed = await StaffUser.exists({ username });
  await StaffUser.updateOne({ username }, { $set: set, $inc: { tokenVersion: 1 }, $setOnInsert: { username } }, { upsert: true });
  console.log(`${existed ? 'Reset ' : 'Created'} ${username}  (${picked.roles.join(', ')})`);
}

(async () => {
  await mongoose.connect(cfg.mongoUri, { serverSelectionTimeoutMS: 5000 });
  const [u, p, r, n] = process.argv.slice(2);
  if (!u) assertDemoDatabase(cfg.mongoUri); // the built-in logins have published passwords: demo databases only. A named person with their own password is fine anywhere.
  if (u) await upsert(u, p, String(r || '').split(',').map((x) => x.trim()).filter(Boolean), n);
  else for (const d of DEFAULTS) await upsert(...d);
  await mongoose.disconnect();
})().catch((e) => { console.error(`\nSeed failed: ${e.message}`); process.exit(1); });
