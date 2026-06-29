/* ============================================================
   FunnelForge — sicherer KI-Proxy (Netlify Function)
   ------------------------------------------------------------
   Der Anthropic-Key liegt AUSSCHLIESSLICH in der Netlify-
   Umgebungsvariable ANTHROPIC_API_KEY und erreicht NIE den
   Browser. Der Browser ruft /.netlify/functions/ai auf,
   diese Funktion hängt den Key serverseitig an.

   Schutz gegen Missbrauch:
   - nur POST
   - Origin-Check (eigene Seite via process.env.URL + optional
     ALLOWED_ORIGINS als Komma-Liste)
   - Modell-Allowlist + max_tokens-Deckel
   - Best-Effort-Ratelimit pro IP (pro warmer Instanz)
   ============================================================ */

const RATE = { windowMs: 5 * 60 * 1000, max: 40 };   // 40 Anfragen / 5 Min / IP
const hits = new Map();                               // ip -> [timestamps]

const MODELS = new Set([
  "claude-3-5-haiku-20241022",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-sonnet-latest",
  "claude-3-haiku-20240307"
]);

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Content-Type": "application/json"
  };
}

// Returns the origin to echo, or null if the origin is not allowed.
function resolveOrigin(origin) {
  const allow = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (process.env.URL) allow.push(process.env.URL);          // Netlify primary URL
  if (process.env.DEPLOY_PRIME_URL) allow.push(process.env.DEPLOY_PRIME_URL);
  if (allow.length === 0) return origin || "*";              // not configured → allow (still rate-limited)
  if (!origin) return allow[0];                              // no Origin header (e.g. server-side)
  return allow.includes(origin) ? origin : null;
}

function rateOk(ip) {
  const t = Date.now();
  const arr = (hits.get(ip) || []).filter(ts => t - ts < RATE.windowMs);
  if (arr.length >= RATE.max) { hits.set(ip, arr); return false; }
  arr.push(t); hits.set(ip, arr);
  return true;
}

exports.handler = async (event) => {
  const h = event.headers || {};
  const origin = h.origin || h.Origin || "";

  if (event.httpMethod === "OPTIONS")
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify({ error: "method not allowed" }) };

  const allow = resolveOrigin(origin);
  if (allow === null)
    return { statusCode: 403, headers: corsHeaders(origin), body: JSON.stringify({ error: "origin not allowed" }) };

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key)
    return { statusCode: 500, headers: corsHeaders(allow), body: JSON.stringify({ error: "proxy not configured: ANTHROPIC_API_KEY missing" }) };

  const ip = String(h["x-nf-client-connection-ip"] || h["x-forwarded-for"] || "")
    .split(",")[0].trim() || "unknown";
  if (!rateOk(ip))
    return { statusCode: 429, headers: corsHeaders(allow), body: JSON.stringify({ error: "rate limit – please wait a moment" }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return { statusCode: 400, headers: corsHeaders(allow), body: JSON.stringify({ error: "invalid JSON" }) }; }

  if (!Array.isArray(body.messages) || body.messages.length === 0)
    return { statusCode: 400, headers: corsHeaders(allow), body: JSON.stringify({ error: "messages[] required" }) };

  const model = MODELS.has(body.model) ? body.model : "claude-3-5-sonnet-20241022";
  const max_tokens = Math.min(parseInt(body.max_tokens, 10) || 1024, 8000);
  const payload = { model, max_tokens, messages: body.messages };
  if (body.system) payload.system = String(body.system).slice(0, 24000);

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(payload)
    });
    const text = await r.text();              // pass Anthropic's response straight through
    return { statusCode: r.status, headers: corsHeaders(allow), body: text };
  } catch (e) {
    return { statusCode: 502, headers: corsHeaders(allow), body: JSON.stringify({ error: "upstream error", detail: String((e && e.message) || e) }) };
  }
};
