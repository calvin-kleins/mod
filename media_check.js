/*
 * Media & AI Unlock Check v3 — Surge Panel
 * 13 services · concurrent · 5s timeout
 */

const PREFIX = '[MediaCheck]';
const log = (...args) => console.log(PREFIX, ...args);

log(`🚀 脚本启动 | ${new Date().toISOString()}`);
const SCRIPT_START = Date.now();

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, 'Accept-Language': 'en' };
const T = 25000;

// ─── HTTP helpers ───────────────────────────────
const get = (o) => {
  if (typeof o === 'string') o = { url: o };
  o.headers = o.headers || H;
  const reqUrl = o.url;
  log(`→ GET ${reqUrl}`);
  return Promise.race([
    new Promise((ok, no) => $httpClient.get(o, (e, r, b) => {
      if (e) {
        log(`✗ GET 失败 | URL: ${reqUrl} | 错误: ${typeof e === 'object' ? JSON.stringify(e) : e}`);
        return no(e);
      }
      log(`← GET ${r.status} | ${reqUrl}`);
      ok({ s: r.status, h: r.headers, b });
    })),
    new Promise((_, no) => setTimeout(() => { log(`⏱ GET 超时 | ${reqUrl}`); no('T'); }, T)),
  ]);
};
const post = (o) => {
  o.headers = o.headers || H;
  const reqUrl = o.url;
  log(`→ POST ${reqUrl}`);
  return Promise.race([
    new Promise((ok, no) => $httpClient.post(o, (e, r, b) => {
      if (e) {
        log(`✗ POST 失败 | URL: ${reqUrl} | 错误: ${typeof e === 'object' ? JSON.stringify(e) : e}`);
        return no(e);
      }
      log(`← POST ${r.status} | ${reqUrl}`);
      ok({ s: r.status, h: r.headers, b });
    })),
    new Promise((_, no) => setTimeout(() => { log(`⏱ POST 超时 | ${reqUrl}`); no('T'); }, T)),
  ]);
};
const J = s => { try { return JSON.parse(s) } catch { return null } };

// ─── Checkers ───────────────────────────────────

async function Netflix() {
  const t = Date.now();
  log('▶ Netflix 开始检测');
  try {
    const { s, h } = await get({ url: 'https://www.netflix.com/title/81280792', headers: H });
    if (s === 403) {
      const r2 = await get({ url: 'https://www.netflix.com/title/80018499', headers: H });
      const res = r2.s === 200 ? [1, nfReg(r2.h['x-originating-url']) + '⁻'] : [0];
      log(`■ Netflix 完成 | ${res[0]===1?'成功':'失败'} | ${Date.now()-t}ms`);
      return res;
    }
    const res = s >= 200 && s <= 302 ? [1, nfReg(h['x-originating-url'])] : [0];
    log(`■ Netflix 完成 | ${res[0]===1?'成功':'失败'} | ${Date.now()-t}ms`);
    return res;
  } catch (e) {
    log(`■ Netflix 完成 | ${e==='T'?'超时':'错误: '+e} | ${Date.now()-t}ms`);
    return e === 'T' ? [-1] : [0];
  }
}
function nfReg(u) {
  if (!u) return 'US';
  let r = (u.split('/')[3] || 'US').split('-')[0];
  return r === 'title' ? 'US' : r.toUpperCase();
}

async function YouTube() {
  const t = Date.now();
  log('▶ YouTube 开始检测');
  try {
    const { s, b } = await get({ url: 'https://www.youtube.com/premium', headers: H });
    if (s !== 200 || b.includes('not available in your country')) {
      log(`■ YouTube 完成 | 失败 | ${Date.now()-t}ms`);
      return [0];
    }
    const m = b.match(/"countryCode":"(\w{2})"/);
    const res = [1, m ? m[1] : 'US'];
    log(`■ YouTube 完成 | 成功 ${res[1]} | ${Date.now()-t}ms`);
    return res;
  } catch (e) {
    log(`■ YouTube 完成 | ${e==='T'?'超时':'错误: '+e} | ${Date.now()-t}ms`);
    return e === 'T' ? [-1] : [0];
  }
}

