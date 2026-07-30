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
      status TEXT NOT NULL DEFAULT 'unchecked',
      status_message TEXT,
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const columns = new Set(
    db.prepare("PRAGMA table_info(accounts)").all().map((column) => column.name),
  );
  if (!columns.has("status")) {
    db.exec("ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'unchecked'");
  }
  if (!columns.has("status_message")) {
    db.exec("ALTER TABLE accounts ADD COLUMN status_message TEXT");
  }
  if (!columns.has("last_checked_at")) {
    db.exec("ALTER TABLE accounts ADD COLUMN last_checked_at TEXT");
  }
  const storedCredentials = db.prepare(`
    SELECT id, email, password, mfa_secret AS mfaSecret
    FROM accounts
    ORDER BY id ASC
  `).all();
  const normalizedEmails = new Set();
  const normalizedCredentials = storedCredentials.map((record) => {
    const normalized = {
      ...record,
      email: String(record.email).trim(),
      password: String(record.password).trim(),
      mfaSecret: String(record.mfaSecret).trim(),
    };
    if (!normalized.email || !normalized.password || !normalized.mfaSecret) {
      throw new Error("Stored account credentials cannot be empty after trimming whitespace.");
    }
    const emailKey = normalized.email.toLowerCase();
    if (normalizedEmails.has(emailKey)) {
      throw new Error(`Stored accounts become duplicates after trimming email whitespace: ${normalized.email}`);
    }
    normalizedEmails.add(emailKey);
    return normalized;
  });
  const normalizeCredentials = db.transaction((records) => {
    const updateCredential = db.prepare(`
      UPDATE accounts
      SET
        email = @email,
        password = @password,
        mfa_secret = @mfaSecret,
        status = 'unchecked',
        status_message = 'Credentials normalized; availability has not been checked.',
        last_checked_at = NULL,
        updated_at = @now
      WHERE id = @id
    `);
    const now = new Date().toISOString();
    for (const record of records) {
      const original = storedCredentials.find((candidate) => candidate.id === record.id);
      if (
        record.email !== original.email
        || record.password !== original.password
        || record.mfaSecret !== original.mfaSecret
      ) {
        updateCredential.run({ ...record, now });
      }
    }
  });
  normalizeCredentials(normalizedCredentials);
  try {
    fs.chmodSync(resolvedPath, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }

  const selectAll = db.prepare(`
    SELECT
      email,
      password,
      mfa_secret AS mfaSecret,
      status,
      status_message AS statusMessage,
      last_checked_at AS lastCheckedAt
    FROM accounts
    ORDER BY id ASC
  `);
  const insert = db.prepare(`
    INSERT INTO accounts (
      email,
      password,
      mfa_secret,
      status,
      status_message,
      last_checked_at,
      created_at,
      updated_at
    )
    VALUES (
      @email,
      @password,
      @mfaSecret,
      @status,
      @statusMessage,
      @lastCheckedAt,
      @now,
      @now
    )
  `);
  const update = db.prepare(`
    UPDATE accounts
    SET password = @password, mfa_secret = @mfaSecret, updated_at = @now
    WHERE email = @email
  `);
  const updateStatus = db.prepare(`
    UPDATE accounts
    SET
      status = @status,
      status_message = @statusMessage,
      last_checked_at = @lastCheckedAt,
      updated_at = @now
    WHERE email = @email
  `);
  const remove = db.prepare("DELETE FROM accounts WHERE email = ?");
  const replaceAll = db.transaction((records) => {
    db.prepare("DELETE FROM accounts").run();
    const now = new Date().toISOString();
    for (const record of records) {
      insert.run({
        ...record,
        status: record.status || "unchecked",
        statusMessage: record.statusMessage || null,
        lastCheckedAt: record.lastCheckedAt || null,
        now,
      });
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
        status: record.status,
        statusMessage: record.statusMessage,
        lastCheckedAt: record.lastCheckedAt,
      }));
    },
    add(record) {
      insert.run({
        ...record,
        status: record.status || "unchecked",
        statusMessage: record.statusMessage || null,
        lastCheckedAt: record.lastCheckedAt || null,
        now: new Date().toISOString(),
      });
    },
    update(email, record, { resetStatus = true } = {}) {
      const result = update.run({
        email,
        password: record.password,
        mfaSecret: record.mfaSecret,
        now: new Date().toISOString(),
      });
      if (result.changes !== 1) {
        throw new Error(`Account not found: ${email}`);
      }
      if (resetStatus) {
        updateStatus.run({
          email,
          status: "unchecked",
          statusMessage: "Credentials changed; availability has not been checked.",
          lastCheckedAt: null,
          now: new Date().toISOString(),
        });
      }
    },
    updateStatus(email, {
      status,
      statusMessage = null,
      lastCheckedAt = null,
    }) {
      const result = updateStatus.run({
        email,
        status,
        statusMessage,
        lastCheckedAt,
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

  const statuses = new Map();
  const withStatus = (record) => {
    const saved = statuses.get(record.email.toLowerCase()) || {};
    return {
      ...record,
      status: saved.status || record.status || "unchecked",
      statusMessage: saved.statusMessage ?? record.statusMessage ?? null,
      lastCheckedAt: saved.lastCheckedAt ?? record.lastCheckedAt ?? null,
    };
  };

  return {
    kind: "file",
    filePath: resolvedPath,
    read() {
      const raw = fs.readFileSync(resolvedPath, "utf8");
      return raw.trim() ? parseCredentialList(raw).map(withStatus) : [];
    },
    add(record) {
      const records = this.read();
      records.push(record);
      statuses.set(record.email.toLowerCase(), {
        status: record.status || "unchecked",
        statusMessage: record.statusMessage || null,
        lastCheckedAt: record.lastCheckedAt || null,
      });
      writePrivateAtomic(resolvedPath, formatCredentialList(records));
    },
    update(email, record, { resetStatus = true } = {}) {
      const records = this.read();
      const index = records.findIndex(
        (candidate) => candidate.email.toLowerCase() === email.toLowerCase(),
      );
      if (index < 0) {
        throw new Error(`Account not found: ${email}`);
      }
      records[index] = record;
      if (resetStatus) {
        statuses.set(email.toLowerCase(), {
          status: "unchecked",
          statusMessage: "Credentials changed; availability has not been checked.",
          lastCheckedAt: null,
        });
      }
      writePrivateAtomic(resolvedPath, formatCredentialList(records));
    },
    updateStatus(email, {
      status,
      statusMessage = null,
      lastCheckedAt = null,
    }) {
      const records = this.read();
      const exists = records.some(
        (candidate) => candidate.email.toLowerCase() === email.toLowerCase(),
      );
      if (!exists) {
        throw new Error(`Account not found: ${email}`);
      }
      statuses.set(email.toLowerCase(), { status, statusMessage, lastCheckedAt });
    },
    remove(email) {
      const records = this.read();
      const filtered = records.filter(
        (candidate) => candidate.email.toLowerCase() !== email.toLowerCase(),
      );
      statuses.delete(email.toLowerCase());
      writePrivateAtomic(resolvedPath, formatCredentialList(filtered));
    },
    replace(records) {
      const nextStatuses = new Map();
      for (const record of records) {
        nextStatuses.set(record.email.toLowerCase(), {
          status: record.status || "unchecked",
          statusMessage: record.statusMessage || null,
          lastCheckedAt: record.lastCheckedAt || null,
        });
      }
      statuses.clear();
      for (const [email, status] of nextStatuses) {
        statuses.set(email, status);
      }
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
