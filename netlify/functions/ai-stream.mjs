/* ============================================================
   FunnelForge — Streaming KI-Proxy (Netlify Function 2.0)
   ------------------------------------------------------------
   Lange Generierungen (komplette HTML-Landeseiten) brauchen oft
   30–60s und sprengen den kurzen Timeout der gepufferten Funktion
   (→ 504). Diese Funktion STREAMT die Anthropic-Antwort direkt an
   den Browser: die Verbindung bleibt aktiv, die Generierung läuft
   zu Ende. Der Key bleibt serverseitig (ANTHROPIC_API_KEY).
   ============================================================ */

const MODEL_OK = (m) => typeof m === "string" && /^claude-[a-z0-9.\-]+$/i.test(m);
const DEFAULT_MODEL = "claude-sonnet-4-6";

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors(), "content-type": "application/json" }
  });
}
function originAllowed(origin) {
  const list = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (process.env.URL) list.push(process.env.URL);
  if (process.env.DEPLOY_PRIME_URL) list.push(process.env.DEPLOY_PRIME_URL);
  if (list.length === 0) return true;     // not configured → allow
  if (!origin) return true;               // same-origin requests may omit Origin
  return list.includes(origin);
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: cors() });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const origin = req.headers.get("origin") || "";
  if (!originAllowed(origin)) return json({ error: "origin not allowed" }, 403);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ error: "proxy not configured: ANTHROPIC_API_KEY missing" }, 500);

  let body;
  try { body = await req.json(); } catch (e) { return json({ error: "invalid JSON" }, 400); }
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    return json({ error: "messages[] required" }, 400);

  const payload = {
    model: MODEL_OK(body.model) ? body.model : DEFAULT_MODEL,
    max_tokens: Math.min(parseInt(body.max_tokens, 10) || 4096, 8192),
    messages: body.messages,
    stream: true
  };
  if (body.system) payload.system = String(body.system).slice(0, 24000);

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return json({ error: "upstream error", detail: String((e && e.message) || e) }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text().catch(() => "");
    return json({ error: "upstream " + upstream.status, detail: t.slice(0, 300) }, upstream.status || 502);
  }

  // Stream Anthropic's Server-Sent-Events straight through to the browser.
  return new Response(upstream.body, {
    status: 200,
    headers: { ...cors(), "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" }
  });
};
