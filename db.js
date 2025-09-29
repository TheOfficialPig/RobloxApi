// db.js
import Database from "better-sqlite3";

const db = new Database("predictions.db");

db.exec(`
CREATE TABLE IF NOT EXISTS active_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  description TEXT,
  answer1 TEXT,
  answer2 TEXT,
  source TEXT,
  timeHours INTEGER,
  created INTEGER,
  expires INTEGER,
  meta TEXT
);

CREATE TABLE IF NOT EXISTS resolved_predictions (
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
  result TEXT
);
`);

export function saveActive(preds) {
  db.exec("DELETE FROM active_predictions");
  const stmt = db.prepare(`
    INSERT INTO active_predictions
    (name, description, answer1, answer2, source, timeHours, created, expires, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((list) => {
    for (const p of list) {
      stmt.run(
        p.Name,
        p.Description,
        p.Answer1,
        p.Answer2,
        p.source,
        p.TimeHours,
        p.created,
        p.expires,
        JSON.stringify(p.meta)
      );
    }
  });
  insertMany(preds);
}

export function loadActive() {
  return db.prepare("SELECT * FROM active_predictions").all().map((r) => ({
    ...r,
    Name: r.name,
    Description: r.description,
    Answer1: r.answer1,
    Answer2: r.answer2,
    source: r.source,
    TimeHours: r.timeHours,
    created: r.created,
    expires: r.expires,
    meta: JSON.parse(r.meta)
  }));
}

export function saveResolved(p) {
  db.prepare(`
    INSERT INTO resolved_predictions
    (name, description, answer1, answer2, source, timeHours, created, expires, meta, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.Name,
    p.Description,
    p.Answer1,
    p.Answer2,
    p.source,
    p.TimeHours,
    p.created,
    p.expires,
    JSON.stringify(p.meta),
    p.result
  );
}

export function loadResolved(limit = 20) {
  return db
    .prepare("SELECT * FROM resolved_predictions ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map((r) => ({
      ...r,
      Name: r.name,
      Description: r.description,
      Answer1: r.answer1,
      Answer2: r.answer2,
      source: r.source,
      TimeHours: r.timeHours,
      created: r.created,
      expires: r.expires,
      meta: JSON.parse(r.meta),
      result: r.result
    }));
}
