/*
 * DNS 缓存刷新 - Surge Script
 * 功能: 按需/网络切换/定时 自动刷新 DNS 缓存
 * 运行环境: Surge Script Engine (type=generic/event/cron)
 */

// ==================== 参数解析 ====================

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

// ==================== 配置常量 ====================
const CONFIG = {
  MIN_FLUSH_INTERVAL: (parseInt(args.min_interval) || 300) * 1000,  // 全局最小刷新间隔 (ms)
  NETWORK_DEBOUNCE: 30000,       // 网络切换防抖间隔 30秒 (ms)
  SMART_COOLDOWN: 600000,        // 智能模式冷却 10分钟 (ms)

  // 存储 Key
  STORE_KEYS: {
    LAST_FLUSH_TIME: "dns_flush_last_time",
    NETWORK_STATE: "dns_flush_network_state",
    FLUSH_STATS: "dns_flush_stats",
    LAST_NETWORK_EVENT: "dns_flush_last_network_event",
    LAST_SMART_FLUSH: "dns_flush_last_smart_flush"
  }
};

// ==================== 日志工具 ====================

// 日志级别控制（支持 sgmodule argument 覆盖）
const LOG_LEVEL = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVEL[(args.log_level || "INFO").toUpperCase()] ?? LOG_LEVEL.INFO;

function log(level, tag, message, data) {
  try {
    if (level < CURRENT_LOG_LEVEL) return;
    const prefix = ["[DEBUG]", "[INFO]", "[WARN]", "[ERROR]"][level] || "[LOG]";
    const logMsg = data !== undefined
      ? `${prefix}[${tag}] ${message} | ${typeof data === "object" ? JSON.stringify(data) : data}`
      : `${prefix}[${tag}] ${message}`;
    console.log(logMsg);
  } catch (e) {
    // 日志不应影响正常流程
  }
}

// ==================== 持久化存储工具 ====================

// 读取 JSON 数据
function readStore(key, defaultValue) {
  try {
    const raw = $persistentStore.read(key);
    if (!raw) {
      log(LOG_LEVEL.DEBUG, "STORE", `读取 ${key}: 无数据，使用默认值`);
      return defaultValue;
    }
    const parsed = JSON.parse(raw);
    log(LOG_LEVEL.DEBUG, "STORE", `读取 ${key} 成功`, parsed);
    return parsed;
  } catch (e) {
    log(LOG_LEVEL.ERROR, "STORE", `读取 ${key} 解析失败: ${e.message}`);
    return defaultValue;
  }
}

// 写入 JSON 数据
function writeStore(key, value) {
  log(LOG_LEVEL.DEBUG, "STORE", `写入 ${key}`, value);
  $persistentStore.write(JSON.stringify(value), key);
}

// 读取数值
function readNumber(key, defaultValue) {
  const raw = $persistentStore.read(key);
  if (!raw) return defaultValue;
  const num = parseFloat(raw);
  return isNaN(num) ? defaultValue : num;
}

// 写入数值
function writeNumber(key, value) {
  log(LOG_LEVEL.DEBUG, "STORE", `写入数值 ${key} = ${value}`);
  $persistentStore.write(String(value), key);
}

// ==================== 刷新统计管理 ====================

// 加载刷新统计
function loadStats() {
  return readStore(CONFIG.STORE_KEYS.FLUSH_STATS, {
    totalFlushes: 0,
    manualFlushes: 0,
    networkFlushes: 0,
    smartFlushes: 0,
    lastFlushTime: 0,
    lastFlushMode: "",
    todayFlushes: 0,
    todayDate: ""
  });
}

// 保存刷新统计
function saveStats(stats) {
  writeStore(CONFIG.STORE_KEYS.FLUSH_STATS, stats);
}

// 更新统计（刷新后调用）
function updateStats(mode) {
  const stats = loadStats();
  const today = new Date().toISOString().slice(0, 10);

  // 重置每日计数
  if (stats.todayDate !== today) {
    stats.todayDate = today;
    stats.todayFlushes = 0;
  }

  stats.totalFlushes += 1;
  stats.todayFlushes += 1;
  stats.lastFlushTime = Date.now();
  stats.lastFlushMode = mode;

  if (mode === "manual") stats.manualFlushes += 1;
  else if (mode === "network") stats.networkFlushes += 1;
  else if (mode === "smart") stats.smartFlushes += 1;

  saveStats(stats);
  return stats;
}