async function Disney() {
  const t = Date.now();
  log('▶ Disney 开始检测');
  try {
    const { s, b } = await get({ url: 'https://www.disneyplus.com/', headers: H });
    if (s !== 200 || b.includes('not available')) {
      log(`■ Disney 完成 | 失败 | ${Date.now()-t}ms`);
      return [0];
    }
    const g = await post({
      url: 'https://disney.api.edge.bamgrid.com/graph/v1/device/graphql',
      headers: { ...H, Authorization: 'ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'mutation registerDevice($input:RegisterDeviceInput!){registerDevice(registerDevice:$input){grant{grantType assertion}}}', variables: { input: { applicationRuntime: 'chrome', attributes: { browserName: 'chrome', browserVersion: '125.0.0', manufacturer: 'apple', model: null, operatingSystem: 'macintosh', operatingSystemVersion: '10.15.7', osDeviceIds: [] }, deviceFamily: 'browser', deviceLanguage: 'en', deviceProfile: 'macosx' } } }),
    });
    const j = J(g.b);
    const cc = j?.extensions?.sdk?.session?.location?.countryCode;
    const res = cc ? [1, cc.toUpperCase()] : [1];
    log(`■ Disney 完成 | 成功 ${cc||''} | ${Date.now()-t}ms`);
    return res;
  } catch (e) {
    log(`■ Disney 完成 | ${e==='T'?'超时':'错误: '+e} | ${Date.now()-t}ms`);
    return e === 'T' ? [-1] : [0];
  }
}

async function Spotify() {
  const t = Date.now();
  log('▶ Spotify 开始检测');
  try {
    const { b } = await get('https://spclient.wg.spotify.com/signup/public/v1/account');
    const j = J(b);
    const res = j?.country ? [1, j.country.toUpperCase()] : [0];
    log(`■ Spotify 完成 | ${res[0]===1?'成功 '+res[1]:'失败'} | ${Date.now()-t}ms`);
    return res;
  } catch (e) {
    log(`■ Spotify 完成 | ${e==='T'?'超时':'错误: '+e} | ${Date.now()-t}ms`);
    return e === 'T' ? [-1] : [0];
  }
}

async function ChatGPT() {
  const t = Date.now();
  log('▶ ChatGPT 开始检测');
  try {
    const tr = await get({ url: 'https://chat.openai.com/cdn-cgi/trace', headers: { 'User-Agent': UA } });
    const loc = (tr.b.match(/loc=(\w+)/) || [])[1] || '';
    const { s } = await get({ url: 'https://ios.chat.openai.com/public-api/mobile/server_status/v1', headers: { 'User-Agent': UA } });
    const res = s === 200 ? [1, loc] : [0];
    log(`■ ChatGPT 完成 | ${res[0]===1?'成功 '+loc:'失败'} | ${Date.now()-t}ms`);
    return res;
  } catch (e) {
    log(`■ ChatGPT 完成 | ${e==='T'?'超时':'错误: '+e} | ${Date.now()-t}ms`);
    return e === 'T' ? [-1] : [0];
  }
}

async function Claude() {
  const t = Date.now();
  log('▶ Claude 开始检测');
  try {
    const { s } = await get({ url: 'https://claude.ai/api/auth/session', headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const res = s >= 200 && s < 404 ? [1] : [0];
    log(`■ Claude 完成 | ${res[0]===1?'成功':'失败'} status=${s} | ${Date.now()-t}ms`);
    return res;
  } catch (e) {
    log(`■ Claude 完成 | ${e==='T'?'超时':'错误: '+e} | ${Date.now()-t}ms`);
    return e === 'T' ? [-1] : [0];
  }
}

async function Gemini() {
  const t = Date.now();
  log('▶ Gemini 开始检测');
  try {
    const { s, b } = await get({ url: 'https://gemini.google.com/', headers: H });
    let res;
    if (s === 403 || s === 451) res = [0];
    else if (s === 200 && (b.includes('not available') || b.includes('not supported'))) res = [0];
    else res = (s >= 200 && s <= 302) ? [1] : [0];
    log(`■ Gemini 完成 | ${res[0]===1?'成功':'失败'} status=${s} | ${Date.now()-t}ms`);
    return res;
  } catch (e) {
    log(`■ Gemini 完成 | ${e==='T'?'超时':'错误: '+e} | ${Date.now()-t}ms`);
    return e === 'T' ? [-1] : [0];
  }
}

async function TikTok() {
  const t = Date.now();
  log('▶ TikTok 开始检测');
  try {
    const { s, b } = await get({ url: 'https://www.tiktok.com/', headers: H });
    if (s !== 200) {
      log(`■ TikTok 完成 | 失败 status=${s} | ${Date.now()-t}ms`);
      return [0];
    }
    const m = b.match(/"region":"(\w{2})"/) || b.match(/region=(\w{2})/);
    const res = m ? [1, m[1].toUpperCase()] : [1];
    log(`■ TikTok 完成 | 成功 ${res[1]||''} | ${Date.now()-t}ms`);
    return res;
  } catch (e) {
    log(`■ TikTok 完成 | ${e==='T'?'超时':'错误: '+e} | ${Date.now()-t}ms`);
    return e === 'T' ? [-1] : [0];
  }
}

async function Bilibili() {
  const t = Date.now();
  log('▶ Bilibili 开始检测');
  try {
    const { b } = await get({ url: 'https://api.bilibili.com/pgc/player/web/playurl?avid=18281381&cid=29892777&qn=0&type=&otype=json&ep_id=364558&fourk=1&fnval=16', headers: { ...H, Referer: 'https://www.bilibili.com/' } });
    const res = J(b)?.code === 0 ? [1, '台'] : [0];
    log(`■ Bilibili 完成 | ${res[0]===1?'成功':'失败'} | ${Date.now()-t}ms`);
    return res;
  } catch (e) {
    log(`■ Bilibili 完成 | ${e==='T'?'超时':'错误: '+e} | ${Date.now()-t}ms`);
    return e === 'T' ? [-1] : [0];
  }
}

async function HBO() {
  const t = Date.now();
  log('▶ HBO 开始检测');
  try {
    const { s, b } = await get({ url: 'https://www.max.com/', headers: H });
    const res = (s === 200 && !b.includes('not available')) ? [1] : [0];
    log(`■ HBO 完成 | ${res[0]===1?'成功':'失败'} status=${s} | ${Date.now()-t}ms`);
    return res;
  } catch (e) {
    log(`■ HBO 完成 | ${e==='T'?'超时':'错误: '+e} | ${Date.now()-t}ms`);
    return e === 'T' ? [-1] : [0];
  }
}

async function Prime() {
  const t = Date.now();
  log('▶ Prime 开始检测');
  try {
    const { s, b } = await get({ url: 'https://www.primevideo.com/', headers: H });
    if (s !== 200) {
      log(`■ Prime 完成 | 失败 status=${s} | ${Date.now()-t}ms`);
      return [0];
    }
    const m = b.match(/"currentTerritory":"(\w{2})"/) || b.match(/"marketplace":"(\w{2})"/);
    const res = m ? [1, m[1].toUpperCase()] : [1];
    log(`■ Prime 完成 | 成功 ${res[1]||''} | ${Date.now()-t}ms`);
    return res;
  } catch (e) {
    log(`■ Prime 完成 | ${e==='T'?'超时':'错误: '+e} | ${Date.now()-t}ms`);
    return e === 'T' ? [-1] : [0];
  }
}

async function DAZN() {
  const t = Date.now();
  log('▶ DAZN 开始检测');
  try {
    const { s } = await get({ url: 'https://startup.core.indazn.com/misl/v5/Ede', headers: { 'User-Agent': UA, 'Content-Type': 'application/json' } });
    const res = s === 200 ? [1] : [0];
    log(`■ DAZN 完成 | ${res[0]===1?'成功':'失败'} status=${s} | ${Date.now()-t}ms`);
    return res;
  } catch (e) {
    log(`■ DAZN 完成 | ${e==='T'?'超时':'错误: '+e} | ${Date.now()-t}ms`);
    return e === 'T' ? [-1] : [0];
  }
}

async function TVB() {
  const t = Date.now();
  log('▶ TVB 开始检测');
  try {
    const { s, b } = await get({ url: 'https://www.mytvsuper.com/iptest.php', headers: H });
    if (s !== 200) {
      log(`■ TVB 完成 | 失败 status=${s} | ${Date.now()-t}ms`);
      return [0];
    }
    const j = J(b);
    const res = (j?.country === 'HK' || j?.region === 'HK' || b.includes('HK')) ? [1] : [0];
    log(`■ TVB 完成 | ${res[0]===1?'成功':'失败'} | ${Date.now()-t}ms`);
    return res;
  } catch (e) {
    log(`■ TVB 完成 | ${e==='T'?'超时':'错误: '+e} | ${Date.now()-t}ms`);
    return e === 'T' ? [-1] : [0];
  }
}

// ─── Render ─────────────────────────────────────

const fmt = (name, r) => {
  if (r[0] === -1) return `${name} \u26a0\ufe0f`;
  if (r[0] === 0)  return `${name} \u2717`;
  return r[1] ? `${name} \u2713${r[1]}` : `${name} \u2713`;
};

;(async () => {
  const t0 = Date.now();
  const panel = { title: '解锁检测', icon: 'play.tv.fill', 'icon-color': '#EF476F', content: '' };

  log('━━━ 开始并发检测 13 个服务 ━━━');

  try {
    const [nf, yt, dp, sp, gpt, cl, gm, tt, bl, hbo, pm, dz, tvb] = await Promise.all([
      Netflix(), YouTube(), Disney(), Spotify(),
      ChatGPT(), Claude(), Gemini(), TikTok(),
      Bilibili(), HBO(), Prime(), DAZN(), TVB(),
    ]);

    const all = [nf, yt, dp, sp, gpt, cl, gm, tt, bl, hbo, pm, dz, tvb];
    const names = ['Netflix','YouTube','Disney','Spotify','ChatGPT','Claude','Gemini','TikTok','Bilibili','HBO','Prime','DAZN','TVB'];
    const ok = all.filter(r => r[0] === 1).length;
    const timeout = all.filter(r => r[0] === -1).length;
    const fail = all.filter(r => r[0] === 0).length;
    const ratio = ok / all.length;
    panel['icon-color'] = ratio >= 0.8 ? '#06D6A0' : ratio >= 0.5 ? '#FFD166' : '#EF476F';

    const sec = ((Date.now() - t0) / 1000).toFixed(1);

    log('━━━ 检测结果汇总 ━━━');
    log(`总耗时: ${sec}s | 成功: ${ok} | 失败: ${fail} | 超时: ${timeout}`);
    all.forEach((r, i) => {
      const status = r[0]===1 ? '✓' : r[0]===-1 ? '⏱' : '✗';
      log(`  ${names[i]}: ${status}${r[1] ? ' ('+r[1]+')' : ''}`);
    });
    log(`脚本总运行时间: ${Date.now() - SCRIPT_START}ms`);

    panel.content = [
      `${fmt('NF', nf)} \u00b7 ${fmt('YT', yt)} \u00b7 ${fmt('D+', dp)} \u00b7 ${fmt('SP', sp)}`,
      `${fmt('HBO', hbo)} \u00b7 ${fmt('Prime', pm)} \u00b7 ${fmt('DAZN', dz)}`,
      `${fmt('GPT', gpt)} \u00b7 ${fmt('Claude', cl)} \u00b7 ${fmt('Gemini', gm)}`,
      `${fmt('TikTok', tt)} \u00b7 ${fmt('Bili', bl)} \u00b7 ${fmt('TVB', tvb)} \u2502 ${ok}/${all.length} ${sec}s`,
    ].join('\n');
  } catch (e) {
    log(`✗ 主流程异常: ${e.message || e}`);
    panel.content = '✗ ' + (e.message || e);
  }

  log('🏁 脚本结束，调用 $done()');
  $done(panel);
})();
