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
          if (this.sql.includes("SELECT id, title FROM conversations")) return { id: conversationId, title: "Existing chat" };
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
  console.error = () => {};
  try {
    const response = await worker.fetch(request, { DB: db, AI: { async run() { throw new Error("private provider details"); } } });
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.code, "AI_PROVIDER_ERROR");
    assert.ok(body.requestId);
    assert.equal(response.headers.get("x-request-id"), body.requestId);
    assert.doesNotMatch(JSON.stringify(body), /private provider details/);
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
