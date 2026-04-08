const Database = require('better-sqlite3');
const path     = require('path');

const db = new Database(path.join(__dirname, 'quid.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── SCHEMA ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    name                    TEXT NOT NULL,
    email                   TEXT NOT NULL UNIQUE,
    handle                  TEXT NOT NULL UNIQUE,
    stripe_customer_id      TEXT UNIQUE,
    stripe_subscription_id  TEXT UNIQUE,
    is_active               INTEGER NOT NULL DEFAULT 0,
    bonus_remaining         INTEGER NOT NULL DEFAULT 0,
    joined_at               TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    week_start  TEXT NOT NULL,
    entry_type  TEXT NOT NULL,
    label       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS draws (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start      TEXT NOT NULL UNIQUE,
    winner_entry_id INTEGER,
    winner_user_id  INTEGER,
    winner_handle   TEXT,
    pot_amount      REAL NOT NULL DEFAULT 0,
    total_entries   INTEGER NOT NULL DEFAULT 0,
    drawn_at        TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (winner_entry_id) REFERENCES entries(id),
    FOREIGN KEY (winner_user_id)  REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL,
    stripe_invoice_id   TEXT UNIQUE,
    stripe_payment_id   TEXT,
    amount_pence        INTEGER NOT NULL,
    status              TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ── MIGRATIONS (add columns to existing DB safely) ───────────────────────────
try { db.exec(`ALTER TABLE users ADD COLUMN referral_code TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN referred_by INTEGER`); } catch(e) {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_code ON users(referral_code)`); } catch(e) {}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function generateReferralCode() {
  return Math.random().toString(36).substr(2, 7).toUpperCase();
}

function currentWeekStart() {
  const now = new Date();
  const day  = now.getUTCDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const mon  = new Date(now);
  mon.setUTCDate(now.getUTCDate() + diff);
  return mon.toISOString().slice(0, 10);
}

function nextWeekStart() {
  const now  = new Date();
  const day  = now.getUTCDay();
  const diff = (day === 0 ? 1 : 8 - day);
  const mon  = new Date(now);
  mon.setUTCDate(now.getUTCDate() + diff);
  return mon.toISOString().slice(0, 10);
}

// ── PREPARED STATEMENTS ───────────────────────────────────────────────────────

const q = {
  createUser:       db.prepare(`INSERT INTO users (name, email, handle, stripe_customer_id, bonus_remaining, referral_code, referred_by) VALUES (@name, @email, @handle, @stripe_customer_id, @bonus_remaining, @referral_code, @referred_by)`),
  getUserByReferralCode: db.prepare(`SELECT * FROM users WHERE referral_code=?`),
  addBonusEntries:  db.prepare(`UPDATE users SET bonus_remaining=bonus_remaining+@n WHERE id=@id`),
  activateUser:     db.prepare(`UPDATE users SET is_active=1, stripe_subscription_id=@sub_id WHERE stripe_customer_id=@cust_id`),
  deactivateUser:   db.prepare(`UPDATE users SET is_active=0 WHERE stripe_customer_id=@cust_id`),
  getUserByCustomer:db.prepare(`SELECT * FROM users WHERE stripe_customer_id=?`),
  getUserByEmail:   db.prepare(`SELECT * FROM users WHERE email=?`),
  getUserById:      db.prepare(`SELECT * FROM users WHERE id=?`),
  getAllActiveUsers: db.prepare(`SELECT * FROM users WHERE is_active=1`),

  addEntry:         db.prepare(`INSERT INTO entries (user_id, week_start, entry_type, label) VALUES (@user_id, @week_start, @entry_type, @label)`),
  getEntriesForWeek:db.prepare(`SELECT * FROM entries WHERE week_start=?`),
  countUserEntriesThisWeek: db.prepare(`SELECT COUNT(*) as n FROM entries WHERE user_id=? AND week_start=?`),
  decrementBonus:   db.prepare(`UPDATE users SET bonus_remaining=bonus_remaining-1 WHERE id=?`),

  getRecentDraws:   db.prepare(`SELECT * FROM draws ORDER BY week_start DESC LIMIT 10`),
  getDrawForWeek:   db.prepare(`SELECT * FROM draws WHERE week_start=?`),
  recordDraw:       db.prepare(`INSERT OR REPLACE INTO draws (week_start, winner_entry_id, winner_user_id, winner_handle, pot_amount, total_entries) VALUES (@week_start, @winner_entry_id, @winner_user_id, @winner_handle, @pot_amount, @total_entries)`),

  recordPayment:    db.prepare(`INSERT OR IGNORE INTO payments (user_id, stripe_invoice_id, stripe_payment_id, amount_pence, status) VALUES (@user_id, @stripe_invoice_id, @stripe_payment_id, @amount_pence, @status)`),

  memberCount:      db.prepare(`SELECT COUNT(*) as n FROM users WHERE is_active=1`),
  totalEntriesToday:db.prepare(`SELECT COUNT(*) as n FROM entries WHERE week_start=?`),
};

function addWeeklyEntries(userId, weekStart) {
  const user = q.getUserById.get(userId);
  if (!user) return;
  q.addEntry.run({ user_id: userId, week_start: weekStart, entry_type: 'subscription', label: null });
  for (let i = 0; i < user.bonus_remaining; i++) {
    q.addEntry.run({ user_id: userId, week_start: weekStart, entry_type: 'bonus', label: null });
    q.decrementBonus.run(userId);
  }
}

module.exports = { db, q, currentWeekStart, nextWeekStart, addWeeklyEntries, generateReferralCode };
