const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const {
  acquireAuthProfile,
  archiveAuthProfilesForEmail,
  completeCodexConsent,
  defaultProfileName,
  extractAuthEmail,
  listAuthProfiles,
  preferredProfileForEmail,
  saveAuthProfile,
} = require("../lib/codex-auth");

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

function authFor(email) {
  return {
    tokens: {
      id_token: jwt({ email }),
      access_token: jwt({ email, scope: "openid profile" }),
      refresh_token: `refresh-${email}`,
    },
    last_refresh: new Date().toISOString(),
  };
}

function mockCodexSpawn(auth) {
  return (_args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      child.signalCode = "SIGTERM";
      child.emit("close", null, "SIGTERM");
    };
    let input = "";
    const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.stdin.on("data", (chunk) => {
      input += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = input.indexOf("\n")) !== -1) {
        const line = input.slice(0, newlineIndex).trim();
        input = input.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        const message = JSON.parse(line);
        if (message.id === 1) {
          send({ id: 1, result: {} });
        }
        if (message.id === 2) {
          send({
            id: 2,
            result: {
              type: "chatgpt",
              loginId: "test-login",
              authUrl: "https://auth.example.test/oauth",
            },
          });
          setImmediate(() => {
            fs.writeFileSync(
              path.join(options.env.CODEX_HOME, "auth.json"),
              `${JSON.stringify(auth)}\n`,
              { mode: 0o600 },
            );
            send({
              method: "account/login/completed",
              params: {
                loginId: "test-login",
                success: true,
                error: null,
              },
            });
          });
        }
      }
    });
    child.stdin.on("finish", () => {
      setImmediate(() => {
        child.exitCode = 0;
        child.emit("close", 0, null);
      });
    });
    return child;
  };
}

