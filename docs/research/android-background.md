# Android 后台播放：系统入口调研（2026-11-04）

## 结论（TL;DR）

- **intent 链接：不可作为可靠入口（"有条件可行"，等价于产品上判不可行）。** Chrome for Android 确实允许网页用 `intent:` scheme 打开外部应用，但会强制附加 `CATEGORY_BROWSABLE` 并剥离 `component`；AOSP Settings 的 `Settings$AppBatteryUsageActivity` 只在 **Android 14+** 为该 action 声明了 `BROWSABLE`，**Android 12/13 没有** —— 这两个版本上该链接**必然失败**，OEM Settings 行为不可验证。因此只能当渐进增强 + 必然可达的指引兜底，不能当"一键按钮"。
- **UI 建议：不要做"一键按钮"作为主路径。** 用"分品牌指引弹层"为主，`intent:` 链接作为原生 Android 14+ 的加速路径；品牌 tab 用 `navigator.userAgentData.getHighEntropyValues(['model'])` 判定，不要解析 UA 字符串。

---

## 1. 网页打开电池优化设置

### 可行的 URL 形式 / 不可行的依据

**可行（Android 14+ AOSP Settings / 声明了 BROWSABLE 的 OEM Settings）：**

```html
<a href="intent:#Intent;action=android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS;package=com.android.settings;S.browser_fallback_url=https%3A%2F%2Fexample.com%2Fbattery-guide;end">
  打开电池优化设置
</a>
```

要点：

- 必须是 `<a href>`（真实用户手势）；JS 定时器 / 无手势的 `location.href` 会被 Chrome 拦截。
- **不能**写 `component=com.android.settings/.Settings$AppBatteryUsageActivity`：Chrome 在解析后会 `setComponent(null)`，显式 intent 一律不支持。
- `package=com.android.settings` 可以保留（Chrome 只清 `component`），用于把解析限定到系统设置；省略 `package` 也能解析，但可能命中第三方应用。
- `S.browser_fallback_url` 必须完整 URL-encoded；解析失败时 Chrome 跳这里（这是我们唯一的兜底手段）。
- **在地址栏直接输入无效**：Chrome 明确不支持"typed in URL"触发外部 intent。

**不可行 / 不可用：**

- `android-app://com.android.settings/...`：该 scheme 的语义是"把某个 http/https URI 投递给指定包"，需要目标应用有对应的 App Links / intent-filter 处理该 URL。AOSP Settings 清单里 **`autoVerify` 出现 0 次、无 `http/https` scheme filter**，所以 `android-app://` 无法表达"打开某个 Settings action"。
- Android 12 / 13 的 AOSP Settings：`IGNORE_BATTERY_OPTIMIZATION_SETTINGS` 的 intent-filter **只有 `DEFAULT`，没有 `BROWSABLE`** → Chrome 解析失败 → 只会走 fallback。
- 三星 / 小米 / 华为的 Settings 是否声明 `BROWSABLE` **无法从公开清单验证**（见"未决问题"），一律按"可能失败"处理。

### 证据

