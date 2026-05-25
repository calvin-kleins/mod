/**
 * 流媒体 & AI 服务解锁检测脚本 v2.0
 * 适用于 Surge Panel，点击即可检测当前节点解锁状态
 *
 * 检测服务（13项）：
 *   Netflix, YouTube Premium, Disney+, Spotify,
 *   ChatGPT, Claude, Gemini, TikTok,
 *   Bilibili港澳台, HBO Max, Prime Video, DAZN, TVB
 *
 * 输出格式：Emoji + 服务名 + 状态，每行两项用 | 分隔
 * icon-color 根据整体解锁率动态变化
 */

// ==================== 配置 ====================

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en',
};

// 单个请求超时（毫秒）
const TIMEOUT = 5000;

// ==================== 工具函数 ====================

/**
 * 创建超时 Promise
 */
function timeoutPromise(ms = TIMEOUT) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('TIMEOUT')), ms);
  });
}

/**
 * 带超时的 HTTP GET
 */
function httpGet(opts) {
  if (typeof opts === 'string') opts = { url: opts };
  if (!opts.headers) opts.headers = HEADERS;
  return Promise.race([
    new Promise((resolve, reject) => {
      $httpClient.get(opts, (err, resp, body) => {
        if (err) return reject(err);
        resolve({ status: resp.status, headers: resp.headers, body });
      });
    }),
    timeoutPromise(),
  ]);
}

/**
 * 带超时的 HTTP POST
 */
function httpPost(opts) {
  if (!opts.headers) opts.headers = HEADERS;
  return Promise.race([
    new Promise((resolve, reject) => {
      $httpClient.post(opts, (err, resp, body) => {
        if (err) return reject(err);
        resolve({ status: resp.status, headers: resp.headers, body });
      });
    }),
    timeoutPromise(),
  ]);
}

/**
 * 安全 JSON 解析
 */
function safeJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

/**
 * 统一结果格式 { ok: boolean, region: string }
 */
function ok(region) { return { ok: true, region: region || '' }; }
function fail() { return { ok: false, region: '' }; }
function warn() { return { ok: false, region: '⚠️' }; }

// ==================== 检测函数 ====================

/**
 * 1. Netflix
 * 检测非自制剧，从 x-originating-url 提取地区
 */
async function checkNetflix() {
  try {
    const { status, headers } = await httpGet({
      url: 'https://www.netflix.com/title/81280792',
      headers: HEADERS,
    });

    if (status === 403) {
      // 降级检测自制剧
      const r2 = await httpGet({
        url: 'https://www.netflix.com/title/80018499',
        headers: HEADERS,
      });
      if (r2.status === 200) {
        const region = extractNFRegion(r2.headers['x-originating-url']);
        return { ok: true, region: region + ' 自制' };
      }
      return fail();
    }

    if (status === 200 || status === 301 || status === 302) {
      const region = extractNFRegion(headers['x-originating-url']);
      return ok(region);
    }
    return fail();
  } catch (e) {
    return e.message === 'TIMEOUT' ? warn() : fail();
  }
}

function extractNFRegion(url) {
  if (!url) return 'US';
  try {
    const parts = url.split('/');
    let r = parts[3] || 'US';
    r = r.split('-')[0];
    if (r === 'title') r = 'US';
    return r.toUpperCase();
  } catch { return 'US'; }
}

/**
 * 2. YouTube Premium
 */
async function checkYouTube() {
  try {
    const { status, body } = await httpGet({
      url: 'https://www.youtube.com/premium',
      headers: HEADERS,
    });
    if (status !== 200) return fail();
    if (body.indexOf('Premium is not available in your country') !== -1) return fail();

    const m = body.match(/"countryCode":"(\w{2})"/);
    if (m) return ok(m[1].toUpperCase());
    if (body.indexOf('www.google.cn') !== -1) return ok('CN');
    return ok('US');
  } catch (e) {
    return e.message === 'TIMEOUT' ? warn() : fail();
  }
}

/**
 * 3. Disney+
 */
