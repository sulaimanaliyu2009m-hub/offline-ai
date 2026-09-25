const COOKIE = "offline_ai_guest";
const MAX_PROMPT_CHARS = 12000;
const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const SYSTEM_PROMPT = `You are Offline AI, a helpful conversational AI assistant. Be warm, clear, and direct. Use the recent conversation to understand follow-up messages, including short replies such as "yes", "no", or "why"; connect them to the previous turn instead of treating them as a new conversation. Ask a specific follow-up only when the context still leaves the user's meaning unclear. Do not claim to be a human or to have personal feelings, memories, or lived experiences. If asked who you are, say you are Offline AI, an AI assistant. Do not invent facts; say when you are unsure. Match the user's language and keep the answer concise unless they ask for detail.`;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function getCookie(request, name) {
  const pair = (request.headers.get("cookie") || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : "";
}

function ownerFor(request) {
  const existing = getCookie(request, COOKIE);
  if (existing && /^[a-f0-9-]{36}$/i.test(existing)) {
    return { id: existing, cookie: null };
  }
  const id = crypto.randomUUID();
  return {
    id,
    cookie: `${COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
  };
}

function withCookie(response, cookie) {
  if (!cookie) return response;
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}

function ownerJson(data, owner, status = 200) {
  return withCookie(json(data, status), owner.cookie);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function ensureConversation(db, ownerId, id) {
  return db.prepare(
    "SELECT id, title FROM conversations WHERE id = ? AND owner_id = ?",
  ).bind(id, ownerId).first();
}

async function routeApi(request, env, owner) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/account" && method === "GET") {
    return ownerJson({ loggedIn: false, username: "Guest" }, owner);
  }
  if (path === "/api/account/logout" && method === "POST") {
    return ownerJson({ ok: true }, owner);
  }

  if (!env.DB) {
    return ownerJson({ error: "The chat database is not connected yet. Add the D1 binding named DB in Cloudflare settings." }, owner, 503);
  }

  if (path === "/api/conversations" && method === "GET") {
    const result = await env.DB.prepare(
      "SELECT id, title, updated_at FROM conversations WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 100",
    ).bind(owner.id).all();
    return ownerJson({ conversations: result.results || [] }, owner);
  }

  if (path === "/api/conversations" && method === "POST") {
    const body = await readJson(request);
    const id = crypto.randomUUID();
    const now = Date.now();
    const title = typeof body?.title === "string" ? body.title.slice(0, 120) : "New chat";
    await env.DB.prepare(
      "INSERT INTO conversations (id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(id, owner.id, title, now, now).run();
    return ownerJson({ id, title }, owner, 201);
  }

  if (path === "/api/conversations/delete" && method === "POST") {
    const body = await readJson(request);
    if (typeof body?.conversation_id !== "string") {
      return ownerJson({ error: "Choose a conversation to delete." }, owner, 400);
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM messages WHERE conversation_id = ? AND owner_id = ?").bind(body.conversation_id, owner.id),
      env.DB.prepare("DELETE FROM conversations WHERE id = ? AND owner_id = ?").bind(body.conversation_id, owner.id),
    ]);
    return ownerJson({ ok: true }, owner);
  }

  if (path === "/api/history" && method === "GET") {
    const id = url.searchParams.get("conversation_id") || "";
    const conversation = await ensureConversation(env.DB, owner.id, id);
    if (!conversation) return ownerJson({ error: "Conversation not found." }, owner, 404);
    const result = await env.DB.prepare(
      "SELECT role, content, created_at FROM messages WHERE conversation_id = ? AND owner_id = ? ORDER BY created_at, rowid",
    ).bind(id, owner.id).all();
    return ownerJson({ conversation_id: id, messages: result.results || [] }, owner);
  }

  if (path === "/api/chat" && method === "POST") {
    if (!env.AI) return ownerJson({ error: "Workers AI is not connected. Add the AI binding in Cloudflare settings." }, owner, 503);
    const body = await readJson(request);
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) return ownerJson({ error: "Type a message first." }, owner, 400);
    if (message.length > MAX_PROMPT_CHARS) return ownerJson({ error: "That message is too long. Please keep it under 12,000 characters." }, owner, 413);
    if (body.image_data) return ownerJson({ error: "Image questions are not connected in this first Cloudflare chat release yet." }, owner, 501);

    let conversationId = typeof body.conversation_id === "string" ? body.conversation_id : "";
    let conversation = conversationId ? await ensureConversation(env.DB, owner.id, conversationId) : null;
    if (!conversation) {
      conversationId = crypto.randomUUID();
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO conversations (id, owner_id, title, created_at, updated_at) VALUES (?, ?, 'New chat', ?, ?)",
      ).bind(conversationId, owner.id, now, now).run();
    }

    const prior = await env.DB.prepare(
      "SELECT role, content FROM messages WHERE conversation_id = ? AND owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 12",
    ).bind(conversationId, owner.id).all();
    const history = (prior.results || []).reverse().map((item) => ({ role: item.role, content: item.content }));
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO messages (id, conversation_id, owner_id, role, content, created_at) VALUES (?, ?, ?, 'user', ?, ?)",
    ).bind(crypto.randomUUID(), conversationId, owner.id, message, now).run();

    let answer;
    try {
      const generated = await env.AI.run(MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...history,
          { role: "user", content: message },
        ],
        max_tokens: 700,
      });
      answer = typeof generated === "string"
        ? generated
        : generated?.response || generated?.result?.response || "I couldn't produce an answer. Please try again.";
    } catch (error) {
      console.error("Workers AI request failed", error);
      return ownerJson({ error: "The AI request failed. Check the Workers AI binding and try again." }, owner, 502);
    }

    const savedAt = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO messages (id, conversation_id, owner_id, role, content, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)",
      ).bind(crypto.randomUUID(), conversationId, owner.id, answer, savedAt),
      env.DB.prepare("UPDATE conversations SET updated_at = ?, title = CASE WHEN title = 'New chat' THEN ? ELSE title END WHERE id = ? AND owner_id = ?")
        .bind(savedAt, message.slice(0, 60), conversationId, owner.id),
    ]);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ token: answer })}\n`));
        controller.close();
      },
    });
    const headers = new Headers({ "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
    if (owner.cookie) headers.append("Set-Cookie", owner.cookie);
    return new Response(stream, { headers });
  }

  if (path.startsWith("/api/account/") && method === "POST") {
    return ownerJson({ error: "Accounts and email verification are not connected in this Cloudflare release. Guest chat is available." }, owner, 501);
  }

  return ownerJson({ error: "API route not found." }, owner, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const owner = ownerFor(request);
    try {
      return await routeApi(request, env, owner);
    } catch (error) {
      return ownerJson({ error: "The request could not be completed. Check that the D1 tables have been created." }, owner, 500);
    }
  },
};
