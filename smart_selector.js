/*
 * Smart 自动优选 - Surge Script
 * 功能: 解锁检测 + 测速 + 自动更新 Smart 组权重
 * 运行环境: Surge Script Engine (type=generic, timeout=300)
 */

// ==================== 配置常量 ====================

// 解析 sgmodule 传入的参数
const args = (() => {
  try {
    if (typeof $argument !== 'undefined' && $argument) {
      return Object.fromEntries(
        $argument.split("&").map(p => {
          const [k, ...v] = p.split("=");
          return [k, v.join("=")];
        })
      );
    }
  } catch(e) {}
  return {};
})();

const CONFIG = {
  // 优先使用 sgmodule argument，其次 persistentStore，最后默认值
  DRY_RUN: (args.dry_run || $persistentStore.read("smart_selector_dry_run") || "false") === "true",
  GITHUB_TOKEN: args.token || $persistentStore.read("smart_selector_github_token") || "",
  GIST_ID: args.gist_id || $persistentStore.read("smart_selector_gist_id") || "",
  CONCURRENCY: 3,
  SPEED_TIMEOUT: 10000,
  UNLOCK_TIMEOUT: 3000,
  // 网络防抖配置
  DEBOUNCE_WINDOW: 2,          // 连续失败次数阈值，连续 N 次结果一致才更新评分
  OUTLIER_THRESHOLD: 2.0,      // 离群值检测倍数，偏差超过 N 倍标准差时降低更新权重
  // 冷却期配置
  COOLDOWN_DURATION: 1800000,  // 冷却时长 30 分钟
  COOLDOWN_TRIGGER_FAILURES: 3, // 触发冷却的连续失败次数
  PRECISE_TEST_COUNT: 3,   // 每地区精确测试的节点数
  NODE_SWITCH_DELAY: 200,  // 切换节点后的等待时间（ms）- select 组切换几乎即时
  PROXY_POLICY: "节点选择",  // 用于外部请求（GitHub API等）的代理策略名
  TEST_GROUP: "速度测试",  // 用于逐节点精确测试的 select 组（不影响用户活跃连接）
  REGION_GROUPS: {
    HK: "HK",
    TW: "TW",
    JP: "JP",
    SG: "SG",
    US: "US",
    KR: "KR"
  },
  REGION_PATTERNS: {
    HK: /香港|HK|Hong\s?Kong|🇭🇰/i,
    TW: /台湾|TW|Taiwan|🇹🇼/i,
    JP: /日本|JP|Japan|🇯🇵/i,
    SG: /新加坡|SG|Singapore|🇸🇬/i,
    US: /美国|US|United\s?States|🇺🇸/i,
    KR: /韩国|KR|Korea|🇰🇷/i
  }
};

// ==================== 日志工具 ====================

const LOG_LEVEL = $persistentStore.read("smart_selector_log_level") || "info";
// 级别: debug < info < warn < error
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level, tag, message, data) {
  try {
    if (LOG_LEVELS[level] === undefined || LOG_LEVELS[level] < LOG_LEVELS[LOG_LEVEL]) return;
    const prefix = `[${level.toUpperCase()}][${tag}]`;
    const logMsg = data !== undefined 
      ? `${prefix} ${message} | ${JSON.stringify(data)}` 
      : `${prefix} ${message}`;
    console.log(logMsg);
  } catch (e) {
    // 日志不应影响正常流程
  }
}

// ==================== HTTP 工具 ====================

// Promise 封装 $httpClient.get
function httpGet(opts) {
  return new Promise((resolve, reject) => {
    const options = typeof opts === "string" ? { url: opts } : { ...opts };
    const timeout = options.timeout || 10000;
    delete options.timeout;
    
    const timer = setTimeout(() => reject(new Error("Timeout")), timeout);
    
    $httpClient.get(options, (error, response, data) => {
      clearTimeout(timer);
      if (error) reject(new Error(error));
      else resolve({ status: response.status, headers: response.headers, body: data });
    });
  });
}

// Promise 封装 $httpClient.post
function httpPost(opts) {
  return new Promise((resolve, reject) => {
    const options = typeof opts === "string" ? { url: opts } : { ...opts };
    const timeout = options.timeout || 10000;
    delete options.timeout;
    
    const timer = setTimeout(() => reject(new Error("Timeout")), timeout);
    
    $httpClient.post(options, (error, response, data) => {
      clearTimeout(timer);
      if (error) reject(new Error(error));
      else resolve({ status: response.status, headers: response.headers, body: data });
    });
  });
}

// PATCH 请求（用于 Gist API 更新）
function httpPatch(opts) {
  return new Promise((resolve, reject) => {
    const options = typeof opts === "string" ? { url: opts } : { ...opts };
    options.method = "PATCH";
    const timeout = options.timeout || 30000;
    delete options.timeout;
    
    const timer = setTimeout(() => reject(new Error("Timeout")), timeout);
    
    $httpClient.post(options, (error, response, data) => {
      clearTimeout(timer);
      if (error) reject(new Error(error));
      else resolve({ status: response.status, headers: response.headers, body: data });
    });
  });
}

// ==================== Surge HTTP API 封装 ==

// Promise 封装 $httpAPI
function surgeAPI(method, path, body = null) {
  return new Promise((resolve, reject) => {
    $httpAPI(method, path, body, (result) => {
      log("debug", "API", `${method} ${path}`, { 
        resultKeys: result ? Object.keys(result).slice(0, 10) : null,
        resultType: typeof result
      });
      if (result && result.error) {
        reject(new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error)));
      } else {
        resolve(result);
      }
    });
  });
}

// 临时切换 Smart/select 组的选中节点
async function switchGroupPolicy(groupName, policyName) {
  await surgeAPI("POST", "/v1/policy_groups/select", { 
    group_name: groupName, 
    policy: policyName 
  });
  log("debug", "API", "切换节点", { group: groupName, policy: policyName });
}

// 缓存策略组数据（避免多次调用同一端点）
let _policyGroupsCache = null;

async function fetchAllPolicyGroups() {
  if (_policyGroupsCache) return _policyGroupsCache;
  _policyGroupsCache = await surgeAPI("GET", "/v1/policy_groups");
  return _policyGroupsCache;
}

// 获取指定策略组的代理节点成员（排除子组），同时返回 lineHash 映射
// 返回 { nodes: ["🇭🇰 香港1", ...], hashMap: { "🇭🇰 香港1": "POLICY::xxx", ... } }
async function getGroupMembers(groupName) {
  try {
    const allGroups = await fetchAllPolicyGroups();
    const members = allGroups[groupName];
    if (!members || !Array.isArray(members)) return { nodes: [], hashMap: {} };
    
    const infoPattern = /剩余流量|套餐到期|重置剩余|过期时间|到期时间|expire|traffic/i;
    const validMembers = members.filter(m => m && !m.isGroup && m.name && !infoPattern.test(m.name));
    
    const nodes = validMembers.map(m => m.name);
    const hashMap = {};
    for (const m of validMembers) {
      if (m.lineHash) hashMap[m.name] = m.lineHash;
    }
    
    log("debug", "Main", `组 ${groupName} 节点`, { total: members.length, filtered: nodes.length, sample: nodes.slice(0, 3) });
    return { nodes, hashMap };
  } catch (e) {
    log("warn", "Main", `获取组 ${groupName} 失败`, { error: e.message });
    return { nodes: [], hashMap: {} };
  }
}

// 从 /v1/policies/benchmark_results 获取所有节点的延迟数据
async function getBenchmarkResults() {
  try {
    const data = await surgeAPI("GET", "/v1/policies/benchmark_results");
    return data || {};
  } catch (e) {
    log("warn", "Main", "获取 benchmark 结果失败", { error: e.message });
    return {};
  }
}

// 将 benchmark 数据映射到节点名（通过 lineHash）
function mapBenchmarkToNodes(benchmarkData, hashMap) {
  const latencyMap = {};
  for (const [nodeName, hash] of Object.entries(hashMap)) {
    const result = benchmarkData[hash];
    if (result && typeof result.lastTestScoreInMS === 'number' && result.lastTestScoreInMS > 0) {
      latencyMap[nodeName] = result.lastTestScoreInMS;
    }
  }
  return latencyMap;
}

// 从 benchmark 数据提取 UDP 转发能力（proxy-test-udp 测试结果）
// 支持 Surge 多种可能的字段名，兼容不同版本
function mapBenchmarkUDP(benchmarkData, hashMap) {
  const udpMap = {};
  for (const [nodeName, hash] of Object.entries(hashMap)) {
    const result = benchmarkData[hash];
    if (!result) continue;
    const udpValue = result.lastTestWithUDPInMS ?? result.udpTestScoreInMS ?? result.lastUDPTestScoreInMS;
    if (typeof udpValue === 'number' && udpValue > 0) {
      udpMap[nodeName] = true;
    }
  }
  return udpMap;
}

// ==================== 网络类型检测 ==

// 检测当前设备网络连接类型
// 返回: "WiFi" | "有线" | "移动"
function detectNetworkType() {
  if (typeof $network !== 'undefined' && $network) {
    // 如果有 WiFi SSID → WiFi
    if ($network.wifi && $network.wifi.ssid) {
      return "WiFi";
    }
    // 通过 primaryInterface 区分有线/蜂窝
    if ($network.v4 && $network.v4.primaryInterface) {
      const iface = $network.v4.primaryInterface;
      // utun = VPN tunnel (macOS/iOS)，检查底层网络
      if (iface.startsWith("utun")) {
        if ($network.wifi) return "WiFi";  // VPN over WiFi
        return "有线"; // VPN over Ethernet
      }
      // pdp_ip0 = Cellular on iOS
      if (iface.startsWith("pdp_ip")) {
        return "移动";
      }
      // en0 = WiFi (already handled above if ssid exists)
      // en1/en2... = Ethernet on Mac
      if (iface.startsWith("en") && iface !== "en0") {
        return "有线";
      }
    }
    // 默认：如果在 Mac 且无 WiFi，假定有线
    return "有线";
  }
  // $network 不可用时 fallback 到 WiFi
  return "WiFi";
}

// ==================== 地区分类（通过 /v1/policy_groups 获取 Smart 组成员）====================

// ==================== 解锁检测模块 ====================

// 解锁分类：定义哪些服务属于哪个类别
const UNLOCK_CATEGORIES = {
  streaming: ["Netflix", "Disney+"],    // 流媒体
  aigc: ["Gemini", "ChatGPT"],          // AI 服务
};

