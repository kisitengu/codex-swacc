"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const Database = require("better-sqlite3");
const {
  formatCredentialList,
  parseCredentialList,
  writePrivateAtomic,
} = require("./password-rotation");

const DEFAULT_DATABASE_PATH = path.join(os.homedir(), ".codex", "accounts.sqlite3");

function defaultDatabasePath() {
  return path.resolve(
    process.env.CODEX_ACCOUNT_DB || DEFAULT_DATABASE_PATH,
  );
}

function ensurePrivatePath(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(filePath), 0o700);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
}

function createSqliteAccountStore(dbPath = defaultDatabasePath()) {
  const resolvedPath = path.resolve(dbPath);
  ensurePrivatePath(resolvedPath);
  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password TEXT NOT NULL,
      mfa_secret TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  try {
    fs.chmodSync(resolvedPath, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }

  const selectAll = db.prepare(`
    SELECT email, password, mfa_secret AS mfaSecret
    FROM accounts
    ORDER BY id ASC
  `);
  const insert = db.prepare(`
    INSERT INTO accounts (email, password, mfa_secret, created_at, updated_at)
    VALUES (@email, @password, @mfaSecret, @now, @now)
  `);
  const update = db.prepare(`
    UPDATE accounts
    SET password = @password, mfa_secret = @mfaSecret, updated_at = @now
    WHERE email = @email
  `);
  const remove = db.prepare("DELETE FROM accounts WHERE email = ?");
  const replaceAll = db.transaction((records) => {
    db.prepare("DELETE FROM accounts").run();
    const now = new Date().toISOString();
    for (const record of records) {
      insert.run({ ...record, now });
    }
  });

  return {
    kind: "sqlite",
    filePath: resolvedPath,
    read() {
      return selectAll.all().map((record) => ({
        email: record.email,
        password: record.password,
        mfaSecret: record.mfaSecret,
      }));
    },
    add(record) {
      insert.run({ ...record, now: new Date().toISOString() });
    },
    update(email, record) {
      const result = update.run({
        email,
        password: record.password,
        mfaSecret: record.mfaSecret,
        now: new Date().toISOString(),
      });
      if (result.changes !== 1) {
        throw new Error(`Account not found: ${email}`);
      }
    },
    remove(email) {
      remove.run(email);
    },
    replace(records) {
      replaceAll(records);
    },
    close() {
      db.close();
    },
  };
}

function createFileAccountStore(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Account list not found: ${resolvedPath}`);
  }

  return {
    kind: "file",
    filePath: resolvedPath,
    read() {
      const raw = fs.readFileSync(resolvedPath, "utf8");
      return raw.trim() ? parseCredentialList(raw) : [];
    },
    add(record) {
      const records = this.read();
      records.push(record);
      writePrivateAtomic(resolvedPath, formatCredentialList(records));
    },
    update(email, record) {
      const records = this.read();
      const index = records.findIndex(
        (candidate) => candidate.email.toLowerCase() === email.toLowerCase(),
      );
      if (index < 0) {
        throw new Error(`Account not found: ${email}`);
      }
      records[index] = record;
      writePrivateAtomic(resolvedPath, formatCredentialList(records));
    },
    remove(email) {
      const records = this.read();
      const filtered = records.filter(
        (candidate) => candidate.email.toLowerCase() !== email.toLowerCase(),
      );
      writePrivateAtomic(resolvedPath, formatCredentialList(filtered));
    },
    replace(records) {
      writePrivateAtomic(resolvedPath, formatCredentialList(records));
    },
    close() {},
  };
}

module.exports = {
  createFileAccountStore,
  createSqliteAccountStore,
  defaultDatabasePath,
};
