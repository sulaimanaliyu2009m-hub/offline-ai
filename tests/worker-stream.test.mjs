import assert from "node:assert/strict";
import test from "node:test";
import worker from "../cloudflare/src/index.js";

test("chat forwards Workers AI SSE and persists the completed answer", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { return { success: true }; },
      };
    },
    async batch(batchStatements) { statements.push(...batchStatements); return []; },
  };
  const chunks = [
    'data: {"response":"Hello "}\n',
    '\ndata: {"response":"from Amiir."}\n\ndata: [DONE]\n\n',
  ].map(value => new TextEncoder().encode(value));
  const AI = {
    async run(model, options) {
      assert.equal(model, "@cf/meta/llama-3.1-8b-instruct-fast");
      assert.equal(options.stream, true);
      return new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
    },
  };
  const request = new Request("https://example.test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Say hello" }),
  });

  const response = await worker.fetch(request, { DB: db, AI });
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const streamed = await response.text();
  assert.ok(streamed.includes('data: {"response":"Hello "}'));
  assert.ok(streamed.includes('data: {"response":"from Amiir."}'));
  assert.ok(statements.some(statement =>
    statement.sql.includes("'assistant'") && statement.args.includes("Hello from Amiir.")));
});

test("editing the latest user turn is owner-scoped and replaces its saved pair after streaming", async () => {
  const ownerId = "11111111-2222-4333-8444-555555555555";
  const conversationId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const writes = [];
  let modelMessages;
  const db = {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (this.sql.includes("SELECT id, title, project_id FROM conversations")) return { id: conversationId, title: "Existing chat", project_id: null };
          return null;
        },
        async all() {
          if (this.sql.includes("SELECT id, role, content FROM messages")) {
            return { results: [
              { id: "old-answer", role: "assistant", content: "Previous answer" },
              { id: "last-user", role: "user", content: "Old question" },
            ] };
          }
          return { results: [] };
        },
        async run() { return { success: true }; },
      };
    },
    async batch(statements) { writes.push(...statements); return []; },
  };
  const AI = {
    async run(_model, options) {
      modelMessages = options.messages;
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"response":"Updated answer"}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      });
    },
  };
  const request = new Request("https://example.test/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `offline_ai_guest=${ownerId}`,
    },
    body: JSON.stringify({ conversation_id: conversationId, message: "Updated question", replace_last: true }),
  });
  const response = await worker.fetch(request, { DB: db, AI });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(modelMessages.at(-1).content, "Updated question");
  assert.ok(writes.some(write => write.sql.includes("UPDATE messages SET content") && write.args.includes("Updated question") && write.args.includes(ownerId)));
  assert.ok(writes.some(write => write.sql.includes("DELETE FROM messages") && write.args.includes("old-answer") && write.args.includes(ownerId)));
});

test("a missing D1 migration returns a safe diagnostic and request ID", async () => {
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() { throw new Error("no such column: archived_at"); },
      };
    },
  };
  const request = new Request("https://example.test/api/conversations");
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await worker.fetch(request, { DB: db });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.code, "DATABASE_SCHEMA_MIGRATION_REQUIRED");
    assert.match(body.error, /pending D1 migrations/);
    assert.ok(body.requestId);
    assert.equal(response.headers.get("x-request-id"), body.requestId);
    assert.doesNotMatch(JSON.stringify(body), /no such column|archived_at/);
  } finally {
    console.error = originalError;
  }
});

test("conversation search queries owner-scoped message text and escapes LIKE wildcards", async () => {
  let query;
  let bindings;
  const db = {
    prepare(sql) {
      query = sql;
      return {
        bind(...args) { bindings = args; return this; },
        async all() { return { results: [] }; },
      };
    },
  };
  const request = new Request("https://example.test/api/conversations?archived=false&q=100%25_complete");
  const response = await worker.fetch(request, { DB: db });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.conversations, []);
  assert.match(query, /title LIKE \? ESCAPE char\(92\)/);
  assert.match(query, /projects\.name LIKE \? ESCAPE char\(92\)/);
  assert.match(query, /m\.content LIKE \? ESCAPE char\(92\)/);
  assert.match(query, /m\.owner_id = conversations\.owner_id/);
  assert.match(query, /owner_id = \?/);
  assert.equal(bindings[1], "%100\\%\\_complete%");
  assert.equal(bindings[1], bindings[2]);
  assert.equal(bindings[1], bindings[3]);
});

