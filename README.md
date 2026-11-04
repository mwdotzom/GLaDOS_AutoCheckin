# GLaDOS 自动签到助手 — Firefox / Floorp 版

![Version](https://img.shields.io/badge/version-1.5-blue.svg)
![Platform](https://img.shields.io/badge/platform-Firefox%20%7C%20Floorp-orange.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

这是一个轻量级的 Firefox / Floorp 浏览器扩展，用于每天自动完成 GLaDOS 平台的签到任务。

> **本仓库是 [imnekosama/GLaDOS_AutoCheckin](https://github.com/imnekosama/GLaDOS_AutoCheckin) 的 Firefox 移植版（fork）**，原项目为 Chrome 扩展，采用 MIT 协议。
> 移植改动见下方「与原版的差异」。

## ✨ 功能特点

- **自动签到**：每天在您设定的时间后自动执行签到。
- **智能重试**：基于 `browser.alarms`，错过时间点后打开浏览器会自动补签。
- **历史记录**：本地保存最近 30 条签到日志。
- **通知提醒**：可选系统级通知，即时反馈签到结果。
- **隐私安全**：纯本地运行，不收集任何用户账号数据。

## 📦 安装（Firefox / Floorp）

### 临时安装（开发调试，重启浏览器后失效）

1. 下载或克隆本仓库到本地。
2. 地址栏打开 `about:debugging#/runtime/this-firefox`。
3. 点击 **“临时载入附加组件” / “Load Temporary Add-on”**。
4. 选择本仓库中的 `manifest.json`。

### 永久安装（需要关闭签名校验）

Firefox 正式版默认要求签名。自签名安装步骤：

1. 地址栏打开 `about:config`，把 `xpinstall.signatures.required` 设为 `false`。
   （Floorp、Firefox Developer Edition、Nightly 可直接设置；Firefox 正式版 128+ 该开关可能被忽略。）
2. 打包：在仓库目录执行 `zip -r -FS ../glados-autocheckin.zip *`。
3. 地址栏打开 `about:addons` → 齿轮菜单 → **“从文件安装附加组件…”**，选择上面的 zip。

若第 1 步的开关不可用，改用 `web-ext sign`（需要 AMO 账号）或继续使用临时安装。

## 🛠 使用方法

1. 安装完成后，在浏览器工具栏找到本插件图标，点击打开设置页。
2. 设定您期望的 **每天签到时间（0-23 点）**。
3. 确保您在当前浏览器中已登录 `https://glados.rocks/console/checkin`。
4. 点击「手动测试签到」验证配置是否正确。

## 🔁 与原版的差异

| 项目 | 原版 (Chrome) | 本版 (Firefox / Floorp) |
|---|---|---|
| 后台 | `background.service_worker` | `background.scripts`（event page），Firefox 不支持 MV3 service worker |
| API | `chrome.*` 回调 | `browser.*` Promise（Firefox 的 `chrome.*` 不支持 Promise，原版 `await chrome.storage.local.get()` 会得到 `undefined`） |
| 权限 | `declarativeNetRequest` | `declarativeNetRequestWithHostAccess`（Firefox 中 `modifyHeaders` 需要宿主权限） |
| 设置页 | `options_page` | `options_ui` + `open_in_tab: true` |
| 域名 | `glados.cloud` | `glados.rocks`（含请求体 `token`） |
| 扩展 ID | 无 | `browser_specific_settings.gecko.id`（`strict_min_version` 128.0） |

域名与请求头集中在本仓库 `background.js` 顶部的 `CONFIG` 对象中，换域名只需改这一处。

## 📂 文件结构

- `manifest.json` — 扩展配置（MV3，Firefox 形式）。
- `background.js` — 后台脚本：动态规则、闹钟、签到逻辑。
- `options.html` / `options.js` — 设置界面与历史记录。
- `PRIVACY_POLICY.md` — 隐私政策。
- `icon.png` / `screenshot.jpg` — 图标与截图。
- `LICENSE` — MIT 协议（原始版权归 imnekosama）。

## ⚖️ 许可协议

本项目沿用 [MIT License](LICENSE)，原始版权归 **imnekosama** 所有，fork 修改部分同样以 MIT 发布。仅供学习交流使用。

---

*注：本工具与 GLaDOS 官方无任何隶属关系。*
