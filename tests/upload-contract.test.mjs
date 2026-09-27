import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../cloudflare/public/index.html", import.meta.url), "utf8");
const worker = await readFile(new URL("../cloudflare/src/index.js", import.meta.url), "utf8");

test("public upload picker only advertises file types handled by the Worker", () => {
  const accepted = html.match(/id="chat-image" type="file" accept="([^"]+)"/)?.[1];
  assert.ok(accepted, "chat upload input has an accept list");
  for (const extension of ["pdf", "txt", "md", "csv", "docx"]) assert.ok(accepted.includes(`.${extension}`));
  for (const extension of ["pptx", "mp3", "m4a", "wav", "ogg"]) assert.ok(!accepted.includes(`.${extension}`));

  const serverExtensions = worker.match(/const supportedExtensions = new Set\(\[([^\]]+)\]\)/)?.[1];
  assert.ok(serverExtensions, "Worker declares its supported document formats");
  const formats = [...serverExtensions.matchAll(/"([a-z0-9]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(formats, ["csv", "docx", "md", "pdf", "txt"]);
});
