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
