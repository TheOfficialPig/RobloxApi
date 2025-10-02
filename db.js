// db.js
import Database from "better-sqlite3";
const db = new Database("predictions.db");

// run migrations (idempotent)
db.exec(`
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  description TEXT,
  answer1 TEXT,
  answer2 TEXT,
  source TEXT,
  timeHours INTEGER,
  created INTEGER,
  expires INTEGER,
  meta TEXT,
  q1 REAL DEFAULT 0,
  q2 REAL DEFAULT 0,
  b REAL DEFAULT 50,
  status TEXT DEFAULT 'open',
  result TEXT
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT,
  username TEXT,
  marketId INTEGER,
  side TEXT,
  shares REAL,
  UNIQUE(userId, marketId, side)
);

CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT,
  username TEXT,
  predictionId INTEGER,
  choice TEXT,
  amount REAL,
  shares REAL,
  type TEXT,
  timestamp INTEGER,
  paidOut INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bets_prediction ON bets(predictionId);
CREATE INDEX IF NOT EXISTS idx_positions_market ON positions(marketId);
`);

// ----------------------
// DB helpers
// ----------------------
function saveMarketRow(m) {
  const sql = `
    INSERT OR REPLACE INTO markets
    (id, name, description, answer1, answer2, source, timeHours, created, expires, meta, q1, q2, b, status, result)
    VALUES (@id, @name, @description, @answer1, @answer2, @source, @timeHours, @created, @expires, @meta, @q1, @q2, @b, @status, @result)
  `;
  db.prepare(sql).run({
    id: m.id || null,
    name: m.Name || m.name,
    description: m.Description || m.description,
    answer1: m.Answer1,
    answer2: m.Answer2,
    source: m.source,
    timeHours: m.TimeHours || m.timeHours || 24,
    created: m.created || Date.now(),
    expires: m.expires || (Date.now() + ( (m.TimeHours || 24) * 60 * 60 * 1000 )),
    meta: JSON.stringify(m.meta || {}),
    q1: m.q1 || 0,
    q2: m.q2 || 0,
    b: m.b || 50,
    status: m.status || 'open',
    result: m.result || null
  });
}

function loadActiveMarkets() {
  return db.prepare("SELECT * FROM markets WHERE status = 'open' ORDER BY id ASC").all().map(r => ({
    id: r.id,
    Name: r.name,
    Description: r.description,
    Answer1: r.answer1,
    Answer2: r.answer2,
    source: r.source,
    TimeHours: r.timeHours,
    created: r.created,
    expires: r.expires,
    meta: JSON.parse(r.meta || "{}"),
    q1: r.q1,
    q2: r.q2,
    b: r.b,
    status: r.status,
    result: r.result
  }));
}

function loadResolvedMarkets(limit = 50) {
  return db.prepare("SELECT * FROM markets WHERE status = 'resolved' ORDER BY id DESC LIMIT ?").all(limit).map(r => ({
    id: r.id,
    Name: r.name,
    Description: r.description,
    Answer1: r.answer1,
    Answer2: r.answer2,
    source: r.source,
    TimeHours: r.timeHours,
    created: r.created,
    expires: r.expires,
    meta: JSON.parse(r.meta || "{}"),
    q1: r.q1,
    q2: r.q2,
    b: r.b,
    status: r.status,
    result: r.result
  }));
}

function saveBet(bet) {
  const info = db.prepare(`
    INSERT INTO bets (userId, username, predictionId, choice, amount, shares, type, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(bet.userId, bet.username, bet.predictionId, bet.choice, bet.amount, bet.shares, bet.type, bet.timestamp || Date.now());
  return info.lastInsertRowid;
}

function getBetsByPrediction(predictionId) {
  return db.prepare("SELECT * FROM bets WHERE predictionId = ? ORDER BY id DESC").all(predictionId);
}

function getRecentBets(predictionId, limit = 10) {
  return db.prepare("SELECT username, type, amount, shares, choice, timestamp FROM bets WHERE predictionId = ? ORDER BY id DESC LIMIT ?").all(predictionId, limit);
}

function upsertPosition({ userId, username, marketId, side, additionalShares }) {
  const existing = db.prepare("SELECT * FROM positions WHERE userId = ? AND marketId = ? AND side = ?").get(userId, marketId, side);
  if (existing) {
    db.prepare("UPDATE positions SET shares = shares + ?, username = ? WHERE id = ?").run(additionalShares, username, existing.id);
    return existing.id;
  } else {
    const info = db.prepare("INSERT INTO positions (userId, username, marketId, side, shares) VALUES (?, ?, ?, ?, ?)").run(userId, username, marketId, side, additionalShares);
    return info.lastInsertRowid;
  }
}

function getPosition(userId, marketId, side) {
  return db.prepare("SELECT * FROM positions WHERE userId = ? AND marketId = ? AND side = ?").get(userId, marketId, side);
}

function reducePosition(userId, marketId, side, reduceShares) {
  const pos = getPosition(userId, marketId, side);
  if (!pos) return false;
  const newShares = Math.max(0, pos.shares - reduceShares);
  if (newShares === 0) db.prepare("DELETE FROM positions WHERE id = ?").run(pos.id);
  else db.prepare("UPDATE positions SET shares = ? WHERE id = ?").run(newShares, pos.id);
  return true;
}

function getPositionsByMarket(marketId) {
  return db.prepare("SELECT * FROM positions WHERE marketId = ?").all(marketId);
}

function markBetsPaid(betIds) {
  const stmt = db.prepare("UPDATE bets SET paidOut = 1 WHERE id = ?");
  const tx = db.transaction((ids) => {
    for (const id of ids) stmt.run(id);
  });
  tx(betIds);
}
