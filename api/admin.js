// دالة واحدة لكل عمليات الداشبورد.
// المتغيرات المطلوبة في Vercel: ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const crypto = require("crypto");

const BASE = () => (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const KEY = () => (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const authH = () => (KEY().startsWith("eyJ") ? { Authorization: "Bearer " + KEY() } : {});

async function sb(path, o = {}) {
  const r = await fetch(BASE() + "/rest/v1/" + path, {
    ...o,
    headers: { apikey: KEY(), ...authH(), "Content-Type": "application/json", ...(o.headers || {}) },
  });
  const txt = await r.text();
  if (!r.ok) throw Object.assign(new Error(txt || r.statusText), { status: r.status >= 500 ? 502 : 400 });
  return txt ? JSON.parse(txt) : null;
}

const bad = (m, s) => Object.assign(new Error(m), { status: s || 400 });
const enc = encodeURIComponent;
const UUID = /^[0-9a-f-]{36}$/i;
const uuid = (v) => { if (!UUID.test(String(v || ""))) throw bad("bad_id"); return v; };
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---- كلمات السر والجلسات ----
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return "scrypt$" + salt + "$" + crypto.scryptSync(pw, salt, 32).toString("hex");
}
function checkPw(pw, h) {
  const [t, salt, hex] = String(h || "").split("$");
  if (t !== "scrypt" || !salt || !hex) return false;
  return same(crypto.scryptSync(pw, salt, 32).toString("hex"), hex);
}
const secret = () => crypto.createHash("sha256").update(process.env.ADMIN_PASSWORD + "|" + KEY()).digest();
const b64 = (s) => Buffer.from(s).toString("base64url");
function sign(payload) {
  const p = b64(JSON.stringify(payload));
  return p + "." + crypto.createHmac("sha256", secret()).update(p).digest("base64url");
}
function verify(tok) {
  const [p, s] = String(tok || "").split(".");
  if (!p || !s) return null;
  const e = crypto.createHmac("sha256", secret()).update(p).digest("base64url");
  if (!same(s, e)) return null;
  try { const o = JSON.parse(Buffer.from(p, "base64url").toString()); return o.exp > Date.now() ? o : null; } catch (e2) { return null; }
}

// ---- الصلاحيات ----
const PERMS = ["bookings", "slots", "briefs", "content", "brief_form", "settings", "notifications"];
const RANK = { view: 1, edit: 2 };
const ALL = Object.fromEntries(PERMS.map((k) => [k, "edit"]));
function can(perms, key, lvl) { return (RANK[perms[key]] || 0) >= RANK[lvl]; }

// ---- توقيت القاهرة -> UTC ----
function offsetMin(ms) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ms)).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms) / 60000;
}
function cairoToISO(d, t) {
  const [Y, M, D] = d.split("-").map(Number), [h, m] = t.split(":").map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, m);
  let utc = guess - offsetMin(guess) * 60000;
  utc = guess - offsetMin(utc) * 60000;
  return new Date(utc).toISOString();
}

const URLV = (v) => { v = String(v || "").trim(); if (v && !/^https?:\/\/\S{3,500}$/.test(v)) throw bad("bad_url"); return v; };
const MIME = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "font/otf": "otf" };

// action -> [الصلاحية, المستوى]
const NEED = {
  me: null,
  bookings_list: ["bookings", "view"], booking_update: ["bookings", "edit"], booking_delete: ["bookings", "edit"],
  slots_list: ["slots", "view"], slots_add: ["slots", "edit"], slots_delete: ["slots", "edit"],
  briefs_list: ["briefs", "view"], brief_get: ["briefs", "view"], brief_mark: ["briefs", "view"], brief_delete: ["briefs", "edit"],
  data_get: null, data_save: null, upload: null,
  admins_list: ["_owner"], admin_save: ["_owner"], admin_delete: ["_owner"],
};