test("the public health route reports only D1 reachability and Workers AI binding presence", async () => {
  const request = new Request("https://example.test/health");
  const healthy = await worker.fetch(request, {
    DB: { prepare(sql) { assert.equal(sql, "SELECT 1 AS ok"); return { async first() { return { ok: 1 }; } }; } },
    AI: {},
    ASSETS: { async fetch() { throw new Error("health must be handled by the Worker"); } },
  });
  const healthyBody = await healthy.json();
  assert.equal(healthy.status, 200);
  assert.deepEqual(healthyBody.services, { database: "ok", workersAI: "configured" });
  assert.equal(healthy.headers.get("cache-control"), "no-store");
  assert.equal(healthy.headers.get("x-request-id"), healthyBody.requestId);

  const unhealthy = await worker.fetch(request, {
    DB: { prepare() { return { async first() { throw new Error("database internals"); } }; } },
    ASSETS: { async fetch() { throw new Error("health must be handled by the Worker"); } },
  });
  const unhealthyBody = await unhealthy.json();
  assert.equal(unhealthy.status, 503);
  assert.deepEqual(unhealthyBody.services, { database: "unavailable", workersAI: "missing" });
  assert.doesNotMatch(JSON.stringify(unhealthyBody), /database internals/);
});

test("personalization is owner-scoped and only explicitly enabled memory reaches the model", async () => {
  const ownerId = "11111111-2222-4333-8444-555555555555";
  const writes = [];
  const db = {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (this.sql.includes("FROM user_preferences")) {
            assert.equal(this.args[0], ownerId);
            return { memory_enabled: 1, memory_content: "Prefers short explanations", custom_instructions: "Use plain language" };
          }
          return null;
        },
        async all() { return { results: [] }; },
        async run() { writes.push({ sql: this.sql, args: this.args }); return { success: true }; },
      };
    },
    async batch(statements) { writes.push(...statements); return []; },
  };
  let systemPrompt;
  const request = new Request("https://example.test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `offline_ai_guest=${ownerId}` },
    body: JSON.stringify({ message: "Explain photosynthesis" }),
  });
  const response = await worker.fetch(request, {
    DB: db,
    AI: { async run(_model, options) {
      systemPrompt = options.messages[0].content;
      return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"response":"Plants make food using light."}\n\ndata: [DONE]\n\n')); controller.close(); } });
    } },
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.match(systemPrompt, /Prefers short explanations/);
  assert.match(systemPrompt, /Use plain language/);
  assert.ok(writes.some(write => write.sql.includes("INSERT INTO messages")));
});

test("preference writes enforce length limits and persist only the requesting owner", async () => {
  const ownerId = "11111111-2222-4333-8444-555555555555";
  let saved;
  const db = {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() { saved = { sql, args: this.args }; return { success: true }; },
      };
    },
  };
  const request = new Request("https://example.test/api/preferences", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: `offline_ai_guest=${ownerId}` },
    body: JSON.stringify({ memoryEnabled: false, memory: "Keep it off", customInstructions: "Use short answers" }),
  });
  const response = await worker.fetch(request, { DB: db });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(saved.args[0], ownerId);
  assert.equal(saved.args[1], 0);
  assert.equal(saved.args[2], "Keep it off");
  assert.deepEqual(body.preferences, { memoryEnabled: false, memory: "Keep it off", customInstructions: "Use short answers" });

  const tooLong = await worker.fetch(new Request("https://example.test/api/preferences", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: `offline_ai_guest=${ownerId}` },
    body: JSON.stringify({ memoryEnabled: true, memory: "x".repeat(2001), customInstructions: "" }),
  }), { DB: db });
  assert.equal(tooLong.status, 413);
  assert.equal(saved.args[2], "Keep it off");
});

