/*
 * Media & AI Unlock Check v3 — Surge Panel
 * 13 services · concurrent · 5s timeout
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, 'Accept-Language': 'en' };
const T = 25000;

// ─── HTTP helpers ───────────────────────────────
const get = (o) => {
  if (typeof o === 'string') o = { url: o };
  o.headers = o.headers || H;
  return Promise.race([
    new Promise((ok, no) => $httpClient.get(o, (e, r, b) => e ? no(e) : ok({ s: r.status, h: r.headers, b }))),
    new Promise((_, no) => setTimeout(() => no('T'), T)),
  ]);
};
const post = (o) => {
  o.headers = o.headers || H;
  return Promise.race([
    new Promise((ok, no) => $httpClient.post(o, (e, r, b) => e ? no(e) : ok({ s: r.status, h: r.headers, b }))),
    new Promise((_, no) => setTimeout(() => no('T'), T)),
  ]);
};
const J = s => { try { return JSON.parse(s) } catch { return null } };

// ─── Checkers ───────────────────────────────────

async function Netflix() {
  try {
    const { s, h } = await get({ url: 'https://www.netflix.com/title/81280792', headers: H });
    if (s === 403) {
      const r2 = await get({ url: 'https://www.netflix.com/title/80018499', headers: H });
      return r2.s === 200 ? [1, nfReg(r2.h['x-originating-url']) + '⁻'] : [0];
    }
    return s >= 200 && s <= 302 ? [1, nfReg(h['x-originating-url'])] : [0];
  } catch (e) { return e === 'T' ? [-1] : [0]; }
}
function nfReg(u) {
  if (!u) return 'US';
  let r = (u.split('/')[3] || 'US').split('-')[0];
  return r === 'title' ? 'US' : r.toUpperCase();
}

async function YouTube() {
  try {
    const { s, b } = await get({ url: 'https://www.youtube.com/premium', headers: H });
    if (s !== 200 || b.includes('not available in your country')) return [0];
    const m = b.match(/"countryCode":"(\w{2})"/);
    return [1, m ? m[1] : 'US'];
  } catch (e) { return e === 'T' ? [-1] : [0]; }
}

async function Disney() {
  try {
    const { s, b } = await get({ url: 'https://www.disneyplus.com/', headers: H });
    if (s !== 200 || b.includes('not available')) return [0];
    const g = await post({
      url: 'https://disney.api.edge.bamgrid.com/graph/v1/device/graphql',
      headers: { ...H, Authorization: 'ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'mutation registerDevice($input:RegisterDeviceInput!){registerDevice(registerDevice:$input){grant{grantType assertion}}}', variables: { input: { applicationRuntime: 'chrome', attributes: { browserName: 'chrome', browserVersion: '125.0.0', manufacturer: 'apple', model: null, operatingSystem: 'macintosh', operatingSystemVersion: '10.15.7', osDeviceIds: [] }, deviceFamily: 'browser', deviceLanguage: 'en', deviceProfile: 'macosx' } } }),
    });
    const j = J(g.b);
    const cc = j?.extensions?.sdk?.session?.location?.countryCode;
    return cc ? [1, cc.toUpperCase()] : [1];
  } catch (e) { return e === 'T' ? [-1] : [0]; }
}

async function Spotify() {
  try {
    const { b } = await get('https://spclient.wg.spotify.com/signup/public/v1/account');
    const j = J(b);
    return j?.country ? [1, j.country.toUpperCase()] : [0];
  } catch (e) { return e === 'T' ? [-1] : [0]; }
}

async function ChatGPT() {
  try {
    const t = await get({ url: 'https://chat.openai.com/cdn-cgi/trace', headers: { 'User-Agent': UA } });
    const loc = (t.b.match(/loc=(\w+)/) || [])[1] || '';
    const { s } = await get({ url: 'https://ios.chat.openai.com/public-api/mobile/server_status/v1', headers: { 'User-Agent': UA } });
    return s === 200 ? [1, loc] : [0];
  } catch (e) { return e === 'T' ? [-1] : [0]; }
}

async function Claude() {
  try {
    const { s } = await get({ url: 'https://claude.ai/api/auth/session', headers: { 'User-Agent': UA, Accept: 'application/json' } });
    return s >= 200 && s < 404 ? [1] : [0];
  } catch (e) { return e === 'T' ? [-1] : [0]; }
}

async function Gemini() {
  try {
    const { s, b } = await get({ url: 'https://gemini.google.com/', headers: H });
    if (s === 403 || s === 451) return [0];
    if (s === 200 && (b.includes('not available') || b.includes('not supported'))) return [0];
    return (s >= 200 && s <= 302) ? [1] : [0];
  } catch (e) { return e === 'T' ? [-1] : [0]; }
}

async function TikTok() {
  try {
    const { s, b } = await get({ url: 'https://www.tiktok.com/', headers: H });
    if (s !== 200) return [0];
    const m = b.match(/"region":"(\w{2})"/) || b.match(/region=(\w{2})/);
    return m ? [1, m[1].toUpperCase()] : [1];
  } catch (e) { return e === 'T' ? [-1] : [0]; }
}

async function Bilibili() {
  try {
    const { b } = await get({ url: 'https://api.bilibili.com/pgc/player/web/playurl?avid=18281381&cid=29892777&qn=0&type=&otype=json&ep_id=364558&fourk=1&fnval=16', headers: { ...H, Referer: 'https://www.bilibili.com/' } });
    return J(b)?.code === 0 ? [1, '台'] : [0];
  } catch (e) { return e === 'T' ? [-1] : [0]; }
}

async function HBO() {
  try {
    const { s, b } = await get({ url: 'https://www.max.com/', headers: H });
    return (s === 200 && !b.includes('not available')) ? [1] : [0];
  } catch (e) { return e === 'T' ? [-1] : [0]; }
}

async function Prime() {
  try {
    const { s, b } = await get({ url: 'https://www.primevideo.com/', headers: H });
    if (s !== 200) return [0];
    const m = b.match(/"currentTerritory":"(\w{2})"/) || b.match(/"marketplace":"(\w{2})"/);
    return m ? [1, m[1].toUpperCase()] : [1];
  } catch (e) { return e === 'T' ? [-1] : [0]; }
}

async function DAZN() {
  try {
    const { s } = await get({ url: 'https://startup.core.indazn.com/misl/v5/Ede', headers: { 'User-Agent': UA, 'Content-Type': 'application/json' } });
    return s === 200 ? [1] : [0];
  } catch (e) { return e === 'T' ? [-1] : [0]; }
}

async function TVB() {
  try {
    const { s, b } = await get({ url: 'https://www.mytvsuper.com/iptest.php', headers: H });
    if (s !== 200) return [0];
    const j = J(b);
    return (j?.country === 'HK' || j?.region === 'HK' || b.includes('HK')) ? [1] : [0];
  } catch (e) { return e === 'T' ? [-1] : [0]; }
}

// ─── Render ─────────────────────────────────────

const fmt = (name, r) => {
  if (r[0] === -1) return `${name} ⚠️`;
  if (r[0] === 0)  return `${name} ✗`;
  return r[1] ? `${name} ✓ ${r[1]}` : `${name} ✓`;
};

;(async () => {
  const t0 = Date.now();
  const panel = { title: '解锁检测', icon: 'play.tv.fill', 'icon-color': '#EF476F', content: '' };

  try {
    const [nf, yt, dp, sp, gpt, cl, gm, tt, bl, hbo, pm, dz, tvb] = await Promise.all([
      Netflix(), YouTube(), Disney(), Spotify(),
      ChatGPT(), Claude(), Gemini(), TikTok(),
      Bilibili(), HBO(), Prime(), DAZN(), TVB(),
    ]);

    const all = [nf, yt, dp, sp, gpt, cl, gm, tt, bl, hbo, pm, dz, tvb];
    const ok = all.filter(r => r[0] === 1).length;
    const ratio = ok / all.length;
    panel['icon-color'] = ratio >= 0.8 ? '#06D6A0' : ratio >= 0.5 ? '#FFD166' : '#EF476F';

    const sec = ((Date.now() - t0) / 1000).toFixed(1);

    panel.content = [
      `${fmt('NF', nf)} · ${fmt('YT', yt)} · ${fmt('D+', dp)} · ${fmt('SP', sp)}`,
      `${fmt('HBO', hbo)} · ${fmt('Prime', pm)} · ${fmt('DAZN', dz)} · ${fmt('TVB', tvb)}`,
      `${fmt('GPT', gpt)} · ${fmt('Claude', cl)} · ${fmt('Gemini', gm)}`,
      `${fmt('TikTok', tt)} · ${fmt('Bili', bl)} ── ${ok}/${all.length} · ${sec}s`,
    ].join('\n');
  } catch (e) {
    panel.content = '✗ ' + (e.message || e);
  }

  $done(panel);
})();
