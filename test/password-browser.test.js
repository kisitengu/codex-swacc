const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  checkAccounts,
  launchRotationBrowser,
  loginAccount,
  parseCredentialList,
  rotateOneAccount,
  rotatePasswords,
} = require("../lib/password-rotation");

function chromeExecutable() {
  const candidates = [
    process.env.CODEX_ACCOUNT_BROWSER_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

const executablePath = chromeExecutable();
if (!executablePath) {
  console.log("Browser flow test skipped: Chrome/Edge/Chromium was not found.");
  process.exit(0);
}

let changedPassword = null;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (
    request.method === "POST"
    && (
      url.pathname === "/verify"
      || url.pathname === "/change"
      || url.pathname === "/verify-final"
    )
  ) {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      changedPassword = {
        ...changedPassword,
        ...JSON.parse(body),
      };
      response.writeHead(204);
      response.end();
    });
    return;
  }

  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (url.pathname === "/") {
    response.end(`<!doctype html>
      <html lang="en">
        <body><a href="/login">Log in</a></body>
      </html>`);
    return;
  }
  if (url.pathname === "/auth-error") {
    response.end(`<!doctype html>
      <html lang="en">
        <body>
          <h1>Oops, an error occurred!</h1>
          <p>RouteError (400 Invalid content type: text/html; charset=UTF-8)</p>
        </body>
      </html>`);
    return;
  }
  if (url.pathname === "/invalid-credentials") {
    response.end(`<!doctype html>
      <html lang="en">
        <body>
          <h1>Enter your password</h1>
          <p>Incorrect email address or password</p>
        </body>
      </html>`);
    return;
  }
  if (url.pathname === "/login") {
    response.end(`<!doctype html>
      <html lang="en">
        <body>
          <main id="app">
            <form id="pre-hydration-form">
              <label>Email address <input type="email" aria-label="Email address"></label>
              <button type="submit">Continue</button>
            </form>
          </main>
          <script>
            const app = document.querySelector("#app");
            let step = "email";
            setTimeout(() => {
              app.innerHTML = '<form id="login-form"><label>Email address <input type="email" aria-label="Email address"></label><button type="submit">Continue</button></form>';
              app.addEventListener("submit", (event) => {
                event.preventDefault();
                if (step === "email") {
                  step = "password";
                  app.innerHTML = '<form><label>Password <input type="password" aria-label="Password" autocomplete="current-password"></label><button type="submit">Continue</button></form>';
                  return;
                }
                if (step === "password") {
                  step = "mfa";
                  app.innerHTML = '<form><label>Code <input aria-label="Code" inputmode="numeric" autocomplete="one-time-code"></label><button type="submit">Verify</button></form>';
                  return;
                }
                window.location.href = "/home";
              });
            }, 350);
          </script>
        </body>
      </html>`);
    return;
  }
  if (url.pathname === "/settings") {
    response.end(`<!doctype html>
      <html lang="en">
        <body>
          <nav>
            <button id="account-tab">Account</button>
            <button id="security-tab">Security and login</button>
          </nav>
          <main id="settings"><h1>Account</h1><p>Account details only.</p></main>
          <script>
            const settings = document.querySelector("#settings");
            document.querySelector("#security-tab").addEventListener("click", () => {
              settings.innerHTML = '<h1>Security and login</h1><button data-testid="password-setting">Password ******</button>';
              document.querySelector('[data-testid="password-setting"]').addEventListener("click", () => {
                window.location.href = "/verify-password";
              });
            });
          </script>
        </body>
      </html>`);
    return;
  }
  if (url.pathname === "/verify-password") {
    response.end(`<!doctype html>
      <html lang="en">
        <body>
          <h1>First, verify it's you</h1>
          <form id="verify-form">
            <label>Password <input type="password" name="currentPassword"></label>
            <button type="submit">Continue</button>
          </form>
          <script>
            document.querySelector("#verify-form").addEventListener("submit", async (event) => {
              event.preventDefault();
              const form = new FormData(event.target);
              await fetch("/verify", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(Object.fromEntries(form.entries())),
              });
              window.location.href = "/verify-otp";
            });
          </script>
        </body>
      </html>`);
    return;
  }
  if (url.pathname === "/verify-otp") {
    response.end(`<!doctype html>
      <html lang="en">
        <body>
          <h1>Check your authenticator app</h1>
          <form id="otp-form">
            <label>One-time code <input name="otp" inputmode="numeric" autocomplete="one-time-code"></label>
            <button type="submit">Continue</button>
          </form>
          <script>
            document.querySelector("#otp-form").addEventListener("submit", async (event) => {
              event.preventDefault();
              const form = new FormData(event.target);
              await fetch("/verify", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(Object.fromEntries(form.entries())),
              });
              window.location.href = "/new-password";
            });
          </script>
        </body>
      </html>`);
    return;
  }
  if (url.pathname === "/new-password") {
    response.end(`<!doctype html>
      <html lang="en">
        <body>
          <form id="password-form">
            <label>New password <input type="password" name="newPassword" autocomplete="new-password"></label>
            <label>Confirm password <input type="password" name="confirmPassword" autocomplete="new-password"></label>
            <button type="submit">Update password</button>
          </form>
          <script>
            document.querySelector("#password-form").addEventListener("submit", async (event) => {
              event.preventDefault();
              const form = new FormData(event.target);
              await fetch("/change", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(Object.fromEntries(form.entries())),
              });
              window.location.href = "/final-otp";
            });
          </script>
        </body>
      </html>`);
    return;
  }
  if (url.pathname === "/final-otp") {
    response.end(`<!doctype html>
      <html lang="en">
        <body>
          <h1>Check your authenticator app</h1>
          <form id="final-otp-form">
            <label>One-time code <input name="finalOtp" inputmode="numeric" autocomplete="one-time-code"></label>
            <button type="submit">Continue</button>
          </form>
          <script>
            document.querySelector("#final-otp-form").addEventListener("submit", async (event) => {
              event.preventDefault();
              const form = new FormData(event.target);
              await fetch("/verify-final", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(Object.fromEntries(form.entries())),
              });
              document.body.innerHTML = '<h1>Security and login</h1><button data-testid="password-setting">Password ******</button>';
            });
          </script>
        </body>
      </html>`);
    return;
  }
  response.end("<!doctype html><html><body><h1>Home</h1></body></html>");
});

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({
    executablePath,
    headless: true,
  });

  try {
    const newPassword = "New-password-123456789!";
    let submitted = false;
    await rotateOneAccount(
      browser,
      {
        email: "  browser-test@example.com  ",
        password: "  Current-password-123!  ",
        mfaSecret: "JBSWY3DPEHPK3PXP",
      },
      newPassword,
      {
        loginUrl: `${origin}/`,
        settingsUrl: `${origin}/settings#Security`,
        timeoutMs: 10_000,
        manualTimeoutMs: 10_000,
        verifyLogin: false,
      },
      async () => {
        submitted = true;
      },
    );

    assert.equal(submitted, true);
    assert.equal(changedPassword.currentPassword, "Current-password-123!");
    assert.match(changedPassword.otp, /^\d{6}$/);
    assert.match(changedPassword.finalOtp, /^\d{6}$/);
    assert.equal(changedPassword.newPassword, newPassword);
    assert.equal(changedPassword.confirmPassword, newPassword);

    const unattendedContext = await browser.newContext({ locale: "en-US" });
    try {
      const unattendedPage = await unattendedContext.newPage();
      await assert.rejects(
        loginAccount(
          unattendedPage,
          {
            email: "unattended@example.com",
            password: "Current-password-123!",
            mfaSecret: "-",
          },
          {
            loginUrl: `${origin}/`,
            settingsUrl: `${origin}/settings#Security`,
            timeoutMs: 10_000,
            manualTimeoutMs: 10_000,
            unattended: true,
          },
        ),
        /no MFA secret was supplied/,
      );
    } finally {
      await unattendedContext.close();
    }

    const authErrorContext = await browser.newContext({ locale: "en-US" });
    try {
      const authErrorPage = await authErrorContext.newPage();
      await assert.rejects(
        loginAccount(
          authErrorPage,
          {
            email: "auth-error@example.com",
            password: "Current-password-123!",
            mfaSecret: "-",
          },
          {
            loginUrl: `${origin}/auth-error`,
            settingsUrl: `${origin}/settings#Security`,
            timeoutMs: 10_000,
            manualTimeoutMs: 10_000,
            unattended: true,
          },
        ),
        (error) => error.accountStatus === "auth_error"
          && /HTML error or browser challenge/.test(error.message),
      );
    } finally {
      await authErrorContext.close();
    }

    const privateBrowser = await launchRotationBrowser({
      browserExecutable: executablePath,
      browserChannel: null,
    });
    try {
      const firstPrivateContext = await privateBrowser.newContext({ locale: "en-US" });
      const firstPrivatePage = await firstPrivateContext.newPage();
      await firstPrivatePage.goto(`${origin}/home`);
      await firstPrivatePage.evaluate(() => localStorage.setItem("private-check", "present"));
      await firstPrivateContext.close();

      const secondPrivateContext = await privateBrowser.newContext({ locale: "en-US" });
      const secondPrivatePage = await secondPrivateContext.newPage();
      await secondPrivatePage.goto(`${origin}/home`);
      assert.equal(
        await secondPrivatePage.evaluate(() => localStorage.getItem("private-check")),
        null,
      );
      await secondPrivateContext.close();
    } finally {
      await privateBrowser.close();
    }

    const checkEvents = [];
    const checkResult = await checkAccounts([
      {
        email: "check-active@example.com",
        password: "Current-password-123!",
        mfaSecret: "JBSWY3DPEHPK3PXP",
      },
    ], {
      browserExecutable: executablePath,
      browserChannel: null,
      loginUrl: `${origin}/`,
            settingsUrl: `${origin}/settings#Security`,
      timeoutMs: 10_000,
      manualTimeoutMs: 10_000,
    }, {
      log() {},
      error() {},
      onAccountStatus: (event) => checkEvents.push(event),
    });
    assert.equal(checkResult.results[0].status, "active");
    assert.deepEqual(checkEvents.map((event) => event.status), ["checking", "active"]);

    const authErrorCheck = await checkAccounts([
      {
        email: "check-auth-error@example.com",
        password: "Current-password-123!",
        mfaSecret: "-",
      },
    ], {
      browserExecutable: executablePath,
      browserChannel: null,
      loginUrl: `${origin}/auth-error`,
      settingsUrl: `${origin}/settings#Security`,
      timeoutMs: 10_000,
      manualTimeoutMs: 10_000,
    }, {
      log() {},
      error() {},
    });
    assert.equal(authErrorCheck.results[0].status, "auth_error");

    const invalidCredentialsCheck = await checkAccounts([
      {
        email: "check-invalid@example.com",
        password: "Wrong-password-123!",
        mfaSecret: "-",
      },
    ], {
      browserExecutable: executablePath,
      browserChannel: null,
      loginUrl: `${origin}/invalid-credentials`,
      settingsUrl: `${origin}/settings#Security`,
      timeoutMs: 10_000,
      manualTimeoutMs: 10_000,
    }, {
      log() {},
      error() {},
    });
    assert.equal(invalidCredentialsCheck.results[0].status, "invalid_credentials");
    assert.match(invalidCredentialsCheck.results[0].message, /password was rejected/i);

    changedPassword = null;
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-flow-"));
    const inputPath = path.join(testRoot, "accounts.txt");
    const outputPath = path.join(testRoot, "accounts-new.txt");
    fs.writeFileSync(
      inputPath,
      "full-flow@example.com|Current-password-456!|JBSWY3DPEHPK3PXP\n",
      { mode: 0o600 },
    );
    const previousLoginUrl = process.env.CODEX_ACCOUNT_LOGIN_URL;
    const previousSettingsUrl = process.env.CODEX_ACCOUNT_SETTINGS_URL;
    process.env.CODEX_ACCOUNT_LOGIN_URL = `${origin}/`;
    process.env.CODEX_ACCOUNT_SETTINGS_URL = `${origin}/settings#Account`;
    try {
      const rotationMessages = [];
      const submittedPasswords = [];
      const result = await rotatePasswords([
        inputPath,
        "--output",
        outputPath,
        "--browser-executable",
        executablePath,
        "--skip-verify",
        "--yes",
      ], {
        log: (message) => rotationMessages.push(message),
        error: (message) => rotationMessages.push(message),
        onPasswordSubmitted: (event) => submittedPasswords.push(event),
      });
      assert.equal(result.success, 1);
      assert.equal(result.failed, 0);
      assert.match(rotationMessages.join("\n"), /Launching Chrome in incognito mode/);
      assert.match(rotationMessages.join("\n"), /\[Login 1\/4\]/);
      assert.match(rotationMessages.join("\n"), /\[Rotation 4\/7\]/);
      assert.match(rotationMessages.join("\n"), /\[Rotation 7\/7\]/);
      const outputAccount = parseCredentialList(
        fs.readFileSync(outputPath, "utf8"),
      )[0];
      assert.equal(outputAccount.password, changedPassword.newPassword);
      assert.notEqual(outputAccount.password, "Current-password-456!");
      assert.deepEqual(submittedPasswords, [{
        email: "full-flow@example.com",
        password: outputAccount.password,
      }]);
      assert.equal(
        JSON.parse(fs.readFileSync(`${outputPath}.state.json`, "utf8"))
          .accounts["full-flow@example.com"].status,
        "success",
      );
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
      }
    } finally {
      if (previousLoginUrl === undefined) {
        delete process.env.CODEX_ACCOUNT_LOGIN_URL;
      } else {
        process.env.CODEX_ACCOUNT_LOGIN_URL = previousLoginUrl;
      }
      if (previousSettingsUrl === undefined) {
        delete process.env.CODEX_ACCOUNT_SETTINGS_URL;
      } else {
        process.env.CODEX_ACCOUNT_SETTINGS_URL = previousSettingsUrl;
      }
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    console.log("Browser password flow test passed.");
  } finally {
    await browser.close();
    server.close();
  }
});