// ==================== DNS 刷新核心 ====================

// 执行 DNS 缓存刷新（使用 $httpAPI，无需 API Key）
async function flushDNS() {
  log(LOG_LEVEL.INFO, "FLUSH", "开始执行 DNS 缓存刷新...");
  return new Promise((resolve, reject) => {
    $httpAPI("POST", "/v1/dns/flush", null, (result) => {
      if (result && result.error) {
        log(LOG_LEVEL.ERROR, "FLUSH", `DNS 刷新失败`, { error: result.error });
        reject(new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error)));
      } else {
        log(LOG_LEVEL.INFO, "FLUSH", "DNS 刷新成功");
        resolve(true);
      }
    });
  });
}

// ==================== 网络状态检测 ====================

// 获取当前网络信息（通过 $network 和 primaryInterface 区分）
function detectNetworkType() {
  if (typeof $network !== "undefined" && $network) {
    const wifi = $network.wifi;
    if (wifi && wifi.ssid) {
      return { type: "WiFi", detail: wifi.ssid };
    }
    // 通过 primaryInterface 区分有线/蜂窝
    if ($network.v4 && $network.v4.primaryInterface) {
      const iface = $network.v4.primaryInterface;
      if (iface.startsWith("pdp_ip") || iface.startsWith("utun")) {
        return { type: "移动", detail: "蜂窝网络" };
      }
      if (iface.startsWith("en") && iface !== "en0") {
        return { type: "有线", detail: "以太网" };
      }
    }
    return { type: "有线", detail: "以太网" };
  }
  return { type: "Unknown", detail: "未知" };
}

// 保存网络状态
function saveNetworkState(state) {
  writeStore(CONFIG.STORE_KEYS.NETWORK_STATE, state);
}

// 加载网络状态
function loadNetworkState() {
  return readStore(CONFIG.STORE_KEYS.NETWORK_STATE, { type: "Unknown", detail: "未知" });
}

// ==================== 延时工具 ====================

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 全局冷却检查 ====================

// 检查全局冷却状态（两次刷新之间至少间隔5分钟）
function checkGlobalCooldown() {
  const lastFlushTime = readNumber(CONFIG.STORE_KEYS.LAST_FLUSH_TIME, 0);
  const elapsed = Date.now() - lastFlushTime;
  if (elapsed < CONFIG.MIN_FLUSH_INTERVAL) {
    const remaining = Math.ceil((CONFIG.MIN_FLUSH_INTERVAL - elapsed) / 1000);
    log(LOG_LEVEL.INFO, "COOL", `全局冷却中: 剩余 ${formatCooldownTime(remaining)}`);
    return { inCooldown: true, remaining, message: `全局冷却中 (${formatCooldownTime(remaining)})` };
  }
  log(LOG_LEVEL.DEBUG, "COOL", `全局冷却已过: 距上次刷新 ${Math.round(elapsed / 1000)}s`);
  return { inCooldown: false, remaining: 0, message: "" };
}

// ==================== 触发模式判断 ====================

// 判断当前脚本触发模式
function detectTriggerMode() {
  // event 类型触发（网络变化）
  if (typeof $trigger !== "undefined" && $trigger && $trigger.type === "event") {
    log(LOG_LEVEL.INFO, "INIT", "触发模式: network (网络事件)");
    return "network";
  }
  // cron 类型触发（定时任务）
  if (typeof $trigger !== "undefined" && $trigger && $trigger.type === "cron") {
    log(LOG_LEVEL.INFO, "INIT", "触发模式: smart (定时任务)");
    return "smart";
  }
  // generic 类型触发（手动/Panel点击）
  log(LOG_LEVEL.INFO, "INIT", "触发模式: manual (手动/Panel点击)");
  return "manual";
}

// ==================== 模式处理函数 ====================