test("projects are owner-scoped and project instructions are stored with project chats", async () => {
  const ownerId = "11111111-2222-4333-8444-555555555555";
  const writes = [];
  const db = {
    prepare(sql) {
      return {
        sql, args: [],
        bind(...args) { this.args = args; return this; },
        async all() { return { results: [] }; },
        async first() { return null; },
        async run() { writes.push({ sql: this.sql, args: this.args }); return { success: true }; },
      };
    },
    async batch(statements) { writes.push(...statements); return []; },
  };
  const create = await worker.fetch(new Request("https://example.test/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `offline_ai_guest=${ownerId}` },
    body: JSON.stringify({ name: "School", instructions: "Explain terms simply." }),
  }), { DB: db });
  const created = await create.json();
  assert.equal(create.status, 201);
  assert.equal(writes[0].sql.includes("INSERT INTO projects"), true);
  assert.equal(writes[0].args[1], ownerId);
  assert.equal(writes[0].args[2], "School");
  assert.equal(writes[0].args[3], "Explain terms simply.");

  const assign = await worker.fetch(new Request("https://example.test/api/conversations/project", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `offline_ai_guest=${ownerId}` },
    body: JSON.stringify({ conversation_id: "chat-1", project_id: created.project.id }),
  }), { DB: {
    ...db,
    prepare(sql) {
      return {
        sql, args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (this.sql.includes("FROM conversations")) return { id: "chat-1" };
          if (this.sql.includes("FROM projects")) return { id: created.project.id };
          return null;
        },
        async run() { writes.push({ sql: this.sql, args: this.args }); return { success: true }; },
      };
    },
  } });
  assert.equal(assign.status, 200);
  assert.ok(writes.some(write => write.sql.includes("UPDATE conversations SET project_id") && write.args[0] === created.project.id && write.args[2] === "chat-1" && write.args[3] === ownerId));
});

test("temporary chat streams with browser context and writes no conversation or message data", async () => {
  const writes = [];
  let modelMessages;
  const db = {
    prepare(sql) {
      return {
        sql, args: [], bind(...args) { this.args = args; return this; },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { writes.push({ sql: this.sql, args: this.args }); return { success: true }; },
      };
    },
    async batch(statements) { writes.push(...statements); return []; },
  };
  const response = await worker.fetch(new Request("https://example.test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      temporary: true,
      history: [{ role: "user", content: "I am studying plants." }, { role: "assistant", content: "Got it." }],
      message: "Explain photosynthesis.",
    }),
  }), { DB: db, AI: { async run(_model, options) {
    modelMessages = options.messages;
    return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"response":"Plants use light."}\n\ndata: [DONE]\n\n')); controller.close(); } });
  } } });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(modelMessages.slice(1, 3), [
    { role: "user", content: "I am studying plants." },
    { role: "assistant", content: "Got it." },
  ]);
  assert.equal(modelMessages.at(-1).content, "Explain photosynthesis.");
  assert.equal(writes.length, 0);
});