const actions = {
  async me(b, ctx) { return { name: ctx.name, owner: ctx.owner, perms: ctx.perms }; },

  async bookings_list() { return { items: await sb("p2_bookings?select=*&order=slot_starts_at.desc&limit=500") }; },
  async booking_update(b) {
    const id = uuid(b.id), patch = {};
    if (b.status !== undefined) { if (!["new", "confirmed", "done", "cancelled"].includes(b.status)) throw bad("bad_status"); patch.status = b.status; }
    if (b.meeting_link !== undefined) patch.meeting_link = URLV(b.meeting_link) || null;
    if (!Object.keys(patch).length) throw bad("nothing");
    await sb(`p2_bookings?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
    return { ok: true };
  },
  async booking_delete(b) { await sb(`p2_bookings?id=eq.${uuid(b.id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); return { ok: true }; },

  async slots_list() {
    const from = enc(new Date(Date.now() - 86400000).toISOString());
    const slots = await sb(`p2_slots?select=id,starts_at,duration_min&starts_at=gte.${from}&order=starts_at.asc&limit=500`);
    const bk = await sb("p2_bookings?select=id,slot_id,name,status&slot_id=not.is.null&limit=2000");
    const m = {}; bk.forEach((x) => (m[x.slot_id] = x));
    return { items: slots.map((s) => ({ ...s, booking: m[s.id] || null })) };
  },
  async slots_add(b) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || "")) throw bad("bad_date");
    const times = [...new Set((Array.isArray(b.times) ? b.times : []).map((x) => String(x).trim()))].filter(Boolean);
    if (!times.length || times.length > 40 || times.some((t) => !/^([01]?\d|2[0-3]):[0-5]\d$/.test(t))) throw bad("bad_times");
    const dur = parseInt(b.duration, 10);
    if (!(dur >= 5 && dur <= 240)) throw bad("bad_duration");
    const rows = times.map((t) => ({ starts_at: cairoToISO(b.date, t), duration_min: dur }));
    await sb("p2_slots?on_conflict=starts_at", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(rows) });
    return { ok: true, added: rows.length };
  },
  async slots_delete(b) {
    const id = uuid(b.id);
    if ((await sb(`p2_bookings?slot_id=eq.${id}&select=id`)).length) throw bad("slot_booked");
    await sb(`p2_slots?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    return { ok: true };
  },

  async briefs_list() { return { items: await sb("p2_briefs?select=id,client_name,brand_name,phone,is_read,created_at&order=created_at.desc&limit=500") }; },
  async brief_get(b) { const r = await sb(`p2_briefs?id=eq.${uuid(b.id)}&select=*`); if (!r.length) throw bad("not_found"); return { item: r[0] }; },
  async brief_mark(b) { await sb(`p2_briefs?id=eq.${uuid(b.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ is_read: b.is_read !== false }) }); return { ok: true }; },
  async brief_delete(b) { await sb(`p2_briefs?id=eq.${uuid(b.id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); return { ok: true }; },

  // المحتوى / الإعدادات / أسئلة البريف: ثلاث صفوف في p2_settings
  async data_get(b, ctx) {
    const r = await sb("p2_settings?key=in.(site,content,brief)&select=key,value"), o = { site: {}, content: {}, brief: null };
    r.forEach((x) => (o[x.key] = x.value));
    return o;
  },
  async data_save(b, ctx) {
    const need = { site: "settings", content: "content", brief: "brief_form" }[b.key];
    if (!need) throw bad("bad_key");
    if (!can(ctx.perms, need, "edit")) throw bad("forbidden", 403);
    const v = b.value;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw bad("bad_value");
    if (JSON.stringify(v).length > 400000) throw bad("too_big");
    if (b.key === "site") {
      const n = (x) => { x = Number(x); if (!(x >= 0.2 && x <= 4)) throw bad("bad_speed"); return x; };
      if (v.marquee_speed !== undefined) v.marquee_speed = n(v.marquee_speed);
      if (v.logo_speed !== undefined) v.logo_speed = n(v.logo_speed);
      if (v.whatsapp !== undefined) { v.whatsapp = String(v.whatsapp).replace(/\D/g, ""); if (v.whatsapp && (v.whatsapp.length < 8 || v.whatsapp.length > 15)) throw bad("bad_whatsapp"); }
      if (!["en", "ar"].includes(v.lang)) v.lang = "en";
      if (!["light", "dark"].includes(v.theme)) v.theme = "light";
      (v.socials || []).forEach((s) => (s.url = URLV(s.url)));
    }
    await sb("p2_settings?on_conflict=key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: b.key, value: v }) });
    return { ok: true };
  },

  // رفع صورة/خط إلى Supabase Storage (bucket p2-assets)
  async upload(b, ctx) {
    if (!can(ctx.perms, "content", "edit") && !can(ctx.perms, "settings", "edit")) throw bad("forbidden", 403);
    const ext = MIME[b.mime];
    if (!ext) throw bad("bad_type");
    const buf = Buffer.from(String(b.data || ""), "base64");
    if (!buf.length || buf.length > 3 * 1024 * 1024) throw bad("bad_size");
    const folder = /^[a-z0-9_-]{1,20}$/.test(b.folder || "") ? b.folder : "misc";
    const path = `${folder}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
    const r = await fetch(`${BASE()}/storage/v1/object/p2-assets/${path}`, {
      method: "POST", headers: { apikey: KEY(), ...authH(), "Content-Type": b.mime, "x-upsert": "false" }, body: buf,
    });
    if (!r.ok) throw bad("upload_failed: " + (await r.text()).slice(0, 200), 502);
    return { url: `${BASE()}/storage/v1/object/public/p2-assets/${path}` };
  },

  // المشرفين (صاحب الموقع فقط)
  async admins_list() {
    return { items: await sb("p2_admins?select=id,username,name,permissions,is_active,created_at,last_login&order=created_at.asc") };
  },
  async admin_save(b) {
    const username = String(b.username || "").trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,30}$/.test(username)) throw bad("bad_username");
    const perms = {};
    PERMS.forEach((k) => { if (RANK[(b.permissions || {})[k]]) perms[k] = b.permissions[k]; });
    const row = { username, name: String(b.name || "").slice(0, 80), permissions: perms, is_active: b.is_active !== false };
    if (b.password) { if (String(b.password).length < 8) throw bad("short_password"); row.password_hash = hashPw(String(b.password)); }
    if (b.id) {
      await sb(`p2_admins?id=eq.${uuid(b.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
    } else {
      if (!row.password_hash) throw bad("short_password");
      await sb("p2_admins", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
    }
    return { ok: true };
  },
  async admin_delete(b) { await sb(`p2_admins?id=eq.${uuid(b.id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); return { ok: true }; },
};

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  if (!process.env.ADMIN_PASSWORD || !BASE() || !KEY()) return res.status(500).json({ error: "env_missing" });
  let b = req.body;
  try { if (typeof b === "string") b = JSON.parse(b || "{}"); } catch (e) { return res.status(400).json({ error: "bad_json" }); }
  b = b || {};
  try {
    if (b.action === "login") {
      const u = String(b.username || "").trim().toLowerCase(), pw = String(b.password || "");
      let tok = null;
      if (!u || u === "owner") {
        if (same(pw, process.env.ADMIN_PASSWORD)) tok = sign({ u: "owner", exp: Date.now() + 12 * 3600e3 });
      } else {
        const r = await sb(`p2_admins?username=eq.${enc(u)}&is_active=eq.true&select=id,password_hash`);
        if (r.length && checkPw(pw, r[0].password_hash)) {
          tok = sign({ u: r[0].id, exp: Date.now() + 12 * 3600e3 });
          await sb(`p2_admins?id=eq.${r[0].id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_login: new Date().toISOString() }) });
        }
      }
      if (!tok) { await new Promise((r) => setTimeout(r, 600)); return res.status(401).json({ error: "unauthorized" }); }
      return res.status(200).json({ token: tok });
    }
    const t = verify(req.headers["x-admin-token"]);
    if (!t) return res.status(401).json({ error: "unauthorized" });
    let ctx;
    if (t.u === "owner") ctx = { owner: true, name: "صاحب الموقع", perms: ALL };
    else {
      const r = await sb(`p2_admins?id=eq.${uuid(t.u)}&is_active=eq.true&select=name,username,permissions`);
      if (!r.length) return res.status(401).json({ error: "unauthorized" });
      ctx = { owner: false, name: r[0].name || r[0].username, perms: r[0].permissions || {} };
    }
    const fn = Object.prototype.hasOwnProperty.call(actions, b.action) ? actions[b.action] : null;
    if (!fn) return res.status(400).json({ error: "unknown_action" });
    const need = NEED[b.action];
    if (need) {
      if (need[0] === "_owner") { if (!ctx.owner) return res.status(403).json({ error: "forbidden" }); }
      else if (!can(ctx.perms, need[0], need[1])) return res.status(403).json({ error: "forbidden" });
    }
    return res.status(200).json(await fn(b, ctx));
  } catch (e) {
    return res.status(e.status || 500).json({ error: "failed", message: String(e.message).slice(0, 300) });
  }
};
module.exports.cairoToISO = cairoToISO;
module.exports.hashPw = hashPw;
module.exports.checkPw = checkPw;
