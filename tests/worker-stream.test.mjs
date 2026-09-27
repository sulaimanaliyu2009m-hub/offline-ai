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