| 来源 | URL | 关键引文 |
|---|---|---|
| Chrome for Developers — Android Intents | https://developer.chrome.com/docs/android/intents | "You can launch apps directly from a web page on an Android device with an Android Intent… use the `intent:` syntax."；"Chrome won't launch an external app for a given Intent URI if: The Intent URI is redirected from a typed in URL; The Intent URI is initiated without user gesture." |
| 同上（BROWSABLE 限制） | https://developer.chrome.com/docs/android/intents | "Only activities with the category filter, android.intent.category.BROWSABLE can be invoked using this method, as it indicates that the application is safe to open from the Browser." |
| Chromium — components/external_intents README | https://chromium.googlesource.com/chromium/src/+/main/components/external_intents/README.md | "Explicit intents (i.e. with a component specified), or intent without the BROWSABLE category (which Chrome always adds to intents)."（列于 Unsupported Flows）；"Launching an app without user activation" 同样不支持 |
| Chromium — ExternalNavigationHandler.java（`sanitizeQueryIntentActivitiesIntent`） | https://chromium.googlesource.com/chromium/src/+/main/components/external_intents/android/java/src/org/chromium/components/external_intents/ExternalNavigationHandler.java | `intent.setFlags(intent.getFlags() & ALLOWED_INTENT_FLAGS); intent.addCategory(Intent.CATEGORY_BROWSABLE); intent.setComponent(null); intent.setSelector(null);` |
| Chromium — Chrome AndroidManifest | https://chromium.googlesource.com/chromium/src/+/main/chrome/android/java/AndroidManifest.xml | `<uses-permission android:name="android.permission.QUERY_ALL_PACKAGES" />`（第 97 行）→ Android 11+ 包可见性不构成阻塞 |
| AOSP Settings AndroidManifest — android-14.0.0_r1 | https://android.googlesource.com/platform/packages/apps/Settings/+/refs/tags/android-14.0.0_r1/AndroidManifest.xml | `<action android:name="android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS" />` + `<category android:name="android.intent.category.BROWSABLE" />` + `DEFAULT`，属 `Settings$AppBatteryUsageActivity` |
| AOSP Settings AndroidManifest — android-13.0.0_r1 | https://android.googlesource.com/platform/packages/apps/Settings/+/refs/tags/android-13.0.0_r1/AndroidManifest.xml | 同一 action 下**只有** `<category android:name="android.intent.category.DEFAULT" />`，无 BROWSABLE |
| AOSP Settings AndroidManifest — android-12.0.0_r1 | https://android.googlesource.com/platform/packages/apps/Settings/+/refs/tags/android-12.0.0_r1/AndroidManifest.xml | 同上：仅 `DEFAULT` |
| Android API 参考 — `Settings` | https://developer.android.com/reference/android/provider/Settings#ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS | "Activity Action: Show screen for controlling which apps can ignore battery optimizations." |
| Android API 参考 — `Intent.URI_ANDROID_APP_SCHEME` | https://developer.android.com/reference/android/content/Intent#URI_ANDROID_APP_SCHEME | "a variation of URI_INTENT_SCHEME whose format is simpler for the case of an http/https URI being delivered to a specific package name"；"the base intent will always have an explicit package name" |
| Stack Overflow — Opening Location Settings Activity from Chrome | https://stackoverflow.com/questions/46099467/opening-location-settings-activity-from-chrome-on-android | （2017，score 8/5）"Seems you can't open Location Settings directly from Android Intents with Chrome because Settings Activities didn't support BROWSABLE category" —— 与 AOSP 12/13 清单一致，但该结论对 14+ 已过时 |
| Stack Overflow — Launch Android settings app through url intent filter | https://stackoverflow.com/questions/19335865/launch-android-settings-app-through-url-intent-filter | "it did **not** work by inputting into the URL bar of Chrome and hitting Enter; it *did* work when this string was turned into a hyperlink on a website and then tapped on." |

### 风险与限制

1. **版本断层**：Android 12/13 上 100% 失败（无 BROWSABLE）；14/15 上可行。三星/小米/华为的 Settings 是替换实现，清单不公开，行为未知。
2. **无法深链到 Chrome 单项**：`IGNORE_BATTERY_OPTIMIZATION_SETTINGS` 只打开"电池优化应用列表"总览，用户仍需自己找到 Chrome 并点"不优化"。`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 需要 `package:` data URI + `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 权限，且 Google Play 政策禁止滥用，网页端不可达。
3. **Chrome 拦截矩阵**：无用户手势、JS 定时器、页面在后台标签、reload/back-forward、超时（约 15 秒）后都会拒绝启动。因此必须绑在真实 click 上，且不要延迟。
4. **Android 15+ 的"受限制设置"**：部分系统对跨应用启动 Settings 加了限制；未找到针对本 action 的官方说明，按"可能被 OEM 拦截"计。
5. **桌面 Chrome 会当作未知协议**：需要在 UA 侧判断 `Android` 再渲染该链接。

---

## 2. 分品牌路径

### 三星 One UI（Android 12+）

菜单层级（中文 / English）：

1. 设置 → 电池和设备维护 → 电池 → 后台使用限制
   Settings → **Battery and device care** → **Battery** → **Background usage limits**
2. 关闭"未使用的应用将进入休眠" / **Put unused apps to sleep**
3. "从不休眠的应用" → `+` → 勾选 Chrome / **Never sleeping apps** → `+` → Chrome

