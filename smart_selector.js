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
  UNLOCK_TIMEOUT: 5000,
  SPEED_FILE_SIZE: 2097152, // 2MB
  // 网络防抖配置
  DEBOUNCE_WINDOW: 2,          // 连续失败次数阈值，连续 N 次结果一致才更新评分
  OUTLIER_THRESHOLD: 2.0,      // 离群值检测倍数，偏差超过 N 倍标准差时降低更新权重
  // 冷却期配置
  COOLDOWN_DURATION: 1800000,  // 冷却时长 30 分钟
  COOLDOWN_TRIGGER_FAILURES: 3, // 触发冷却的连续失败次数
  PROXY_POLICY: "节点选择",  // 用于外部请求（GitHub API等）的代理策略名
  REGION_GROUPS: {
    HK: "HK",
    TW: "TW",
    JP: "JP",
    SG: "SG",
    US: "US"
  },
  REGION_PATTERNS: {
    HK: /香港|HK|Hong\s?Kong|🇭🇰/i,
    TW: /台湾|TW|Taiwan|🇹🇼/i,
    JP: /日本|JP|Japan|🇯🇵/i,
    SG: /新加坡|SG|Singapore|🇸🇬/i,
    US: /美国|US|United\s?States|🇺🇸/i
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

// ==================== 并发控制 ====================

// 控制并发的 Promise 池
async function asyncPool(limit, items, fn) {
  const results = [];
  const executing = new Set();
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.allSettled(results);
}

// ==================== Surge HTTP API 封装 ====================

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

// 获取代理节点详情（含延迟）
async function getProxyDetail(name) {
  return await surgeAPI("GET", `/v1/policies/detail?policy_name=${encodeURIComponent(name)}`);
}

// 批量延迟测试
async function testLatency(names) {
  return await surgeAPI("POST", "/v1/policies/test", { policy_names: names });
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

// 获取所有策略组
async function getPolicyGroups() {
  return await surgeAPI("GET", "/v1/policy_groups");
}

// 重载配置
async function reloadProfile() {
  await surgeAPI("POST", "/v1/profiles/reload");
}

// ==================== 网络类型检测 ====================

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
      // pdp_ip0 = Cellular on iOS, utun = VPN tunnel
      if (iface.startsWith("pdp_ip") || iface.startsWith("utun")) {
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

const UNLOCK_TARGETS = {
  HK: [
    { name: "Netflix", url: "https://www.netflix.com/title/81280792", check: (status, body) => status === 200 || status === 301 },
    { name: "Disney+", url: "https://www.disneyplus.com/", check: (status, body) => status >= 200 && status < 400 },
    { name: "Gemini", url: "https://gemini.google.com/", check: (status, body) => status >= 200 && status < 400 }
  ],
  TW: [
    { name: "Netflix", url: "https://www.netflix.com/title/81280792", check: (status, body) => status === 200 || status === 301 },
    { name: "Disney+", url: "https://www.disneyplus.com/", check: (status, body) => status >= 200 && status < 400 },
    { name: "Gemini", url: "https://gemini.google.com/", check: (status, body) => status >= 200 && status < 400 }
  ],
  JP: [
    { name: "Netflix", url: "https://www.netflix.com/title/81280792", check: (status, body) => status === 200 || status === 301 },
    { name: "Disney+", url: "https://www.disneyplus.com/", check: (status, body) => status >= 200 && status < 400 },
    { name: "Gemini", url: "https://gemini.google.com/", check: (status, body) => status >= 200 && status < 400 }
  ],
  SG: [
    { name: "Netflix", url: "https://www.netflix.com/title/81280792", check: (status, body) => status === 200 || status === 301 },
    { name: "Disney+", url: "https://www.disneyplus.com/", check: (status, body) => status >= 200 && status < 400 },
    { name: "Gemini", url: "https://gemini.google.com/", check: (status, body) => status >= 200 && status < 400 }
  ],
  US: [
    { name: "Netflix", url: "https://www.netflix.com/title/81280792", check: (status, body) => status === 200 || status === 301 },
    { name: "Disney+", url: "https://www.disneyplus.com/", check: (status, body) => status >= 200 && status < 400 },
    { name: "Gemini", url: "https://gemini.google.com/", check: (status, body) => status >= 200 && status < 400 },
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
  HK: { url: "http://cachefly.cachefly.net/2mb.test", size: 2097152 },
  TW: { url: "http://cachefly.cachefly.net/2mb.test", size: 2097152 },
  JP: { url: "http://cachefly.cachefly.net/2mb.test", size: 2097152 },
  SG: { url: "http://cachefly.cachefly.net/2mb.test", size: 2097152 },
  US: { url: "http://cachefly.cachefly.net/2mb.test", size: 2097152 },
  DEFAULT: { url: "http://cachefly.cachefly.net/2mb.test", size: 2097152 }
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
    const elapsed = (Date.now() - startTime) / 1000;
    const speedBps = testFile.size / elapsed;
    log("debug", "Speed", `${region} (${smartGroupName})`, { speedMbps: (speedBps * 8 / 1048576).toFixed(2), elapsed: elapsed.toFixed(2) });
    return { speedBps, elapsed };
  } catch (e) {
    log("warn", "Speed", `${region} (${smartGroupName}) 测速失败`, { error: e.message });
    return null;
  }
}

// ==================== 综合测试（已重构为地区级）====================

// ==================== ML 算法模块 ====================

// EMA（指数移动平均）- alpha 越大，新数据权重越高
function updateEMA(oldEMA, newValue, alpha = 0.3) {
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

// UCB1 (Upper Confidence Bound) - 探索与利用平衡
function ucb1Score(nodeScore, totalRounds, nodeTests, C = 1.5) {
  if (nodeTests === 0) return Infinity; // 未测试过的节点优先探索
  return nodeScore + C * Math.sqrt(Math.log(totalRounds) / nodeTests);
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
  
  // 速率分 (归一化到 0-1，假设 10MB/s 为满分)
  const speedScore = Math.min((node.emaSpeed || 0) / 10485760, 1.0);
  
  // 延迟分 (越低越好，映射到 0-1)
  const latencyScore = node.emaLatency ? Math.max(1 - node.emaLatency / 500, 0) : 0.5;
  
  // 解锁概率
  const unlockProb = getUnlockProbability(node.unlockAlpha || 1, node.unlockBeta || 1);
  
  // 解锁门控：只要有解锁（unlockProb > 0 表示 Beta 分布中有成功记录）即为合格
  // unlockProb 来自 Beta 分布，反映历史解锁成功率
  const unlockGate = unlockProb > 0.3 ? 1.0   // 有解锁记录 → 不惩罚
                   : unlockProb > 0.1 ? 0.5   // 解锁不稳定 → 轻微惩罚
                   : 0.1;                      // 基本不解锁 → 重惩罚

  // 速率和延迟的质量分
  const qualityScore = speedScore * 0.6 + latencyScore * 0.4;

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
    cooldownUntil: 0           // 冷却结束时间戳，0 表示不在冷却中
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
  
  // Beta 分布更新（带防抖：只有连续失败达到阈值才降低解锁评分）
  if (unlocked) {
    const beta = updateBetaDistribution(node.unlockAlpha, node.unlockBeta, true);
    node.unlockAlpha = beta.alpha;
    node.unlockBeta = beta.beta;
  } else if (node.consecutiveFailures >= CONFIG.DEBOUNCE_WINDOW) {
    // 连续失败达到防抖窗口，才真正更新 Beta 分布的失败计数
    const beta = updateBetaDistribution(node.unlockAlpha, node.unlockBeta, false);
    node.unlockAlpha = beta.alpha;
    node.unlockBeta = beta.beta;
  } else if (!unlocked) {
    log("debug", "Debounce", "防抖生效-跳过Beta更新", { node: result.proxyName });
  }
  // 单次失败不更新 Beta 分布，等待后续结果确认
  
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

// ==================== UCB1 选择与模型权重生成 ====================

// UCB1 选择测试目标
function selectTestTargets(history, nodes, region, count) {
  const totalRounds = history.runCount || 1;
  const now = Date.now();
  
  const scored = nodes
    .filter(name => {
      // 跳过处于冷却期的节点
      const node = history.nodes[name];
      if (node && node.cooldownUntil && now < node.cooldownUntil) return false;
      return true;
    })
    .map(name => {
      const node = history.nodes[name];
      if (!node || node.totalTests === 0) {
        return { name, ucb: Infinity }; // 未测试过优先
      }
      const ucb = ucb1Score(node.score, totalRounds, node.totalTests, 1.5);
      return { name, ucb };
    });
  
  // 按 UCB 分数降序
  scored.sort((a, b) => b.ucb - a.ucb);
  const selected = scored.slice(0, count).map(s => s.name);
  log("debug", "ML", "UCB1选择", { region, selected });
  return selected;
}

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
    
    // 计算原始权重
    const rawEntries = nodes
      .map(name => {
        const node = history.nodes[name];
        if (!node) return null;
        // score 高 -> weight 低 -> 优先级高
        // score 范围 [0, 1] -> weight 映射到 [0.3, 3.0]
        const weight = clamp(mapRange(node.score, 0, 1, 3.0, 0.3), 0.3, 3.0);
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

// 数值映射工具
function mapRange(value, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return (outMin + outMax) / 2;
  return outMin + (value - inMin) * (outMax - outMin) / (inMax - inMin);
}

// 数值限制
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// 计算单个节点权重
// unlockScore: 0-1, speedBps: bytes/s, latencyMs: ms, maxSpeedInGroup: bytes/s
function calculateWeight(unlockScore, speedBps, latencyMs, maxSpeedInGroup) {
  // 解锁系数: 有解锁=0.6, 不确定=1.0, 无解锁=2.5
  const unlockFactor = unlockScore > 0 ? 0.6 
                     : 2.5;
  
  // 速率系数: 归一化到 [0.5, 1.5]（速度越高系数越低=优先级越高）
  const speedFactor = maxSpeedInGroup > 0 
    ? mapRange(speedBps, 0, maxSpeedInGroup, 1.5, 0.5) 
    : 1.0;
  
  // 延迟系数: <100ms=0.8, 100-300ms=1.0, >300ms=1.3
  const latencyFactor = !latencyMs ? 1.0
                       : latencyMs < 100 ? 0.8 
                       : latencyMs < 300 ? 1.0 
                       : 1.3;
  
  // 综合 (clamp 到 [0.3, 3.0])
  return clamp(unlockFactor * speedFactor * latencyFactor, 0.3, 3.0);
}

// ==================== Profile 更新模块 ====================

// 匹配 Smart 组所属地区
function matchSmartGroupRegion(groupLine) {
  for (const [region, pattern] of Object.entries(CONFIG.REGION_PATTERNS)) {
    if (pattern.test(groupLine)) return region;
  }
  return null;
}

// 更新 Profile 中 Smart 组的 policy-priority 参数
// profileText: 完整的 Surge 配置文本
// weightMap: { "HK": "NodeA:0.6;NodeB:1.2", "JP": "..." }
// suffix: 当前网络类型后缀，如 "-WiFi"，只更新匹配该后缀的 Smart 组
// 返回修改后的完整配置文本
function updateProfileWeights(profileText, weightMap, suffix) {
  const lines = profileText.split("\n");
  let inProxyGroup = false;
  let currentSection = "";
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // 检测 section 切换
    if (line.startsWith("[")) {
      currentSection = line;
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
      const commentIdx = lines[i].indexOf("//");
      if (commentIdx > 0) {
        const configPart = lines[i].substring(0, commentIdx).replace(/\s*$/, "");
        const commentPart = lines[i].substring(commentIdx);
        lines[i] = `${configPart}, ${priorityValue} ${commentPart}`;
      } else {
        lines[i] = lines[i].replace(/\s*$/, `, ${priorityValue}`);
      }
    }
  }
  
  return lines.join("\n");
}

// ==================== Fallback 地区排序模块 ====================

// Fallback 组重排配置
const FALLBACK_REORDER_CONFIG = {
  "代理容灾": { exclude: [], sortBy: "overall" },
  "Google容灾": { exclude: [], sortBy: "latency" },
  "Netflix容灾": { exclude: [], sortBy: "unlock" },
  "流媒体容灾": { exclude: [], sortBy: "unlock" },
  "AIGC容灾": { exclude: ["HK"], sortBy: "overall" },
  "游戏容灾": { exclude: ["US", "TW"], sortBy: "latency", suffix: ["DIRECT"] },
  "TG容灾": { exclude: [], sortBy: "latency" },
  "Apple容灾": { regions: ["HK", "US", "JP"], sortBy: "latency" },
};

// 计算地区综合分
// regionScores 格式: { HK: { unlock, speedMbps, latencyMs }, ... }
function calcRegionScore(regionData, sortBy) {
  const unlock = regionData.unlock || 0;          // 0-1
  const speed = regionData.speedMbps || 0;         // Mbps
  const latency = regionData.latencyMs || 999;     // ms
  
  // 归一化
  const speedNorm = Math.min(speed / 20, 1);              // 20Mbps 满分
  const latencyNorm = 1 - Math.min(latency / 500, 1);    // 500ms 零分
  
  if (sortBy === "latency") {
    // 延迟优先：延迟占 60%，速度 25%，解锁 15%
    return latencyNorm * 0.6 + speedNorm * 0.25 + unlock * 0.15;
  } else if (sortBy === "unlock") {
    // 解锁优先：解锁占 50%，速度 30%，延迟 20%
    return unlock * 0.5 + speedNorm * 0.3 + latencyNorm * 0.2;
  } else {
    // overall 综合分
    return unlock * 0.3 + speedNorm * 0.4 + latencyNorm * 0.3;
  }
}

// 对 Profile 中的 Fallback 组做地区重排
function reorderFallbackGroups(profileText, regionScores) {
  const lines = profileText.split("\n");
  let inProxyGroup = false;
  let currentSection = "";
  
  // 所有可能的地区简称
  const ALL_REGIONS = Object.keys(CONFIG.REGION_GROUPS);
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // 检测 section 切换
    if (line.startsWith("[")) {
      currentSection = line;
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
    const eqIndex = lines[i].indexOf("=");
    const afterEq = lines[i].substring(eqIndex + 1).trim();
    
    // 分离参数部分（url=, interval=, timeout=, evaluate-before-use=, hidden=, icon-url= 等）
    const parts = afterEq.split(",").map(p => p.trim());
    const policyType = parts[0]; // "fallback"
    
    // 分离成员和参数
    const members = [];
    const params = [];
    const paramPattern = /^(url|interval|timeout|evaluate-before-use|hidden|icon-url|no-alert|policy-regex-filter)\s*=/;
    
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
      sortableRegions = regionMembers.filter(r => !config.exclude.includes(r));
    }
    
    // 按分数排序（降序：分高优先）
    sortableRegions.sort((a, b) => {
      const scoreA = regionScores[a] ? calcRegionScore(regionScores[a], config.sortBy) : 0;
      const scoreB = regionScores[b] ? calcRegionScore(regionScores[b], config.sortBy) : 0;
      return scoreB - scoreA;
    });
    
    // 重组成员列表
    // 被 exclude 的地区不参与，也不保留在结果中
    let newMembers = [...sortableRegions];
    
    // 添加特殊后缀
    if (config.suffix) {
      // 使用配置的 suffix
      newMembers = newMembers.concat(config.suffix);
    } else {
      // 保留原来的特殊成员在末尾
      newMembers = newMembers.concat(specialMembers);
    }
    
    // 重组行
    const prefix = lines[i].substring(0, eqIndex + 1);
    const newLine = `${prefix} ${policyType}, ${newMembers.join(", ")}${params.length > 0 ? ", " + params.join(", ") : ""}`;
    lines[i] = newLine;
    
    log("info", "Fallback", "地区排序", { group: groupName, order: sortableRegions });
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

// 上传更新后的 Profile 到 Gist（使用下载时自动发现的文件名）
async function uploadProfile(content) {
  if (!_discoveredGistFilename) {
    throw new Error("未发现 Gist 文件名，请先执行 downloadProfile");
  }
  log("info", "Gist", "Profile 上传开始", { filename: _discoveredGistFilename });
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

// 格式化 Panel 输出内容
function formatPanelOutput(weightMap, duration, isColdStart, runCount, cooldownCount) {
  let output = "";
  let totalNodes = 0;
  
  for (const [region, priorities] of Object.entries(weightMap)) {
    const nodes = priorities.split(";");
    totalNodes += nodes.length;
    // 找到该地区最优节点（权重最小）
    let bestNode = "";
    let bestWeight = Infinity;
    for (const entry of nodes) {
      const [name, w] = entry.split(":");
      const weight = parseFloat(w);
      if (weight < bestWeight) {
        bestWeight = weight;
        bestNode = name;
      }
    }
    output += `${region}: ${bestNode}(${bestWeight.toFixed(1)})\n`;
  }
  
  const mode = isColdStart ? "🆕冷启动" : `🧠第${runCount}轮`;
  const cooldownInfo = cooldownCount > 0 ? ` | ${cooldownCount}节点冷却中` : "";
  output += `${mode} | 共${totalNodes}节点${cooldownInfo} | ${duration}s`;
  return output;
}

// ==================== 主流程 ====================

;(async () => {
  const startTime = Date.now();
  const panel = { title: "Smart 优选", content: "检测中...", icon: "bolt.horizontal.circle.fill", "icon-color": "#5AC8FA" };
  
  try {
    // 验证配置
    if (!CONFIG.GITHUB_TOKEN) throw new Error("未配置 GitHub Token");
    if (!CONFIG.GIST_ID) throw new Error("未配置 Gist ID");
    
    // 检测当前网络类型，确定 Smart 组后缀
    const networkType = detectNetworkType(); // "WiFi" | "有线" | "移动"
    const networkSuffix = "-" + networkType;  // "-WiFi" | "-有线" | "-移动"
    log("info", "Main", "Smart Selector 启动", { dryRun: CONFIG.DRY_RUN, network: networkType, suffix: networkSuffix });
    log("debug", "Main", "配置验证通过");
    
    // ==================== API 端点探测（仅 DRY_RUN 模式，带缓存）====================
    if (CONFIG.DRY_RUN) {
      // 检查 probe 缓存是否有效（24小时过期）
      const PROBE_CACHE_KEY = "smart_selector_probe_cache";
      const PROBE_CACHE_TTL = 86400000; // 24小时
      let probeCache = null;
      try {
        const raw = $persistentStore.read(PROBE_CACHE_KEY);
        if (raw) probeCache = JSON.parse(raw);
      } catch (e) { /* ignore */ }
      
      const probeCacheValid = probeCache && probeCache.timestamp && (Date.now() - probeCache.timestamp < PROBE_CACHE_TTL);
      
      if (probeCacheValid) {
        log("info", "Probe", "使用缓存的探测结果", { age: ((Date.now() - probeCache.timestamp) / 3600000).toFixed(1) + "h" });
      } else {
        log("info", "Probe", "开始 API 端点探测（首次或缓存已过期）");
        
        // 仅探测只读 GET 端点，排除会触发实际操作的 POST 端点
        const endpoints = [
          { method: "GET", path: "/v1/policy_groups" },
          { method: "GET", path: "/v1/policies/benchmark_results" },
          { method: "GET", path: "/v1/policies/detail?policy_name=HK-WiFi" },
          { method: "GET", path: "/v1/policy_groups/select?group_name=HK-WiFi" },
        ];
        
        const probeResults = {};
        for (const ep of endpoints) {
          try {
            const result = await surgeAPI(ep.method, ep.path, ep.body || null);
            const resultStr = JSON.stringify(result);
            probeResults[`${ep.method} ${ep.path}`] = { ok: true, size: resultStr.length };
            log("info", "Probe", `✅ ${ep.method} ${ep.path}`, { 
              size: resultStr.length,
              preview: resultStr.slice(0, 200)
            });
          } catch (e) {
            probeResults[`${ep.method} ${ep.path}`] = { ok: false, error: e.message };
            log("info", "Probe", `❌ ${ep.method} ${ep.path}`, { error: e.message });
          }
        }
        
        // 缓存探测结果
        $persistentStore.write(JSON.stringify({ timestamp: Date.now(), results: probeResults }), PROBE_CACHE_KEY);
        log("info", "Probe", "API 端点探测完成，结果已缓存");
      }
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
    
    // 3. 获取 benchmark 延迟数据（逐节点，通过 lineHash 映射）
    const benchmarkData = await getBenchmarkResults();
    log("info", "Main", "Benchmark 数据获取完成", { entries: Object.keys(benchmarkData).length });
    
    // 确保所有节点有历史记录
    for (const [region, data] of Object.entries(regionData)) {
      for (const name of data.nodes) {
        if (!history.nodes[name]) initNodeHistory(history, name, regional);
      }
    }
    
    // 4. 对每个地区执行解锁检测和测速（通过 Smart 组级路由）
    const regionResults = {};
    
    // 预处理：映射延迟数据到各地区节点
    const regionLatencies = {};
    for (const [region, data] of Object.entries(regionData)) {
      if (data.nodes.length === 0) continue;
      const nodeLatencies = mapBenchmarkToNodes(benchmarkData, data.hashMap);
      regionLatencies[region] = nodeLatencies;
      log("debug", "Main", `${region} 延迟映射`, { mapped: Object.keys(nodeLatencies).length, total: data.nodes.length });
      
      // 更新历史中的延迟 EMA
      for (const [name, lat] of Object.entries(nodeLatencies)) {
        if (history.nodes[name]) {
          history.nodes[name].emaLatency = updateEMA(history.nodes[name].emaLatency, lat);
        }
      }
    }
    
    // 阶段1：所有地区的解锁检测并行执行（各地区走不同代理节点，互不影响）
    const activeRegionEntries = Object.entries(regionData).filter(([_, data]) => data.nodes.length > 0);
    const unlockResults = await Promise.all(
      activeRegionEntries.map(async ([region, data]) => {
        const unlockResult = await checkRegionUnlock(region, data.smartGroup);
        log("info", "Unlock", `${region} 解锁检测`, { score: unlockResult.unlockScore, details: unlockResult.details });
        return { region, unlockResult };
      })
    );
    
    // 构建解锁结果映射：region -> unlockResult
    const unlockMap = {};
    for (const { region, unlockResult } of unlockResults) {
      unlockMap[region] = unlockResult;
    }
    
    // 阶段2：测速串行执行（避免带宽互相干扰）
    for (const [region, data] of activeRegionEntries) {
      const smartGroupName = data.smartGroup;
      const nodeLatencies = regionLatencies[region];
      const unlockResult = unlockMap[region];
      
      // 地区级测速
      const speedResult = await testRegionSpeed(region, smartGroupName);
      log("info", "Speed", `${region} 测速`, speedResult ? { speedMbps: (speedResult.speedBps / 1048576).toFixed(2), elapsed: speedResult.elapsed.toFixed(1) } : { failed: true });
      
      // 为该地区每个节点生成结果（延迟逐节点，解锁/速度共享地区值）
      regionResults[region] = data.nodes.map(nodeName => ({
        proxyName: nodeName,
        region,
        latency: nodeLatencies[nodeName] || null,
        unlockScore: unlockResult.unlockScore,
        unlockDetails: unlockResult.details,
        speedBps: speedResult ? speedResult.speedBps : 0,
        speedElapsed: speedResult ? speedResult.elapsed : null
      }));
      
      // 更新历史数据
      for (const result of regionResults[region]) {
        updateNodeHistory(history, result);
      }
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
      const unlockResult = unlockMap[region];
      // 计算地区平均延迟
      const latencies = Object.values(regionLatencies[region] || {});
      const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 999;
      // 计算地区测速（从 regionResults 中获取）
      const regionResult = regionResults[region];
      const speedBps = (regionResult && regionResult.length > 0) ? regionResult[0].speedBps : 0;
      const speedMbps = (speedBps * 8) / 1048576; // 转换为 Mbps
      
      regionScores[region] = {
        unlock: unlockResult ? unlockResult.unlockScore : 0,
        speedMbps: speedMbps,
        latencyMs: avgLatency
      };
    }
    log("info", "Main", "地区综合分", { scores: Object.fromEntries(Object.entries(regionScores).map(([r, s]) => [r, calcRegionScore(s, "overall").toFixed(3)])) });
    
    // 8. 下载 Profile -> 更新 Smart 组权重 -> Fallback 重排 -> 上传 Gist
    log("info", "Main", "Profile 同步流程开始");
    const profile = await downloadProfile();
    // 8a. 更新 Smart 组的 policy-priority（只更新当前网络类型的 Smart 组）
    const profileWithWeights = updateProfileWeights(profile, weightMap, networkSuffix);
    // 8b. 对 Fallback 组做地区重排
    const updatedProfile = reorderFallbackGroups(profileWithWeights, regionScores);
    
    if (CONFIG.DRY_RUN) {
      log("info", "DryRun", "跳过 Gist 上传", { regions: Object.keys(weightMap) });
    } else {
      await uploadProfile(updatedProfile);
      log("info", "Main", "Profile 同步完成");
    }
    
    // 9. 触发 Surge 重载
    if (CONFIG.DRY_RUN) {
      log("info", "DryRun", "跳过 Profile 重载");
    } else {
      await reloadProfile();
    }
    
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
    
    // 10. 保存历史数据
    history.lastRun = new Date().toISOString();
    history.runCount = (history.runCount || 0) + 1;
    saveHistory(history);
    
    // 11. Panel 输出
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    // 统计处于冷却期的节点数
    const now = Date.now();
    const cooldownCount = Object.values(history.nodes).filter(n => n.cooldownUntil && now < n.cooldownUntil).length;
    panel.content = formatPanelOutput(weightMap, duration, isColdStart, history.runCount, cooldownCount);
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
  }
  
  $done(panel);
})();
