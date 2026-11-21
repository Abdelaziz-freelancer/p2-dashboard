// API الداشبورد — دالة واحدة بـ action. كل طلب (ماعدا login/refresh) لازم توكن، وكل action ليه صلاحية.
const sendPush = require('./_push');
const U = () => process.env.SUPABASE_URL;
const SK = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
const AK = () => process.env.SUPABASE_ANON_KEY;
const SH = () => ({ apikey: SK(), ...(SK().startsWith('sb_') ? {} : { Authorization: 'Bearer ' + SK() }), 'Content-Type': 'application/json' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// الأقسام اللي ينفع تتحدد صلاحياتها: 0 = ممنوع، 1 = مشاهدة، 2 = تعديل
const PERM_KEYS = ['bookings', 'slots', 'briefs', 'texts', 'lists', 'media', 'brief_form', 'appearance', 'stats', 'clients'];
const LIST_KEYS = ['services', 'why', 'brands', 'cases', 'showcase', 'testimonials', 'packages', 'counters', 'articles', 'landings'];
const IMAGE_KEYS = ['me_white', 'me_dark', 'logo'];

async function rest(path, opt = {}) {
  const r = await fetch(`${U()}/rest/v1/${path}`, { ...opt, headers: { ...SH(), ...(opt.headers || {}) } });
  const txt = await r.text();
  if (!r.ok) throw new Error(txt || r.status);
  return txt ? JSON.parse(txt) : null;
}

async function getUser(token) {
  if (!token) return null;
  const r = await fetch(`${U()}/auth/v1/user`, { headers: { apikey: AK(), Authorization: 'Bearer ' + token } });
  if (!r.ok) return null;
  const u = await r.json();
  const email = (u.email || '').toLowerCase();
  const owner = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
  if (!email) return null;
  if (owner && email === owner) {
    const perms = {}; PERM_KEYS.forEach(k => perms[k] = 2);
    return { email, owner: true, perms };
  }
  const a = await rest(`p2_admins?email=eq.${encodeURIComponent(email)}&select=perms`);
  if (!a || !a[0]) return null;
  const perms = {}; PERM_KEYS.forEach(k => perms[k] = Math.min(2, Math.max(0, +(a[0].perms || {})[k] || 0)));
  return { email, owner: false, perms };
}

const cleanPerms = p => { const o = {}; PERM_KEYS.forEach(k => o[k] = Math.min(2, Math.max(0, parseInt((p || {})[k]) || 0))); return o; };

// تنضيف أي بيانات جاية من الواجهة قبل ما تتحفظ
function san(v, key, depth = 0) {
  if (depth > 8) return null;
  if (typeof v === 'string') {
    v = v.slice(0, key === 'be' || key === 'ba' ? 20000 : 4000);
    if (['img', 'u', 'url'].includes(key) && v && !/^(https:\/\/|http:\/\/localhost[:\/])/i.test(v)) return '';
    return v;
  }
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map(x => san(x, key === 'shots' || key === 'showcase' ? 'img' : key, depth + 1)).filter(x => x !== null);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).slice(0, 200)) { if (/^[\w.\-]{1,60}$/.test(k)) o[k] = san(v[k], k, depth + 1); }
    return o;
  }
  return null;
}

