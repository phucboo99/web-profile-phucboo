/**
 * Phucboo Agents - máy chủ tải video (Cloudflare Worker, miễn phí)
 * ------------------------------------------------------------------
 *   GET /resolve?url=<link TikTok hoặc Facebook>   -> JSON thông tin video + các link tải
 *   GET /download?src=<link media>&name=<tên file> -> tải file về (đặt sẵn tên file)
 *
 * Biến môi trường (tuỳ chọn, đặt trong Settings > Variables của Worker):
 *   ALLOWED_ORIGINS = https://dinhtanphuc.github.io
 *     -> chỉ website của bạn được gọi /resolve. Bỏ trống = cho phép mọi nơi.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Chỉ cho phép tải từ các máy chủ media này, tránh bị lợi dụng làm proxy tự do
const ALLOWED_MEDIA = [
  /(^|\.)tikwm\.com$/, /(^|\.)tiktokcdn(-[a-z]+)?\.com$/, /(^|\.)tiktokv\.com$/,
  /(^|\.)tiktok\.com$/, /(^|\.)byteoversea\.com$/, /(^|\.)ibyteimg\.com$/,
  /(^|\.)muscdn\.com$/, /(^|\.)fbcdn\.net$/
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
    const anyOrigin = allowed.includes('*');
    const cors = {
      'Access-Control-Allow-Origin': anyOrigin ? '*' : (allowed.includes(origin) ? origin : allowed[0]),
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length',
      'Vary': 'Origin'
    };
    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return json({ ok: false, code: 'METHOD' }, 405);

    const url = new URL(request.url);
    try {
      if (url.pathname === '/resolve') {
        if (!anyOrigin && origin && !allowed.includes(origin)) return json({ ok: false, code: 'FORBIDDEN' }, 403);
        const target = (url.searchParams.get('url') || '').trim();
        const platform = detect(target);
        if (!platform) return json({ ok: false, code: 'UNSUPPORTED' }, 400);
        const data = platform === 'tiktok' ? await tiktok(target) : await facebook(target);
        return json({ ok: true, ...data });
      }

      if (url.pathname === '/download') {
        const src = url.searchParams.get('src') || '';
        let host;
        try { host = new URL(src).hostname; } catch { return json({ ok: false, code: 'BAD_SRC' }, 400); }
        if (!ALLOWED_MEDIA.some(re => re.test(host))) return json({ ok: false, code: 'BAD_SRC' }, 403);
        const name = safeName(url.searchParams.get('name') || 'video.mp4');
        const up = await fetch(src, {
          redirect: 'follow',
          headers: {
            'User-Agent': UA,
            'Referer': host.includes('fbcdn') ? 'https://www.facebook.com/' : 'https://www.tiktok.com/'
          }
        });
        if (!up.ok) return json({ ok: false, code: 'EXPIRED', status: up.status }, 502);
        const h = new Headers(cors);
        h.set('Content-Type', up.headers.get('Content-Type') || 'application/octet-stream');
        const len = up.headers.get('Content-Length');
        if (len) h.set('Content-Length', len);
        const ascii = name.replace(/[^\x20-\x7E]/g, '_');
        h.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
        h.set('Cache-Control', 'no-store');
        return new Response(up.body, { status: 200, headers: h });
      }

      return json({ ok: true, service: 'phucboo-video', endpoints: ['/resolve?url=', '/download?src=&name='] });
    } catch (e) {
      return json({ ok: false, code: e.code || 'FAILED', message: String(e.message || e) }, 502);
    }
  }
};

function detect(u) {
  let h;
  try { h = new URL(u).hostname.toLowerCase(); } catch { return null; }
  if (/(^|\.)(tiktok\.com|douyin\.com)$/.test(h)) return 'tiktok';
  if (/(^|\.)(facebook\.com|fb\.watch|fb\.com)$/.test(h)) return 'facebook';
  return null;
}

function fail(code, message) { return Object.assign(new Error(message || code), { code }); }

/* ---------------- TikTok (qua TikWM, trả về bản gốc không logo) ---------------- */
async function tiktok(link) {
  const res = await fetch('https://www.tikwm.com/api/', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ url: link, hd: '1' })
  });
  let j;
  try { j = await res.json(); } catch { throw fail('TIKTOK_FAIL'); }
  if (j.code !== 0 || !j.data) {
    throw fail(/limit/i.test(j.msg || '') ? 'RATE_LIMIT' : 'TIKTOK_FAIL', j.msg);
  }
  const d = j.data;
  const abs = p => !p ? null : (/^https?:/.test(p) ? p : 'https://www.tikwm.com' + p);
  const items = [];
  if (Array.isArray(d.images) && d.images.length) {
    d.images.forEach((im, i) => items.push({ kind: 'image', index: i + 1, url: abs(im), ext: 'jpg' }));
  } else {
    if (d.hdplay) items.push({ kind: 'video_hd', url: abs(d.hdplay), size: d.hd_size || null, ext: 'mp4' });
    if (d.play && d.play !== d.hdplay) items.push({ kind: 'video', url: abs(d.play), size: d.size || null, ext: 'mp4' });
    if (d.wmplay) items.push({ kind: 'video_wm', url: abs(d.wmplay), size: d.wm_size || null, ext: 'mp4' });
  }
  if (d.music) items.push({ kind: 'audio', url: abs(d.music), ext: 'mp3' });
  if (!items.length) throw fail('TIKTOK_FAIL');
  return {
    platform: 'tiktok',
    id: String(d.id || ''),
    title: d.title || '',
    author: (d.author && (d.author.nickname || d.author.unique_id)) || '',
    cover: abs(d.origin_cover || d.cover),
    duration: d.duration || null,
    items
  };
}

/* ---------------- Facebook (chỉ video công khai) ---------------- */
async function facebook(link) {
  const res = await fetch(link, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none'
    }
  });
  const html = await res.text();
  const pick = (...patterns) => {
    for (const re of patterns) { const m = html.match(re); if (m) return unescapeJson(m[1]); }
    return null;
  };
  const hd = pick(/"browser_native_hd_url":"([^"]+)"/, /"playable_url_quality_hd":"([^"]+)"/, /hd_src(?:_no_ratelimit)?:"([^"]+)"/);
  const sd = pick(/"browser_native_sd_url":"([^"]+)"/, /"playable_url":"([^"]+)"/, /sd_src(?:_no_ratelimit)?:"([^"]+)"/);
  if (!hd && !sd) throw fail('FB_NOT_FOUND');
  const meta = prop => {
    const m = html.match(new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]*)"`, 'i'));
    return m ? decodeEntities(m[1]) : '';
  };
  const items = [];
  if (hd) items.push({ kind: 'video_hd', url: hd, ext: 'mp4' });
  if (sd && sd !== hd) items.push({ kind: 'video', url: sd, ext: 'mp4' });
  const idMatch = link.match(/(?:videos\/|v=|reel\/|watch\/\?v=)(\d+)/);
  return {
    platform: 'facebook',
    id: idMatch ? idMatch[1] : '',
    title: meta('og:title'),
    author: '',
    cover: meta('og:image') || null,
    duration: null,
    items
  };
}

function unescapeJson(s) {
  try { return JSON.parse('"' + s + '"'); } catch { return s.replace(/\\\//g, '/'); }
}
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function safeName(n) {
  return n.replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 120) || 'video.mp4';
}
