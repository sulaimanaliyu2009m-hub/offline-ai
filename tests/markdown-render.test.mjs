import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../cloudflare/public/index.html", import.meta.url), "utf8");
const start = html.indexOf("    function escapeHtml(");
const end = html.indexOf("    function setMessageText(", start);
assert.ok(start >= 0 && end > start, "Markdown renderer exists in the app page");
const renderer = {};
vm.runInNewContext(html.slice(start, end), renderer);

test("Markdown renderer supports ordered lists and scrollable tables", () => {
  const output = renderer.renderMarkdown("1. First\n2. Second\n\n| Name | Count |\n| --- | ---: |\n| Roses | 3 |");
  assert.match(output, /<ol><li>First<\/li><li>Second<\/li><\/ol>/);
  assert.match(output, /class="table-scroll"/);
  assert.match(output, /<th>Name<\/th><th>Count<\/th>/);
  assert.match(output, /<td>Roses<\/td><td>3<\/td>/);
});

test("Code blocks are labeled, copyable, highlighted, and HTML-escaped", () => {
  const output = renderer.renderMarkdown("```js\nconst answer = 42;\n<script>alert(1)</script>\n```");
  assert.match(output, /class="code-header"/);
  assert.match(output, /aria-label="Copy code"/);
  assert.match(output, /token-keyword/);
  assert.match(output, /token-number/);
  assert.match(output, /&lt;script&gt;/);
  assert.doesNotMatch(output, /<script>alert/);
});

const streamStart = html.indexOf("    async function readChatResponseStream(");
const streamEnd = html.indexOf("    async function regenerateAssistant(", streamStart);
assert.ok(streamStart >= 0 && streamEnd > streamStart, "Chat stream reader exists in the app page");
const streamReader = { TextDecoder };
vm.runInNewContext(html.slice(streamStart, streamEnd), streamReader, { timeout: 1000 });

test("Chat stream reader renders Workers AI and OpenAI-compatible delta payloads", async () => {
  for (const data of [
    { response: "Workers AI" },
    { result: { response: "wrapped Workers AI" } },
    { choices: [{ delta: { content: "OpenAI-compatible" } }] },
  ]) {
    const response = new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
    let rendered = "";
    await streamReader.readChatResponseStream(response, token => { rendered += token; });
    assert.equal(rendered, data.response || data.result?.response || data.choices[0].delta.content);
  }
});
