import assert from "node:assert/strict";
import test from "node:test";
import worker from "../cloudflare/src/index.js";

test("email signup sends a five-minute OTP and verification creates an HttpOnly session", async () => {
  let pendingOtp = null;
  let pendingResetOtp = null;
  let savedAccount = null;
  const database = {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (this.sql.includes("SELECT COUNT(*) AS n FROM account_auth_attempts")) return { n: 0 };
          if (this.sql.includes("SELECT id FROM accounts WHERE contact") || this.sql.includes("SELECT id, contact, password_salt, password_hash FROM accounts")) return savedAccount;
          if (this.sql.includes("SELECT sent_at FROM signup_otps")) return null;
          if (this.sql.includes("SELECT * FROM signup_otps")) return pendingOtp;
          if (this.sql.includes("SELECT sent_at FROM password_reset_otps")) return null;
          if (this.sql.includes("SELECT otp_hash, expires_at, attempts FROM password_reset_otps")) return pendingResetOtp;
          if (this.sql.includes("SELECT id FROM accounts WHERE contact = ? COLLATE NOCASE")) return savedAccount;
          return null;
        },
        async run() {
          if (this.sql.includes("INSERT OR REPLACE INTO signup_otps")) {
            pendingOtp = {
              contact: this.args[0], otp_hash: this.args[1], password_salt: this.args[2],
              password_hash: this.args[3], expires_at: this.args[4], sent_at: this.args[5], attempts: 0,
            };
          } else if (this.sql.includes("INSERT OR REPLACE INTO password_reset_otps")) {
            pendingResetOtp = {
              contact: this.args[0], otp_hash: this.args[1], expires_at: this.args[2], sent_at: this.args[3], attempts: 0,
            };
          } else if (this.sql.includes("INSERT INTO accounts")) {
            savedAccount = { id: this.args[0], contact: this.args[1], password_salt: this.args[2], password_hash: this.args[3] };
          } else if (this.sql.includes("INSERT INTO account_sessions")) {
            this.sessionArgs = this.args;
          }
          return { success: true };
        },
      };
    },
    async batch(statements) {
      for (const statement of statements) {
        if (statement.sql.includes("UPDATE accounts SET password_salt")) {
          savedAccount.password_salt = statement.args[0];
          savedAccount.password_hash = statement.args[1];
        }
        if (statement.sql.includes("DELETE FROM signup_otps")) pendingOtp = null;
        if (statement.sql.includes("DELETE FROM password_reset_otps")) pendingResetOtp = null;
      }
      return [];
    },
  };

  const originalFetch = globalThis.fetch;
  let emailPayload;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    emailPayload = JSON.parse(options.body);
    assert.equal(options.headers.Authorization, "Bearer fake-resend-key");
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const env = {
      DB: database,
      OTP_HMAC_SECRET: "test-secret-".padEnd(40, "x"),
      RESEND_API_KEY: "fake-resend-key",
      EMAIL_FROM: "Amiir AI <qa@example.invalid>",
    };
    const signup = await worker.fetch(new Request("https://example.test/api/account/signup", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.20" },
      body: JSON.stringify({ contact: "qa@example.invalid", password: "StrongPass9!" }),
    }), env);
    const signupBody = await signup.json();
    assert.equal(signup.status, 200);
    assert.equal(signupBody.ok, true);
    assert.match(signupBody.message, /within 5 minutes/);
    assert.match(emailPayload.text, /expires in 5 minutes/);
    assert.ok(pendingOtp);

    const code = emailPayload.text.match(/\b\d{6}\b/)?.[0];
    assert.match(code || "", /^\d{6}$/);
    const guestCookie = signup.headers.get("set-cookie")?.split(";")[0];
    assert.match(guestCookie || "", /^offline_ai_guest=/);
    assert.doesNotMatch(JSON.stringify(signupBody), new RegExp(code));

    const verified = await worker.fetch(new Request("https://example.test/api/account/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "203.0.113.20",
        cookie: guestCookie,
      },
      body: JSON.stringify({ contact: "qa@example.invalid", code }),
    }), env);
    const verifiedBody = await verified.json();
    assert.equal(verified.status, 200);
    assert.deepEqual(verifiedBody, { ok: true, loggedIn: true, username: "qa@example.invalid" });
    assert.match(verified.headers.get("set-cookie") || "", /amiir_ai_session=.*HttpOnly.*Secure.*SameSite=Lax/);
    assert.equal(savedAccount?.contact, "qa@example.invalid");
    assert.equal(pendingOtp, null);

    const resetStart = await worker.fetch(new Request("https://example.test/api/account/reset-start", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.21" },
      body: JSON.stringify({ contact: "qa@example.invalid" }),
    }), env);
    const resetStarted = await resetStart.json();
    assert.equal(resetStart.status, 200);
    assert.equal(resetStarted.ok, true);
    assert.match(resetStarted.message, /expires in 5 minutes/);
    const resetCode = emailPayload.text.match(/\b\d{6}\b/)?.[0];
    assert.match(resetCode || "", /^\d{6}$/);

    const reset = await worker.fetch(new Request("https://example.test/api/account/reset-verify", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.21" },
      body: JSON.stringify({ contact: "qa@example.invalid", code: resetCode, password: "NewStrongPass8!" }),
    }), env);
    const resetBody = await reset.json();
    assert.equal(reset.status, 200);
    assert.equal(resetBody.loggedIn, true);
    assert.equal(pendingResetOtp, null);

    const login = await worker.fetch(new Request("https://example.test/api/account/login", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.22" },
      body: JSON.stringify({ contact: "qa@example.invalid", password: "NewStrongPass8!" }),
    }), env);
    const loginBody = await login.json();
    assert.equal(login.status, 200);
    assert.deepEqual(loginBody, { ok: true, loggedIn: true, username: "qa@example.invalid" });
    assert.match(login.headers.get("set-cookie") || "", /amiir_ai_session=.*HttpOnly.*Secure.*SameSite=Lax/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