备选（单应用）：
设置 → 应用 → Chrome → 电池 → 电池优化 → 所有应用 → Chrome → 不优化
Settings → Apps → Chrome → Battery → Battery optimization → All apps → Chrome → Don't optimize

- 适用：One UI 4（Android 12）及以上；One UI 6（Android 14）菜单名仍为 Battery and device care → Battery → Background usage limits。One UI 8 上部分机型入口改为 Device care。
- 来源：https://www.samsung.com/us/support/answer/ANS10003442/ （"Navigate to and open **Settings**, and then tap **Battery and device care**. Tap **Battery**, and then tap **Background usage limits**."）；https://dontkillmyapp.com/samsung （"Settings -> Apps -> Your App -> Battery -> Battery optimization -> All apps -> Your app -> Don't optimize"）
- 注意：Samsung 会把应用重新加回休眠列表（固件更新或判定耗电后），需提示用户复查。

### 小米 MIUI / HyperOS

菜单层级：

1. 设置 → 应用设置 → 应用管理 → Chrome → 省电策略 → **无限制**
   Settings → **Apps** → **Manage apps** → Chrome → **Battery saver** → **No restrictions**
2. 自启动：设置 → 应用设置 → 应用管理 → Chrome → 应用权限 → 后台自启动（MIUI 14+）
   Settings → Apps → Chrome → App permissions → **Background autostart**
3. 旧路径（MIUI 12 及更早）：设置 → 更多设置 → 电池与性能 → 应用智能省电 / 管理应用电池用量 → 省电策略 → 选应用 → 后台设置 → **无限制**
   Settings → Additional settings → Battery & performance → Manage apps' battery usage → Saving power in the background → Choose apps → app → Background settings → No restrictions

- 适用：MIUI 12 及以上、HyperOS 1.0/2.0/3.0。
- 来源：https://dontkillmyapp.com/xiaomi （"Settings > Additional Settings > Battery & Performance > Manage apps' battery usage … Background Settings > No restrictions"；"On MIUI 14, there is a new permission to start from the background for each app, in Settings > Apps > Your app > App permissions > Background autostart."）；https://info.drivequant.com/hubfs/Tuto%20Smartphones%20-%20EN/Xiaomi/Xiaomi%20-%20HyperOS%202.0%20-%20EN.pdf （HyperOS：Settings → Apps → Manage apps → 选应用 → 关闭省电限制）
- 注意：小米的"省电策略"对浏览器后台播放影响最大；自启动权限影响媒体会话恢复。

### 华为 EMUI / HarmonyOS

菜单层级：

1. 手机管家 → 应用启动管理 → Chrome → 关闭"自动管理" → 打开"手动管理"的三个开关：自启动 / 关联启动 / 后台活动
   **Phone Manager** → **App launch** → Chrome → **Manage manually** → enable **Auto-launch**, **Secondary launch**, **Run in background**
2. 设置 → 电池 → 应用启动管理（部分 EMUI 版本把入口放在电池下）
3. 设置 → 电池 → 更多电池设置 → 休眠时始终保持网络连接（辅助项，按需）

- 适用：EMUI 9.0 及以上；HarmonyOS 2/3/4 路径基本一致（"应用启动管理"）。
- 来源：https://consumer.huawei.com/en/support/content/en-us15850065/ （"Go to Phone Manager > App launch > Manage manually and turn on the switches for Auto-launch, Secondary launch, and Run in background."）
- 注意：华为部分机型还有"电池优化 → 不允许"，路径为 设置 → 电池 → 电池优化 → 所有应用 → Chrome → 不允许（同一官方页的 "Setting background power consumption protection" 段）。

### 原生 Android（Pixel / AOSP 系）

菜单层级：

1. 设置 → 应用 → 查看全部应用 → Chrome → 应用电池用量 → **不受限制**
   Settings → **Apps** → **See all apps** → Chrome → **App battery usage** → **Unrestricted**
2. 或：设置 → 应用 → 特殊应用权限 → 电池优化 → 所有应用 → Chrome → 不优化
   Settings → Apps → Special app access → Battery optimization → All apps → Chrome → Don't optimize
3. 旧版（Android 11 及更早）：设置 → 应用 → Chrome → 电池 → 电池优化

