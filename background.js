// GLaDOS 自动签到助手 — Firefox / Floorp 版
//
// 与 Chrome 版的差异：
//   1. 后台用 event page (background.scripts) 而不是 service worker。
//   2. 全部改用 browser.* Promise API（Firefox 的 chrome.* 只支持回调，
//      原版 `await chrome.storage.local.get(...)` 在 Firefox 上会拿到 undefined）。
//   3. 域名集中在 CONFIG 里，glados.cloud → glados.rocks 改一处即可。
//
// 2026-11 起站点要求签到请求携带一次性的 nonce + proof（见 CONFIG.PROOF_SALT），
// 否则会被判定为自动签到，只给最低分。流程照抄站点前端 /console/checkin：
//   GET  /api/user/checkin/challenge  -> { code, nonce, ttl, turnstile? }
//   等待 >= 2500ms（前端就是这么节流的）
//   proof = SHA-256(nonce + "." + salt)
//   POST /api/user/checkin  { token: 站点 hostname, nonce, proof, tsState }

const CONFIG = {
  ORIGIN: "https://glados.rocks",
  API: "https://glados.rocks/api",
  CHALLENGE_URL: "https://glados.rocks/api/user/checkin/challenge",
  CHECKIN_URL: "https://glados.rocks/api/user/checkin",
  CHECKIN_PAGE: "https://glados.rocks/console/checkin",
  // 站点前端把 proof 的盐做成了字符码数组，解码后是下面这个字符串。
  PROOF_SALT: "glados-observe-v1",
  // 请求体里的 token 是前端 location.hostname，扩展里没有站点 location，只能照抄。
  TOKEN: "glados.rocks",
  MIN_CHALLENGE_MS: 2500,
  CHALLENGE_TTL_FALLBACK_MS: 300000,
  REQUEST_TIMEOUT_MS: 30000,
  MAX_ATTEMPTS: 3,
  RULE_ID: 1
};

const api = typeof browser !== "undefined" ? browser : chrome;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- 请求头伪装
// 让 /api/user/checkin 的请求带上站点自己的 Origin / Referer，
// 否则服务端会拒绝跨站请求。
async function installHeaderRules() {
  const rules = [{
    id: CONFIG.RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Origin", operation: "set", value: CONFIG.ORIGIN },
        { header: "Referer", operation: "set", value: CONFIG.CHECKIN_PAGE }
      ]
    },
    condition: {
      urlFilter: `${CONFIG.ORIGIN}/api/`,
      resourceTypes: ["xmlhttprequest"]
    }
  }];

  try {
    await api.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [CONFIG.RULE_ID],
      addRules: rules
    });
    console.log("[规则] 请求头伪装规则已更新");
  } catch (error) {
    // 规则失败不阻断签到：cookie 仍然会发送，只是缺少 Origin/Referer。
    console.error("[规则] 更新动态规则失败:", error);
  }
}