const UNLOCK_TARGETS = {
  HK: [
    { name: "Netflix", url: "https://www.netflix.com/title/81280792", check: (status, body) => status === 200 || status === 301 },
    { name: "Disney+", url: "https://www.disneyplus.com/", check: (status, body) => status >= 200 && status < 400 },
    { name: "Gemini", url: "https://gemini.google.com/app", check: (status, body) => {
      if (status !== 200) return false;
      // Google 首页对所有地区返回 200，但 app 页在封锁地区会包含 region-block 提示
      const b = (body || "").toLowerCase();
      const blocked = ["not available in your", "not available in your region", "not available in your country", "not supported in your", "not yet available in"]; 
      return !blocked.some(p => b.includes(p));
    } },
    { name: "ChatGPT", url: "https://ios.chat.openai.com/public-api/mobile/server_status/v1", check: (status, body) => status === 200 }
  ],
  TW: [
    { name: "Netflix", url: "https://www.netflix.com/title/81280792", check: (status, body) => status === 200 || status === 301 },
    { name: "Disney+", url: "https://www.disneyplus.com/", check: (status, body) => status >= 200 && status < 400 },
    { name: "Gemini", url: "https://gemini.google.com/app", check: (status, body) => {
      if (status !== 200) return false;
      // Google 首页对所有地区返回 200，但 app 页在封锁地区会包含 region-block 提示
      const b = (body || "").toLowerCase();
      const blocked = ["not available in your", "not available in your region", "not available in your country", "not supported in your", "not yet available in"]; 
      return !blocked.some(p => b.includes(p));
    } },
    { name: "ChatGPT", url: "https://ios.chat.openai.com/public-api/mobile/server_status/v1", check: (status, body) => status === 200 }
  ],
  JP: [
    { name: "Netflix", url: "https://www.netflix.com/title/81280792", check: (status, body) => status === 200 || status === 301 },
    { name: "Disney+", url: "https://www.disneyplus.com/", check: (status, body) => status >= 200 && status < 400 },
    { name: "Gemini", url: "https://gemini.google.com/app", check: (status, body) => {
      if (status !== 200) return false;
      // Google 首页对所有地区返回 200，但 app 页在封锁地区会包含 region-block 提示
      const b = (body || "").toLowerCase();
      const blocked = ["not available in your", "not available in your region", "not available in your country", "not supported in your", "not yet available in"]; 
      return !blocked.some(p => b.includes(p));
    } },
    { name: "ChatGPT", url: "https://ios.chat.openai.com/public-api/mobile/server_status/v1", check: (status, body) => status === 200 }
  ],
  SG: [
    { name: "Netflix", url: "https://www.netflix.com/title/81280792", check: (status, body) => status === 200 || status === 301 },
    { name: "Disney+", url: "https://www.disneyplus.com/", check: (status, body) => status >= 200 && status < 400 },
    { name: "Gemini", url: "https://gemini.google.com/app", check: (status, body) => {
      if (status !== 200) return false;
      // Google 首页对所有地区返回 200，但 app 页在封锁地区会包含 region-block 提示
      const b = (body || "").toLowerCase();
      const blocked = ["not available in your", "not available in your region", "not available in your country", "not supported in your", "not yet available in"]; 
      return !blocked.some(p => b.includes(p));
    } },
    { name: "ChatGPT", url: "https://ios.chat.openai.com/public-api/mobile/server_status/v1", check: (status, body) => status === 200 }
  ],
  US: [
    { name: "Netflix", url: "https://www.netflix.com/title/81280792", check: (status, body) => status === 200 || status === 301 },
    { name: "Disney+", url: "https://www.disneyplus.com/", check: (status, body) => status >= 200 && status < 400 },
    { name: "Gemini", url: "https://gemini.google.com/app", check: (status, body) => {
      if (status !== 200) return false;
      // Google 首页对所有地区返回 200，但 app 页在封锁地区会包含 region-block 提示
      const b = (body || "").toLowerCase();
      const blocked = ["not available in your", "not available in your region", "not available in your country", "not supported in your", "not yet available in"]; 
      return !blocked.some(p => b.includes(p));
    } },
    { name: "ChatGPT", url: "https://ios.chat.openai.com/public-api/mobile/server_status/v1", check: (status, body) => status === 200 }
  ],
  KR: [
    { name: "Netflix", url: "https://www.netflix.com/title/81280792", check: (status, body) => status === 200 || status === 301 },
    { name: "Disney+", url: "https://www.disneyplus.com/", check: (status, body) => status >= 200 && status < 400 },
    { name: "Gemini", url: "https://gemini.google.com/app", check: (status, body) => {
      if (status !== 200) return false;
      // Google 首页对所有地区返回 200，但 app 页在封锁地区会包含 region-block 提示
      const b = (body || "").toLowerCase();
      const blocked = ["not available in your", "not available in your region", "not available in your country", "not supported in your", "not yet available in"]; 
      return !blocked.some(p => b.includes(p));
    } },
    { name: "ChatGPT", url: "https://ios.chat.openai.com/public-api/mobile/server_status/v1", check: (status, body) => status === 200 }
  ]
};

// 检测指定地区的解锁情况（通过 Smart 组路由，非逐节点）
// 返回 { unlockScore: 0-1, details: [{name, unlocked: bool}] }
async function checkRegionUnlock(region, smartGroupName) {
  const targets = UNLOCK_TARGETS[region];
  if (!targets || targets.length === 0) return { unlockScore: 0, details: [] };

  const results = await Promise.allSettled(
    targets.map(async (target) => {
      try {
        const resp = await httpGet({
          url: target.url,
          policy: smartGroupName,  // 通过 Smart 组路由
          timeout: CONFIG.UNLOCK_TIMEOUT,
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" }
        });
        return { name: target.name, unlocked: target.check(resp.status, resp.body || "") };
      } catch (e) {
        log("debug", "Unlock", `${smartGroupName} ${target.name} 检测失败`, { error: e.message });
        return { name: target.name, unlocked: false };
      }
    })
  );

  const details = results.map(r => r.status === "fulfilled" ? r.value : { name: "unknown", unlocked: false });
  const unlocked = details.filter(d => d.unlocked).length;
  const score = unlocked / targets.length;
  log("debug", "Unlock", smartGroupName, { score, details: details.map(d => `${d.name}:${d.unlocked}`) });
  return { unlockScore: score, details };
}

// ==================== 测速模块 ====================

const SPEED_TEST_FILES = {
  HK: { url: "http://cachefly.cachefly.net/1mb.test", size: 1048576 },
  TW: { url: "http://cachefly.cachefly.net/1mb.test", size: 1048576 },
  JP: { url: "http://cachefly.cachefly.net/1mb.test", size: 1048576 },
  SG: { url: "http://cachefly.cachefly.net/1mb.test", size: 1048576 },
  US: { url: "http://cachefly.cachefly.net/1mb.test", size: 1048576 },
  KR: { url: "http://cachefly.cachefly.net/1mb.test", size: 1048576 },
  DEFAULT: { url: "http://cachefly.cachefly.net/1mb.test", size: 1048576 }
};


// 测试指定地区的下载速率（通过 Smart 组路由）
// 返回 { speedBps: number (bytes/s), elapsed: number (s) } 或 null（超时/失败）
async function testRegionSpeed(region, smartGroupName) {
  const testFile = SPEED_TEST_FILES[region] || SPEED_TEST_FILES.DEFAULT;

  try {
    const startTime = Date.now();
    await httpGet({
      url: testFile.url,
      policy: smartGroupName,  // 通过 Smart 组路由
      timeout: CONFIG.SPEED_TIMEOUT,
      headers: { "User-Agent": "Mozilla/5.0 SpeedTest" }
    });
    const elapsed = Math.max((Date.now() - startTime) / 1000, 0.001); // 最低 1ms 防止除零
    const speedBps = testFile.size / elapsed;
    log("debug", "Speed", `${region} (${smartGroupName})`, { speedMbps: (speedBps * 8 / 1048576).toFixed(2), elapsed: elapsed.toFixed(2) });
    return { speedBps, elapsed };
  } catch (e) {
    log("warn", "Speed", `${region} (${smartGroupName}) 测速失败`, { error: e.message });
    return null;
  }
}


// ==================== 综合测试（已重构为地区级）====================

// 逐节点精确测试：切换"速度测试"select 组到目标节点 → 测速+解锁 → 返回结果
// 使用独立的 select 组作为测试通道，不影响 Smart 组的自动选择和用户活跃连接
async function testSingleNode(nodeName, region) {
  try {
    // 1. 切换"速度测试"select 组到指定节点（不影响 Smart 组的自动选择）
    await switchGroupPolicy(CONFIG.TEST_GROUP, nodeName);
    
    // 2. 等待切换生效
    await new Promise(r => setTimeout(r, CONFIG.NODE_SWITCH_DELAY));
    
    // 3. 并行执行解锁检测和测速（通过"速度测试"组路由）
    const [unlockResult, speedResult] = await Promise.all([
      checkRegionUnlock(region, CONFIG.TEST_GROUP),
      testRegionSpeed(region, CONFIG.TEST_GROUP)
    ]);
    
    log("info", "Test", `${nodeName} 精确测试完成`, {
      unlock: unlockResult.unlockScore.toFixed(2),
      speed: speedResult ? (speedResult.speedBps / 1048576).toFixed(2) + "MB/s" : "失败"
    });
    
    return {
      proxyName: nodeName,
      region,
      latency: null, // 由 benchmark 补充
      unlockScore: unlockResult.unlockScore,
      unlockDetails: unlockResult.details,
      speedBps: speedResult ? speedResult.speedBps : 0,
      speedElapsed: speedResult ? speedResult.elapsed : null
    };
  } catch (e) {
    log("warn", "Test", `${nodeName} 精确测试失败`, { error: e.message });
    return {
      proxyName: nodeName,
      region,
      latency: null,
      unlockScore: 0,
      unlockDetails: [],
      speedBps: 0,
      speedElapsed: null
    };
  }
}

// ==================== ML 算法模块 ====================

// UCB1 选择精确测试目标（每地区 Top-N）
function selectPreciseTestTargets(history, nodes, region, count) {
  const totalRounds = history.runCount || 1;
  const now = Date.now();
  
  const scored = nodes
    .filter(name => {
      const node = history.nodes[name];
      // 跳过冷却期节点
      if (node && node.cooldownUntil && now < node.cooldownUntil) return false;
      return true;
    })
    .map(name => {
      const node = history.nodes[name];
      if (!node || node.totalTests === 0) return { name, ucb: Infinity }; // 未测试优先
      const exploration = Math.sqrt(Math.log(totalRounds) / node.totalTests);
      return { name, ucb: node.score + 1.5 * exploration };
    });
  
  scored.sort((a, b) => b.ucb - a.ucb);
  const selected = scored.slice(0, count).map(s => s.name);
  log("debug", "ML", "UCB1精确测试选择", { region, selected, totalCandidates: scored.length });
  return selected;
}

