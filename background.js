// GLaDOS 自动签到助手 — Firefox / Floorp 版
//
// 与 Chrome 版的差异：
//   1. 后台用 event page (background.scripts) 而不是 service worker。
//   2. 全部改用 browser.* Promise API（Firefox 的 chrome.* 只支持回调，
//      原版 `await chrome.storage.local.get(...)` 在 Firefox 上会拿到 undefined）。
//   3. 域名集中在 CONFIG 里，glados.cloud → glados.rocks 改一处即可。

const CONFIG = {
  ORIGIN: "https://glados.rocks",
  CHECKIN_URL: "https://glados.rocks/api/user/checkin",
  CHECKIN_PAGE: "https://glados.rocks/console/checkin",
  // 请求体里的 token 与站点域名一致，这是原版的约定。
  TOKEN: "glados.rocks",
  RULE_ID: 1
};

const api = typeof browser !== "undefined" ? browser : chrome;

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
      urlFilter: `${CONFIG.ORIGIN}/api/user/checkin`,
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

// ---------------------------------------------------------------- 生命周期
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
      console.log("满足自动签到条件，准备发送请求...");
      await performFetch(today, data.notifyEnabled, false);
    } else {
      console.log("未满足自动签到条件，继续等待。");
    }
  } catch (error) {
    console.error("执行 tryCheckIn 时发生错误:", error);
  }
}

/**
 * 服务端是否认为本次签到已经完成（成功、或已是今日签到）。
 * 判定标准沿用原版：code === 0 或消息里出现这些关键词。
 */
function looksDone(result, statusMsg) {
  const msgLower = String(statusMsg).toLowerCase();
  return (
    result.code === 0 ||
    ["checkin", "points", "repeat", "tomorrow", "logged"].some((word) =>
      msgLower.includes(word)
    )
  );
}

async function performFetch(today, notifyEnabled, isManual = false) {
  const tag = isManual ? "手动" : "自动";
  let statusMsg;

  try {
    const response = await fetch(CONFIG.CHECKIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=UTF-8" },
      credentials: "include",
      body: JSON.stringify({ token: CONFIG.TOKEN })
    });

    const result = await response.json();
    console.log(`[${tag}测试] 服务器返回完整结果:`, result);

    statusMsg = result.message || `HTTP ${response.status}`;
    await saveHistory(`[${tag}] ${statusMsg}`);

    // 手动测试同样写入今日标记，否则同一天还会再自动签到一次。
    if (looksDone(result, statusMsg)) {
      await api.storage.local.set({ lastCheckInDate: today });
      console.log(
        isManual
          ? "手动测试成功，已更新今日签到标记"
          : "已更新自动签到日期标识"
      );
    } else {
      console.log(`签到未完成（${statusMsg}），保持今日标记不变`);
    }
  } catch (error) {
    console.error("网络请求发生错误:", error);
    statusMsg = "网络连接失败";
    await saveHistory(`[${tag}] ${statusMsg}`);
  }

  if (notifyEnabled !== false && statusMsg) {
    try {
      await api.notifications.create({
        type: "basic",
        iconUrl: api.runtime.getURL("icon-128.png"),
        title: isManual ? "GLaDOS 手动测试结果" : "GLaDOS 自动签到结果",
        message: statusMsg
      });
    } catch (error) {
      console.error("发送通知失败:", error);
    }
  }
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
      performFetch(today, data.notifyEnabled, true).then(() => ({
        status: "done"
      }))
    );
  }
  return undefined;
});

api.action.onClicked.addListener(() => {
  api.runtime.openOptionsPage();
});