// ---------------------------------------------------------------- HTTP
async function requestJson(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= CONFIG.MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        credentials: "include",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json;charset=UTF-8",
          ...(options.headers || {})
        },
        ...options,
        signal:
          typeof AbortSignal !== "undefined" && AbortSignal.timeout
            ? AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS)
            : undefined
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
        error.retryable = [502, 503, 504].includes(response.status);
        throw error;
      }
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`响应不是有效 JSON: ${text.slice(0, 200)}`);
      }
    } catch (error) {
      lastError = error;
      const retryable =
        error.retryable ||
        error.name === "TypeError" ||
        error.name === "TimeoutError" ||
        error.name === "AbortError";
      if (!retryable || attempt === CONFIG.MAX_ATTEMPTS) break;
      await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

function unauthorizedMessage(data) {
  const message = String(data?.message || "");
  if (
    Number(data?.code) === -2 ||
    message.includes("没有权限") ||
    message.toLowerCase().includes("unauthorized")
  )
    return "未登录或登录已过期，请在浏览器里打开 glados.rocks 重新登录";
  return null;
}

async function sha256Hex(text) {
  const buffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 取一次签到挑战。
 * 站点的挑战没有 turnstile 时，前端直接报 tsState:"off"，不弹验证码。
 */
async function fetchChallenge() {
  const data = await requestJson(CONFIG.CHALLENGE_URL, { method: "GET" });
  const unauthorized = unauthorizedMessage(data);
  if (unauthorized) throw new Error(unauthorized);
  if (Number(data.code) !== 0 || !data.nonce)
    throw new Error(`未能获取签到挑战: ${data.message || data.code}`);
  return {
    nonce: data.nonce,
    ttl: Number(data.ttl) || CONFIG.CHALLENGE_TTL_FALLBACK_MS,
    at: Date.now(),
    turnstile: data.turnstile || null
  };
}

/**
 * 按站点前端的顺序构造签到请求体：
 * 取 nonce → 等够 2500ms → 算 proof → 带 tsState。
 *
 * tsState 取值与站点一致：off（挑战没要求验证）/ ok / timeout / error。
 * 后台页面无法渲染 Turnstile 组件，所以要求验证时只能如实报 timeout，
 * 由服务端回 reason:"turnstile"，再提示用户去官网手动签一次。
 */
async function buildCheckinBody() {
  const challenge = await fetchChallenge();
  const tsState = challenge.turnstile ? "timeout" : "off";

  const remaining = CONFIG.MIN_CHALLENGE_MS - (Date.now() - challenge.at);
  if (remaining > 0) {
    console.log(`[挑战] 等待 ${remaining}ms 以满足站点的节流`);
    await sleep(remaining);
  }

  const proof = await sha256Hex(`${challenge.nonce}.${CONFIG.PROOF_SALT}`);
  return {
    body: {
      token: CONFIG.TOKEN,
      nonce: challenge.nonce,
      proof,
      tsState
    },
    needsTurnstile: Boolean(challenge.turnstile)
  };
}

// ---------------------------------------------------------------- 生命周期
// Firefox 的 alarms 不会跨浏览器重启保留，而 onInstalled 只在安装那一次触发。
// 所以闹钟必须在每次启动时重建，否则重启后再也没有定时签到。
// 这里只在确实缺失时创建，避免在闹钟回调里重建导致周期被重置。
async function ensureAlarm() {
  try {
    const existing = await api.alarms.get("checkInAlarm");
    if (existing) return;
    await api.alarms.create("checkInAlarm", {
      delayInMinutes: 1,
      periodInMinutes: 60
    });
    console.log("[闹钟] 已创建：1 分钟后开始，每 60 分钟一次");
  } catch (error) {
    console.error("[闹钟] 创建失败:", error);
  }
}

api.runtime.onInstalled.addListener(() => {
  console.log("插件已安装，配置伪装规则...");
  installHeaderRules();
  ensureAlarm();
  tryCheckIn();
});

api.runtime.onStartup.addListener(() => {
  console.log("检测到浏览器启动，重建定时任务并检查签到条件...");
  installHeaderRules();
  ensureAlarm();
  tryCheckIn();
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkInAlarm") {
    console.log("定时闹钟触发，开始检查签到条件...");
    ensureAlarm();
    tryCheckIn();
  }
});

// ---------------------------------------------------------------- 签到逻辑
function localToday() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function tryCheckIn() {
  try {
    const data = await api.storage.local.get([
      "notifyEnabled",
      "lastCheckInDate",
      "targetHour"
    ]);

    const today = localToday();
    const currentHour = new Date().getHours();
    const targetHour = data.targetHour !== undefined ? data.targetHour : 9;

    console.log(
      `[状态检查] 今日:${today}, 上次自动签到:${data.lastCheckInDate}, 当前小时:${currentHour}, 目标小时:${targetHour}`
    );

    if (data.lastCheckInDate !== today && currentHour >= targetHour) {
      console.log("满足自动签到条件，准备获取挑战并签到...");
      await performFetch(today, data.notifyEnabled, false);
    } else {
      console.log("未满足自动签到条件，继续等待。");
    }
  } catch (error) {
    console.error("执行 tryCheckIn 时发生错误:", error);
  }
}

/**
 * 把服务端返回解析成统一结果。
 * 站点会用到：code / message / reason / points / streak / repeated / list[0].balance。
 */
function describeResult(result, needsTurnstile) {
  const message = String(result?.message || "").trim();
  const code = Number(result?.code);
  const reason = String(result?.reason || "");
  const balance = parseFloat(result?.list?.[0]?.balance);
  const balanceText = Number.isFinite(balance)
    ? `，当前余额 ${Math.floor(balance)} 积分`
    : "";
  const pointsText =
    result?.points != null ? `，获得 ${result.points} 积分` : "";
  const streakText =
    result?.streak != null ? `，连签 ${result.streak} 天` : "";

  if (code === 4 && reason === "device-mismatch")
    return {
      ok: false,
      needsManual: true,
      text: "登录设备与签到设备不一致，请重新登录 glados.rocks"
    };

  if (reason === "turnstile" || (needsTurnstile && code !== 0))
    return {
      ok: false,
      needsManual: true,
      text: "站点要求人机验证，请在官网手动签到一次以解除"
    };

  if (
    message.includes("Checkin Repeats") ||
    message.includes("Please Try Tomorrow") ||
    result?.repeated === true
  )
    return { ok: true, text: `今日已签到${balanceText}` };

  if (
    code === 0 ||
    message.includes("Today's observation logged") ||
    message.includes("Checkin! Got")
  )
    return {
      ok: true,
      text: `签到成功${pointsText}${streakText}${balanceText}`
    };

  return { ok: false, text: `未知结果: ${message || code}` };
}

async function performFetch(today, notifyEnabled, isManual = false) {
  const tag = isManual ? "手动" : "自动";
  let outcome;

  try {
    const { body, needsTurnstile } = await buildCheckinBody();
    console.log(`[${tag}] 挑战已获取，提交签到`);
    const result = await requestJson(CONFIG.CHECKIN_URL, {
      method: "POST",
      body: JSON.stringify(body)
    });
    console.log(`[${tag}] 服务器返回完整结果:`, result);

    const unauthorized = unauthorizedMessage(result);
    if (unauthorized) {
      outcome = { ok: false, text: unauthorized };
    } else {
      outcome = describeResult(result, needsTurnstile);
    }
  } catch (error) {
    console.error(`[${tag}] 签到失败:`, error);
    outcome = { ok: false, text: error.message || "网络连接失败" };
  }

  await saveHistory(`[${tag}] ${outcome.text}${outcome.ok ? "" : ""}`);

  // 手动测试同样写入今日标记，否则同一天还会再自动签到一次。
  if (outcome.ok) {
    await api.storage.local.set({ lastCheckInDate: today });
    console.log(
      isManual ? "手动测试成功，已更新今日签到标记" : "已更新自动签到日期标识"
    );
  } else {
    console.log(`签到未完成（${outcome.text}），保持今日标记不变`);
  }

  if (notifyEnabled !== false && outcome.text) {
    try {
      await api.notifications.create({
        type: "basic",
        iconUrl: api.runtime.getURL("icon-128.png"),
        title: outcome.ok
          ? isManual
            ? "GLaDOS 手动测试结果"
            : "GLaDOS 自动签到结果"
          : outcome.needsManual
            ? "GLaDOS 需要你手动签到一次"
            : "GLaDOS 签到未成功",
        message: outcome.text
      });
    } catch (error) {
      console.error("发送通知失败:", error);
    }
  }

  return outcome;
}

async function saveHistory(msg) {
  try {
    const data = await api.storage.local.get({ history: [] });
    const record = { time: new Date().toLocaleString(), result: msg };
    const history = [record, ...data.history].slice(0, 30);
    await api.storage.local.set({ history });
  } catch (error) {
    console.error("保存历史记录失败:", error);
  }
}

// ---------------------------------------------------------------- 消息入口
// Firefox 中返回 Promise 即可回复消息，不需要 keepalive hack。
api.runtime.onMessage.addListener((request) => {
  if (request && request.action === "forceCheckIn") {
    console.log("收到强制签到指令");
    const today = localToday();
    return api.storage.local.get(["notifyEnabled"]).then((data) =>
      performFetch(today, data.notifyEnabled, true).then((outcome) => ({
        status: "done",
        ok: Boolean(outcome && outcome.ok),
        text: outcome ? outcome.text : ""
      }))
    );
  }
  return undefined;
});

api.action.onClicked.addListener(() => {
  api.runtime.openOptionsPage();
});