function mockCodexRefreshSpawn(auth) {
  return (_args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      child.signalCode = "SIGTERM";
      child.emit("close", null, "SIGTERM");
    };
    let input = "";
    const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.stdin.on("data", (chunk) => {
      input += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = input.indexOf("\n")) !== -1) {
        const line = input.slice(0, newlineIndex).trim();
        input = input.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        const message = JSON.parse(line);
        if (message.id === 1) {
          send({ id: 1, result: {} });
        }
        if (message.id === 2 && message.method === "account/read") {
          assert.deepEqual(message.params, { refreshToken: true });
          fs.writeFileSync(
            path.join(options.env.CODEX_HOME, "auth.json"),
            `${JSON.stringify(auth)}\n`,
            { mode: 0o600 },
          );
          send({
            id: 2,
            result: {
              account: {
                type: "chatgpt",
                email: extractAuthEmail(auth),
              },
            },
          });
        }
      }
    });
    child.stdin.on("finish", () => {
      setImmediate(() => {
        child.exitCode = 0;
        child.emit("close", 0, null);
      });
    });
    return child;
  };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-test-"));
  const directory = path.join(root, "profiles");
  const activeFile = path.join(root, "auth.json");
  fs.mkdirSync(directory, { recursive: true });
  try {
    const primary = authFor("person@example.com");
    const duplicate = authFor("person@example.com");
    fs.writeFileSync(path.join(directory, "account-one.json"), JSON.stringify(primary));
    fs.writeFileSync(path.join(directory, "temp1.json"), JSON.stringify(duplicate));
    fs.writeFileSync(path.join(directory, "broken.json"), "{not-json");
    fs.writeFileSync(activeFile, JSON.stringify(primary));

    assert.equal(extractAuthEmail(primary), "person@example.com");
    const profiles = listAuthProfiles({ directory, activeFile });
    assert.equal(profiles.length, 3);
    assert.equal(
      profiles.find((profile) => profile.name === "account-one").isCurrent,
      true,
    );
    assert.equal(
      profiles.find((profile) => profile.name === "broken").valid,
      false,
    );
    assert.equal(
      preferredProfileForEmail("person@example.com", profiles).name,
      "account-one",
    );
    assert.equal(
      defaultProfileName("Another.User+test@example.com", profiles),
      "another.user-test-at-example.com",
    );

    const refreshed = authFor("person@example.com");
    const saved = saveAuthProfile(`${JSON.stringify(refreshed)}\n`, {
      profileName: "account-one",
      expectedEmail: "person@example.com",
      directory,
    });
    assert.equal(saved.fileName, "account-one.json");
    assert.match(saved.backupFileName, /^account-one\.json\.backup-/);
    assert.throws(
      () => saveAuthProfile(JSON.stringify(authFor("other@example.com")), {
        profileName: "wrong-account",
        expectedEmail: "person@example.com",
        directory,
      }),
      /belongs to other@example\.com/,
    );
    saveAuthProfile(JSON.stringify(authFor("archive@example.com")), {
      profileName: "archive-me",
      expectedEmail: "archive@example.com",
      directory,
    });
    const archived = archiveAuthProfilesForEmail("archive@example.com", { directory });
    assert.equal(archived.length, 1);
    assert.equal(fs.existsSync(path.join(directory, "archive-me.json")), false);
    assert.equal(
      fs.existsSync(path.join(directory, ".archive", archived[0].archiveName)),
      true,
    );

    let consentClicks = 0;
    const consentPage = {
      url: () => "https://auth.openai.com/sign-in-with-chatgpt/codex/consent",
      getByRole(role, options) {
        assert.equal(role, "button");
        assert.deepEqual(options, { name: "Continue", exact: true });
        return {
          count: async () => 1,
          isVisible: async () => true,
          isEnabled: async () => true,
          click: async () => {
            consentClicks += 1;
          },
        };
      },
      waitForTimeout: async () => {},
    };
    assert.equal(await completeCodexConsent(consentPage), true);
    assert.equal(consentClicks, 1);

    let loginCalls = 0;
    let consentCalls = 0;
    let browserClosed = false;
    let contextClosed = false;
    const acquired = await acquireAuthProfile({
      email: "new-user@example.com",
      password: "Current-password-123!",
      mfaSecret: "JBSWY3DPEHPK3PXP",
    }, {
      directory,
      spawnCodexProcess: mockCodexSpawn(authFor("new-user@example.com")),
      browserFactory: async (options) => {
        assert.equal(Object.hasOwn(options, "headless"), false);
        return {
          async newContext() {
            return {
              async newPage() {
                return {};
              },
              async close() {
                contextClosed = true;
              },
            };
          },
          async close() {
            browserClosed = true;
          },
        };
      },
      login: async (_page, account, options) => {
        loginCalls += 1;
        assert.equal(account.email, "new-user@example.com");
        assert.equal(Object.hasOwn(options, "headless"), false);
        assert.equal(options.unattended, true);
      },
      consent: async () => {
        consentCalls += 1;
        return true;
      },
    });
    assert.equal(acquired.fileName, "new-user-at-example.com.json");
    assert.equal(loginCalls, 1);
    assert.equal(consentCalls, 1);
    assert.equal(contextClosed, true);
    assert.equal(browserClosed, true);
    assert.equal(
      listAuthProfiles({ directory, activeFile })
        .find((profile) => profile.name === "new-user-at-example.com").email,
      "new-user@example.com",
    );

    const refreshOnly = authFor("person@example.com");
    refreshOnly.refresh_marker = "refreshed-without-browser";
    let refreshBrowserCalls = 0;
    const refreshedExisting = await acquireAuthProfile({
      email: "person@example.com",
      password: "Current-password-123!",
      mfaSecret: "JBSWY3DPEHPK3PXP",
    }, {
      directory,
      spawnCodexProcess: mockCodexRefreshSpawn(refreshOnly),
      browserFactory: async () => {
        refreshBrowserCalls += 1;
        throw new Error("Browser login should not run when refresh succeeds.");
      },
    });
    assert.equal(refreshedExisting.fileName, "account-one.json");
    assert.equal(refreshBrowserCalls, 0);
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(directory, "account-one.json"), "utf8"),
      ).refresh_marker,
      "refreshed-without-browser",
    );

    console.log("Codex auth profile tests passed.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
