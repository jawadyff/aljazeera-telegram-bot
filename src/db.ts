import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DB_PATH = path.resolve(__dirname, "../data/messages.db");

let db: Database.Database;

export function initDb(): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      channel    TEXT    NOT NULL,
      text       TEXT    NOT NULL,
      date       INTEGER NOT NULL,
      date_cst   TEXT    NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_channel_message
      ON messages (channel, message_id);
  `);
  console.log("[DB] Initialized:", DB_PATH);
}

export interface DbMessage {
  id: number;
  message_id: number;
  channel: string;
  text: string;
  date: number;
  created_at: number;
}

function toCST(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
}

export function insertMessage(
  messageId: number,
  channel: string,
  text: string,
  date: number
): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages (message_id, channel, text, date, date_cst)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(messageId, channel, text, date, toCST(date));
}

export function getRecentMessages(channel: string, limit = 50): DbMessage[] {
  const stmt = db.prepare(`
    SELECT * FROM (
      SELECT * FROM messages
      WHERE channel = ?
      ORDER BY date DESC
      LIMIT ?
    ) ORDER BY date ASC
  `);
  return stmt.all(channel, limit) as DbMessage[];
}

export function getMessagesByTimeRange(
  channel: string,
  fromUnix: number,
  toUnix: number,
  limit = 500
): DbMessage[] {
  const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE channel = ? AND date >= ? AND date <= ?
    ORDER BY date ASC
    LIMIT ?
  `);
  return stmt.all(channel, fromUnix, toUnix, limit) as DbMessage[];
}