// EMA（指数移动平均）- alpha 越大，新数据权重越高
function updateEMA(oldEMA, newValue, alpha = 0.3) {
  if (!Number.isFinite(newValue)) return oldEMA; // 拒绝 NaN/Infinity 污染
  if (oldEMA === null || oldEMA === undefined) return newValue;
  return alpha * newValue + (1 - alpha) * oldEMA;
}

// Beta 分布贝叶斯推断 - 解锁概率
function getUnlockProbability(alpha, beta) {
  return alpha / (alpha + beta);
}

function updateBetaDistribution(alpha, beta, unlocked) {
  return unlocked ? { alpha: alpha + 1, beta } : { alpha, beta: beta + 1 };
}

// 时间衰减因子 - 数据越旧权重越低
function timeDecayFactor(lastTestTime, halfLifeMs = 86400000) { // 默认半衰期1天
  if (!lastTestTime) return 0;
  const age = Date.now() - lastTestTime;
  return Math.pow(0.5, age / halfLifeMs);
}

// 综合评分 - 结合速率、延迟、解锁概率和时间衰减
function calculateNodeScore(node) {
  const decay = timeDecayFactor(node.lastTestTime);
  
  // 速率分 (归一化到 0-1，以 5MB/s 为满分，更贴近代理实际吞吐)
  const speedScore = Math.min((node.emaSpeed || 0) / 5242880, 1.0);
  
  // 延迟分 (越低越好，250ms 为下限，更贴近实际体感差异)
  const latencyScore = node.emaLatency ? Math.max(1 - node.emaLatency / 250, 0) : 0.5;
  
  // 解锁概率
  const unlockProb = getUnlockProbability(node.unlockAlpha || 1, node.unlockBeta || 1);
  
  // 解锁门控：只要有解锁（unlockProb > 0 表示 Beta 分布中有成功记录）即为合格
  // unlockProb 来自 Beta 分布，反映历史解锁成功率
  const unlockGate = unlockProb > 0.3 ? 1.0   // 有解锁记录 → 不惩罚
                   : unlockProb > 0.1 ? 0.5   // 解锁不稳定 → 轻微惩罚
                   : 0.1;                      // 基本不解锁 → 重惩罚

  // 延迟为王：延迟占 65%（决定浏览/流媒体/P2P 体感），速度占 35%（大文件另说）
  const qualityScore = speedScore * 0.35 + latencyScore * 0.65;

  // 最终评分 = 门控 × 质量分
  const raw = unlockGate * qualityScore;
  return raw * decay + (1 - decay) * 0.3; // 衰减后向中间值回归
}

// ==================== 历史数据管理 ====================

// 加载历史数据
function loadHistory() {
  const raw = $persistentStore.read("smart_selector_history");
  if (!raw) return { version: 1, lastRun: null, runCount: 0, nodes: {} };
  try {
    const history = JSON.parse(raw);
    // 兼容旧版历史数据：为缺失的新字段补充默认值
    for (const node of Object.values(history.nodes || {})) {
      if (node.consecutiveFailures === undefined) node.consecutiveFailures = 0;
      if (node.lastSpeedVariance === undefined) node.lastSpeedVariance = 0;
      if (node.cooldownUntil === undefined) node.cooldownUntil = 0;
      // 兼容旧版：从统一 unlockAlpha/unlockBeta 迁移到按分类存储
      if (node.unlockByCategory === undefined) {
        node.unlockByCategory = {
          streaming: { alpha: node.unlockAlpha || 1, beta: node.unlockBeta || 1 },
          aigc: { alpha: node.unlockAlpha || 1, beta: node.unlockBeta || 1 },
        };
      }
    }
    return history;
  } catch (e) {
    return { version: 1, lastRun: null, runCount: 0, nodes: {} };
  }
}

// 保存历史数据
function saveHistory(history) {
  $persistentStore.write(JSON.stringify(history), "smart_selector_history");
}

// 初始化节点历史
function initNodeHistory(history, name, regional) {
  let region = "UNKNOWN";
  for (const [r, nodes] of Object.entries(regional)) {
    if (nodes.includes(name)) { region = r; break; }
  }
  history.nodes[name] = {
    region,
    emaSpeed: null,
    emaLatency: null,
    // 解锁记录按分类存储
    unlockByCategory: {
      streaming: { alpha: 1, beta: 1 },  // 流媒体解锁 Beta 分布
      aigc: { alpha: 1, beta: 1 },       // AIGC 解锁 Beta 分布
    },
    // 保留旧字段兼容（向后兼容）
    unlockAlpha: 1,
    unlockBeta: 1,
    totalTests: 0,
    lastTestTime: 0,
    lastSpeed: 0,
    lastLatency: null,
    lastUnlockScore: 0,
    score: 0.3, // 默认中间值
    // 网络防抖字段
    consecutiveFailures: 0,    // 连续失败计数
    lastSpeedVariance: 0,      // 速度方差（用于离群检测）
    // 冷却期字段
    cooldownUntil: 0,           // 冷却结束时间戳，0 表示不在冷却中
    // UDP 转发能力（从 proxy-test-udp benchmark 检测）
    udpCapable: false
  };
}

// 更新节点历史
function updateNodeHistory(history, result) {
  const node = history.nodes[result.proxyName];
  if (!node) return;
  
  node.totalTests += 1;
  node.lastTestTime = Date.now();
  node.lastSpeed = result.speedBps || 0;
  node.lastLatency = result.latency;
  node.lastUnlockScore = result.unlockScore || 0;
  
  // --- 网络防抖：离群值检测 ---
  const currentSpeed = result.speedBps || 0;
  let speedAlpha = 0.3; // 默认 EMA 平滑系数
  
  if (node.emaSpeed !== null && node.emaSpeed > 0) {
    const deviation = Math.abs(currentSpeed - node.emaSpeed);
    const stdDev = Math.sqrt(node.lastSpeedVariance || 0);
    // 当偏差超过阈值倍标准差时，视为离群值，降低更新权重
    if (stdDev > 0 && deviation > CONFIG.OUTLIER_THRESHOLD * stdDev) {
      speedAlpha = 0.1; // 离群值使用更小的 alpha 平滑
      log("debug", "ML", "离群值检测", { node: result.proxyName, deviation: deviation.toFixed(0) });
    }
    // 更新速度方差（增量方差估计）
    const diff = currentSpeed - node.emaSpeed;
    node.lastSpeedVariance = updateEMA(node.lastSpeedVariance, diff * diff, 0.2);
  } else if (node.emaSpeed !== null) {
    // emaSpeed 为 0 时初始化方差
    node.lastSpeedVariance = currentSpeed * currentSpeed * 0.1;
  }
  
  // EMA 更新（使用经过离群检测调整的 alpha）
  node.emaSpeed = updateEMA(node.emaSpeed, currentSpeed, speedAlpha);
  if (result.latency) {
    node.emaLatency = updateEMA(node.emaLatency, result.latency, 0.3);
  }
  
  // --- 网络防抖：连续失败追踪 ---
  const unlocked = (result.unlockScore || 0) > 0;  // 任意一个服务解锁即为成功
  const isFailed = !unlocked && currentSpeed === 0; // 解锁失败且测速为0视为失败
  
  if (isFailed) {
    node.consecutiveFailures += 1;
    log("debug", "Debounce", "连续失败", { node: result.proxyName, count: node.consecutiveFailures });
  } else {
    // 成功时重置连续失败计数
    node.consecutiveFailures = 0;
  }
  
  // --- 按分类更新解锁 Beta 分布 ---
  if (result.unlockDetails && result.unlockDetails.length > 0) {
    for (const [category, serviceNames] of Object.entries(UNLOCK_CATEGORIES)) {
      if (!node.unlockByCategory[category]) {
        node.unlockByCategory[category] = { alpha: 1, beta: 1 };
      }
      // 检查该分类下是否有任一服务解锁成功
      const categoryUnlocked = serviceNames.some(svc =>
        result.unlockDetails.some(d => d.name === svc && d.unlocked)
      );
      
      // 遗忘因子：衰减旧参数，让模型对解锁能力变化保持敏感
      const BETA_DECAY = 0.99;
      node.unlockByCategory[category].alpha *= BETA_DECAY;
      node.unlockByCategory[category].beta *= BETA_DECAY;
      
      // 防抖逻辑仍适用
      if (categoryUnlocked) {
        node.unlockByCategory[category].alpha += 1;
      } else if (node.consecutiveFailures >= CONFIG.DEBOUNCE_WINDOW) {
        node.unlockByCategory[category].beta += 1;
      }
    }
  }

  // 保持旧的统一 unlockAlpha/unlockBeta 也同步更新（兼容 calculateNodeScore 的门控）
  const anyUnlocked = (result.unlockScore || 0) > 0;
  if (anyUnlocked) {
    node.unlockAlpha += 1;
  } else if (node.consecutiveFailures >= CONFIG.DEBOUNCE_WINDOW) {
    node.unlockBeta += 1;
  } else if (!anyUnlocked) {
    log("debug", "Debounce", "防抖生效-跳过Beta更新", { node: result.proxyName });
  }
  
  // --- 冷却期触发 ---
  if (node.consecutiveFailures >= CONFIG.COOLDOWN_TRIGGER_FAILURES) {
    node.cooldownUntil = Date.now() + CONFIG.COOLDOWN_DURATION;
    log("warn", "ML", "节点进入冷却", { node: result.proxyName, cooldownUntil: new Date(node.cooldownUntil).toISOString() });
  }
}

// 重新计算所有节点评分
function recalculateAllScores(history) {
  for (const [name, node] of Object.entries(history.nodes)) {
    node.score = calculateNodeScore(node);
  }
}

// ==================== 模型权重生成 ====================