- 适用：Android 12+（"App battery usage" 三档 Unrestricted / Optimized / Restricted 自 Android 13 起）；Android 11 及更早用 Battery optimization 白名单。
- 来源：https://developer.android.com/reference/android/provider/Settings#ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS （该 action 即上述白名单页）；标签文案参考 https://support.google.com/pixelphone/thread/299966895/turn-off-battery-optimization-for-an-app?hl=en （社区帖，非官方文档）
- 注意："Unrestricted" 的**中文译名随厂商 ROM 变化**（不受限制 / 无限制 / 不优化），文案里应同时给英文。

---

## 3. 对 UI 的建议

**一键按钮：不作为主路径。** 理由：Android 12/13 必然失败，OEM Settings 行为不可验证，失败时用户看到"什么都没发生"比"看到指引"更糟。做法是"按钮 + 必然可达的指引"：

1. **按钮文案**："打开系统电池设置"（不承诺"一键完成"）。点击后：
   - `href` 用上面的 `intent:` 形式，`S.browser_fallback_url` 指向本页 `#battery-guide`（绝对 URL、URL-encoded）；
   - 同时用 `setTimeout(~1200ms)` 检测 `document.visibilityState` 是否仍为 `visible`；仍是 visible 说明没跳走 → 自动展开指引弹层。
2. **弹层为主路径**，按品牌分 tab，默认 tab 判定规则：

| 判定 | 条件 | 默认 tab |
|---|---|---|
| 1 | `navigator.userAgentData?.getHighEntropyValues(['model'])` 的 `model` 以 `SM-` / `SAMSUNG` 开头 | 三星 |
| 2 | `model` 匹配 `M\d{4}` / `2\d{3}` / `POCO` / `Redmi` / `MI ` | 小米 |
| 3 | `model` 匹配 `ELS-` / `ANA-` / `NOH-` / `ALN-` / `HUAWEI` / `HarmonyOS` | 华为 |
| 4 | 其余（含 `model` 为空、Client Hints 不可用） | 原生 Android |
| 5 | `navigator.userAgentData` 不存在且 UA 含 `SamsungBrowser` | 三星（兜底） |

不要解析 UA 字符串里的机型：Chrome 的 UA 精简后机型段不可靠，`Sec-CH-UA-Model` / `getHighEntropyValues(['model'])` 才是官方途径（https://developer.chrome.com/docs/privacy-security/user-agent-client-hints ："The additional values are accessed via the `getHighEntropyValues()` call"；注意同页 "the value may be blank, not returned, or populated with a varying value"，所以必须有第 4 条兜底）。

3. **文案要点**（每条 tab 内）：
   - 一句话目的："让 Chrome 在后台继续播放，不被系统休眠。"
   - 编号步骤，中英双写（用户 ROM 语言不确定）；每步只描述"看到什么 → 点什么"。
   - 明确"设置完回到本页刷新/继续播放"，避免用户以为设置会自动生效。
   - 附"如果你在 设置 里找不到该项，用设置顶部搜索框搜 `电池优化` / `battery optimization`"。
4. **失败兜底**：
   - `intent:` 无反应 → 1.2s 后自动弹指引（不报错、不 toast 失败）。
   - 桌面端 / 非 Android → 不渲染按钮，只显示"在手机上打开本页"。
   - 指引里放一个"复制步骤"按钮，方便用户跨设备查看。

---

## 未决问题

1. **三星 / 小米 / 华为 Settings 是否声明 `BROWSABLE`**：三家都不公开 Settings 的 AndroidManifest，无法静态验证。需真机 `adb shell dumpsys package com.android.settings | grep -A5 IGNORE_BATTERY` 或 `cmd package query-activities -a android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS --categories android.intent.category.BROWSABLE` 实测。
2. **Chrome 实际版本行为**：本文依据 main 分支源码与官方文档，未在真机 Chrome 上跑通 `intent:` → Settings 的端到端链路；需要一台 Android 14+ Pixel 做一次点击验证（并观察是否弹"打开方式"选择器）。
3. **Android 15/16 是否新增了"限制从浏览器启动 Settings"的策略**：未找到可靠来源。
4. **HyperOS 3.0 的省电策略菜单名**：仅有第三方教程（drivequant PDF），无小米官方文档；未找到可靠官方来源。
5. **Chrome 自身作为"被优化对象"的默认状态**：Chrome 通常默认就在"已优化"名单里，但各 OEM 默认值不同，未找到可靠来源。
