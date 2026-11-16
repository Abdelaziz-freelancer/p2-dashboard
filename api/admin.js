// دالة واحدة لكل عمليات الداشبورد (عشان حد Vercel المجاني 12 دالة).
// المتغيرات المطلوبة في Vercel: ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const crypto = require("crypto");

const BASE = () => (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || "";

async function sb(path, o = {}) {
  const r = await fetch(BASE() + "/rest/v1/" + path, {
    ...o,
    headers: { apikey: KEY(), Authorization: "Bearer " + KEY(), "Content-Type": "application/json", ...(o.headers || {}) },
  });
  const txt = await r.text();
  if (!r.ok) throw Object.assign(new Error(txt || r.statusText), { status: r.status >= 500 ? 502 : 400 });
  return txt ? JSON.parse(txt) : null;
}

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const bad = (m) => Object.assign(new Error(m), { status: 400 });
const UUID = /^[0-9a-f-]{36}$/i;
const uuid = (v) => { if (!UUID.test(String(v || ""))) throw bad("bad_id"); return v; };
const enc = encodeURIComponent;

// توقيت القاهرة -> UTC (بيراعي التوقيت الصيفي)
function offsetMin(ms) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms)).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms) / 60000;
}
function cairoToISO(d, t) {
  const [Y, M, D] = d.split("-").map(Number), [h, m] = t.split(":").map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, m);
  let utc = guess - offsetMin(guess) * 60000;
  utc = guess - offsetMin(utc) * 60000;
  return new Date(utc).toISOString();
}

const SPEED = (v) => { const n = Number(v); if (!(n >= 0.2 && n <= 4)) throw bad("bad_speed"); return Math.round(n * 100) / 100; };
const URLV = (v) => { v = String(v || "").trim(); if (v && !/^https?:\/\/\S{3,300}$/.test(v)) throw bad("bad_url"); return v; };

const actions = {
  async login() { return { ok: true }; },

  async slots_list() {
    const from = enc(new Date(Date.now() - 86400000).toISOString());
    const slots = await sb(`p2_slots?select=id,starts_at,duration_min&starts_at=gte.${from}&order=starts_at.asc&limit=500`);
    const bk = await sb("p2_bookings?select=id,slot_id,name,status&slot_id=not.is.null&limit=2000");
    const m = {}; bk.forEach((b) => (m[b.slot_id] = b));
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
    const used = await sb(`p2_bookings?slot_id=eq.${id}&select=id`);
    if (used.length) throw bad("slot_booked");
    await sb(`p2_slots?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    return { ok: true };
  },

  async bookings_list() {
    return { items: await sb("p2_bookings?select=*&order=slot_starts_at.desc&limit=500") };
  },
  async booking_update(b) {
    const id = uuid(b.id), patch = {};
    if (b.status !== undefined) {
      if (!["new", "confirmed", "done", "cancelled"].includes(b.status)) throw bad("bad_status");
      patch.status = b.status;
    }
    if (b.meeting_link !== undefined) patch.meeting_link = URLV(b.meeting_link) || null;
    if (!Object.keys(patch).length) throw bad("nothing");
    await sb(`p2_bookings?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
    return { ok: true };
  },
  async booking_delete(b) {
    await sb(`p2_bookings?id=eq.${uuid(b.id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    return { ok: true };
  },

  async briefs_list() {
    return { items: await sb("p2_briefs?select=id,client_name,brand_name,phone,is_read,created_at&order=created_at.desc&limit=500") };
  },
  async brief_get(b) {
    const r = await sb(`p2_briefs?id=eq.${uuid(b.id)}&select=*`);
    if (!r.length) throw bad("not_found");
    return { item: r[0] };
  },
  async brief_mark(b) {
    await sb(`p2_briefs?id=eq.${uuid(b.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ is_read: b.is_read !== false }) });
    return { ok: true };
  },
  async brief_delete(b) {
    await sb(`p2_briefs?id=eq.${uuid(b.id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    return { ok: true };
  },

  async settings_get() {
    const r = await sb("p2_settings?key=eq.site&select=value");
    return { value: (r[0] || {}).value || {} };
  },
  async settings_save(b) {
    const r = await sb("p2_settings?key=eq.site&select=value");
    const v = { ...((r[0] || {}).value || {}) };
    if (b.marquee_speed !== undefined) v.marquee_speed = SPEED(b.marquee_speed);
    if (b.logo_speed !== undefined) v.logo_speed = SPEED(b.logo_speed);
    if (b.whatsapp !== undefined) {
      const w = String(b.whatsapp).replace(/\D/g, "");
      if (w.length < 8 || w.length > 15) throw bad("bad_whatsapp");
      v.whatsapp = w;
    }
    if (b.facebook !== undefined) v.facebook = URLV(b.facebook);
    if (b.instagram !== undefined) v.instagram = URLV(b.instagram);
    await sb("p2_settings?on_conflict=key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "site", value: v }) });
    return { ok: true, value: v };
  },
};

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  if (!process.env.ADMIN_PASSWORD || !BASE() || !KEY()) return res.status(500).json({ error: "env_missing" });
  if (!same(req.headers["x-admin-password"] || "", process.env.ADMIN_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 500));
    return res.status(401).json({ error: "unauthorized" });
  }
  let b = req.body;
  try { if (typeof b === "string") b = JSON.parse(b || "{}"); } catch (e) { return res.status(400).json({ error: "bad_json" }); }
  b = b || {};
  const fn = Object.prototype.hasOwnProperty.call(actions, b.action) ? actions[b.action] : null;
  if (!fn) return res.status(400).json({ error: "unknown_action" });
  try {
    return res.status(200).json(await fn(b));
  } catch (e) {
    return res.status(e.status || 500).json({ error: "failed", message: String(e.message).slice(0, 300) });
  }
};
module.exports.cairoToISO = cairoToISO;