// 基于 ML 模型生成所有节点权重（含 EMA 平滑 + 权重上下限）
function generateWeightsFromModel(history, regional, currentNetworkType) {
  const weightMap = {};
  const EMA_ALPHA = 0.6;           // 当前测量权重60%，历史40%
  const MAX_WEIGHT_RATIO = 3.0;    // 最高权重不超过平均值的 3 倍
  const MIN_WEIGHT = 0.1;          // 最低权重不低于 0.1
  
  // 读取历史权重（按网络类型分开存储）
  const allNetworkWeights = history.regionWeights || {};
  const historyWeights = allNetworkWeights[currentNetworkType] || {};
  // 本轮新权重（用于保存）
  const newRegionWeights = {};
  
  for (const [region, nodes] of Object.entries(regional)) {
    if (nodes.length === 0) continue;
    
    // 计算原始权重（含 UCB1 探索性调整 + 冷却降权）
    const rawEntries = nodes
      .map(name => {
        const node = history.nodes[name];
        if (!node) return null;
        
        const totalRounds = history.runCount || 1;
        const nodeTests = node.totalTests || 0;
        
        // 基础权重（score 高 → weight 低 → 优先级高）
        let weight = clamp(mapRange(node.score, 0, 1, 3.0, 0.3), 0.3, 3.0);
        
        // UCB1 探索性调整：测试次数少时，权重向中间值(1.0)回归
        // confidence = 1 - exploration_bonus（测试越多越自信）
        if (nodeTests > 0 && totalRounds > 1) {
          const exploration = Math.sqrt(Math.log(totalRounds) / nodeTests);
          const confidence = Math.max(1 - exploration, 0.3); // 最低 30% 信心
          weight = weight * confidence + 1.0 * (1 - confidence); // 向中间值 1.0 插值
        } else if (nodeTests === 0) {
          weight = 1.0; // 完全未测试，给中间权重（不奖不罚）
        }
        
        // 解锁一票否决：所有分类都不解锁才否决（AND 语义）
        // 只要还能服务某个业务（流媒体或AIGC），节点就有存在价值
        if (node.totalTests >= 2 && node.unlockByCategory) {
          const allFailed = Object.values(node.unlockByCategory).every(beta => {
            const prob = getUnlockProbability(beta.alpha || 1, beta.beta || 1);
            return prob <= 0.1;
          });
          if (allFailed) {
            weight = 3.0;
            log("debug", "ML", "全分类解锁否决", { node: name });
          }
        }
        
        // 冷却期降权
        if (node.cooldownUntil && Date.now() < node.cooldownUntil) {
          weight = 3.0; // 冷却期内直接最低优先级
          log("debug", "ML", "冷却降权", { node: name });
        }
        
        // 流量倍率微弱参考：仅作轻微调节，不主导权重
        // 0.1x节点→0.9（微弱提优），2x节点→1.1（微弱降优）
        const rawMultiplier = parseMultiplier(name);
        const multiplier = clamp(rawMultiplier, 0.99, 1.01);
        weight = weight * multiplier;
        if (multiplier > 1) {
          log("debug", "ML", "流量倍率惩罚", { node: name, multiplier, weight: weight.toFixed(2) });
        }
        
        return { name, weight };
      })
      .filter(Boolean);
    
    if (rawEntries.length === 0) continue;
    
    // 1.1 EMA 平滑：对每个节点的最终权重做 EMA
    let weights = rawEntries.map(entry => {
      const histW = historyWeights[entry.name];
      const smoothed = (histW !== undefined && histW !== null)
        ? EMA_ALPHA * entry.weight + (1 - EMA_ALPHA) * histW
        : entry.weight;
      return { name: entry.name, weight: smoothed };
    });
    
    // 1.2 权重上限/下限
    const avgWeight = weights.reduce((sum, w) => sum + w.weight, 0) / weights.length;
    weights = weights.map(w => ({
      name: w.name,
      weight: Math.max(Math.min(w.weight, avgWeight * MAX_WEIGHT_RATIO), MIN_WEIGHT)
    }));
    
    // 1.3 归一化：让平均值 = 1.0（weight < 1 提优，> 1 降优）
    const finalAvg = weights.reduce((s, w) => s + w.weight, 0) / weights.length;
    if (finalAvg > 0) {
      weights = weights.map(w => ({ name: w.name, weight: w.weight / finalAvg }));
    }
    
    // 保存本轮权重供下次 EMA 使用
    for (const w of weights) {
      newRegionWeights[w.name] = w.weight;
    }
    
    const entries = weights.map(w => `${w.name}:${w.weight.toFixed(2)}`);
    weightMap[region] = entries.join(";");
    
    log("debug", "ML", `${region} EMA平滑`, { avg: avgWeight.toFixed(2), nodes: weights.length });
  }
  
  // 1.3 保存权重历史（按网络类型分开存储）
  if (!history.regionWeights) history.regionWeights = {};
  history.regionWeights[currentNetworkType] = newRegionWeights;
  
  log("info", "Profile", "权重已更新(EMA+cap)", { regions: Object.keys(weightMap) });
  return weightMap;
}

// ==================== 权重工具 ====================

// 查找真正的内联注释位置（排除 URL 中的 // 和引号内的 //）
// Surge 内联注释格式: 配置内容后跟 " //注释" 或 ", //注释"
function findCommentIndex(line) {
  let inQuotes = false;
  for (let j = 0; j < line.length - 1; j++) {
    if (line[j] === '"') { inQuotes = !inQuotes; continue; }
    if (inQuotes) continue;
    if (line[j] === '/' && line[j + 1] === '/') {
      // 排除 URL 中的 :// (如 https:// http://)
      if (j > 0 && line[j - 1] === ':') continue;
      return j;
    }
  }
  return -1;
}

// 数值映射工具
function mapRange(value, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return (outMin + outMax) / 2;
  return outMin + (value - inMin) * (outMax - outMin) / (inMax - inMin);
}

// 数值限制
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// 从节点名解析流量倍率
// 匹配模式: "2x", "2X", "2×", "2倍", "1.5x", "-3x" 等
function parseMultiplier(nodeName) {
  const match = nodeName.match(/(\d+(?:\.\d+)?)\s*[xX×倍]/);
  return match ? parseFloat(match[1]) : 1;
}

// ==================== Profile 更新模块 ==

// 匹配 Smart 组所属地区（仅匹配组名，避免 URL/参数中的误匹配）
function matchSmartGroupRegion(groupLine) {
  const nameMatch = groupLine.match(/^\s*([^=]+?)\s*=/);
  if (!nameMatch) return null;
  const groupName = nameMatch[1];
  for (const [region, pattern] of Object.entries(CONFIG.REGION_PATTERNS)) {
    if (pattern.test(groupName)) return region;
  }
  return null;
}

// 注释插入/更新工具
function insertOrUpdateComment(lines, targetIndex, comment) {
  if (targetIndex > 0 && lines[targetIndex - 1].trim().startsWith("# [SmartSelector]")) {
    lines[targetIndex - 1] = comment;
    return 0;
  } else {
    lines.splice(targetIndex, 0, comment);
    return 1;
  }
}

// 更新 Profile 中 Smart 组的 policy-priority 参数
// profileText: 完整的 Surge 配置文本
// weightMap: { "HK": "NodeA:0.6;NodeB:1.2", "JP": "..." }
// suffix: 当前网络类型后缀，如 "-WiFi"，只更新匹配该后缀的 Smart 组
// regionScores: 地区综合分数据
// networkType: 当前网络类型
// 返回修改后的完整配置文本
function updateProfileWeights(profileText, weightMap, suffix, regionScores, networkType) {
  const lines = profileText.split("\n");
  let inProxyGroup = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // 检测 section 切换
    if (line.startsWith("[")) {
      inProxyGroup = (line === "[Proxy Group]");
      continue;
    }
    
    if (!inProxyGroup) continue;
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    
    // 检查是否是 smart 类型的组
    // Surge 配置格式: "GroupName = smart, ..."（smart 紧跟在 = 后面，非 type=smart 参数）
    if (!/=\s*smart\b/i.test(line)) continue;
    
    // 只处理匹配当前网络类型后缀的 Smart 组
    const groupNameMatch2 = line.match(/^\s*([^=]+?)\s*=/);
    if (groupNameMatch2) {
      const gName = groupNameMatch2[1].trim();
      if (suffix && !gName.endsWith(suffix)) continue;
    }
    
    // 匹配该 Smart 组的地区
    const region = matchSmartGroupRegion(line);
    if (!region || !weightMap[region]) continue;
    
    // 更新或插入 policy-priority
    const priorityValue = `policy-priority="${weightMap[region]}"`;
    
    if (/policy-priority\s*=\s*"[^"]*"/.test(lines[i])) {
      // 已有 policy-priority，替换
      lines[i] = lines[i].replace(/policy-priority\s*=\s*"[^"]*"/, priorityValue);
    } else {
      // 没有，在行末追加（逗号分隔），注意避开内联注释
      const commentIdx = findCommentIndex(lines[i]);
      if (commentIdx > 0) {
        const configPart = lines[i].substring(0, commentIdx).trimEnd();
        const commentPart = lines[i].substring(commentIdx);
        lines[i] = `${configPart}, ${priorityValue} ${commentPart}`;
      } else {
        lines[i] = lines[i].trimEnd() + `, ${priorityValue}`;
      }
    }
    
    // 在修改行上方插入/更新 SmartSelector 注释
    if (regionScores && regionScores[region]) {
      const score = regionScores[region];
      const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      const comment = `# [SmartSelector] ${now} ${networkType} | 解锁:${score.unlock.toFixed(2)} 速度:${score.speedMbps.toFixed(1)}Mbps 延迟:${Math.round(score.latencyMs)}ms`;
      i += insertOrUpdateComment(lines, i, comment);
    }
  }
  
  return lines.join("\n");
}

// ==================== UDP 组 policy-regex-filter 更新 ====================

// UDP 专用 Smart 组名映射（地区 → UDP 组名）
const UDP_GROUPS = { HK: "HK-UDP", SG: "SG-UDP", JP: "JP-UDP", KR: "KR-UDP" };

// 为 UDP Smart 组动态生成 policy-regex-filter（仅纳入 UDP 转发能力节点）
// 这才是真正的一票否决：不支持 UDP 的节点直接从组里排除
function updateUDPGroupFilters(profileText, regionUDPCapable) {
  const lines = profileText.split("\n");
  let inProxyGroup = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("[")) {
      inProxyGroup = (line === "[Proxy Group]");
      continue;
    }
    if (!inProxyGroup || !line || line.startsWith("#")) continue;
    if (!/=\s*smart\b/i.test(line)) continue;

    // 提取组名
    const nameMatch = line.match(/^\s*([^=]+?)\s*=/);
    if (!nameMatch) continue;
    const groupName = nameMatch[1].trim();

    // 检查是否是 UDP 组
    let udpRegion = null;
    for (const [region, udpName] of Object.entries(UDP_GROUPS)) {
      if (groupName === udpName) { udpRegion = region; break; }
    }
    if (!udpRegion) continue;

    // 获取该地区 UDP 能力节点名单
    const udpMap = regionUDPCapable[udpRegion];
    if (!udpMap) continue;
    const udpNodes = Object.entries(udpMap).filter(([_, v]) => v).map(([name]) => name);

    if (udpNodes.length === 0) {
      log("info", "UDP", `${groupName} 无 UDP 节点，保持默认 filter`);
      continue;
    }

    // 构建 policy-regex-filter（精确匹配节点名，转义正则特殊字符）
    const escapedNames = udpNodes.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const regexFilter = escapedNames.map(n => `(${n})`).join("|");
    const filterValue = `policy-regex-filter="${regexFilter}"`;

    // 替换或插入 policy-regex-filter
    if (/policy-regex-filter\s*=\s*"[^"]*"/.test(lines[i])) {
      lines[i] = lines[i].replace(/policy-regex-filter\s*=\s*"[^"]*"/, filterValue);
    } else {
      const commentIdx = findCommentIndex(lines[i]);
      if (commentIdx > 0) {
        const configPart = lines[i].substring(0, commentIdx).trimEnd();
        const commentPart = lines[i].substring(commentIdx);
        lines[i] = `${configPart}, ${filterValue} ${commentPart}`;
      } else {
        lines[i] = lines[i].trimEnd() + `, ${filterValue}`;
      }
    }

    log("info", "UDP", `${groupName} filter 已更新`, { nodes: udpNodes.length, sample: udpNodes.slice(0, 3) });
  }

  return lines.join("\n");
}