const SETTINGS_KEYS = {
  whatsapp: v => String(v || '').replace(/\D/g, '').slice(0, 20),
  marquee_speed: v => Math.min(5, Math.max(0.2, Number(v) || 1)),
  logo_speed: v => Math.min(5, Math.max(0.2, Number(v) || 1)),
  default_lang: v => (v === 'ar' ? 'ar' : 'en'),
  default_theme: v => (v === 'dark' ? 'dark' : 'light'),
  site_title: v => String(v || '').slice(0, 120),
  social: v => (Array.isArray(v) ? v.slice(0, 20).map(s => ({ n: String(s.n || '').slice(0, 40), u: /^(https:\/\/|http:\/\/localhost[:\/])/i.test(s.u || '') ? String(s.u).slice(0, 400) : '', v: s.v === 0 || s.v === false ? 0 : 1, m: s.m === 'icon' ? 'icon' : 'text' })).filter(s => s.n) : []),
  meta_pixel: v => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 8 && d.length <= 20 ? d : ''; },
  tiktok_pixel: v => { const d = String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); return d.length >= 8 && d.length <= 30 ? d : ''; },
  logo_anim: v => {
    v = v && typeof v === 'object' ? v : {};
    const pick = (x, L, d) => (L.includes(x) ? x : d), sp = parseFloat(v.speed);
    return { ent: pick(v.ent, ['none', 'pop', 'fade', 'up', 'zoom', 'spin', 'blur', 'drop'], 'pop'), mot: pick(v.mot, ['none', 'float', 'swing', 'bounce'], 'none'), scl: pick(v.scl, ['none', 'pulse', 'spin', 'flip'], 'none'), glow: +v.glow ? 1 : 0, shine: +v.shine ? 1 : 0, speed: isFinite(sp) ? Math.min(3, Math.max(0.3, sp)) : 1, nav: +v.nav === 0 && v.nav !== undefined ? 0 : 1 };
  },
  ga4_id: v => { const d = String(v || '').trim().toUpperCase(); return /^G-[A-Z0-9]{6,14}$/.test(d) ? d : ''; },
  snap_pixel: v => { const d = String(v || '').trim().toLowerCase(); return /^[0-9a-f-]{20,50}$/.test(d) ? d : ''; },
  seo: v => { v = v || {}; return { title: String(v.title || '').slice(0, 90), desc: String(v.desc || '').slice(0, 200), img: /^https:\/\//i.test(v.img || '') ? String(v.img).slice(0, 500) : '' }; },
  wa_float: v => { v = v || {}; return { on: +v.on ? 1 : 0, msg: String(v.msg || '').slice(0, 300) }; },
  cookie: v => ({ on: v && +v.on ? 1 : 0 }),
  maint: v => { v = v || {}; return { on: +v.on ? 1 : 0, msg: String(v.msg || '').slice(0, 300) }; },
  magnet: v => { v = v || {}; const t = x => String(x || '').slice(0, 300); return { on: +v.on ? 1 : 0, te: t(v.te), ta: t(v.ta), de: t(v.de), da: t(v.da), url: /^https:\/\//i.test(v.url || '') ? String(v.url).slice(0, 500) : '' }; },
  wa_mode: v => (v === 'icon' ? 'icon' : 'text'),
  wa_template: v => String(v || '').slice(0, 800),
  fonts: v => { const o = {}; ['en_head', 'en_body', 'ar_head', 'ar_body'].forEach(k => { const n = String((v || {})[k] || '').trim(); o[k] = /^[\w \-]{2,40}$/.test(n) ? n : ''; }); return o; },
};

const MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

async function authAdminApi(path, method, body) {
  const r = await fetch(`${U()}/auth/v1/admin/${path}`, { method, headers: SH(), body: body ? JSON.stringify(body) : undefined });
  let d = {}; try { d = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, d };
}

const T = (n = 500) => v => String(v == null ? '' : v).slice(0, n);
const NUM = v => { const n = parseFloat(v); return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0; };
const DATE = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const FK = v => (UUID.test(v || '') ? v : null);
const ENUM = L => v => (L.includes(v) ? v : L[0]);
const HTTPS = v => (/^https:\/\//i.test(v || '') ? String(v).slice(0, 500) : '');
const ITEMS = v => (Array.isArray(v) ? v.slice(0, 50).map(x => ({ d: T(200)(x && x.d), q: NUM(x && x.q), p: NUM(x && x.p) })) : []);
const REC = {
  clients: { perm: 'clients', table: 'p2_clients', cols: { name: T(120), phone: T(40), email: T(120), brand: T(120), notes: T(3000) } },
  contracts: { perm: 'clients', table: 'p2_contracts', embed: ',p2_clients(name)', cols: { client_id: FK, title: T(200), body: T(20000), amount: NUM, status: ENUM(['draft', 'sent', 'signed']) } },
  invoices: { perm: 'clients', table: 'p2_invoices', embed: ',p2_clients(name)', cols: { client_id: FK, number: T(40), items: ITEMS, total: NUM, paid: NUM, due: DATE, note: T(1000) } },
  reports: { perm: 'clients', table: 'p2_reports', embed: ',p2_clients(name)', cols: { client_id: FK, title: T(200), period: T(80), body: T(8000), link: HTTPS } },
  spend: { perm: 'stats', table: 'p2_spend', cols: { cmp: T(80), src: T(40), amount: NUM, day: DATE } },
  leads: { perm: 'bookings', table: 'p2_leads', cols: null },
  msgs: { perm: 'clients', table: 'p2_portal_msgs', embed: ',p2_clients(name)', cols: null },
};
const MUT = /^(booking_(update|delete|reschedule)|brief_(update|delete)|slots_add|slot_delete|content_save|settings_save|rec_save|rec_del|client_from|admins_|upload|vapid_generate)/;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!U() || !SK() || !AK()) return res.status(500).json({ error: 'السيرفر مش متظبط: متغيرات Vercel ناقصة' });
  const b = req.body || {};
  let who = '';
  const send = async (data, code = 200) => {
    if (code === 200 && who && MUT.test(b.action || '')) {
      try { await rest('p2_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ who, action: b.action, detail: [b.table, b.part, b.key, b.id, b.row && b.row.id].filter(Boolean).join(' ').slice(0, 200) }) }); } catch (e) {}
    }
    return res.status(code).json(data);
  };
  try {
    if (b.action === 'login' || b.action === 'refresh') {
      const body = b.action === 'login' ? { email: String(b.email || '').trim(), password: String(b.password || '') } : { refresh_token: b.refresh_token };
      const r = await fetch(`${U()}/auth/v1/token?grant_type=${b.action === 'login' ? 'password' : 'refresh_token'}`, {
        method: 'POST', headers: { apikey: AK(), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const d = await r.json();
      if (!r.ok) return send({ error: 'الإيميل أو كلمة السر غلط' }, 401);
      const me = await getUser(d.access_token);
      if (!me) return send({ error: 'الحساب ده مش مصرّح له يدخل الداشبورد' }, 403);
      return send({ access_token: d.access_token, refresh_token: d.refresh_token, expires_in: d.expires_in, email: me.email });
    }

    const me = await getUser((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!me) return send({ error: 'unauthorized' }, 401);
    who = me.email;
    const need = (k, lvl) => { if ((me.perms[k] || 0) < lvl) { const e = new Error('ليس لديك صلاحية لهذا الإجراء'); e.code = 403; throw e; } };
    const owner = () => { if (!me.owner) { const e = new Error('للمالك فقط'); e.code = 403; throw e; } };
    const anyView = (...ks) => { if (!ks.some(k => (me.perms[k] || 0) >= 1)) { const e = new Error('ليس لديك صلاحية لهذا الإجراء'); e.code = 403; throw e; } };
    const getContent = async () => ((await rest('p2_settings?key=eq.content&select=value'))[0] || {}).value || {};
    const putSetting = (key, value) => rest('p2_settings?on_conflict=key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key, value }) });

    switch (b.action) {
      case 'me': return send({ email: me.email, owner: me.owner, perms: me.perms, site: (process.env.SITE_URL || '').replace(/\/+$/, '') });
      case 'overview': {
        const now = new Date().toISOString(), o = {};
        if (me.perms.bookings >= 1) o.upcoming = (await rest(`p2_bookings?select=id,p2_slots!inner(starts_at)&p2_slots.starts_at=gte.${now}`)).length;
        if (me.perms.bookings >= 1 || me.perms.briefs >= 1) {
          const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }); o.follow = 0;
          if (me.perms.bookings >= 1) o.follow += (await rest(`p2_bookings?select=id&follow_up=lte.${today}&stage=not.in.(won,lost)&archived=eq.false`)).length;
          if (me.perms.briefs >= 1) o.follow += (await rest(`p2_briefs?select=id&follow_up=lte.${today}&stage=not.in.(won,lost)&archived=eq.false`)).length;
        }
        if (me.perms.briefs >= 1) o.unread = (await rest('p2_briefs?select=id&is_read=eq.false')).length;
        if (me.perms.slots >= 1) o.open = (await rest('p2_open_slots?select=id')).length;
        return send(o);
      }
      // ---- الحجوزات والمواعيد والبريفات ----
      case 'bookings_list': {
        need('bookings', 1);
        const rows = await rest(`p2_bookings?select=id,name,phone,activity,created_at,status,stage,follow_up,notes,archived,client_id,p2_slots(starts_at,duration_min)&archived=eq.${b.arch ? 'true' : 'false'}&order=created_at.desc&limit=500`);
        const st = ((await rest('p2_settings?key=eq.site&select=value'))[0] || {}).value || {};
        return send({ rows, tpl: st.wa_template || '' });
      }
      case 'open_slots': need('bookings', 1);
        return send(await rest(`p2_open_slots?select=id,starts_at&starts_at=gte.${new Date().toISOString()}&order=starts_at.asc&limit=200`));
      case 'booking_update': case 'brief_update': {
        const isB = b.action === 'booking_update';
        need(isB ? 'bookings' : 'briefs', 2);
        if (!UUID.test(b.id)) return send({ error: 'bad id' }, 400);
        const f = b.fields || {}, o = {};
        if ('stage' in f) o.stage = ENUM(['new', 'talked', 'offer', 'won', 'lost'])(f.stage);
        if ('follow_up' in f) o.follow_up = DATE(f.follow_up);
        if ('notes' in f) o.notes = T(3000)(f.notes);
        if ('archived' in f) o.archived = !!f.archived;
        if ('client_id' in f) o.client_id = FK(f.client_id);
        if (isB && 'status' in f) o.status = ENUM(['new', 'confirmed', 'done', 'noshow'])(f.status);
        if (!Object.keys(o).length) return send({ error: 'مفيش تعديل' }, 400);
        await rest(`${isB ? 'p2_bookings' : 'p2_briefs'}?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify(o) });
        return send({ ok: true });
      }
      case 'booking_reschedule': {
        need('bookings', 2);
        if (!UUID.test(b.id) || !UUID.test(b.slot)) return send({ error: 'bad id' }, 400);
        const sl = await rest(`p2_slots?id=eq.${b.slot}&starts_at=gt.${new Date().toISOString()}&select=id`);
        if (!sl.length) return send({ error: 'الميعاد ده مش متاح' }, 400);
        try { await rest(`p2_bookings?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ slot_id: b.slot, reminded: false }) }); }
        catch (e) { return send({ error: 'الميعاد ده اتحجز بالفعل' }, 409); }
        return send({ ok: true });
      }
      case 'client_from': {
        need('clients', 2);
        const isB = b.kind === 'booking';
        if (!UUID.test(b.id) || !['booking', 'brief'].includes(b.kind)) return send({ error: 'bad id' }, 400);
        const r = (await rest(`${isB ? 'p2_bookings' : 'p2_briefs'}?id=eq.${b.id}&select=*`))[0];
        if (!r) return send({ error: 'مش موجود' }, 404);
        if (r.client_id) return send({ ok: true, id: r.client_id });
        const c = (await rest('p2_clients', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name: isB ? r.name : (r.client_name || r.brand_name || 'عميل'), phone: r.phone || '', brand: isB ? r.activity : (r.brand_name || '') }) }))[0];
        await rest(`${isB ? 'p2_bookings' : 'p2_briefs'}?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ client_id: c.id }) });
        return send({ ok: true, id: c.id });
      }
      case 'rec_list': case 'rec_save': case 'rec_del': {
        const R = REC[b.table];
        if (!R) return send({ error: 'unknown table' }, 400);
        if (b.action === 'rec_list') {
          need(R.perm, 1);
          let q = `${R.table}?select=*${R.embed || ''}&order=created_at.desc&limit=500`;
          if (UUID.test(b.client_id || '')) q += `&client_id=eq.${b.client_id}`;
          return send(await rest(q));
        }
        need(R.perm, 2);
        if (b.action === 'rec_del') {
          if (!UUID.test(b.id)) return send({ error: 'bad id' }, 400);
          await rest(`${R.table}?id=eq.${b.id}`, { method: 'DELETE' }); return send({ ok: true });
        }
        if (!R.cols) return send({ error: 'للقراءة فقط' }, 400);
        const row = b.row || {}, o = {};
        for (const [k, fn] of Object.entries(R.cols)) if (k in row) o[k] = fn(row[k]);
        if (b.table === 'invoices' && o.items && o.items.length) o.total = Math.round(o.items.reduce((a, x) => a + x.q * x.p, 0) * 100) / 100;
        if (b.table === 'clients' && !o.name && !row.id) return send({ error: 'الاسم مطلوب' }, 400);
        if (b.table === 'spend' && (!o.cmp || !o.amount)) return send({ error: 'اسم الحملة والمبلغ مطلوبين' }, 400);
        if (b.table !== 'clients' && b.table !== 'spend' && !o.client_id && !row.id) return send({ error: 'اختار العميل' }, 400);
        if (UUID.test(row.id || '')) { await rest(`${R.table}?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify(o) }); return send({ ok: true, id: row.id }); }
        const ins = await rest(R.table, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(o) });
        return send({ ok: true, id: ins[0].id });
      }
      case 'log_list': owner();
        return send(await rest('p2_log?select=*&order=at.desc&limit=200'));
      case 'backup': {
        owner();
        const out = { at: new Date().toISOString(), tables: {} };
        for (const t of ['p2_slots', 'p2_bookings', 'p2_briefs', 'p2_settings', 'p2_clients', 'p2_contracts', 'p2_invoices', 'p2_reports', 'p2_portal_msgs', 'p2_spend', 'p2_leads', 'p2_admins']) out.tables[t] = await rest(`${t}?select=*&limit=10000`);
        return send(out);
      }
      case 'stats': {
        need('stats', 1);
        const days = [1, 7, 30, 90].includes(+b.days) ? +b.days : 7;
        return send(await rest('rpc/p2_stats', { method: 'POST', body: JSON.stringify({ p_days: days }) }));
      }
      case 'booking_delete': need('bookings', 2);
        if (!UUID.test(b.id)) return send({ error: 'bad id' }, 400);
        await rest(`p2_bookings?id=eq.${b.id}`, { method: 'DELETE' }); return send({ ok: true });
      case 'slots_list': need('slots', 1);
        return send(await rest(`p2_slots?select=id,starts_at,duration_min,p2_bookings(id,name)&starts_at=gte.${new Date(Date.now() - 86400000).toISOString()}&order=starts_at.asc&limit=1000`));
      case 'slots_add': {
        need('slots', 2);
        const dur = Math.min(240, Math.max(10, parseInt(b.duration) || 30));
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 500).map(x => new Date(x)).filter(d => !isNaN(d) && d > new Date());
        if (!items.length) return send({ error: 'مفيش مواعيد صالحة' }, 400);
        await rest('p2_slots?on_conflict=starts_at', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(items.map(d => ({ starts_at: d.toISOString(), duration_min: dur }))) });
        return send({ ok: true, count: items.length });
      }
      case 'slot_delete': need('slots', 2);
        if (!UUID.test(b.id)) return send({ error: 'bad id' }, 400);
        await rest(`p2_slots?id=eq.${b.id}`, { method: 'DELETE' }); return send({ ok: true });
      case 'briefs_list': need('briefs', 1);
        return send(await rest(`p2_briefs?select=id,client_name,brand_name,phone,is_read,created_at,stage,follow_up,archived,client_id&archived=eq.${b.arch ? 'true' : 'false'}&order=created_at.desc&limit=500`));
      case 'brief_get': {
        need('briefs', 1);
        if (!UUID.test(b.id)) return send({ error: 'bad id' }, 400);
        const r = await rest(`p2_briefs?id=eq.${b.id}&select=*`);
        if (r[0] && !r[0].is_read && me.perms.briefs >= 2) await rest(`p2_briefs?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ is_read: true }) });
        return send(r[0] || null);
      }
      case 'brief_delete': need('briefs', 2);
        if (!UUID.test(b.id)) return send({ error: 'bad id' }, 400);
        await rest(`p2_briefs?id=eq.${b.id}`, { method: 'DELETE' }); return send({ ok: true });

      // ---- المحتوى ----
      case 'content_get': {
        anyView('texts', 'lists', 'media', 'brief_form');
        const c = await getContent(), o = {};
        if (me.perms.texts >= 1) o.texts = c.texts || {};
        if (me.perms.lists >= 1) LIST_KEYS.forEach(k => { if (Array.isArray(c[k])) o[k] = c[k]; });
        if (me.perms.media >= 1) o.images = c.images || {};
        if (me.perms.brief_form >= 1) o.brief = c.brief || null;
        return send(o);
      }
      case 'content_save': {
        const c = await getContent();
        if (b.part === 'texts') {
          need('texts', 2);
          const t = {};
          for (const [k, v] of Object.entries(b.value || {})) {
            if (!/^[a-z]+\.\d+$/.test(k) || !v || typeof v !== 'object') continue;
            const o = {}; ['en', 'ar', 'v'].forEach(f => { if (typeof v[f] === 'string' && v[f].trim()) o[f] = v[f].slice(0, 3000); });
            if (Object.keys(o).length) t[k] = o;
          }
          c.texts = t;
        } else if (b.part === 'list') {
          need('lists', 2);
          if (!LIST_KEYS.includes(b.key)) return send({ error: 'قائمة غير معروفة' }, 400);
          if (!Array.isArray(b.value)) return send({ error: 'بيانات غلط' }, 400);
          c[b.key] = san(b.value.slice(0, 100), b.key);
          if (b.key === 'landings') c.landings = c.landings.map(x => ({ ...x, slug: String(x.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) })).filter(x => x.slug);
        } else if (b.part === 'images') {
          need('media', 2);
          const im = { ...(c.images || {}) };
          for (const k of IMAGE_KEYS) if (k in (b.value || {})) { const u = String(b.value[k] || ''); im[k] = /^(https:\/\/|http:\/\/localhost[:\/])/i.test(u) ? u.slice(0, 500) : ''; }
          c.images = im;
        } else if (b.part === 'brief') {
          need('brief_form', 2);
          const br = san(b.value, 'brief');
          if (!br || !Array.isArray(br.sections)) return send({ error: 'بيانات غلط' }, 400);
          c.brief = br;
        } else return send({ error: 'unknown part' }, 400);
        await putSetting('content', c);
        return send({ ok: true });
      }
      case 'upload': {
        if (!((me.perms.media || 0) >= 2 || (me.perms.lists || 0) >= 2 || (me.perms.brief_form || 0) >= 2)) need('media', 2);
        const ext = MIME[b.type];
        if (!ext) return send({ error: 'نوع الصورة غير مدعوم (PNG / JPG / WEBP / GIF)' }, 400);
        const buf = Buffer.from(String(b.data || ''), 'base64');
        if (!buf.length || buf.length > 3.2 * 1024 * 1024) return send({ error: 'الصورة كبيرة (الحد الأقصى 3MB)' }, 400);
        const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const r = await fetch(`${U()}/storage/v1/object/p2-media/${path}`, { method: 'POST', headers: { ...SH(), 'Content-Type': b.type, 'x-upsert': 'false' }, body: buf });
        if (!r.ok) return send({ error: 'فشل رفع الصورة. تأكد إن مخزن الصور اتعمل (SQL التحديث)' }, 500);
        return send({ url: `${U()}/storage/v1/object/public/p2-media/${path}` });
      }

      // ---- المظهر والإعدادات ----
      case 'settings_get': anyView('appearance');
        return send(((await rest('p2_settings?key=eq.site&select=value'))[0] || {}).value || {});
      case 'settings_save': {
        need('appearance', 2);
        const cur = ((await rest('p2_settings?key=eq.site&select=value'))[0] || {}).value || {};
        const v = { ...cur };
        for (const k of Object.keys(SETTINGS_KEYS)) if (k in (b.value || {})) v[k] = SETTINGS_KEYS[k](b.value[k]);
        await putSetting('site', v);
        return send({ ok: true, value: v });
      }

      // ---- الإشعارات ----
      case 'telegram_test': {
        const { TELEGRAM_BOT_TOKEN: T, TELEGRAM_CHAT_ID: C } = process.env;
        if (!T || !C) return send({ error: 'TELEGRAM_BOT_TOKEN أو TELEGRAM_CHAT_ID مش متضافين في Vercel' }, 400);
        const r = await fetch(`https://api.telegram.org/bot${T}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: C, text: '✅ الإشعارات شغالة — دي رسالة تجريبية من الداشبورد.' }) });
        return r.ok ? send({ ok: true }) : send({ error: 'تليجرام رفض الرسالة: راجع التوكن والـ Chat ID' }, 400);
      }
      case 'push_key': return send({ key: process.env.VAPID_PUBLIC_KEY || '' });
      case 'push_subscribe': {
        const s = b.sub;
        if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !s.keys) return send({ error: 'اشتراك غير صالح' }, 400);
        await rest('p2_push_subs?on_conflict=endpoint', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ endpoint: s.endpoint, sub: s, email: me.email }) });
        return send({ ok: true });
      }
      case 'push_unsubscribe':
        await rest(`p2_push_subs?endpoint=eq.${encodeURIComponent(String(b.endpoint || ''))}&email=eq.${encodeURIComponent(me.email)}`, { method: 'DELETE' });
        return send({ ok: true });
      case 'push_test': {
        const r = await sendPush({ title: 'إشعار تجريبي ✅', body: 'إشعارات الموبايل شغالة.', url: '/' }, me.email);
        if (r.skipped) return send({ error: 'مفاتيح الإشعارات (VAPID) مش متضافة في Vercel' }, 400);
        return r.sent ? send({ ok: true }) : send({ error: 'مفيش جهاز مشترك. اضغط "تفعيل إشعارات الموبايل" الأول' }, 400);
      }
      case 'vapid_generate': {
        owner();
        let wp; try { wp = require('web-push'); } catch (e) { return send({ error: 'مكتبة web-push مش متنصبة' }, 500); }
        return send(wp.generateVAPIDKeys());
      }

      // ---- المشرفين (للمالك فقط) ----
      case 'admins_list': owner();
        return send(await rest('p2_admins?select=email,perms,created_at&order=created_at.asc'));
      case 'admins_create': {
        owner();
        const email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
        if (!EMAIL.test(email)) return send({ error: 'الإيميل غير صالح' }, 400);
        if (pw.length < 8) return send({ error: 'كلمة السر لازم تكون 8 حروف على الأقل' }, 400);
        if (email === (process.env.OWNER_EMAIL || '').trim().toLowerCase()) return send({ error: 'ده إيميل المالك' }, 400);
        const cr = await authAdminApi('users', 'POST', { email, password: pw, email_confirm: true });
        let uid = null, note = '';
        if (cr.ok) uid = cr.d.id || (cr.d.user && cr.d.user.id) || null;
        else if (cr.status === 422) note = 'الإيميل ده كان موجود في Supabase، اتضاف كمشرف بدون تغيير كلمة سره.';
        else return send({ error: 'فشل إنشاء الحساب في Supabase' }, 500);
        await rest('p2_admins?on_conflict=email', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ email, ...(uid ? { user_id: uid } : {}), perms: cleanPerms(b.perms) }) });
        return send({ ok: true, note });
      }
      case 'admins_update': owner();
        await rest(`p2_admins?email=eq.${encodeURIComponent(String(b.email || '').toLowerCase())}`, { method: 'PATCH', body: JSON.stringify({ perms: cleanPerms(b.perms) }) });
        return send({ ok: true });
      case 'admins_password': {
        owner();
        const pw = String(b.password || ''); if (pw.length < 8) return send({ error: 'كلمة السر لازم تكون 8 حروف على الأقل' }, 400);
        const a = await rest(`p2_admins?email=eq.${encodeURIComponent(String(b.email || '').toLowerCase())}&select=user_id`);
        if (!a[0] || !a[0].user_id) return send({ error: 'مش قادر أغير كلمة سر الحساب ده من هنا (غيّرها من Supabase)' }, 400);
        const r = await authAdminApi('users/' + a[0].user_id, 'PUT', { password: pw });
        return r.ok ? send({ ok: true }) : send({ error: 'فشل تغيير كلمة السر' }, 500);
      }
      case 'admins_delete': {
        owner();
        const email = String(b.email || '').toLowerCase();
        const a = await rest(`p2_admins?email=eq.${encodeURIComponent(email)}&select=user_id`);
        await rest(`p2_admins?email=eq.${encodeURIComponent(email)}`, { method: 'DELETE' });
        if (a[0] && a[0].user_id) await authAdminApi('users/' + a[0].user_id, 'DELETE');
        return send({ ok: true });
      }
      default: return send({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    if (e && e.code === 403) return send({ error: e.message }, 403);
    return send({ error: 'حصلت مشكلة في السيرفر' }, 500);
  }
};