async function checkDisney() {
  try {
    const { status, body } = await httpGet({
      url: 'https://www.disneyplus.com/',
      headers: HEADERS,
    });

    if (status !== 200 || body.indexOf('not available in your region') !== -1) return fail();

    // GraphQL 获取地区
    const gql = await httpPost({
      url: 'https://disney.api.edge.bamgrid.com/graph/v1/device/graphql',
      headers: {
        'Accept-Language': 'en',
        'Authorization': 'ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84',
        'Content-Type': 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify({
        query: 'mutation registerDevice($input: RegisterDeviceInput!) { registerDevice(registerDevice: $input) { grant { grantType assertion } } }',
        variables: {
          input: {
            applicationRuntime: 'chrome',
            attributes: {
              browserName: 'chrome', browserVersion: '125.0.0',
              manufacturer: 'apple', model: null,
              operatingSystem: 'macintosh', operatingSystemVersion: '10.15.7',
              osDeviceIds: [],
            },
            deviceFamily: 'browser', deviceLanguage: 'en', deviceProfile: 'macosx',
          },
        },
      }),
    });

    if (gql.status !== 200) return fail();
    const json = safeJSON(gql.body);
    if (!json || json.errors) return fail();

    const sdk = json?.extensions?.sdk;
    if (sdk) {
      const cc = sdk.session?.location?.countryCode || '';
      if (sdk.session?.inSupportedLocation === false) return { ok: true, region: cc.toUpperCase() + '⁻' };
      return ok(cc.toUpperCase());
    }
    return ok('');
  } catch (e) {
    return e.message === 'TIMEOUT' ? warn() : fail();
  }
}

/**
 * 4. Spotify
 */
async function checkSpotify() {
  try {
    const { body } = await httpGet({
      url: 'https://spclient.wg.spotify.com/signup/public/v1/account',
      headers: HEADERS,
    });
    const json = safeJSON(body);
    if (json && json.country) return ok(json.country.toUpperCase());
    return fail();
  } catch (e) {
    return e.message === 'TIMEOUT' ? warn() : fail();
  }
}

/**
 * 5. ChatGPT
 */
async function checkChatGPT() {
  try {
    // CF trace 获取地区
    const trace = await httpGet({
      url: 'https://chat.openai.com/cdn-cgi/trace',
      headers: { 'User-Agent': UA },
    });
    let loc = '';
    const lines = (trace.body || '').split('\n');
    for (const line of lines) {
      if (line.startsWith('loc=')) { loc = line.split('=')[1]; break; }
    }

    // 验证 API 可用性
    const { status } = await httpGet({
      url: 'https://ios.chat.openai.com/public-api/mobile/server_status/v1',
      headers: { 'User-Agent': UA },
    });
    if (status === 200) return ok(loc);
    return fail();
  } catch (e) {
    return e.message === 'TIMEOUT' ? warn() : fail();
  }
}

/**
 * 6. Claude
 */
async function checkClaude() {
  try {
    const { status } = await httpGet({
      url: 'https://claude.ai/api/auth/session',
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    });
    // 200/301/302 均视为可达
    if (status >= 200 && status < 404) return ok('');
    return fail();
  } catch (e) {
    return e.message === 'TIMEOUT' ? warn() : fail();
  }
}

/**
 * 7. Gemini (Google AI)
 */
async function checkGemini() {
  try {
    const { status, body } = await httpGet({
      url: 'https://gemini.google.com/',
      headers: HEADERS,
    });
    // 若被重定向到不支持页面或返回错误
    if (status === 403 || status === 451) return fail();
    if (status === 200) {
      // 检查是否有不可用提示
      if (body.indexOf('not available') !== -1 || body.indexOf('not supported') !== -1) {
        return fail();
      }
      return ok('');
    }
    // 302 重定向通常表示可用（重定向到 consent 页面）
    if (status === 302 || status === 301) return ok('');
    return fail();
  } catch (e) {
    return e.message === 'TIMEOUT' ? warn() : fail();
  }
}

/**
 * 8. TikTok
 */
async function checkTikTok() {
  try {
    const { status, body } = await httpGet({
      url: 'https://www.tiktok.com/',
      headers: HEADERS,
    });
    if (status !== 200) return fail();

    const m = body.match(/"region":"(\w{2})"/);
    if (m) return ok(m[1].toUpperCase());

    const m2 = body.match(/region=(\w{2})/);
    if (m2) return ok(m2[1].toUpperCase());

    if (body.indexOf('tiktok') !== -1) return ok('');
    return fail();
  } catch (e) {
    return e.message === 'TIMEOUT' ? warn() : fail();
  }
}

/**
 * 9. Bilibili 港澳台
 */
async function checkBilibili() {
  try {
    const { body } = await httpGet({
      url: 'https://api.bilibili.com/pgc/player/web/playurl?avid=18281381&cid=29892777&qn=0&type=&otype=json&ep_id=364558&fourk=1&fnval=16',
      headers: { ...HEADERS, 'Referer': 'https://www.bilibili.com/' },
    });
    const json = safeJSON(body);
    if (json && json.code === 0) return ok('港澳台');
    return fail();
  } catch (e) {
    return e.message === 'TIMEOUT' ? warn() : fail();
  }
}

/**
 * 10. HBO Max (Max)
 */
async function checkHBO() {
  try {
    const { status, body } = await httpGet({
      url: 'https://www.max.com/',
      headers: HEADERS,
    });
    if (status === 200) {
      if (body.indexOf('not available') !== -1 || body.indexOf('not yet available') !== -1) return fail();
      return ok('');
    }
    if (status === 403) return fail();
    return fail();
  } catch (e) {
    return e.message === 'TIMEOUT' ? warn() : fail();
  }
}

/**
 * 11. Prime Video
 */
async function checkPrimeVideo() {
  try {
    const { status, body } = await httpGet({
      url: 'https://www.primevideo.com/',
      headers: HEADERS,
    });
    if (status !== 200) return fail();

    const m = body.match(/"currentTerritory":"(\w{2})"/);
    if (m) return ok(m[1].toUpperCase());

    const m2 = body.match(/"marketplace":"(\w{2})"/);
    if (m2) return ok(m2[1].toUpperCase());

    if (body.indexOf('primevideo') !== -1) return ok('');
    return fail();
  } catch (e) {
    return e.message === 'TIMEOUT' ? warn() : fail();
  }
}

/**
 * 12. DAZN
 */
async function checkDAZN() {
  try {
    const { status } = await httpGet({
      url: 'https://startup.core.indazn.com/misl/v5/Ede',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    });
    if (status === 200) return ok('');
    return fail();
  } catch (e) {
    return e.message === 'TIMEOUT' ? warn() : fail();
  }
}

/**
 * 13. TVB (myTV SUPER)
 */
async function checkTVB() {
  try {
    const { status, body } = await httpGet({
      url: 'https://www.mytvsuper.com/iptest.php',
      headers: HEADERS,
    });
    if (status === 200) {
      const json = safeJSON(body);
      if (json) {
        if (json.country === 'HK' || json.region === 'HK') return ok('');
      }
      if (body.indexOf('HK') !== -1) return ok('');
      return fail();
    }
    return fail();
  } catch (e) {
    return e.message === 'TIMEOUT' ? warn() : fail();
  }
}

// ==================== 格式化输出 ====================

/**
 * 将检测结果格式化为单个服务的展示文本
 */
function fmtService(emoji, name, result) {
  if (result.region === '⚠️') return `${emoji} ${name}: ⚠️`;
  if (!result.ok) return `${emoji} ${name}: ✗`;
  return `${emoji} ${name}: ✓${result.region ? ' ' + result.region : ''}`;
}

/**
 * 根据解锁率计算 icon-color
 */
function calcIconColor(results) {
  const total = results.length;
  const success = results.filter(r => r.ok).length;
  const ratio = success / total;
  if (ratio >= 0.8) return '#06D6A0'; // 绿 — 大部分解锁
  if (ratio >= 0.5) return '#FFD166'; // 黄 — 部分解锁
  return '#EF476F';                   // 红 — 多数失败
}

// ==================== 主逻辑 ====================

;(async () => {
  const startTime = Date.now();

  const panel = {
    title: '流媒体 & AI 解锁检测',
    content: '',
    icon: 'play.tv.fill',
    'icon-color': '#EF476F',
  };

  try {
    // 并发检测所有服务
    const [
      netflix, youtube, disney, spotify,
      chatgpt, claude, gemini, tiktok,
      bilibili, hbo, prime, dazn, tvb,
    ] = await Promise.all([
      checkNetflix(),
      checkYouTube(),
      checkDisney(),
      checkSpotify(),
      checkChatGPT(),
      checkClaude(),
      checkGemini(),
      checkTikTok(),
      checkBilibili(),
      checkHBO(),
      checkPrimeVideo(),
      checkDAZN(),
      checkTVB(),
    ]);

    const results = [netflix, youtube, disney, spotify, chatgpt, claude, gemini, tiktok, bilibili, hbo, prime, dazn, tvb];

    // 动态 icon-color
    panel['icon-color'] = calcIconColor(results);

    // 计算耗时
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // 格式化输出 — 每行两个服务
    const lines = [
      `${fmtService('▶️', 'Netflix', netflix)} | ${fmtService('🎬', 'Disney+', disney)}`,
      `${fmtService('📺', 'YouTube', youtube)} | ${fmtService('🎵', 'Spotify', spotify)}`,
      `${fmtService('🤖', 'ChatGPT', chatgpt)} | ${fmtService('🧠', 'Claude', claude)}`,
      `${fmtService('💎', 'Gemini', gemini)} | ${fmtService('📱', 'TikTok', tiktok)}`,
      `${fmtService('📡', 'TVB', tvb)} | ${fmtService('🎮', 'DAZN', dazn)}`,
      `${fmtService('🅱️', 'Bilibili', bilibili)} | ${fmtService('🎥', 'HBO', hbo)}`,
      `${fmtService('🛒', 'Prime', prime)} | ⏱ ${elapsed}s`,
    ];

    panel.content = lines.join('\n');
  } catch (e) {
    panel.content = '❌ 检测异常: ' + (e.message || String(e));
  }

  $done(panel);
})();