test("share links expose only random bearer tokens, expire, and load read-only owner data", async () => {
  const ownerId = "11111111-2222-4333-8444-555555555555";
  let persisted;
  let revoked = false;
  const db = {
    prepare(sql) {
      return {
        sql, args: [], bind(...args) { this.args = args; return this; },
        async first() {
          if (this.sql.includes("FROM conversations")) return { id: "chat-private", title: "Study notes", project_id: null };
          if (this.sql.includes("COUNT(*) AS active_count")) return { active_count: 0 };
          if (this.sql.includes("FROM share_links")) return revoked ? null : { conversation_id: "chat-private", owner_id: ownerId };
          return null;
        },
        async all() { return { results: [{ role: "assistant", content: "Shared answer", created_at: 20 }] }; },
        async run() { persisted = { sql: this.sql, args: this.args }; if(this.sql.includes("UPDATE share_links"))revoked=true; return { success: true, meta:{changes:1} }; },
      };
    },
  };
  const create = await worker.fetch(new Request("https://example.test/api/shares", {
    method: "POST", headers: { "content-type": "application/json", cookie: `offline_ai_guest=${ownerId}` },
    body: JSON.stringify({ conversation_id: "chat-private" }),
  }), { DB: db });
  const created = await create.json();
  assert.equal(create.status, 201);
  assert.match(created.url, /^\/share\/[A-Za-z0-9_-]{40,50}$/);
  assert.equal(created.expiresAt - persisted.args[4], 7 * 24 * 60 * 60 * 1000);
  assert.equal(persisted.args[1].length, 64);
  assert.equal(persisted.args.includes(created.url.split("/").at(-1)), false);

  const token = created.url.split("/").at(-1);
  const shared = await worker.fetch(new Request(`https://example.test/api/shared?token=${token}`), { DB: db });
  const body = await shared.json();
  assert.equal(shared.status, 200);
  assert.equal(body.title, "Study notes");
  assert.deepEqual(body.messages, [{ role: "assistant", content: "Shared answer", created_at: 20 }]);

  const shareId = persisted.args[0];
  const revoke = await worker.fetch(new Request("https://example.test/api/shares/revoke", {
    method:"POST",headers:{"content-type":"application/json",cookie:`offline_ai_guest=${ownerId}`},
    body:JSON.stringify({share_id:shareId}),
  }),{DB:db});
  assert.equal(revoke.status,200);
  assert.equal(persisted.args[2],ownerId);
  const revokedLink = await worker.fetch(new Request(`https://example.test/api/shared?token=${token}`),{DB:db});
  assert.equal(revokedLink.status,404);
});

test("a Workers AI provider failure returns a traceable error instead of hiding the cause", async () => {
  const db = {
    prepare() {
      return {
        bind() { return this; },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { return { success: true }; },
      };
    },
    async batch() { return []; },
  };
  const request = new Request("https://example.test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "A diagnostic test" }),
  });
  const originalError = console.error;
  const diagnostics = [];
  console.error = (line) => diagnostics.push(JSON.parse(line));
  try {
    const providerError = Object.assign(new Error("private provider details"), { status: 429, code: 3036 });
    const response = await worker.fetch(request, { DB: db, AI: { async run() { throw providerError; } } });
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.code, "AI_PROVIDER_ERROR");
    assert.ok(body.requestId);
    assert.equal(response.headers.get("x-request-id"), body.requestId);
    assert.doesNotMatch(JSON.stringify(body), /private provider details/);
    assert.equal(diagnostics[0].provider, "cloudflare_workers_ai");
    assert.equal(diagnostics[0].operation, "chat");
    assert.equal(diagnostics[0].providerStatus, 429);
    assert.equal(diagnostics[0].providerCode, 3036);
    assert.doesNotMatch(JSON.stringify(diagnostics), /private provider details/);
  } finally {
    console.error = originalError;
  }
});

test("the document endpoint accepts the Worker's raw file body and summarizes its contents", async () => {
  const writes = [];
  const db = {
    prepare(sql) {
      return {
        sql,
        bind(...args) { this.args = args; return this; },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { return { success: true }; },
      };
    },
    async batch(statements) { writes.push(...statements); return []; },
  };
  let prompt;
  const request = new Request("https://example.test/api/summarize-file?question=Summarize", {
    method: "POST",
    headers: { "content-type": "text/plain", "x-attachment-name": "notes.txt" },
    body: "Amiir upload test: plants use sunlight to make food.",
  });
  const response = await worker.fetch(request, {
    DB: db,
    AI: { async run(_model, options) { prompt = options.messages.at(-1).content; return { response: "Plants use sunlight to make food." }; } },
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.answer, "Plants use sunlight to make food.");
  assert.match(prompt, /Amiir upload test/);
  assert.ok(writes.some(write => write.sql.includes("INSERT INTO messages") && write.args.includes("Plants use sunlight to make food.")));
});

test("the document endpoint returns a specific unsupported-type error", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/summarize-file", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-attachment-name": "audio.mp3" },
    body: "not sent to the model",
  }), { DB: {}, AI: {} });
  const body = await response.json();
  assert.equal(response.status, 415);
  assert.match(body.error, /not supported/);
});
