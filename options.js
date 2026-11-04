// 设置页 — Firefox / Floorp 版，使用 browser.* Promise API
const api = typeof browser !== "undefined" ? browser : chrome;

document.addEventListener("DOMContentLoaded", async () => {
  const data = await api.storage.local.get({
    targetHour: 9,
    notifyEnabled: true,
    history: []
  });

  document.getElementById("targetHour").value = data.targetHour;
  document.getElementById("notifyToggle").checked = data.notifyEnabled;

  const list = document.getElementById("historyList");
  if (data.history.length === 0) {
    list.innerHTML = "<li>暂无签到日志</li>";
  } else {
    data.history.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = `[${item.time}] ${item.result}`;
      list.appendChild(li);
    });
  }
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  const hour = parseInt(document.getElementById("targetHour").value, 10);
  const notify = document.getElementById("notifyToggle").checked;

  await api.storage.local.set({ targetHour: hour, notifyEnabled: notify });
  alert("设置已保存！插件将每天在 " + hour + " 点后尝试签到。");
});

document.getElementById("testBtn").addEventListener("click", async () => {
  try {
    await api.runtime.sendMessage({ action: "forceCheckIn" });
    alert("测试指令已发送，请检查下方历史记录或系统通知。");
    setTimeout(() => location.reload(), 2000);
  } catch (error) {
    console.error("发送测试指令失败:", error);
    alert("测试指令发送失败，请查看后台控制台日志。");
  }
});
