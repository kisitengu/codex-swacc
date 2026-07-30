const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
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
  if (request.method === "POST" && url.pathname === "/change") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      changedPassword = JSON.parse(body);
      response.writeHead(204);
      response.end();
    });
    return;
  }

  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (url.pathname === "/login") {
    response.end(`<!doctype html>
      <html lang="en">
        <body>
          <main id="app">
            <form id="login-form">
              <label>Email address <input type="email" aria-label="Email address"></label>
              <button type="submit">Continue</button>
            </form>
          </main>
          <script>
            const app = document.querySelector("#app");
            let step = "email";
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
          </script>
        </body>
      </html>`);
    return;
  }
  if (url.pathname === "/settings") {
    response.end(`<!doctype html>
      <html lang="en">
        <body>
          <main id="settings">
            <h1>Account</h1>
            <button id="open">Update password</button>
          </main>
          <script>
            const settings = document.querySelector("#settings");
            document.querySelector("#open").addEventListener("click", () => {
              settings.innerHTML = \`
                <form id="password-form">
                  <label>Current password <input type="password" name="currentPassword" autocomplete="current-password"></label>
                  <label>New password <input type="password" name="newPassword" autocomplete="new-password"></label>
                  <label>Confirm password <input type="password" name="confirmPassword" autocomplete="new-password"></label>
                  <button type="submit">Update password</button>
                </form>
              \`;
              document.querySelector("#password-form").addEventListener("submit", async (event) => {
                event.preventDefault();
                const form = new FormData(event.target);
                await fetch("/change", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(Object.fromEntries(form.entries())),
                });
                settings.innerHTML = "<p>Password was updated successfully.</p>";
              });
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
        email: "browser-test@example.com",
        password: "Current-password-123!",
        mfaSecret: "JBSWY3DPEHPK3PXP",
      },
      newPassword,
      {
        loginUrl: `${origin}/login`,
        settingsUrl: `${origin}/settings#Account`,
        timeoutMs: 10_000,
        manualTimeoutMs: 10_000,
        headless: true,
        verifyLogin: false,
      },
      async () => {
        submitted = true;
      },
    );

    assert.equal(submitted, true);
    assert.deepEqual(changedPassword, {
      currentPassword: "Current-password-123!",
      newPassword,
      confirmPassword: newPassword,
    });

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
            loginUrl: `${origin}/login`,
            settingsUrl: `${origin}/settings#Account`,
            timeoutMs: 10_000,
            manualTimeoutMs: 10_000,
            headless: false,
            unattended: true,
          },
        ),
        /no MFA secret was supplied/,
      );
    } finally {
      await unattendedContext.close();
    }

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
    process.env.CODEX_ACCOUNT_LOGIN_URL = `${origin}/login`;
    process.env.CODEX_ACCOUNT_SETTINGS_URL = `${origin}/settings#Account`;
    try {
      const result = await rotatePasswords([
        inputPath,
        "--output",
        outputPath,
        "--browser-executable",
        executablePath,
        "--headless",
        "--skip-verify",
        "--yes",
      ]);
      assert.equal(result.success, 1);
      assert.equal(result.failed, 0);
      const outputAccount = parseCredentialList(
        fs.readFileSync(outputPath, "utf8"),
      )[0];
      assert.equal(outputAccount.password, changedPassword.newPassword);
      assert.notEqual(outputAccount.password, "Current-password-456!");
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
