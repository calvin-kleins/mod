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
  GIST_FILENAME: null,  // 自动从 Gist API 发现（优先 .conf 文件）
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

// 基于 ML 模型生成所有节点权重
function generateWeightsFromModel(history, regional) {
  const weightMap = {};
  
  for (const [region, nodes] of Object.entries(regional)) {
    if (nodes.length === 0) continue;
    
    const entries = nodes
      .map(name => {
        const node = history.nodes[name];
        if (!node) return null;
        // score 高 -> weight 低 -> 优先级高
        // score 范围 [0, 1] -> weight 映射到 [0.3, 3.0]
        const weight = clamp(mapRange(node.score, 0, 1, 3.0, 0.3), 0.3, 3.0);
        return `${name}:${weight.toFixed(2)}`;
      })
      .filter(Boolean);
    
    if (entries.length > 0) {
      weightMap[region] = entries.join(";");
    }
  }
  
  log("info", "Profile", "权重已更新", { regions: Object.keys(weightMap) });
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
// 返回修改后的完整配置文本
function updateProfileWeights(profileText, weightMap) {
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
    
    log("info", "Main", "Smart Selector 启动", { dryRun: CONFIG.DRY_RUN });
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
    // regionData 格式: { HK: { nodes: [...], hashMap: {...}, smartGroup: "HK-WiFi" }, ... }
    const regionData = {};
    const networkSuffixes = ["-WiFi", "-有线", "-移动"];

    for (const [region, groupPrefix] of Object.entries(CONFIG.REGION_GROUPS)) {
      for (const suffix of networkSuffixes) {
        const groupName = groupPrefix + suffix;
        const { nodes, hashMap } = await getGroupMembers(groupName);
        if (nodes.length > 0) {
          regionData[region] = { nodes, hashMap, smartGroup: groupName };
          break;
        }
      }
      if (!regionData[region]) regionData[region] = { nodes: [], hashMap: {}, smartGroup: "" };
      log("info", "Main", `${region} 获取到 ${regionData[region].nodes.length} 个节点`, { smartGroup: regionData[region].smartGroup });
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
    const weightMap = generateWeightsFromModel(history, regional);
    if (Object.keys(weightMap).length === 0) throw new Error("无有效测试结果");
    
    // 7. 下载 Profile -> 更新权重 -> 上传 Gist
    log("info", "Main", "Profile 同步流程开始");
    const profile = await downloadProfile();
    const updatedProfile = updateProfileWeights(profile, weightMap);
    if (CONFIG.DRY_RUN) {
      log("info", "DryRun", "跳过 Gist 上传", { regions: Object.keys(weightMap) });
    } else {
      await uploadProfile(updatedProfile);
      log("info", "Main", "Profile 同步完成");
    }
    
    // 8. 触发 Surge 重载
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
    
    // 9. 保存历史数据
    history.lastRun = new Date().toISOString();
    history.runCount = (history.runCount || 0) + 1;
    saveHistory(history);
    
    // 10. Panel 输出
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