// ==================== Fallback 地区排序模块 ====================

// Fallback 组重排配置
const FALLBACK_REORDER_CONFIG = {
  "代理容灾": { exclude: [], sortBy: "overall" },
  "Google容灾": { exclude: [], sortBy: "overall" },
  "Netflix容灾": { exclude: [], sortBy: "overall", requiredUnlock: ["Netflix"] },
  "流媒体容灾": { exclude: [], sortBy: "overall" },
  "AIGC容灾": { exclude: ["HK"], sortBy: "overall", requiredUnlock: ["Gemini", "ChatGPT"] },
  "游戏容灾": { exclude: ["US", "TW"], sortBy: "latency", udpSuffix: true, suffix: ["DIRECT"] },
  "漏网之鱼容灾": { exclude: ["US", "TW"], sortBy: "latency", udpSuffix: true, suffix: ["代理容灾"] },
  "TG容灾": { exclude: [], sortBy: "overall" },
  "Apple容灾": { regions: ["HK", "US", "JP", "KR"], sortBy: "overall" },
};

// 计算地区综合分
// regionScores 格式: { HK: { unlock, speedMbps, latencyMs }, ... }
// maxSpeedMbps: 本轮所有地区中的最大速度，用于相对归一化
function calcRegionScore(regionData, sortBy, minSpeedMbps, maxSpeedMbps) {
  const unlock = regionData.unlock || 0;          // 0-1
  const speed = regionData.speedMbps || 0;
  const latency = regionData.latencyMs || 999;     // ms
  
  // min-max 归一化
  const speedRange = maxSpeedMbps - minSpeedMbps;
  const speedNorm = speedRange > 0 ? Math.min(Math.max((speed - minSpeedMbps) / speedRange, 0), 1) : 0.5;
  const latencyNorm = 1 - Math.min(latency / 500, 1);    // 500ms 零分
  
  if (sortBy === "latency") {
    // 延迟优先（游戏等延迟敏感场景）：延迟占 50%，速度 35%，解锁 15%
    return latencyNorm * 0.5 + speedNorm * 0.35 + unlock * 0.15;
  } else if (sortBy === "unlock") {
    // 解锁优先：解锁占 45%，速度 40%，延迟 15%
    return unlock * 0.45 + speedNorm * 0.4 + latencyNorm * 0.15;
  } else {
    // overall 综合分（带宽为王）：速度占 50%，解锁 30%，延迟 20%
    return speedNorm * 0.5 + unlock * 0.3 + latencyNorm * 0.2;
  }
}

// 对 Profile 中的 Fallback 组做地区重排
// unlockDetails 格式: { HK: [{name: "Netflix", unlocked: true}, ...], ... }
// minSpeedMbps/maxSpeedMbps: EMA 平滑后的速度范围，由主流程计算并传入
function reorderFallbackGroups(profileText, regionScores, unlockDetails, minSpeedMbps, maxSpeedMbps) {
  const lines = profileText.split("\n");
  let inProxyGroup = false;
  
  // 所有可能的地区简称
  const ALL_REGIONS = Object.keys(CONFIG.REGION_GROUPS);
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // 检测 section 切换
    if (line.startsWith("[")) {
      inProxyGroup = (line === "[Proxy Group]");
      continue;
    }
    
    if (!inProxyGroup) continue;
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    
    // 检查是否是 fallback 类型的组
    if (!/=\s*fallback\b/i.test(line)) continue;
    
    // 提取组名
    const groupNameMatch = lines[i].match(/^\s*([^=]+?)\s*=/);
    if (!groupNameMatch) continue;
    const groupName = groupNameMatch[1].trim();
    
    // 检查该组是否在重排配置中
    const config = FALLBACK_REORDER_CONFIG[groupName];
    if (!config) continue;
    
    // 解析 Fallback 行
    // 格式: 组名 = fallback, 地区1, 地区2, ..., 自动选优/DIRECT, url=..., interval=...
    // 先分离可能存在的内联注释
    const commentIdx = findCommentIndex(lines[i]);
    let inlineComment = "";
    let workLine = lines[i];
    if (commentIdx > 0) {
      inlineComment = " " + lines[i].substring(commentIdx);
      workLine = lines[i].substring(0, commentIdx).trimEnd();
    }
    const eqIndex = workLine.indexOf("=");
    const afterEq = workLine.substring(eqIndex + 1).trim();
    
    // 分离参数部分（url=, interval=, timeout=, evaluate-before-use=, hidden=, icon-url= 等）
    const parts = afterEq.split(",").map(p => p.trim());
    const policyType = parts[0]; // "fallback"
    
    // 分离成员和参数
    const members = [];
    const params = [];
    const paramPattern = /^(url|interval|timeout|evaluate-before-use|hidden|icon-url|no-alert|persistent|include-all-proxies|test-timeout|policy-regex-filter|policy-priority|external-policy-modifier)\s*=/;
    
    for (let j = 1; j < parts.length; j++) {
      if (paramPattern.test(parts[j])) {
        params.push(parts[j]);
      } else {
        members.push(parts[j]);
      }
    }
    
    // 分离特殊成员（自动选优、DIRECT 等）和地区成员
    const specialMembers = []; // 非地区成员（如 "自动选优", "DIRECT"）
    const regionMembers = [];  // 地区成员
    
    for (const m of members) {
      if (ALL_REGIONS.includes(m)) {
        regionMembers.push(m);
      } else if (config.udpSuffix) {
        // 识别 XX-UDP 格式的组名（如 HK-UDP → 基础地区 HK）
        const udpMatch = m.match(/^([A-Z]{2})-UDP$/);
        if (udpMatch && ALL_REGIONS.includes(udpMatch[1])) {
          regionMembers.push(udpMatch[1]); // 存储基础地区名用于排序
        } else {
          specialMembers.push(m);
        }
      } else {
        specialMembers.push(m);
      }
    }
    
    // 确定参与排序的地区
    let sortableRegions;
    if (config.regions) {
      // 指定了参与的地区列表
      sortableRegions = config.regions.filter(r => regionMembers.includes(r));
    } else {
      // 从当前成员中排除 exclude
      sortableRegions = regionMembers.filter(r => {
        const baseRegion = r.replace(/-UDP$/, '');
        return !config.exclude.includes(r) && !config.exclude.includes(baseRegion);
      });
    }
    
    // 解锁一票否决：如果配置了 requiredUnlock，分为通过/未通过两组
    let failed = [];
    if (config.requiredUnlock && config.requiredUnlock.length > 0 && unlockDetails) {
      const passed = [];
      failed = [];
      for (const region of sortableRegions) {
        const details = unlockDetails[region];
        const hasRequired = config.requiredUnlock.some(serviceName =>
          details && details.some(d => d.name === serviceName && d.unlocked)
        );
        hasRequired ? passed.push(region) : failed.push(region);
      }
      // 分别按分数排序，未通过的放后面
      passed.sort((a, b) => {
        const scoreA = regionScores[a] ? calcRegionScore(regionScores[a], config.sortBy, minSpeedMbps, maxSpeedMbps) : 0;
        const scoreB = regionScores[b] ? calcRegionScore(regionScores[b], config.sortBy, minSpeedMbps, maxSpeedMbps) : 0;
        return scoreB - scoreA;
      });
      failed.sort((a, b) => {
        const scoreA = regionScores[a] ? calcRegionScore(regionScores[a], config.sortBy, minSpeedMbps, maxSpeedMbps) : 0;
        const scoreB = regionScores[b] ? calcRegionScore(regionScores[b], config.sortBy, minSpeedMbps, maxSpeedMbps) : 0;
        return scoreB - scoreA;
      });
      sortableRegions = [...passed, ...failed];
      if (failed.length > 0) {
        log("info", "Fallback", `${groupName} 解锁否决`, { passed, failed, required: config.requiredUnlock });
      }
    } else {
      // 无 requiredUnlock 配置，按分数正常排序（降序：分高优先）
      sortableRegions.sort((a, b) => {
        const scoreA = regionScores[a] ? calcRegionScore(regionScores[a], config.sortBy, minSpeedMbps, maxSpeedMbps) : 0;
        const scoreB = regionScores[b] ? calcRegionScore(regionScores[b], config.sortBy, minSpeedMbps, maxSpeedMbps) : 0;
        return scoreB - scoreA;
      });
    }
    
    // 无可排序地区时跳过，避免破坏已有的行内容和注释
    if (sortableRegions.length === 0) {
      log("debug", "Fallback", `${groupName} 无可排序地区，跳过`);
      continue;
    }

    // 重组成员列表
    // 被 exclude 的地区不参与，也不保留在结果中
    let newMembers = [...sortableRegions];
    
    // UDP 后缀模式：将基础地区名转换为 XX-UDP 组名
    if (config.udpSuffix) {
      newMembers = newMembers.map(r => `${r}-UDP`);
    }
    
    // 添加特殊后缀
    if (config.suffix) {
      // 使用配置的 suffix
      newMembers = newMembers.concat(config.suffix);
    } else {
      // 保留原来的特殊成员在末尾
      newMembers = newMembers.concat(specialMembers);
    }
    
    // 重组行
    const prefix = workLine.substring(0, eqIndex + 1);
    const newLine = `${prefix} ${policyType}, ${newMembers.join(", ")}${params.length > 0 ? ", " + params.join(", ") : ""}${inlineComment}`;
    lines[i] = newLine;
    
    // 在重排行上方插入/更新 SmartSelector 注释
    const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const scoreStr = sortableRegions.map(r => `${r}(${(regionScores[r] ? calcRegionScore(regionScores[r], config.sortBy, minSpeedMbps, maxSpeedMbps) : 0).toFixed(2)})`).join(">");
    const vetoInfo = failed.length > 0 ? ` | 否决:${failed.join(",")}` : "";
    const fbComment = `# [SmartSelector] ${now} | ${scoreStr}${vetoInfo}`;
    i += insertOrUpdateComment(lines, i, fbComment);
    
    log("info", "Fallback", "地区排序", { group: groupName, order: sortableRegions });
  }
  
  return lines.join("\n");
}

