"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");

const DEFAULT_QUOTA_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_QUOTA_OUTPUT_BYTES = 5 * 1024 * 1024;

function optionalNumber(value, {
  minimum = Number.NEGATIVE_INFINITY,
  maximum = Number.POSITIVE_INFINITY,
  integer = false,
} = {}) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const normalized = integer ? Math.trunc(value) : value;
  return Math.max(minimum, Math.min(maximum, normalized));
}

function normalizeQuotaRows(rows) {
  if (!Array.isArray(rows)) {
    throw new Error("Codex quota command returned a non-array response.");
  }
  return rows.map((row) => {
    const profile = String(row?.profile || "").trim();
    if (!profile) {
      throw new Error("Codex quota response contains a row without a profile name.");
    }
    const nextExpiry = typeof row.resetCreditsNextExpiry === "string"
      && !Number.isNaN(Date.parse(row.resetCreditsNextExpiry))
      ? new Date(row.resetCreditsNextExpiry).toISOString()
      : null;
    const otherWindows = Array.isArray(row.otherWindows)
      ? row.otherWindows
        .map((window) => ({
          durationMins: optionalNumber(window?.durationMins, {
            minimum: 1,
            integer: true,
          }),
          remainingPercent: optionalNumber(window?.remainingPercent, {
            minimum: 0,
            maximum: 100,
          }),
        }))
        .filter((window) => window.durationMins !== null)
      : [];
    return {
      profile,
      weekRemainingPercent: optionalNumber(row.weekRemainingPercent, {
        minimum: 0,
        maximum: 100,
      }),
      resetCreditsAvailable: optionalNumber(row.resetCreditsAvailable, {
        minimum: 0,
        integer: true,
      }),
      resetCreditsNextExpiry: nextExpiry,
      otherWindows,
      error: row.error ? String(row.error) : null,
    };
  });
}

function readQuotaSummaries({
  timeoutMs = DEFAULT_QUOTA_TIMEOUT_MS,
  execFileImpl = execFile,
} = {}) {
  const cliPath = path.join(__dirname, "..", "bin", "codex-account.js");
  return new Promise((resolve, reject) => {
    execFileImpl(
      process.execPath,
      [cliPath, "quota", "--json"],
      {
        cwd: path.join(__dirname, ".."),
        encoding: "utf8",
        env: process.env,
        maxBuffer: MAX_QUOTA_OUTPUT_BYTES,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || "").trim();
          reject(new Error(
            `Could not read Codex quotas: ${detail || error.message}`,
          ));
          return;
        }
        try {
          resolve(normalizeQuotaRows(JSON.parse(String(stdout || "").trim())));
        } catch (parseError) {
          reject(new Error(`Could not parse Codex quota output: ${parseError.message}`));
        }
      },
    );
  });
}

module.exports = {
  normalizeQuotaRows,
  readQuotaSummaries,
};
