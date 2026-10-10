// Matoshree site worker: static assets + lead capture (D1) + admin API.
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

const STATUSES = ["new", "contacted", "survey_scheduled", "quoted", "won", "lost", "spam"];

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function authorized(req, env) {
  const key = env.ADMIN_KEY || "";
  const given = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (key.length < 12 || given.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

async function getOrders(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='orders_completed'").first();
  return row ? parseInt(row.value, 10) || 0 : 0;
}


// Self-healing schema: creates missing tables and adds missing columns, so an older
// or partly-run schema.sql can never break the site. Runs once per worker instance.
const TABLES = [
  "CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), name TEXT NOT NULL, phone TEXT NOT NULL, city TEXT, bill INTEGER, lang TEXT, status TEXT NOT NULL DEFAULT 'new', note TEXT, ip_hash TEXT)",
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS installations (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), title TEXT NOT NULL, city TEXT, kw REAL, photo_id INTEGER, visible INTEGER NOT NULL DEFAULT 1)",
];
const COLUMNS = {
  leads: [["city", "TEXT"], ["bill", "INTEGER"], ["lang", "TEXT"], ["status", "TEXT NOT NULL DEFAULT 'new'"], ["note", "TEXT"], ["ip_hash", "TEXT"]],
  installations: [["city", "TEXT"], ["kw", "REAL"], ["photo_id", "INTEGER"], ["visible", "INTEGER NOT NULL DEFAULT 1"]],
};
let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const sql of TABLES) await env.DB.prepare(sql).run();
      for (const [table, cols] of Object.entries(COLUMNS)) {
        const have = (await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results.map((r) => r.name);
        for (const [name, def] of cols)
          if (!have.includes(name)) await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`).run();
      }
      await env.DB.prepare(
        "INSERT INTO settings (key,value) SELECT 'orders_completed','92' WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key='orders_completed')"
      ).run();
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// Update-then-insert works on any table layout (no reliance on ON CONFLICT).
async function setOrders(env, n) {
  const r = await env.DB.prepare("UPDATE settings SET value=? WHERE key='orders_completed'").bind(String(n)).run();
  if (!r.meta || !r.meta.changes)
    await env.DB.prepare("INSERT INTO settings (key,value) VALUES ('orders_completed',?)").bind(String(n)).run();
}
async function bumpOrders(env) { await setOrders(env, (await getOrders(env)) + 1); }

async function saveLead(req, env) {
  let b;
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  if (b.website) return json({ ok: true }); // honeypot: bots fill this, pretend success

  const name = String(b.name || "").trim().slice(0, 80);
  const phone = String(b.phone || "").replace(/\D/g, "").slice(-10);
  const city = String(b.city || "").slice(0, 60);
  const lang = b.lang === "en" ? "en" : "hi";
  const billNum = parseInt(b.bill, 10);
  const bill = Number.isFinite(billNum) && billNum >= 0 && billNum < 10000000 ? billNum : null;
  if (!name || !/^[6-9]\d{9}$/.test(phone)) return json({ error: "invalid" }, 400);

  const ipHash = await sha256(req.headers.get("CF-Connecting-IP") || "unknown");

  // Rate limit: max 5 submissions per IP per hour.
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM leads WHERE ip_hash=? AND created_at > datetime('now','-1 hour')"
  ).bind(ipHash).first();
  if (recent && recent.c >= 5) return json({ error: "too_many" }, 429);

  // Same phone within 30 minutes: treat as already received.
  const dup = await env.DB.prepare(
    "SELECT id FROM leads WHERE phone=? AND created_at > datetime('now','-30 minutes') LIMIT 1"
  ).bind(phone).first();
  if (dup) return json({ ok: true, duplicate: true });

  await env.DB.prepare(
    "INSERT INTO leads (name, phone, city, bill, lang, ip_hash) VALUES (?,?,?,?,?,?)"
  ).bind(name, phone, city, bill, lang, ipHash).run();
  return json({ ok: true });
}

async function admin(req, env, url) {
  if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
  const path = url.pathname;

  if (path === "/api/admin/leads" && req.method === "GET") {
    const status = url.searchParams.get("status");
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    const where = [], vals = [];
    if (status && STATUSES.includes(status)) { where.push("status=?"); vals.push(status); }
    const dateOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
    if (dateOk(from)) { where.push("date(created_at,'+5 hours','+30 minutes') >= ?"); vals.push(from); }
    if (dateOk(to)) { where.push("date(created_at,'+5 hours','+30 minutes') <= ?"); vals.push(to); }
    const sql = "SELECT id,created_at,name,phone,city,bill,lang,status,note FROM leads" +
      (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY id DESC LIMIT 2000";
    const { results } = await env.DB.prepare(sql).bind(...vals).all();
    const counts = await env.DB.prepare("SELECT status, COUNT(*) AS c FROM leads GROUP BY status").all();
    return json({ leads: results, counts: counts.results, orders: await getOrders(env) });
  }

  const m = path.match(/^\/api\/admin\/leads\/(\d+)$/);
  if (m && req.method === "PATCH") {
    let b; try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
    const sets = [], vals = [];
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return json({ error: "bad_status" }, 400);
      sets.push("status=?"); vals.push(b.status);
    }
    if (b.note !== undefined) { sets.push("note=?"); vals.push(String(b.note).slice(0, 500)); }
    if (!sets.length) return json({ error: "nothing" }, 400);
    await env.DB.prepare(`UPDATE leads SET ${sets.join(",")} WHERE id=?`).bind(...vals, Number(m[1])).run();
    return json({ ok: true });
  }

  if (path === "/api/admin/orders" && req.method === "PUT") {
    let b; try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
    const n = parseInt(b.orders, 10);
    if (!Number.isFinite(n) || n < 0 || n > 100000) return json({ error: "bad_number" }, 400);
    await setOrders(env, n);
    return json({ ok: true, orders: n });
  }
  if (path === "/api/admin/installations" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id,created_at,title,city,kw,photo_id,visible FROM installations ORDER BY id DESC LIMIT 500"
    ).all();
    return json({ installations: results, orders: await getOrders(env) });
  }

  if (path === "/api/admin/installations" && req.method === "POST") {
    let b; try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
    const title = String(b.title || "").trim().slice(0, 100);
    const city = String(b.city || "").trim().slice(0, 60);
    const kwNum = parseFloat(b.kw);
    const kw = Number.isFinite(kwNum) && kwNum > 0 && kwNum < 10000 ? kwNum : null;
    if (!title) return json({ error: "title_required" }, 400);
    let photo = String(b.photo || "").replace(/^data:image\/jpeg;base64,/, "");
    if (photo && (!photo.startsWith("/9j/") || photo.length > 700000 || !/^[A-Za-z0-9+/=]+$/.test(photo)))
      return json({ error: "bad_photo" }, 400);

    let photoId = null;
    if (photo) {
      const r = await env.DB.prepare("INSERT INTO photos (data) VALUES (?)").bind(photo).run();
      photoId = r.meta.last_row_id;
    }
    await env.DB.prepare("INSERT INTO installations (title,city,kw,photo_id) VALUES (?,?,?,?)")
      .bind(title, city, kw, photoId).run();
    if (b.increment) {
      await bumpOrders(env);
    }
    return json({ ok: true, orders: await getOrders(env) });
  }

  const mi = path.match(/^\/api\/admin\/installations\/(\d+)$/);
  if (mi && req.method === "PATCH") {
    let b; try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
    await env.DB.prepare("UPDATE installations SET visible=? WHERE id=?").bind(b.visible ? 1 : 0, Number(mi[1])).run();
    return json({ ok: true });
  }
  if (mi && req.method === "DELETE") {
    const row = await env.DB.prepare("SELECT photo_id FROM installations WHERE id=?").bind(Number(mi[1])).first();
    await env.DB.prepare("DELETE FROM installations WHERE id=?").bind(Number(mi[1])).run();
    if (row && row.photo_id) await env.DB.prepare("DELETE FROM photos WHERE id=?").bind(row.photo_id).run();
    return json({ ok: true });
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // The D1 binding must be named DB (wrangler.jsonc). Accept the name wrangler suggests too.
    if (!env.DB && env.matoshree_db) env = { ...env, DB: env.matoshree_db };
    try {
      if (url.pathname.startsWith("/api/") && !env.DB) throw new Error("D1 database is not bound: in wrangler.jsonc the binding name must be DB");
      if (url.pathname.startsWith("/api/")) await ensureSchema(env);
      if (url.pathname === "/api/stats" && req.method === "GET") {
        return json({ orders: await getOrders(env) }, 200, { "Cache-Control": "public, max-age=60" });
      }
      if (url.pathname === "/api/installations" && req.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT id,title,city,kw,photo_id FROM installations WHERE visible=1 AND photo_id IS NOT NULL ORDER BY id DESC LIMIT 12"
        ).all();
        return json({ installations: results }, 200, { "Cache-Control": "public, max-age=60" });
      }
      const pm = url.pathname.match(/^\/api\/photo\/(\d+)$/);
      if (pm && req.method === "GET") {
        const row = await env.DB.prepare("SELECT data FROM photos WHERE id=?").bind(Number(pm[1])).first();
        if (!row) return new Response("Not found", { status: 404 });
        const bin = atob(row.data), bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Response(bytes, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
      }
      if (url.pathname === "/api/lead" && req.method === "POST") return await saveLead(req, env);
      if (url.pathname.startsWith("/api/admin/")) return await admin(req, env, url);
      if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    } catch (e) {
      console.error("worker error", url.pathname, e && e.stack || e);
      // Details only for the (already authenticated) admin area; public callers get a generic error.
      const detail = url.pathname.startsWith("/api/admin/") && authorized(req, env) ? String(e && e.message || e) : undefined;
      return json({ error: "server_error", detail }, 500);
    }
    return env.ASSETS.fetch(req);
  },
};
