// Fonction serverless Vercel : envoie un événement à l'API Conversions de Meta.
// Appelée par le navigateur (fire-and-forget) avec le même event_id que fbq() -> déduplication.
//
// Variables d'environnement (Vercel > Settings > Environment Variables) :
//   META_CAPI_TOKEN        (obligatoire) token d'accès de l'API Conversions — jamais dans le code ni dans les logs
//   META_TEST_EVENT_CODE   (optionnel)   ex. TEST12345 : les événements apparaissent dans « Tester les événements »
//   META_PIXEL_ID          (optionnel)   par défaut 1870821831034824
//   META_GRAPH_VERSION     (optionnel)   par défaut v26.0

const crypto = require('crypto');

const PIXEL_ID = process.env.META_PIXEL_ID || '1870821831034824';
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
const ALLOWED_EVENTS = new Set(['Schedule', 'Lead']);

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

const normEmail = (v) => {
  const e = String(v || '').trim().toLowerCase().replace(/\s+/g, '');
  return /^[^@]+@[^@]+\.[^@]+$/.test(e) ? e : '';
};

// Téléphone au format international sans « + » ni espaces (France par défaut : 06… -> 336…)
const normPhone = (v) => {
  let p = String(v || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  else if (p.startsWith('00')) p = p.slice(2);
  else if (/^0\d{9}$/.test(p)) p = '33' + p.slice(1);
  p = p.replace(/\D/g, '');
  return p.length >= 8 ? p : '';
};

const normName = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');

const parseCookies = (header) => Object.fromEntries(
  String(header || '').split(';').map((c) => c.trim().split('=')).filter((kv) => kv[0])
    .map(([k, ...rest]) => [k, decodeURIComponent(rest.join('='))])
);

const clientIp = (req) => {
  const xff = req.headers['x-forwarded-for'];
  const ip = (xff ? String(xff).split(',')[0] : '') || req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
  return String(ip).trim();
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const token = process.env.META_CAPI_TOKEN;
  if (!token) return res.status(503).json({ ok: false, error: 'capi_not_configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const eventName = String(body.event_name || '');
  const eventId = String(body.event_id || '').slice(0, 100);
  if (!ALLOWED_EVENTS.has(eventName) || !eventId) {
    return res.status(400).json({ ok: false, error: 'invalid_event' });
  }

  const cookies = parseCookies(req.headers.cookie);
  const user_data = {
    client_ip_address: clientIp(req) || undefined,
    client_user_agent: req.headers['user-agent'] || undefined,
    fbp: body.fbp || cookies._fbp || undefined,
    fbc: body.fbc || cookies._fbc || undefined,
  };

  const em = normEmail(body.email);
  if (em) user_data.em = [sha256(em)];
  const ph = normPhone(body.phone);
  if (ph) user_data.ph = [sha256(ph)];

  let fn = normName(body.first_name);
  let ln = normName(body.last_name);
  if (!fn && !ln && body.full_name) {
    const parts = normName(body.full_name).split(' ');
    fn = parts.shift() || '';
    ln = parts.join(' ');
  }
  if (fn) user_data.fn = [sha256(fn)];
  if (ln) user_data.ln = [sha256(ln)];
  if (body.external_id) user_data.external_id = [sha256(String(body.external_id))];

  Object.keys(user_data).forEach((k) => user_data[k] === undefined && delete user_data[k]);

  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      event_source_url: String(body.event_source_url || req.headers.referer || '').slice(0, 1000) || undefined,
      action_source: 'website',
      user_data,
    }],
  };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl.signal }
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Log sans token ni données personnelles : uniquement le message d'erreur Meta
      console.error('CAPI error', r.status, data?.error?.message || '', data?.error?.fbtrace_id || '');
      return res.status(502).json({ ok: false, error: 'meta_error' });
    }
    return res.status(200).json({ ok: true, events_received: data.events_received ?? null, test: Boolean(payload.test_event_code) });
  } catch (e) {
    console.error('CAPI request failed', e.name === 'AbortError' ? 'timeout' : e.name); // jamais e.message (pourrait contenir l'URL avec le token)
    return res.status(502).json({ ok: false, error: 'request_failed' });
  } finally {
    clearTimeout(timer);
  }
};
