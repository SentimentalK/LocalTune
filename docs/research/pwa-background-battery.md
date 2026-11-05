# PWA 后台播放与电池：iOS / Android 可检测性调研（APP-001-V1）

> 范围：只回答 V1 的 6 个问题，产出可执行的 UI 结论。不修改产品代码。
> 调研日期：2026-11-05。目标环境：Android 17 / Pixel（Chrome 156）与 iOS（Safari 15–27）。
> 方法：一手文档（MDN、web.dev、Chrome for Developers、Android Developers、Apple Support、
> WebKit Bugzilla、Chromium 源码仓库）+ 本仓库现有实现（`src/core/install.js`、`src/ui/settings.js`、
> `src/manifest.webmanifest`、`e2e/`）。每条结论都带来源；推断与未验证项单独标注。

## 结论摘要

| # | 问题 | 结论 | 关键来源 |
|---|---|---|---|
| 1 | Android 能否读取“电池优化 / 不受限制”状态 | **不能。** 5 条途径全部失败：Battery Status API 只有电量/充电；Permissions API 无此描述符；Service Worker 无该 API；WebAPK 不给网页 JS 桥；`chrome.*` 仅扩展可用。 | [MDN getBattery](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getBattery)、[MDN Permissions API](https://developer.mozilla.org/en-US/docs/Web/API/Permissions_API)、[Chromium webapps 架构](https://chromium.googlesource.com/chromium/src/+/HEAD/components/webapps/docs/android_architecture.md) |
| 2 | Android 17 / 通用 Android 的设置路径 | Pixel：`Settings → Apps → See all apps → <app> → App battery usage → Allow background usage → Unrestricted`。通用/旧版：`Settings → Battery → Battery optimization → All apps → <app> → Don't optimize`。WebAPK 的渲染进程属于 Chrome，**Chrome 那一项才是有效的**。 | [Pixel Help 7015477](https://support.google.com/pixelphone/answer/7015477?hl=en)、[Android Doze/Standby](https://developer.android.com/training/monitoring-device-state/doze-standby)、[web.dev WebAPK](https://web.dev/articles/webapks) |
| 3 | iOS 后台音频真实边界 | `<audio>` 元素：锁屏/切 App 可继续（iOS **15.4** 起 standalone PWA 也修好）。WebAudio 默认是 Ambient，退后台会被系统停（除非 `navigator.audioSession.type='playback'`，Safari **16.4**+）。后台**自动切下一首**在 iOS 16/17 standalone 里是坏的（WebKit bug 仍 NEW）。iOS 26 有“重开 PWA 后 `<audio>` 不出声”的回归。 | [WebKit 198277](https://bugs.webkit.org/show_bug.cgi?id=198277)、[WebKit 261858](https://bugs.webkit.org/show_bug.cgi?id=261858)、[WebKit 295518](https://bugs.webkit.org/show_bug.cgi?id=295518)、[Safari 15 发布说明](https://developer.apple.com/documentation/safari-release-notes/safari-15-release-notes) |
| 4 | iOS 能检测什么 | 只能检测安装态（`display-mode: standalone` / `navigator.standalone`）。电量和低电量模式都读不到：Safari 未实现 Battery Status API；Low Power Mode、Background App Refresh 无 Web API。 | [BCD getBattery](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getBattery)、[Apple 配置 Web 应用](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html)、[Apple 低电量模式](https://support.apple.com/en-us/101604) |
| 5 | 推荐 UI | 安装态**能**判定并持久灰化；电池优化**永远不可检测**，按钮固定 `Check settings`，绝不显示 OK。弹窗分 Android / iOS 两段，红=必须、黄=建议、普通=说明，不列 OEM。 | 本文 §5 |
| 6 | 验收 | Playwright 可测判定/文案/弹窗焦点/360px/禁 OEM；不可测真安装、真电池设置、真后台音频、iOS Safari 引擎。真机清单见 §6.2。 | 本文 §6 |

**最终判定：电池优化状态 = 完全不可检测（Android 与 iOS 都是），安装态 = 可检测。**
不存在“部分可检测”的中间地带；`navigator.getBattery()` 的 `level` / `charging` 是**整机电量**，
与“某应用是否被电池优化”没有映射关系，不能拿来推断，也不能用来点亮 OK。

---

## 1. Android 可检测性（逐项）

| 途径 | 能读到什么 | 能否回答“Chrome 是否 Unrestricted” | 依据 |
|---|---|---|---|
| **Battery Status API** `navigator.getBattery()` | `level`（0–1）、`charging`、`chargingTime`、`dischargingTime`，外加 4 个 change 事件 | **不能**。这是系统电池，不是逐应用优化状态；接口里根本没有该字段 | MDN 的 `BatteryManager` 属性列表只有上述 4 项；Chrome Android 从 38 起支持，Safari 从不支持（BCD `safari: false`、`safari_ios: false`）。Chrome 103 起仅限安全上下文 |
| **Permissions API** `navigator.permissions.query()` | 固定描述符集合 | **不能**。MDN 列出的描述符里没有 battery/power/optimization 一类；传未知名字在 Chrome 抛 `TypeError` | MDN Permissions API 的 “Permission-aware APIs” 清单：geolocation、notifications、push、midi、camera、microphone、persistent-storage、background-sync、screen-wake-lock 等，无电池优化 |
| **Service Worker** | 缓存、推送、后台同步 | **不能**。Worker 全局没有该 API；`getBattery` 只挂在 `Navigator`，不在 `WorkerNavigator` 上 | BCD 条目为 `api.Navigator.getBattery`；Service Worker 规范无电源管理接口 |
| **WebAPK / 已安装应用** | 出现在启动器与系统“应用”列表；能接管 scope 内链接 | **不能**。WebAPK 是“瘦壳”，运行期把渲染交给 Chrome；Chrome 与壳之间只有内部 AIDL（通知、权限），没有暴露给网页的 JS 桥 | Chromium `android_architecture.md`：“thin shells that load Chrome to render the content”；“Chrome communicates with the WebAPK via a bound service using the `IWebApkApi` AIDL interface”，用途仅通知与权限 |
| **Chrome 私有 API** | `chrome.*` | **不能**。`chrome.*` 只对扩展页面开放；网页无法调用，`chrome://` 页面也不能被跨源脚本读取 | Chrome 扩展文档把 `chrome.*` 定义为扩展 API；网页上下文没有该命名空间 |
| （对照）Android 原生 | `PowerManager.isIgnoringBatteryOptimizations(pkg)` | 原生可以，网页不行 | Android 官方：“An app can check whether it is currently on the exemption list by calling `isIgnoringBatteryOptimizations()`” —— 这是 SDK API，不是 Web API |

### 1.1 由此产生的产品铁律

1. **不要**用 `getBattery()` 的 `charging` / `level` 推断“已优化”。充电中也可能被 Restricted；满电也可能 Unrestricted。
2. **不要**把“媒体通知还在”“播放没断”当作设置正确的证据。前台服务（FGS）在播放期间本来就让应用避开 App Standby
   （Android 文档：“The app has a process currently in the foreground, either as an activity or foreground service, or in use by another activity or foreground service.”）。
3. 电池按钮**没有**“检测成功”分支可写。V2 只需实现“不可检测”分支；把可检测分支留成能力探测函数返回 `'unknown'` 即可，不要伪造状态。

---

## 2. Android 设置路径（只写有来源的）

### 2.1 Pixel / Android 17（Chrome）

```
Settings → Apps → See all apps → Chrome → App battery usage
        → Allow background usage → Unrestricted
```

- 来源：Google Pixel 帮助《Keep Adaptive Battery & battery optimization on》当前版本，第 3–5 步为
  “Tap on an app” → “App battery usage” → “Allow background usage” → 选档位（该页以 Optimized 举例）。同一页面明确
  “Some of these steps only work on Android 14 and up”。三档为 **Unrestricted / Optimized / Restricted**
  （官方页以 Optimized 举例，`Unrestricted` 只在社区回答与实机 UI 中出现；Android 17 未截屏核对）。
- 中文菜单：`设置 → 应用 → 查看全部应用 → Chrome → 应用电池用量 → 允许后台使用 → 不受限制`。
  ROM 语言不同则标签不同，文案里必须同时给英文路径。
- 注意：`Allow background usage` 关闭 = Restricted，不是“仅优化”。

### 2.2 Pixel / Android 17（LocalTune 已安装）

```
Settings → Apps → See all apps → LocalTune → App battery usage → Allow background usage → Unrestricted
```

- LocalTune 作为 WebAPK 安装后会出现在系统应用列表（web.dev：“show up in the app launcher, in Android's
  app settings”）。若列表里没有独立条目，只改 **Chrome**。
- **哪一项才有效**：WebAPK 启动时向 Chrome 发 intent，由 Chrome 的 `WebappActivity` 渲染
  （Chromium 架构文档的 “Launch Intent” 流程）。因此承载页面的是 Chrome 的进程/uid，电池优化对
  **Chrome** 生效。LocalTune 条目存在时一并设为 Unrestricted 是零成本的保险，但不要把它写成唯一项。
  [INFERENCE：由 Chromium 的 intent→Chrome activity 流程推出，未见官方一句“电池设置只看 Chrome”。]

### 2.3 通用 Android / 旧版（AOSP 与 Android 13 及更早）

```
Settings → Battery → Battery optimization → All apps → Chrome → Don't optimize
```

- 来源：Android 官方 Doze/App Standby 文档：“Users can manually configure the list of exempted apps in
  **Settings > Battery > Battery Optimization**”。该页面同时给出 `ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`
  ——它打开的正是这个白名单列表。
- 部分版本首页入口在 `Settings → Apps → Special app access → Battery optimization`；标签
  `Don't optimize` / `不优化` 随语言变化。**只写这两条有来源的路径，不做 OEM 分支。**

### 2.4 何时才真的需要改它

- 播放中：Chrome 持有媒体前台服务与音频焦点，Doze 不会掐断正在播放的 FGS；改 Unrestricted 的收益主要在
  **长时间息屏后的恢复**（进程被回收 / 通知被清）。
- 已知的断播根因不在电池：APP-001-K 的证据指向 `AudioHardening` 焦点拒绝与切歌边界 0.68–1.24 s 的
  “无焦点/无 session/无 FGS”窗口（见 `docs/research/android-background-advance.md`）。
- 因此文案必须写“让系统不要过早回收”，**不能**承诺“设了就不会断”。

---

## 3. iOS 后台音频行为

### 3.1 行为矩阵

| 场景 | `<audio>` 元素 | WebAudio（`AudioContext`） | Web 能否控制 |
|---|---|---|---|
| 锁屏 | 继续播放；锁屏显示媒体控制（Media Session，Safari 15+） | 默认 Ambient，退后台被系统停 | 能：`audioSession.type='playback'`（Safari 16.4+）可让 WebAudio 按播放型音频处理；否则不要用 WebAudio 做播放 |
| 切到别的 App | 继续播放（standalone 自 iOS 15.4 起；Safari 标签页更早已可） | 同锁屏：被停 | 部分：页面 JS 会被挂起，UI 不再更新；只有音频管线活着 |
| 一首播完自动下一首 | **standalone 在 iOS 16/17 不可靠**：后台播完即暂停，MediaSession 的 next/prev 也失灵；回前台才继续（WebKit 261858，仍 NEW）。Safari 标签页与 iOS 15 正常 | 不适用 | 不能从 Web 侧修复；只能规避（见 3.3） |
| Low Power Mode | 官方只说明会关 Background App Refresh、30 秒自动锁屏、降亮度等；**未说明会停媒体播放** | 无数据 | 不能检测、不能改；文案写“建议关闭”即可，不要断言必然断播 |
| Background App Refresh | 与 Web 音频无直接关系：该开关管理原生 App 的定期刷新；主屏 Web App 不出现在该列表（[INFERENCE]，未找到官方句） | 同左 | 不能读、不能改 |
| 重开 PWA 后再播 | iOS **26 回归**：`<audio>` 在 PWA 重开后 `play()` resolve 但无声（WebKit 295518，仍 NEW；26.1/26.2 有改善的报告）。WebAudio 同类问题在 26.2 beta 3 报告已修复（291892 c7） | 部分修复 | 不能从 Web 侧修复；规避：重开时重建 `<audio>` 元素并重设 `src` |

### 3.2 版本差异（只写有来源的）

| 版本 | 变化 | 来源 |
|---|---|---|
| iOS 15 | Media Session API（锁屏元数据/控制） | Safari 15 Release Notes：“Added support for the MediaSession API” |
| iOS **15.4** | 修复“standalone Web App 退到后台就停播”（198277 → dup 232909）。修复后锁屏可暂停/继续 | WebKit 198277 c73–c76：“this was a change shipped in iOS 15.4” |
| iOS 16.4 | `navigator.audioSession` / `AudioSession.type`（Safari 16.4，BCD） | MDN `AudioSession.type`；BCD `api.Navigator.audioSession: safari 16.4` |
| iOS 16/17 | standalone 后台播完不自动续播（261858） | WebKit 261858 |
| iOS 26 | PWA 重开后 `<audio>` 无声（295518）；26.2 对 WebAudio 有修复报告 | WebKit 295518、291892 |

### 3.3 对 LocalTune 的直接含义

1. **必须用 `<audio>` 元素播放**，不要用 WebAudio 解码输出做播放器；若未来要用，先设
   `navigator.audioSession.type = 'playback'`（存在性判断后再设）。
2. 后台自动切歌在 iOS standalone 上**不能承诺**。可做的缓解：在 `ended` 时立即 `play()` 下一首（Safari 标签页有效），
   并在 UI 上把“自动切歌”标为可能暂停；不要为此加轮询定时器（后台会被节流）。
3. 重开 PWA 后先销毁重建媒体元素（针对 iOS 26 回归），成本低，可放在播放初始化路径。
4. 锁屏控制依赖 Media Session metadata；没有 metadata 时锁屏只显示系统默认信息。

---

## 4. iOS 可检测性

| 能力 | 能否 | 具体 API / 依据 | 不能读什么 |
|---|---|---|---|
| 安装态 | **能** | `matchMedia('(display-mode: standalone)')`（iOS 12.2+，BCD `css.at-rules.media.display-mode: safari_ios 12.2`）；`window.navigator.standalone === true`（Apple《Configuring Web Applications》）。两者都要用：老版本只有后者 | 不能区分“从主屏启动”与“独立窗口”（iOS 无此形态）；Safari 标签页内无法知道用户是否另装了主屏图标 |
| 安装动作 | **不能** | `beforeinstallprompt` / `appinstalled` 在 Safari 均为 `false`（BCD）；`getInstalledRelatedApps` Safari 为 `false`。iOS 只能给“分享 → 添加到主屏幕”图文 | 无程序化安装 |
| 电量 / 充电 | **不能** | Safari 与 iOS Safari 都不实现 Battery Status API（BCD `safari: false`、`safari_ios: false`）。不是弃用，是never shipped | 电量百分比、是否充电 |
| 低电量模式 | **不能** | 无 Web API。Apple 只提供系统开关说明（Settings → Battery → Low Power Mode / Power Mode） | LPM 开关状态 |
| 后台刷新 | **不能** | 无 Web API；且主屏 Web App 不出现在 Background App Refresh 列表（[INFERENCE]） | BAR 开关、逐 App 状态 |
| 热状态 / 被挂起 | **不能** | 无 API | 页面何时被 suspend；只能靠 `visibilitychange` 间接感知前台/后台 |

**边界一句话**：iOS 上唯一可靠的信号是“我现在是不是以 standalone 运行”；其余全部不可读。
所以 iOS 段落只能是**说明 + 手动步骤**，不能有任何状态化按钮。

---

## 5. 推荐 UI（给 V2）

### 5.1 两个按钮的状态机

#### Install

```
installed   := display-mode ∈ {standalone, fullscreen, minimal-ui} || navigator.standalone === true || appinstalled 已触发
installable := beforeinstallprompt 已触发（仅 Chromium）
browser     := 其余
```

| 状态 | 按钮 | 副文案 | 交互 |
|---|---|---|---|
| `installed` | `Installed`，`disabled`，灰态 | “Open LocalTune from your home screen.” | 不可点；`aria-disabled="true"` |
| `installable` | `Install app`，可点 | “Install for the most reliable background playback.” | 调 `prompt()`；`accepted` 后立即置 `installed`（乐观），并保留 `appinstalled` 兜底 |
| `browser`（Android 无 prompt） | `How to install`，可点 | “Chrome did not offer an install prompt. Open the browser menu → Install app.” | 打开同一个弹窗的安装段 |
| `browser`（iOS） | `How to install`，可点 | “Safari cannot install from a button.” | 打开弹窗的 iOS 段 |

持久性：`installed` 由**运行环境**推导，刷新后仍然成立，不需要 localStorage。
**不要**用 localStorage 记“已安装”：卸载后仍会显示 Installed，属于对用户撒谎。
已知假阴性：Android 已安装但用户在 Chrome 标签页里打开时，`beforeinstallprompt` 不再触发 → 显示 `browser`。
`getInstalledRelatedApps()` 可以补这个洞，但它要求 manifest 里的 `related_applications` 自引用
（web.dev 给了写法），属于 `src/manifest.webmanifest`，不在 V2 写路径内；V2 先接受假阴性并在文案里说明。

#### Battery guide

| 平台 | 电池优化可检测？ | 按钮 | 状态 | 弹窗首行 |
|---|---|---|---|---|
| Android | 否 | `Check settings` | **始终可点**，永不 disabled | “Android does not let the browser read this setting. Check it manually.” |
| iOS | 否（无此概念） | `Check settings` | 始终可点 | “iOS has no per-app battery switch. Two things matter here.” |
| 未来可检测 | 是 | `Battery: OK` | disabled + OK | 不需要弹窗（保留分支即可） |

**四象限（V2 落地版）**

| | 可检测 | 不可检测 |
|---|---|---|
| **Android** | 当前不存在。保留分支：状态 `ok` → 按钮 `Battery: OK` 灰态；状态 `needs` → `Check settings` | **默认分支**：`Check settings` + 弹窗 Android 段；红项 = 安装 + Unrestricted |
| **iOS** | 不可能（iOS 没有该设置） | **默认分支**：`Check settings` + 弹窗 iOS 段；红项 = 添加到主屏幕；黄项 = 关低电量模式 |

禁止项：
- 不要显示 “Battery: OK” 的绿点/对勾，除非来自真实检测（当前不存在）。
- 不要把 `charging === true` 当作 OK。
- 不要因为“媒体通知在”就标记已设置。

### 5.2 弹窗结构

```
role="dialog" aria-modal="true" aria-labelledby="battery-dialog-title"
初始焦点：标题（tabindex="-1"）或关闭按钮
Esc 关闭；点击遮罩关闭；关闭后焦点回到触发按钮
内部 Tab 循环；背景滚动锁定；360px 无横向溢出
```

内容骨架（不含 OEM）：

```
标题：Background playback
说明：一行，为什么后台会停（系统会回收后台页面，不是 bug）。

[Android]（仅 Android 显示）
  红（必须）
    1. Install LocalTune to your home screen.
    2. Chrome → App battery usage → Allow background usage → Unrestricted.
       设置 → 应用 → 查看全部应用 → Chrome → 应用电池用量 → 允许后台使用 → 不受限制
  黄（建议）
    · Turn off Battery Saver while listening.
    · Re-check after a system update; Android may reset it.
  普通
    · The browser cannot read this setting, so this app cannot show a green "OK".
    · Keep the media notification; swiping it away can end playback.

[iOS]（仅 iOS 显示）
  红（必须）
    1. Tap Share in Safari → Add to Home Screen.
    2. Open LocalTune from the home screen (not from a Safari tab).
  黄（建议）
    · Keep Low Power Mode off while listening.
    · Use the lock-screen controls to change tracks.
  普通
    · iOS may pause after a track ends in the background; this is a system limit.
    · iOS 26: if audio is silent after reopening the app, close and reopen it once.

[关闭]
```

红/黄/普通用语义 class（`.guide-must` / `.guide-should` / `.guide-note`），颜色走 token。
当前 `src/styles.css` 只有 `--muted` / `--accent` / `--line`，**没有** danger/warn token；
V2 需加 `--danger`、`--warn`（浅色 + 深色两套），不要硬编码 hex。

### 5.3 文案（i18n key 建议）

保留现有 key 风格（`settings.background.*`），新增：

| key | en | zh-CN |
|---|---|---|
| `settings.background.install` | `Install app` | `安装应用` |
| `settings.background.installed` | `Installed` | `已安装` |
| `settings.background.installedHint` | `Open LocalTune from your home screen.` | `请从主屏幕打开 LocalTune。` |
| `settings.background.howToInstall` | `How to install` | `如何安装` |
| `settings.background.checkSettings` | `Check settings` | `检查设置` |
| `settings.background.batteryUnknown` | `Android does not let the browser read this setting.` | `浏览器读不到这个设置，请手动确认。` |
| `battery.dialog.title` | `Background playback` | `后台播放` |
| `battery.dialog.intro` | `Phones pause background pages to save power. These steps keep playback alive.` | `系统会为省电暂停后台页面。完成下面的步骤可以让播放继续。` |
| `battery.android.must1` | `Install LocalTune to your home screen.` | `把 LocalTune 安装到主屏幕。` |
| `battery.android.must2` | `Chrome → App battery usage → Allow background usage → Unrestricted.` | `设置 → 应用 → 查看全部应用 → Chrome → 应用电池用量 → 允许后台使用 → 不受限制。` |
| `battery.android.should1` | `Turn off Battery Saver while listening.` | `收听时关闭省电模式。` |
| `battery.android.should2` | `Re-check after a system update; Android may reset it.` | `系统更新后请复查，Android 可能会重置。` |
| `battery.android.note1` | `The browser cannot read this setting, so no green "OK" is shown.` | `浏览器读不到这个设置，所以不会显示绿色的“正常”。` |
| `battery.android.note2` | `Keep the media notification; swiping it away can end playback.` | `保留媒体通知，滑掉通知可能导致播放结束。` |
| `battery.ios.must1` | `Tap Share in Safari → Add to Home Screen.` | `在 Safari 点分享 → 添加到主屏幕。` |
| `battery.ios.must2` | `Open LocalTune from the home screen, not a Safari tab.` | `请从主屏幕打开 LocalTune，不要用 Safari 标签页。` |
| `battery.ios.should1` | `Keep Low Power Mode off while listening.` | `收听时关闭低电量模式。` |
| `battery.ios.should2` | `Use the lock-screen controls to change tracks.` | `用锁屏控制切歌。` |
| `battery.ios.note1` | `iOS may pause after a track ends in the background; this is a system limit.` | `iOS 可能在后台一首结束后暂停，这是系统限制。` |
| `battery.ios.note2` | `iOS 26: if audio is silent after reopening, close and reopen the app once.` | `iOS 26：重开后没声音时，关闭再打开一次。` |

zh-TW / ja 按现有表同步翻译；删掉全部 `batteryBrand*`、`samsung*`、`xiaomi*`、`huawei*`、
`stock1..3`、`stepsTitle`、`batteryGuide`、`batteryDesktop` 死 key。

### 5.4 卡片最终形态

```
Background playback
Phones pause background pages to save power.

[ Install app / Installed ]   [ Check settings ]
<一行状态：Installed — open it from the home screen. / Install for reliable playback.>
```

桌面端：不显示电池按钮与安装按钮，只留一句 “Background playback applies to phones.”（沿用现有
`batteryDesktop` 的语义，但只保留一句，不再包围 Android/iOS 分支）。

---

## 6. 验收建议

### 6.1 Playwright 能测 / 不能测

| 能测 | 怎么做 |
|---|---|
| 安装态灰化 | `addInitScript` 覆写 `matchMedia`，让 `(display-mode: standalone)` 返回 `matches: true`（现有用例 `e2e/reliability.spec.js` 已有此写法）；断言按钮 `disabled`、文案 `Installed`、刷新后仍成立 |
| `appinstalled` 切换 | 页面内 `dispatchEvent(new Event('appinstalled'))`；断言同会话内立即灰化 |
| `beforeinstallprompt` 可安装态 | 注入一个带 `prompt()` 的假事件对象并 dispatch；点按钮 → 断言 store 被调用 → 置 Installed |
| iOS 分支 | iOS UA（现有 `e2e/ios.spec.js`）+ `navigator.standalone` 注入；断言没有安装按钮、有 iOS 段、无 Android 段 |
| 电池按钮固定态 | 断言 label 恒为 `Check settings`、`disabled === false`、**不存在**任何 OK/绿勾文本 |
| 弹窗 | `role=dialog`、`aria-modal=true`、初始焦点在标题/关闭按钮、Tab 循环不逃逸、Esc 关闭、焦点回到触发按钮 |
| 360 / 390px | `setViewportSize`，断言 `scrollWidth - clientWidth <= 0`、红/黄/普通三档 class 存在 |
| 禁 OEM | 断言文档内不含 `Samsung|Xiaomi|Huawei|MIUI|One UI|EMUI`（文案级，不是源码级） |
| 文案完整性 | 每个新 key 在 4 个 locale 都有值且不等于 key（沿用 `tests/battery.test.js` 的写法，但改成“弹窗文案表”） |

| 不能测 | 原因 / 替代 |
|---|---|
| 真实安装（WebAPK minting） | Playwright 无安装能力；只能测状态机。真机见 6.2 |
| 真实电池优化状态 | OS 设置，无 API；只能测“永远不可检测”的行为 |
| 真实后台播放 / 锁屏 / 切 App | 需要真机；Chromium headless 不可信 |
| iOS Safari 行为 | Playwright 的 WebKit 不是 iOS Safari，UA 注入只影响我们的分支判断，不影响引擎 |
| `display-mode` 原生模拟 | Playwright `emulateMedia` 不覆盖 `display-mode`；只能 `addInitScript` 打桩。打桩验证的是**我们的分类逻辑**，不是 Chrome 的行为 |
| 系统菜单名是否与文案一致 | 见 6.2 的真机核对 |

### 6.2 真机清单（标“待用户审核”）

**Android（Pixel / Android 17 / Chrome）**
1. 从 Chrome 安装 → 启动器出现 LocalTune → 设置里能按文案路径找到 `Chrome → App battery usage → Allow background usage`。
2. 设为 `Unrestricted`，回到应用重开设置页：Install 显示 `Installed` 灰态。
3. 播放 → 息屏 → 连续播 3 首，记录是否断播（断播时抓 `dumpsys audio` 焦点历史，对齐 K 票方法）。
4. 清掉媒体通知，观察播放是否结束（验证 note2 的措辞）。
5. 复查 `设置 → 电池 → 电池优化` 是否存在且与文案一致。

**iOS（Safari / 主屏）**
1. 分享 → 添加到主屏幕 → 从主屏打开：设置页 Install 显示 `Installed`。
2. 播放 → 锁屏：确认继续、锁屏有标题/封面、暂停/继续可用。
3. 切到别的 App 2 分钟：确认继续。
4. 让一首在后台自然结束：记录是否自动下一首（预期：iOS 16/17 standalone 会停，261858）。
5. 开 Low Power Mode 重复第 2 步：记录是否断（用于决定黄项措辞是否需要加强）。
6. iOS 26 设备：杀掉 PWA 重开再播，记录是否无声（295518）；若复现，确认 note2 的规避文案成立（重建元素后是否恢复）。

---

## 7. 未验证 / 不确定

| 项 | 状态 | 影响 |
|---|---|---|
| Android 17 的 `Allow background usage` 三档措辞 | 依据 Pixel 帮助页（Android 14+ 通用）与同页 `Optimized` 示例；**未在 Android 17 实机截屏核对** | 文案风险低；真机清单第 1 条覆盖 |
| WebAPK 的电池设置是否只看 Chrome | 由 Chromium “WebAPK → intent → Chrome WebappActivity” 推出（INFERENCE） | 文案写“Chrome 为主，LocalTune 条目存在则一并设置”，不写成单一路径 |
| iOS 主屏 Web App 是否出现在 Background App Refresh 列表 | 未找到官方句，按“不出现”处理（INFERENCE） | 弹窗不提 BAR，只提低电量模式 |
| Low Power Mode 对 Web 音频的实际影响 | Apple 文档未提媒体播放；无实测 | 只写“建议关闭”，不断言 |
| iOS 26.2+ 是否彻底修复 295518 / 291892 | Bugzilla 状态仍 NEW；291892 c7 报告 26.2 beta 3 修复，295518 c9 说 26.1 仍复现 | 弹窗保留 iOS 26 规避句 |
| iOS 后台 `ended` 事件是否稳定触发 | 261858 报告称 `ended` / `canplay` 正常触发但续播被拦；未独立复现 | 建议 V2 保留“后台可能暂停”的说明 |
| Android Chrome 是否会上报 `display-mode: minimal-ui` | 理论只在安装态出现；未见反例 | 分类器已把 minimal-ui 计入 installed，保持 |
| `getInstalledRelatedApps()` 补齐标签页假阴性 | 需改 manifest（不在 V2 写路径） | V2 接受假阴性；另开票再议 |

---

## 8. 来源

| 主题 | URL |
|---|---|
| Battery Status API 能力与安全上下文 | https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getBattery |
| BatteryManager 字段（仅 level/charging/时间） | https://developer.mozilla.org/en-US/docs/Web/API/BatteryManager |
| 浏览器兼容数据（Safari 不支持 getBattery） | https://github.com/mdn/browser-compat-data/blob/main/api/Navigator.json |
| Permissions API 描述符清单 | https://developer.mozilla.org/en-US/docs/Web/API/Permissions_API |
| Chrome 103 移除不安全来源的 Battery API | https://developer.chrome.com/blog/deps-rems-103 |
| Android Doze / App Standby、豁免检查、`Settings > Battery > Battery Optimization` | https://developer.android.com/training/monitoring-device-state/doze-standby |
| `ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS` | https://developer.android.com/reference/android/provider/Settings#ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS |
| Pixel 帮助：App battery usage → Allow background usage | https://support.google.com/pixelphone/answer/7015477?hl=en |
| WebAPK：进入应用列表、共享 Chrome profile、运行在 Chrome 内 | https://web.dev/articles/webapks |
| Chromium WebAPK/TWA 架构（瘦壳、IWebApkApi AIDL、launch intent） | https://chromium.googlesource.com/chromium/src/+/HEAD/components/webapps/docs/android_architecture.md |
| PWA 安装态检测（display-mode / appinstalled / getInstalledRelatedApps） | https://web.dev/learn/pwa/detection |
| iOS standalone 后台音频修复（15.4） | https://bugs.webkit.org/show_bug.cgi?id=198277 |
| iOS 16/17 standalone 后台不续播 | https://bugs.webkit.org/show_bug.cgi?id=261858 |
| iOS 26 PWA 重开后 `<audio>` 无声 | https://bugs.webkit.org/show_bug.cgi?id=295518 |
| iOS 26 PWA WebAudio 静音（26.2 修复报告） | https://bugs.webkit.org/show_bug.cgi?id=291892 |
| Safari 15 加入 Media Session API | https://developer.apple.com/documentation/safari-release-notes/safari-15-release-notes |
| AudioSession.type（Safari 16.4） | https://developer.mozilla.org/en-US/docs/Web/API/AudioSession/type |
| `navigator.standalone`（Apple 归档文档） | https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html |
| 低电量模式关闭 Background App Refresh 等 | https://support.apple.com/en-us/101604 |
| `display-mode` 媒体查询兼容（iOS 12.2+） | https://github.com/mdn/browser-compat-data/blob/main/css/at-rules/media.json |
| `beforeinstallprompt` / `appinstalled` Safari 不支持 | https://github.com/mdn/browser-compat-data/blob/main/api/Window.json |