// ==================== Profile 摘要注入 ====================

// 在配置文件顶部插入/更新运行摘要（完全自举：所有数据从 history 提取）
function insertProfileSummary(profileText, weightMap, networkType, history, regional) {
  const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  
  // 所有数据从 history 提取
  const runCount = history.runCount || 0;
  const firstRun = history.firstRun || "未知";
  const totalNodes = Object.keys(history.nodes).length;
  
  // 构建摘要行
  const summaryLines = [`# [SmartSelector Summary]`];
  summaryLines.push(`# 更新时间: ${now} | 网络: ${networkType} | 第${runCount}轮 | 自${firstRun}起 | ${totalNodes}节点`);
  
  // 地区统计：从 history.nodes 按 regional 分组聚合
  const regionSummaries = [];
  const regionBests = [];
  for (const [region, nodes] of Object.entries(regional || {})) {
    const regionNodes = nodes
      .map(name => history.nodes[name])
      .filter(Boolean);
    
    if (regionNodes.length === 0) continue;
    
    // 聚合：取各节点 EMA 的均值
    const avgLatency = regionNodes.reduce((s, n) => s + (n.emaLatency || 0), 0) / regionNodes.length;
    const avgSpeed = regionNodes.reduce((s, n) => s + (n.emaSpeed || 0), 0) / regionNodes.length;
    const avgUnlock = regionNodes.reduce((s, n) => s + getUnlockProbability(n.unlockAlpha || 1, n.unlockBeta || 1), 0) / regionNodes.length;
    const totalTests = regionNodes.reduce((s, n) => s + (n.totalTests || 0), 0);
    
    // 格式化
    regionSummaries.push(`${region}: 解锁${avgUnlock.toFixed(2)} 速度${(avgSpeed / 1048576).toFixed(1)}MB/s 延迟${Math.round(avgLatency)}ms (测${totalTests}次)`);
    
    // 找到该地区历史评分最高的节点
    let bestName = "", bestScore = -1;
    for (const name of nodes) {
      const node = history.nodes[name];
      if (node && node.score > bestScore) {
        bestScore = node.score;
        bestName = name;
      }
    }
    if (bestName && bestScore > 0) {
      regionBests.push(`${region}=${bestName}(${bestScore.toFixed(2)})`);
    }
  }
  
  // 地区概览（每行最多2个地区）
  for (let i = 0; i < regionSummaries.length; i += 2) {
    summaryLines.push(`# ${regionSummaries.slice(i, i + 2).join(" | ")}`);
  }
  
  // 历史最优节点
  if (regionBests.length > 0) {
    summaryLines.push(`# 历史最优: ${regionBests.join(" ")}`);
  }
  
  // 本轮权重最优节点（从 weightMap 取，权重最小 = 优先级最高）
  const currentBests = Object.entries(weightMap).map(([region, priorities]) => {
    const entries = priorities.split(";");
    let bestNode = "", bestWeight = Infinity;
    for (const entry of entries) {
      const lastColon = entry.lastIndexOf(":");
      if (lastColon <= 0) continue;
      const name = entry.substring(0, lastColon);
      const w = parseFloat(entry.substring(lastColon + 1));
      if (!Number.isFinite(w)) continue;
      if (w < bestWeight) { bestWeight = w; bestNode = name; }
    }
    if (!Number.isFinite(bestWeight)) return `${region}=未知(--)`;
    return `${region}=${bestNode}(${bestWeight.toFixed(2)})`;
  });
  summaryLines.push(`# 本轮权重: ${currentBests.join(" ")}`);
  
  // 移除旧摘要
  const lines = profileText.split("\n");
  let startIdx = -1, endIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "# [SmartSelector Summary]") {
      startIdx = i;
      endIdx = i;
      while (endIdx + 1 < lines.length && lines[endIdx + 1].trim().startsWith("#") && !lines[endIdx + 1].trim().startsWith("[" )) {
        endIdx++;
      }
      break;
    }
  }
  
  if (startIdx >= 0) {
    // 替换旧摘要
    lines.splice(startIdx, endIdx - startIdx + 1, ...summaryLines);
  } else {
    // 在顶部插入（保留可能存在的 #!managed-config 行）
    if (lines[0] && lines[0].startsWith("#!")) {
      lines.splice(1, 0, ...summaryLines, "");
    } else {
      lines.splice(0, 0, ...summaryLines, "");
    }
  }
  
  return lines.join("\n");
}

// ==================== Gist 同步模块 ====================

// 模块级变量：存储从 Gist API 自动发现的文件名
let _discoveredGistFilename = null;

// 从 Gist API 响应中自动发现配置文件名
// 优先选 .conf 结尾的文件，否则取第一个文件
function discoverGistFilename(files) {
  const filenames = Object.keys(files);
  if (filenames.length === 0) throw new Error("Gist 中无任何文件");
  const confFile = filenames.find(f => f.endsWith('.conf'));
  const selected = confFile || filenames[0];
  log("info", "Gist", "自动发现文件名", { selected, total: filenames.length });
  return selected;
}