// 手动刷新模式
async function handleManualFlush() {
  log(LOG_LEVEL.INFO, "FLUSH", "执行手动刷新模式...");
  await flushDNS();
  writeNumber(CONFIG.STORE_KEYS.LAST_FLUSH_TIME, Date.now());
  const stats = updateStats("manual");
  return { success: true, message: "手动刷新完成", stats };
}

// 网络切换刷新模式（含防抖机制）
async function handleNetworkFlush() {
  const currentNetwork = detectNetworkType();
  const previousNetwork = loadNetworkState();
  log(LOG_LEVEL.INFO, "NET", `网络事件: 当前=${currentNetwork.type}(${currentNetwork.detail}), 上次=${previousNetwork.type}(${previousNetwork.detail})`);

  // 保存当前网络状态
  saveNetworkState(currentNetwork);

  // 网络类型或详情发生变化才刷新
  if (currentNetwork.type === previousNetwork.type && currentNetwork.detail === previousNetwork.detail) {
    log(LOG_LEVEL.INFO, "NET", "网络未变化，跳过刷新");
    return {
      success: true,
      message: "网络未变化，跳过刷新",
      skipped: true
    };
  }

  // 防抖：30秒内多次网络变化事件只执行一次刷新
  const lastNetworkEvent = readNumber(CONFIG.STORE_KEYS.LAST_NETWORK_EVENT, 0);
  const sinceLast = Date.now() - lastNetworkEvent;
  if (sinceLast < CONFIG.NETWORK_DEBOUNCE) {
    const debounceRemaining = Math.ceil((CONFIG.NETWORK_DEBOUNCE - sinceLast) / 1000);
    log(LOG_LEVEL.INFO, "NET", `网络防抖中: 距上次事件 ${Math.round(sinceLast / 1000)}s，剩余 ${debounceRemaining}s`);
    return {
      success: true,
      message: `网络防抖中 (${debounceRemaining}s)`,
      skipped: true
    };
  }

  // 检查全局最小刷新间隔
  const lastFlushTime = readNumber(CONFIG.STORE_KEYS.LAST_FLUSH_TIME, 0);
  if (Date.now() - lastFlushTime < CONFIG.MIN_FLUSH_INTERVAL) {
    const remaining = Math.ceil((CONFIG.MIN_FLUSH_INTERVAL - (Date.now() - lastFlushTime)) / 1000);
    log(LOG_LEVEL.INFO, "NET", `网络切换但全局冷却中: 剩余 ${remaining}s`);
    return {
      success: true,
      message: `全局冷却中 (${remaining}s)`,
      skipped: true
    };
  }

  // 记录网络事件时间（防抖标记）
  writeNumber(CONFIG.STORE_KEYS.LAST_NETWORK_EVENT, Date.now());

  // 执行刷新
  log(LOG_LEVEL.INFO, "NET", `网络切换触发刷新: ${previousNetwork.detail} → ${currentNetwork.detail}`);
  await flushDNS();
  writeNumber(CONFIG.STORE_KEYS.LAST_FLUSH_TIME, Date.now());
  const stats = updateStats("network");

  $notification.post(
    "DNS缓存已刷新",
    `网络切换: ${previousNetwork.detail} → ${currentNetwork.detail}`,
    ""
  );

  return {
    success: true,
    message: `网络切换刷新: ${currentNetwork.detail}`,
    stats
  };
}

// 智能刷新模式（含10分钟冷却期）
async function handleSmartFlush() {
  log(LOG_LEVEL.INFO, "SMART", "执行定时刷新模式...");
  // 检查智能模式专属冷却（10分钟）
  const lastSmartFlush = readNumber(CONFIG.STORE_KEYS.LAST_SMART_FLUSH, 0);
  const smartElapsed = Date.now() - lastSmartFlush;
  if (smartElapsed < CONFIG.SMART_COOLDOWN) {
    const remaining = Math.ceil((CONFIG.SMART_COOLDOWN - smartElapsed) / 1000);
    log(LOG_LEVEL.INFO, "COOL", `智能模式冷却中: ${formatCooldownTime(remaining)}`);
    return { success: true, message: `冷却中 (${formatCooldownTime(remaining)})`, skipped: true, cooldownRemaining: remaining };
  }

  // 直接刷新
  await flushDNS();
  const now = Date.now();
  writeNumber(CONFIG.STORE_KEYS.LAST_FLUSH_TIME, now);
  writeNumber(CONFIG.STORE_KEYS.LAST_SMART_FLUSH, now);
  const stats = updateStats("smart");

  return { success: true, message: "定时刷新完成", stats };
}

