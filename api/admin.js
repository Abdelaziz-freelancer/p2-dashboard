// API الداشبورد — دالة واحدة بـ action. كل الطلبات (ماعدا login/refresh) لازم تكون بتوكن مسجّل دخول.
const U = () => process.env.SUPABASE_URL;
const SK = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
const AK = () => process.env.SUPABASE_ANON_KEY;
const SH = () => ({ apikey: SK(), Authorization: 'Bearer ' + SK(), 'Content-Type': 'application/json' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rest(path, opt = {}) {
  const r = await fetch(`${U()}/rest/v1/${path}`, { ...opt, headers: { ...SH(), ...(opt.headers || {}) } });
  const txt = await r.text();
  if (!r.ok) throw new Error(txt || r.status);
  return txt ? JSON.parse(txt) : null;
}

async function authUser(token) {
  if (!token) return null;
  const r = await fetch(`${U()}/auth/v1/user`, { headers: { apikey: AK(), Authorization: 'Bearer ' + token } });
  if (!r.ok) return null;
  const u = await r.json();
  const owner = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
  if (!owner || (u.email || '').toLowerCase() !== owner) return null;
  // المرحلة 2: هنا هيتضاف المشرفين وصلاحياتهم. دلوقتي المالك بس.
  return { email: u.email, owner: true };
}

const SETTINGS_KEYS = {
  whatsapp: v => String(v || '').replace(/\D/g, '').slice(0, 20),
  facebook: v => String(v || '').trim().slice(0, 300),
  instagram: v => String(v || '').trim().slice(0, 300),
  marquee_speed: v => Math.min(5, Math.max(0.2, Number(v) || 1)),
  logo_speed: v => Math.min(5, Math.max(0.2, Number(v) || 1)),
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!U() || !SK() || !AK()) return res.status(500).json({ error: 'السيرفر مش متظبط: متغيرات Vercel ناقصة' });
  const b = req.body || {};
  const send = (data, code = 200) => res.status(code).json(data);
  try {
    if (b.action === 'login' || b.action === 'refresh') {
      const body = b.action === 'login' ? { email: String(b.email || '').trim(), password: String(b.password || '') } : { refresh_token: b.refresh_token };
      const r = await fetch(`${U()}/auth/v1/token?grant_type=${b.action === 'login' ? 'password' : 'refresh_token'}`, {
        method: 'POST', headers: { apikey: AK(), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const d = await r.json();
      if (!r.ok) return send({ error: 'الإيميل أو كلمة السر غلط' }, 401);
      const me = await authUser(d.access_token);
      if (!me) return send({ error: 'الحساب ده مش مصرّح له يدخل الداشبورد' }, 403);
      return send({ access_token: d.access_token, refresh_token: d.refresh_token, expires_in: d.expires_in, email: me.email });
    }

    const me = await authUser((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!me) return send({ error: 'unauthorized' }, 401);

    switch (b.action) {
      case 'overview': {
        const now = new Date().toISOString();
        const [up, unread, open] = await Promise.all([
          rest(`p2_bookings?select=id,p2_slots!inner(starts_at)&p2_slots.starts_at=gte.${now}`),
          rest('p2_briefs?select=id&is_read=eq.false'),
          rest(`p2_open_slots?select=id`)
        ]);
        return send({ upcoming: up.length, unread: unread.length, open: open.length });
      }
      case 'bookings_list':
        return send(await rest('p2_bookings?select=id,name,phone,activity,created_at,p2_slots(starts_at,duration_min)&order=created_at.desc&limit=300'));
      case 'booking_delete':
        if (!UUID.test(b.id)) return send({ error: 'bad id' }, 400);
        await rest(`p2_bookings?id=eq.${b.id}`, { method: 'DELETE' });
        return send({ ok: true });
      case 'slots_list':
        return send(await rest(`p2_slots?select=id,starts_at,duration_min,p2_bookings(id,name)&starts_at=gte.${new Date(Date.now() - 86400000).toISOString()}&order=starts_at.asc&limit=1000`));
      case 'slots_add': {
        const dur = Math.min(240, Math.max(10, parseInt(b.duration) || 30));
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 500).map(x => new Date(x)).filter(d => !isNaN(d) && d > new Date());
        if (!items.length) return send({ error: 'مفيش مواعيد صالحة' }, 400);
        await rest('p2_slots?on_conflict=starts_at', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(items.map(d => ({ starts_at: d.toISOString(), duration_min: dur }))) });
        return send({ ok: true, count: items.length });
      }
      case 'slot_delete':
        if (!UUID.test(b.id)) return send({ error: 'bad id' }, 400);
        await rest(`p2_slots?id=eq.${b.id}`, { method: 'DELETE' });
        return send({ ok: true });
      case 'briefs_list':
        return send(await rest('p2_briefs?select=id,client_name,brand_name,phone,is_read,created_at&order=created_at.desc&limit=300'));
      case 'brief_get': {
        if (!UUID.test(b.id)) return send({ error: 'bad id' }, 400);
        const r = await rest(`p2_briefs?id=eq.${b.id}&select=*`);
        if (r[0] && !r[0].is_read) await rest(`p2_briefs?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ is_read: true }) });
        return send(r[0] || null);
      }
      case 'brief_delete':
        if (!UUID.test(b.id)) return send({ error: 'bad id' }, 400);
        await rest(`p2_briefs?id=eq.${b.id}`, { method: 'DELETE' });
        return send({ ok: true });
      case 'settings_get': {
        const r = await rest('p2_settings?key=eq.site&select=value');
        return send((r[0] || {}).value || {});
      }
      case 'settings_save': {
        const cur = ((await rest('p2_settings?key=eq.site&select=value'))[0] || {}).value || {};
        const v = { ...cur };
        for (const k of Object.keys(SETTINGS_KEYS)) if (k in (b.value || {})) v[k] = SETTINGS_KEYS[k](b.value[k]);
        await rest('p2_settings?on_conflict=key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: 'site', value: v }) });
        return send({ ok: true, value: v });
      }
      case 'telegram_test': {
        const { TELEGRAM_BOT_TOKEN: T, TELEGRAM_CHAT_ID: C } = process.env;
        if (!T || !C) return send({ error: 'TELEGRAM_BOT_TOKEN أو TELEGRAM_CHAT_ID مش متضافين في Vercel' }, 400);
        const r = await fetch(`https://api.telegram.org/bot${T}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: C, text: '✅ الإشعارات شغالة — دي رسالة تجريبية من الداشبورد.' }) });
        return r.ok ? send({ ok: true }) : send({ error: 'تليجرام رفض الرسالة: راجع التوكن والـ Chat ID' }, 400);
      }
      default:
        return send({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    return send({ error: 'حصلت مشكلة في السيرفر' }, 500);
  }
};