// 从 Gist 下载当前 Profile
async function downloadProfile() {
  log("info", "Gist", "Profile 下载开始");
  const resp = await httpGet({
    url: `https://api.github.com/gists/${CONFIG.GIST_ID}`,
    headers: {
      "Authorization": `token ${CONFIG.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "Surge-SmartSelector"
    },
    policy: CONFIG.PROXY_POLICY,  // GitHub API 需代理访问
    timeout: 15000
  });
  
  if (resp.status !== 200) {
    log("error", "Gist", "Profile 下载失败", { status: resp.status });
    throw new Error(`Gist download failed: HTTP ${resp.status}`);
  }
  
  const gistData = JSON.parse(resp.body);
  
  // 自动从 Gist 元数据中发现文件名
  _discoveredGistFilename = discoverGistFilename(gistData.files);
  const file = gistData.files[_discoveredGistFilename];
  
  // 如果文件太大，需要通过 raw_url 获取
  if (file.truncated) {
    const rawResp = await httpGet({
      url: file.raw_url,
      policy: CONFIG.PROXY_POLICY,
      timeout: 15000
    });
    log("info", "Gist", "Profile 下载完成 (truncated, via raw_url)", { filename: _discoveredGistFilename });
    return rawResp.body;
  }
  
  log("info", "Gist", "Profile 下载完成", { filename: _discoveredGistFilename });
  return file.content;
}

// Profile 合法性校验（上传前防御）
function validateProfile(text) {
  const requiredSections = ['[General]', '[Proxy]', '[Proxy Group]', '[Rule]'];
  for (const s of requiredSections) {
    if (!text.includes(s)) throw new Error(`Profile 校验失败: 缺少 ${s}`);
  }
  const lineCount = text.split('\n').length;
  if (lineCount < 50) throw new Error(`Profile 校验失败: 行数异常少 (${lineCount}行)，可能被截断`);
  log("info", "Gist", "Profile 校验通过", { lines: lineCount });
}

// 上传更新后的 Profile 到 Gist（使用下载时自动发现的文件名）
async function uploadProfile(content) {
  if (!_discoveredGistFilename) {
    throw new Error("未发现 Gist 文件名，请先执行 downloadProfile");
  }
  log("info", "Gist", "Profile 上传开始", { filename: _discoveredGistFilename });
  validateProfile(content); // 上传前校验 Profile 合法性
  const resp = await httpPatch({
    url: `https://api.github.com/gists/${CONFIG.GIST_ID}`,
    headers: {
      "Authorization": `token ${CONFIG.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "Surge-SmartSelector"
    },
    body: JSON.stringify({
      files: {
        [_discoveredGistFilename]: { content }
      }
    }),
    policy: CONFIG.PROXY_POLICY,
    timeout: 30000
  });
  
  if (resp.status !== 200) {
    log("error", "Gist", "Profile 上传失败", { status: resp.status });
    throw new Error(`Gist upload failed: HTTP ${resp.status}`);
  }
  log("info", "Gist", "Profile 上传完成", { filename: _discoveredGistFilename });
  return true;
}

// ==================== Panel 格式化 ====================

// 格式化 Panel 输出内容（自举设计：从 history 提取历史累积数据）
function formatPanelOutput(weightMap, duration, isColdStart, runCount, cooldownCount, history, regional) {
  let output = "";
  let totalNodes = 0;
  
  for (const [region, priorities] of Object.entries(weightMap)) {
    const nodes = priorities.split(";");
    totalNodes += nodes.length;
    
    // 本轮最优节点（权重最小）
    let bestNode = "", bestWeight = Infinity;
    for (const entry of nodes) {
      const lastColon = entry.lastIndexOf(":");
      if (lastColon <= 0) continue;
      const name = entry.substring(0, lastColon);
      const weight = parseFloat(entry.substring(lastColon + 1));
      if (!Number.isFinite(weight)) continue;
      if (weight < bestWeight) { bestWeight = weight; bestNode = name; }
    }
    
    // 从 history 获取该地区历史平均 EMA 延迟
    const regionNodes = (regional[region] || []).map(n => history.nodes[n]).filter(Boolean);
    const avgLatency = regionNodes.length > 0 
      ? Math.round(regionNodes.reduce((s, n) => s + (n.emaLatency || 0), 0) / regionNodes.length)
      : "?";
    
    if (bestNode) {
      output += `${region}: ${bestNode} ${avgLatency}ms\n`;
    }
  }
  
  const mode = isColdStart ? "🆕冷启动" : `🧠第${runCount}轮`;
  const cooldownInfo = cooldownCount > 0 ? ` | ${cooldownCount}冷却` : "";
  output += `${mode} | ${totalNodes}节点${cooldownInfo} | ${duration}s`;
  return output;
}

// ==================== 主流程 ====================

;(async () => {
  const startTime = Date.now();
  const panel = { title: "Smart 优选", content: "检测中...", icon: "bolt.horizontal.circle.fill", "icon-color": "#5AC8FA" };
  
  // 运行锁：防止 cron 重叠触发导致并发竞争（时间戳防呆，10分钟无心跳视为死锁）
  const LOCK_KEY = "smart_selector_running";
  const LOCK_STALE_MS = 600000; // 10 分钟
  const lockVal = $persistentStore.read(LOCK_KEY);
  const lockTs = lockVal ? Number(lockVal) : 0;
  if (lockTs && (Date.now() - lockTs) < LOCK_STALE_MS) {
    log("warn", "Main", "上一轮仍在运行，跳过本轮", { elapsed: Math.round((Date.now() - lockTs) / 1000) + "s" });
    $done({ title: "Smart 优选", content: "跳过：上一轮仍在运行", icon: "bolt.horizontal.circle.fill", "icon-color": "#FF9500" });
  }
  $persistentStore.write(String(Date.now()), LOCK_KEY);
  
  let originalTestGroupPolicy = null; // 提升到最外层，确保 catch/finally 都能访问
  try {
    // 验证配置
    if (!CONFIG.GITHUB_TOKEN) throw new Error("未配置 GitHub Token");
    if (!CONFIG.GIST_ID) throw new Error("未配置 Gist ID");
    
    // 检测当前网络类型，确定 Smart 组后缀
    const networkType = detectNetworkType(); // "WiFi" | "有线" | "移动"
    const networkSuffix = "-" + networkType;  // "-WiFi" | "-有线" | "-移动"
    log("info", "Main", "Smart Selector 启动", { dryRun: CONFIG.DRY_RUN, network: networkType, suffix: networkSuffix });
    log("debug", "Main", "配置验证通过");
    
    // ==================== API 端点探测（仅 DRY_RUN 模式）====================
    if (CONFIG.DRY_RUN) {
      log("info", "Probe", "开始 API 端点探测");
      
      // 仅探测只读 GET 端点，排除会触发实际操作的 POST 端点
      const endpoints = [
        { method: "GET", path: "/v1/policy_groups" },
        { method: "GET", path: "/v1/policies/benchmark_results" },
        { method: "GET", path: "/v1/policies/detail?policy_name=HK-WiFi" },
        { method: "GET", path: "/v1/policy_groups/select?group_name=HK-WiFi" },
      ];
      
      for (const ep of endpoints) {
        try {
          const result = await surgeAPI(ep.method, ep.path, ep.body || null);
          const resultStr = JSON.stringify(result);
          log("info", "Probe", `✅ ${ep.method} ${ep.path}`, { 
            size: resultStr.length,
            preview: resultStr.slice(0, 200)
          });
        } catch (e) {
          log("info", "Probe", `❌ ${ep.method} ${ep.path}`, { error: e.message });
        }
      }
      log("info", "Probe", "API 端点探测完成");
    }
    
    // 1. 加载历史数据
    let history = loadHistory();
    const isColdStart = !history || history.runCount === 0;
    
    // 2. 从各地区 Smart 组获取代理节点（含 hashMap）
    // 只获取当前网络类型对应的 Smart 组
    // regionData 格式: { HK: { nodes: [...], hashMap: {...}, smartGroup: "HK-WiFi" }, ... }
    const regionData = {};

    for (const [region, groupPrefix] of Object.entries(CONFIG.REGION_GROUPS)) {
      const smartGroupName = groupPrefix + networkSuffix; // e.g. "HK-WiFi" or "HK-有线"
      const { nodes, hashMap } = await getGroupMembers(smartGroupName);
      regionData[region] = { nodes, hashMap, smartGroup: smartGroupName };
      log("info", "Main", `${region} 获取到 ${regionData[region].nodes.length} 个节点`, { smartGroup: smartGroupName });
    }

    // 兼容后续需要 regional 格式的地方
    const regional = {};
    for (const [region, data] of Object.entries(regionData)) {
      regional[region] = data.nodes;
    }

    const activeRegions = Object.entries(regional).filter(([_, nodes]) => nodes.length > 0);
    if (activeRegions.length === 0) throw new Error("无法从策略组获取节点");
    log("info", "Main", "节点获取完成", { 
      regions: activeRegions.map(([r, n]) => `${r}:${n.length}`).join(", ")
    });
    
    const totalNodes = activeRegions.reduce((sum, [_, nodes]) => sum + nodes.length, 0);
    log("info", "Main", "获取代理节点", { total: totalNodes, regions: activeRegions.map(r => r[0]) });
    
    // 确保所有节点有历史记录
    for (const [region, data] of Object.entries(regionData)) {
      for (const name of data.nodes) {
        if (!history.nodes[name]) initNodeHistory(history, name, regional);
      }
    }
    
    // 3. 分层测试：精确测试 Top-N + 地区级测试兆底
    const activeRegionEntries = Object.entries(regionData).filter(([_, data]) => data.nodes.length > 0);

    // 3a. 触发 Surge 内置组延迟测试（获取最新可用节点）
    for (const [region, data] of activeRegionEntries) {
      try {
        await surgeAPI("POST", "/v1/policy_groups/test", { group_name: data.smartGroup });
        log("debug", "Main", `${region} 触发组延迟测试`);
      } catch (e) {
        log("debug", "Main", `${region} 组延迟测试触发失败`, { error: e.message });
      }
    }
    // 自适应等待 benchmark 更新（最多 3s，数据有变化即提前继续）
    const _benchBefore = await getBenchmarkResults();
    const _beforeKeys = Object.keys(_benchBefore);
    const _beforeTesting = _beforeKeys.filter(k => _benchBefore[k] && _benchBefore[k].testing === 1).length;

    let benchmarkData = _benchBefore;
    for (let _poll = 0; _poll < 6; _poll++) {
      await new Promise(r => setTimeout(r, 500));
      benchmarkData = await getBenchmarkResults();
      const currentKeys = Object.keys(benchmarkData);
      const currentTesting = currentKeys.filter(k => benchmarkData[k] && benchmarkData[k].testing === 1).length;
      // 如果 testing 数量减少（测试完成），提前退出
      if (currentTesting < _beforeTesting) break;
    }
    log("info", "Main", "Benchmark 数据刷新完成", { entries: Object.keys(benchmarkData).length });

    // 诊断：输出 benchmark 数据的字段结构（帮助发现 UDP 相关字段）
    if (CONFIG.DRY_RUN && Object.keys(benchmarkData).length > 0) {
      const sampleHash = Object.keys(benchmarkData)[0];
      const sampleData = benchmarkData[sampleHash];
      if (sampleData && typeof sampleData === 'object') {
        const fields = Object.entries(sampleData)
          .filter(([_, v]) => typeof v === 'number')
          .map(([k, v]) => `${k}:${v}`);
        log("info", "Diag", "Benchmark 数值字段", { hash: sampleHash, fields: fields.join(", ") });
      }
    }

    // 映射延迟到节点
    const regionLatencies = {};
    // 映射 UDP 转发能力到节点（按地区）
    const regionUDPCapable = {};
    for (const [region, data] of Object.entries(regionData)) {
      if (data.nodes.length === 0) continue;
      regionLatencies[region] = mapBenchmarkToNodes(benchmarkData, data.hashMap);
      // UDP 能力检测（proxy-test-udp 测试结果）
      const udpData = mapBenchmarkUDP(benchmarkData, data.hashMap);
      regionUDPCapable[region] = udpData;
      // 更新 EMA 延迟
      for (const [name, lat] of Object.entries(regionLatencies[region])) {
        if (history.nodes[name]) {
          history.nodes[name].emaLatency = updateEMA(history.nodes[name].emaLatency, lat);
        }
      }
      // 独立循环：仅在有正向 UDP 测试结果时更新，不因数据缺失覆写已知状态
      for (const name of data.nodes) {
        if (history.nodes[name] && udpData[name]) {
          history.nodes[name].udpCapable = true;
        }
      }
    }

    // 4. 分层测试执行
    const regionResults = {};
    
    if (!CONFIG.DRY_RUN) {
      // 记录测试组的原始选择，测试结束后恢复
      originalTestGroupPolicy = "DIRECT"; // 默认值
      try {
        const testGroupData = await surgeAPI("GET", `/v1/policy_groups/select?group_name=${encodeURIComponent(CONFIG.TEST_GROUP)}`);
        if (testGroupData && testGroupData.policy) {
          originalTestGroupPolicy = testGroupData.policy;
        }
        log("debug", "Main", "记录测试组原始选择", { policy: originalTestGroupPolicy });
      } catch (e) {
        log("debug", "Main", "获取测试组原始选择失败，将恢复为DIRECT", { error: e.message });
      }
    
      // 对每地区 UCB1 Top-N 节点做逐节点精确测试（try/finally 确保测试通道恢复）
      try {
        for (const [region, data] of activeRegionEntries) {
          const targets = selectPreciseTestTargets(history, data.nodes, region, CONFIG.PRECISE_TEST_COUNT);
          if (targets.length === 0) {
            log("info", "Main", `${region} 全部节点处于冷却期，跳过本轮`);
            regionResults[region] = [];
            continue;
          }
          log("info", "Main", `${region} 精确测试目标`, { targets });
              
          const preciseResults = [];
          for (const nodeName of targets) {
            const result = await testSingleNode(nodeName, region);
            // 补充 benchmark 延迟
            result.latency = regionLatencies[region] ? regionLatencies[region][nodeName] || null : null;
            preciseResults.push(result);
          }
              
          // 4a. 非精确测试节点：使用精确测试的平均值作为地区信号
          const avgSpeed = preciseResults.reduce((s, r) => s + r.speedBps, 0) / (preciseResults.length || 1);
          const avgUnlock = preciseResults.reduce((s, r) => s + r.unlockScore, 0) / (preciseResults.length || 1);
          const avgDetails = preciseResults.length > 0 ? preciseResults[0].unlockDetails : [];
              
          const otherNodes = data.nodes.filter(n => !targets.includes(n));
          const otherResults = otherNodes.map(nodeName => ({
            proxyName: nodeName,
            region,
            latency: regionLatencies[region] ? regionLatencies[region][nodeName] || null : null,
            unlockScore: avgUnlock, // 使用地区平均值
            unlockDetails: avgDetails,
            speedBps: avgSpeed, // 使用地区平均值
            speedElapsed: null
          }));
              
          regionResults[region] = [...preciseResults, ...otherResults];
              
          // 更新历史
          for (const result of regionResults[region]) {
            updateNodeHistory(history, result);
          }
        }
      } finally {
        // 循环结束后统一恢复“速度测试”组（try/finally 确保即使异常也能恢复）
        try {
          await switchGroupPolicy(CONFIG.TEST_GROUP, originalTestGroupPolicy);
          log("info", "Main", "测试通道已恢复", { restored: originalTestGroupPolicy });
        } catch (e) {
          log("warn", "Main", "测试通道恢复失败", { error: e.message });
        }
      }
    } else {
      // DRY_RUN 模式：通过 TEST_GROUP 路由测试流量（不影响活跃 Smart 组）
      // 记录测试组原始选择
      originalTestGroupPolicy = "DIRECT";
      try {
        const testGroupData = await surgeAPI("GET", `/v1/policy_groups/select?group_name=${encodeURIComponent(CONFIG.TEST_GROUP)}`);
        if (testGroupData && testGroupData.policy) {
          originalTestGroupPolicy = testGroupData.policy;
        }
      } catch (e) { /* ignore */ }
    
      // 解锁并行（通过 TEST_GROUP 路由，不影响活跃 Smart 组）
      const unlockResults = await Promise.all(
        activeRegionEntries.map(async ([region, data]) => {
          const unlockResult = await checkRegionUnlock(region, CONFIG.TEST_GROUP);
          return { region, unlockResult };
        })
      );
      const unlockMap = {};
      for (const { region, unlockResult } of unlockResults) {
        unlockMap[region] = unlockResult;
      }
          
      // 测速串行
      for (const [region, data] of activeRegionEntries) {
        const speedResult = await testRegionSpeed(region, CONFIG.TEST_GROUP);
        const unlockResult = unlockMap[region];
            
        regionResults[region] = data.nodes.map(nodeName => ({
          proxyName: nodeName,
          region,
          latency: regionLatencies[region] ? regionLatencies[region][nodeName] || null : null,
          unlockScore: unlockResult.unlockScore,
          unlockDetails: unlockResult.details,
          speedBps: speedResult ? speedResult.speedBps : 0,
          speedElapsed: speedResult ? speedResult.elapsed : null
        }));
            
        for (const result of regionResults[region]) {
          updateNodeHistory(history, result);
        }
      }
    
      // 恢复测试组
      try {
        await switchGroupPolicy(CONFIG.TEST_GROUP, originalTestGroupPolicy);
      } catch (e) { /* ignore */ }
    }
    
    
    // 5. 重新计算所有节点的综合评分
    recalculateAllScores(history);
    
    // 6. 基于 ML 模型生成权重（对所有已知节点）
    const weightMap = generateWeightsFromModel(history, regional, networkType);
    if (Object.keys(weightMap).length === 0) throw new Error("无有效测试结果");
    
    // 7. 构建地区综合分数据（供 Fallback 重排使用）
    const regionScores = {};
    for (const [region, data] of Object.entries(regionData)) {
      if (data.nodes.length === 0) continue;
      // 计算地区平均延迟
      const latencies = Object.values(regionLatencies[region] || {});
      const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 999;
      // 从 regionResults 中获取平均解锁和速度
      const results = regionResults[region] || [];
      const avgUnlock = results.length > 0 ? results.reduce((s, r) => s + r.unlockScore, 0) / results.length : 0;
      const avgSpeedBps = results.length > 0 ? results.reduce((s, r) => s + r.speedBps, 0) / results.length : 0;
      const speedMbps = (avgSpeedBps * 8) / 1048576; // 转换为 Mbps
      
      regionScores[region] = {
        unlock: avgUnlock,
        speedMbps: speedMbps,
        latencyMs: avgLatency,
      };
    }
    // 计算本轮 min/max
    const allSpeeds = Object.values(regionScores).map(s => s.speedMbps || 0).filter(s => s > 0);
    const currentMax = allSpeeds.length > 0 ? Math.max(...allSpeeds) : 0;
    const currentMin = allSpeeds.length > 0 ? Math.min(...allSpeeds) : 0;

    // EMA 平滑 min/max（按网络类型存储）
    const SPEED_RANGE_ALPHA = 0.7;  // 当前轮 70%，历史 30%
    if (!history.speedRange) history.speedRange = {};
    let minSpeedMbps, maxSpeedMbps;

    if (allSpeeds.length > 0) {
      // 有成功测速数据，更新 EMA
      const prevRange = history.speedRange[networkType] || { emaMin: currentMin, emaMax: currentMax };
      const emaMax = SPEED_RANGE_ALPHA * currentMax + (1 - SPEED_RANGE_ALPHA) * prevRange.emaMax;
      const emaMin = SPEED_RANGE_ALPHA * currentMin + (1 - SPEED_RANGE_ALPHA) * prevRange.emaMin;
      // 保存
      history.speedRange[networkType] = { emaMin, emaMax };
      // 防御边界：emaMax <= emaMin 时避免除零
      minSpeedMbps = emaMin;
      maxSpeedMbps = emaMax > emaMin ? emaMax : emaMin + 0.01;
      log("info", "Main", "速度范围 EMA", { currentMin: currentMin.toFixed(2), currentMax: currentMax.toFixed(2), emaMin: emaMin.toFixed(2), emaMax: emaMax.toFixed(2), network: networkType });
    } else {
      // 本轮无成功测速数据，跳过 speedRange 更新，使用历史值或默认值
      const prevRange = history.speedRange[networkType];
      if (prevRange) {
        minSpeedMbps = prevRange.emaMin;
        maxSpeedMbps = prevRange.emaMax > prevRange.emaMin ? prevRange.emaMax : prevRange.emaMin + 0.01;
      } else {
        minSpeedMbps = 0;
        maxSpeedMbps = 1;
      }
      log("info", "Main", "速度范围 EMA", { note: "本轮无测速数据，使用历史值", minSpeedMbps: minSpeedMbps.toFixed(2), maxSpeedMbps: maxSpeedMbps.toFixed(2), network: networkType });
    }
    log("info", "Main", "地区综合分", { scores: Object.fromEntries(Object.entries(regionScores).map(([r, s]) => [r, calcRegionScore(s, "overall", minSpeedMbps, maxSpeedMbps).toFixed(3)])) });
    
    // 8. 下载 Profile -> 更新 Smart 组权重 -> Fallback 重排 -> 上传 Gist
    log("info", "Main", "Profile 同步流程开始");
    const profile = await downloadProfile();
    // 8a. 更新 Smart 组的 policy-priority（只更新当前网络类型的 Smart 组）
    const profileWithWeights = updateProfileWeights(profile, weightMap, networkSuffix, regionScores, networkType);
    // 8a2. 更新 UDP Smart 组的 policy-regex-filter（仅纳入 UDP 转发能力节点）
    const profileWithUDP = updateUDPGroupFilters(profileWithWeights, regionUDPCapable);
    // 8b. 对 Fallback 组做地区重排（传入各地区解锁详情，用于一票否决机制）
    const unlockDetails = {};
    for (const [region, results] of Object.entries(regionResults)) {
      if (results.length > 0 && results[0].unlockDetails) {
        unlockDetails[region] = results[0].unlockDetails;
      }
    }
    const updatedProfile = reorderFallbackGroups(profileWithUDP, regionScores, unlockDetails, minSpeedMbps, maxSpeedMbps);
    
    // 8c. 先更新轮次和首次时间（摘要需要读取这些值）
    if (!history.firstRun) {
      history.firstRun = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "2-digit", day: "2-digit" });
    }
    history.runCount = (history.runCount || 0) + 1;

    // 生成摘要（此时 history 中的轮次和首次时间已是最新）
    const finalProfile = insertProfileSummary(updatedProfile, weightMap, networkType, history, regional);
    
    if (CONFIG.DRY_RUN) {
      log("info", "DryRun", "跳过 Gist 上传", { regions: Object.keys(weightMap) });
    } else {
      await uploadProfile(finalProfile);
      log("info", "Main", "Profile 同步完成");
    }
    
    // 9. 不自动重载 Profile（用户手动控制重载时机，避免中断活跃连接）
    log("info", "Main", "跳过 Profile 重载（由用户手动触发）");
    
    // DRY_RUN 模式下额外打印调试信息
    if (CONFIG.DRY_RUN) {
      // 打印每个地区的权重详情
      for (const [region, priorities] of Object.entries(weightMap)) {
        log("info", "DryRun", `${region} 权重`, { priorities });
      }
      // 打印 top 节点信息
      for (const [region, results] of Object.entries(regionResults)) {
        if (results.length > 0) {
          const sorted = results.sort((a, b) => (b.speedBps || 0) - (a.speedBps || 0));
          log("info", "DryRun", `${region} 测试结果`, {
            tested: results.length,
            best: sorted[0].proxyName,
            bestSpeed: (sorted[0].speedBps / 1048576).toFixed(2) + "MB/s"
          });
        }
      }
    }
    
    // 10. 保存历史数据（先清理过期节点）
    const HISTORY_RETENTION_DAYS = 7;
    const retentionMs = HISTORY_RETENTION_DAYS * 86400000;
    const currentNodes = new Set(Object.values(regional).flat());
    const nowCleanup = Date.now();
    for (const [name, node] of Object.entries(history.nodes)) {
      if (!currentNodes.has(name) && node.lastTestTime && (nowCleanup - node.lastTestTime > retentionMs)) {
        delete history.nodes[name];
        // 同步清理各网络类型下的旧权重基线
        if (history.regionWeights) {
          for (const weights of Object.values(history.regionWeights)) {
            if (weights && weights[name] !== undefined) delete weights[name];
          }
        }
        log("debug", "Main", "清理过期节点", { name, lastTest: new Date(node.lastTestTime).toISOString() });
      }
    }
    
    // 保存历史数据
    history.lastRun = new Date().toISOString();
    saveHistory(history);
    
    // 11. Panel 输出
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    // 统计处于冷却期的节点数
    const now = Date.now();
    const cooldownCount = Object.values(history.nodes).filter(n => n.cooldownUntil && now < n.cooldownUntil).length;
    panel.content = formatPanelOutput(weightMap, duration, isColdStart, history.runCount, cooldownCount, history, regional);
    panel["icon-color"] = "#4CD964";
    if (CONFIG.DRY_RUN) {
      panel.content = "🧪 DRY RUN 模式\n" + panel.content;
      panel["icon-color"] = "#FF9500";
    }
    log("info", "Main", "Smart Selector 完成", { duration, runCount: history.runCount, cooldownCount });
    $notification.post("Smart优选完成", `耗时${duration}s | 第${history.runCount}轮`, "");
    
  } catch (e) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    panel.content = `失败: ${e.message || e}\n耗时: ${duration}s`;
    panel["icon-color"] = "#FF3B30";
    log("error", "Main", "Smart Selector 失败", { error: e.message || String(e), duration });
    $notification.post("Smart优选失败", "", e.message || e);
    // 异常时恢复测试组（防止测试组停留在测试节点）
    if (originalTestGroupPolicy) {
      try { await switchGroupPolicy(CONFIG.TEST_GROUP, originalTestGroupPolicy); } catch (_) {}
    }
  } finally {
    // 无论如何都释放运行锁
    $persistentStore.write("0", LOCK_KEY);
  }
  
  $done(panel);
})();