// ==================== Panel 格式化 ====================

// 格式化时间显示
function formatTime(timestamp) {
  if (!timestamp || timestamp === 0) return "从未";
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

// 格式化模式名称
function formatModeName(mode) {
  const modeNames = {
    manual: "手动",
    network: "网络切换",
    smart: "定时"
  };
  return modeNames[mode] || "未知";
}

// 生成 Panel 输出内容
function formatPanelOutput(mode, result) {
  const stats = result.stats || loadStats();
  const network = detectNetworkType();
  const networkDisplay = network.type === "WiFi" ? `WiFi(${network.detail})` : network.type;

  const modeName = formatModeName(mode);
  const lastTime = formatTime(stats.lastFlushTime);

  // 组装输出
  let content = `网络: ${networkDisplay} | 已刷新: ${stats.totalFlushes}次\n`;
  content += `上次: ${lastTime} | 模式: ${modeName}\n`;

  // 冷却状态显示
  if (result.cooldownRemaining) {
    content += `⏳ 冷却中: ${formatCooldownTime(result.cooldownRemaining)}`;
  } else if (result.skipped) {
    content += `⏸️ ${result.message}`;
  } else {
    content += `✅ ${result.message}`;
  }

  return content;
}

// 格式化冷却时间显示
function formatCooldownTime(seconds) {
  if (seconds >= 60) {
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return sec > 0 ? `${min}分${sec}秒` : `${min}分钟`;
  }
  return `${seconds}秒`;
}

// ==================== 主流程 ====================

;(async () => {
  log(LOG_LEVEL.INFO, "INIT", "===== DNS 刷新脚本启动 =====");
  const panel = {
    title: "DNS 刷新",
    content: "检测中...",
    icon: "arrow.clockwise.circle.fill",
    "icon-color": "#5AC8FA"
  };

  try {
    // 检测触发模式
    const mode = detectTriggerMode();
    let result;

    // 非手动模式下，检查全局冷却（手动模式跳过全局冷却检查，始终允许执行）
    if (mode !== "manual") {
      const globalCooldown = checkGlobalCooldown();
      if (globalCooldown.inCooldown) {
        log(LOG_LEVEL.INFO, "COOL", `全局冷却拦截，跳过执行 (mode=${mode})`);
        result = {
          success: true,
          message: globalCooldown.message,
          skipped: true,
          cooldownRemaining: globalCooldown.remaining
        };
        panel.content = formatPanelOutput(mode, result);
        panel["icon-color"] = "#8E8E93";
        log(LOG_LEVEL.DEBUG, "PANEL", `Panel 输出: ${panel.content}`);
        $done(panel);
        return;
      }
    }

    switch (mode) {
      case "manual":
        result = await handleManualFlush();
        break;
      case "network":
        result = await handleNetworkFlush();
        break;
      case "smart":
        result = await handleSmartFlush();
        break;
      default:
        result = await handleManualFlush();
    }

    // 生成 Panel 输出
    panel.content = formatPanelOutput(mode, result);
    log(LOG_LEVEL.DEBUG, "PANEL", `Panel 输出: ${panel.content}`);

    if (result.skipped) {
      panel["icon-color"] = "#8E8E93"; // 灰色 = 跳过
    } else {
      panel["icon-color"] = "#4CD964"; // 绿色 = 成功
    }

  } catch (e) {
    log(LOG_LEVEL.ERROR, "INIT", `脚本执行异常: ${e.message || e}`, e.stack || "");
    panel.content = `❌ 失败: ${e.message || e}`;
    panel["icon-color"] = "#FF3B30";
    $notification.post("DNS刷新失败", "", e.message || String(e));
  }

  log(LOG_LEVEL.INFO, "INIT", "===== DNS 刷新脚本结束 =====");
  $done(panel);
})();
