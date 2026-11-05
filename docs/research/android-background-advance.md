# Android 后台自动切歌：离线 logcat 证据与在线复现裁决（2026-11-04）

> 范围：离线只读分析 `.scratch/adb/ringbuffer-1810.txt`、`.scratch/adb/live-1810.txt`，并入
> `.scratch/adb/repro-report.md`、`repro-prestate.md`、`prestate/dumpsys_audio.txt`、`playlog-full.json` 的在线复现结论，
> 并对照 `playlog-2026-11-04-summary.md` 与 `src/core/*` 代码事实。不修改源码。
> **失败样本都不在 logcat 覆盖窗口内**；本文件的失败裁决来自 `dumpsys audio` 焦点历史 + playlog 毫秒级记录。

## 结论（TL;DR）

- **时区修正（实证）**：设备时区 `America/Toronto`，2026-11-04 当天为 **EST = UTC−5**（现场 `adb shell 'date +%z'` = `-0500`；`repro-prestate.md:7` 亦标注 `EST, America/New_York`）。摘要的 UTC 时间换算到本地要**减 5 小时**：失败 #1 = **16:27:27**、#4 = **16:48:37**；成功 #3 = 16:44:33、#5 = 17:10:43、#6 = 17:19:49。它们**全部早于 logcat 覆盖起点 18:04:20**；窗口内的 6 次切歌是摘要之后的新一轮播放。**本文件早前“摘要与 logcat 不能按时间对齐 / #5 #6 无法认定”的推测作废**。
- **两个失败样本都不在 logcat 窗口内**（#1 早约 1 h 37 min，#4 早约 1 h 16 min，缓冲区内该时段只有 `trusty` 行），但都有 `dumpsys audio` 焦点历史与 playlog 毫秒级记录，足以完成在线裁决（§4.3、§4.4）。
- **在线复现 28 次自动切歌 0 失败**（20 次有效主动尝试 + 只读期 6 次自然边界 + 试跑 2 次；`repro-report.md:67`）。失败是低频事件，不是“后台切歌必现”。
- **裁决（在线）**：候选 R1（焦点请求被 `AudioHardening` 真拒绝）**对形态 (b) 支持**；R3（autoplay 拒绝）**排除**；R2（FGS/会话拆除后页面被冻结）**对 (b) 无证据支持、对形态 (a) 未排除且为首选假设**。
- **共同触发点是边界的“三无”窗口**：每次切歌 `abandonAudioFocus` → 销毁 session → `setFgsInactiveLocked` → 新曲已 `audio:play` → `requestAudioFocus` → 新 session active + FGS，**0.68–1.24 s 内无焦点、无 session、无 FGS**（`repro-report.md:220-233`）。
- **窗口内 6 次切歌（18:07:32 / 18:11:33 / 18:16:05 / 18:20:22 / 18:24:26 / 18:27:45）系统侧全部成功**；每次都是媒体会话级重建，音频空档 148–186 ms，且前一首按帧计数确实播满整首（§2、§2.1）。
- **应用侧事件根本不在 logcat**：`src/core/store.js:323 log()` 只写 IndexedDB playlog（`src/core` 里 `console.*` 为 0 条，logcat 中 `audio:` 行数为 0），因此失败诊断依赖 playlog + `dumpsys audio`，系统日志只提供“边界其实是被重建出来的”。
- **1 Hz 会话推送仍是可观测负担**：`src/core/store.js:77 MEDIA_SYNC_INTERVAL = 1000` → 每 1.063 s 一次 `setPositionState`，截至 live 第 57494 行共 825 条会话状态行、798 条“后台启动 FGS”告警、1629 条 `MediaPlayerWrapper ... no new data`、939 条通知重发告警。它是边界叠加的次要因素（候选 ④），也是修法 5 的依据。

## 1. 数据与方法

| 文件 | 行数（快照） | 时间跨度（本地） | 说明 |
|---|---|---|---|
| `.scratch/adb/ringbuffer-1810.txt` | 26071 | 18:04:20.026 → 18:10:10.086（另有 00:07–17:59 的稀疏 `trusty` 行） | `adb logcat -d` 主缓冲快照 |
| `.scratch/adb/live-1810.txt` | 46246（分析开始时 `wc -l`，末行 18:15:59.383）；写作期间持续增长（已超 6.1 万行） | 同上，持续增长 | 与 ringbuffer **前缀逐字节相同**（`cmp` 通过），分析截止取 live 第 57494 行（18:21:40） |

- 时间基准：设备时区 `America/Toronto`，2026-11-04 为 **EST = UTC−5**（现场 `adb shell 'date +%z'` = `-0500`；`repro-prestate.md:7`）。logcat 为设备本地时间，摘要 UTC 换算到本地要**减 5 小时**。早前的 −4 h 换算已按实测更正（§4.1）。
- 覆盖判据：18:04:20 之前的 3048 条 `11-04 HH:MM` 行**全部**是 `trusty` tag，其中包含 #1（16:27:27）与 #4（16:48:37）两个失败时刻（§4.1）；该段还有多处分钟级空洞（例如 17:45:03.415→17:51:44.822，live:13142→13143），但两个失败时刻都远早于 18:04:20，是否有空洞不影响结论。
- 统计口径：只统计 Chrome（uid 10201 / pid 18631）；计数随 live 增长而变，文内数字均标注“截至第 57494 行”。
- 行号引用格式 `live:NNNNN` = `.scratch/adb/live-1810.txt` 的第 NNNNN 行（`grep -n` 可回查；追加写在文件尾，旧行号稳定）。

### 1.1 Chrome 相关行落在哪些时间窗

Chrome 自己几乎不写日志：可归属 Chrome 的行（pid 18631 或 uid 10201）**共 74 条**，集中在 5 个簇；其余全部是系统代它记录的行。

| 时间窗 | Chrome 自身行数 | 主要 tag |
|---|---|---|
| 18:06:45.924–18:06:48.081 | 3 | `AudioManager`（焦点 dispatch）、`AS.FadeOutManager` |
| 18:07:32.146–18:07:33.355 | 19 | `AAudio`/`AAudioStream`/`AudioTrack`/`MediaRouter`/`MediaSessionCompat`/`cr_BindingManager` |
| 18:11:33.263–18:11:34.281 | 18 | 同上 |
| 18:16:05.150–18:16:06.173 | 17 | 同上 |
| 18:20:22.350–18:20:23.397 | 17 | 同上 |

系统代记的 Chrome 行是连续的 1 Hz：`MediaSessionService:onSessionPlaybackStateChanged` 覆盖 18:07:08.375–18:21:40+，相邻间隔中位数 **1.063 s**、最大 **2.127 s**（live:23193→23235，发生在 18:08:39 曲中，不是边界）。

---

## 2. 时间线（覆盖窗口内每次切歌）

判定列：**成功** = 系统侧可证音频流重启、新会话 `active=true` 且 `PLAYING`、随后 1 Hz 更新无断档；**失败** = 窗口内无样本。

> 本表与 §2.2 的 6 次切歌都发生在摘要 6 次事件之后（摘要最后一次事件在 17:19:49，本表最早 18:07:32），二者无重叠。
> 应用侧的 `audio:play` / `audio:ended` / `audio:waiting` / `audio:suspend` / `trackchange` 行**不在 logcat**（`log()` 只写 IndexedDB，见 §3 末行），因此本时间线只含系统侧事件；系统侧唯一能锚定“切歌时刻”的是 `abandonAudioFocus` + `AudioTrack stop` 这一对。

| 本地时间 | 事件 | 判定 | 证据 |
|---|---|---|---|
| 18:07:07.722 | 息屏（电源键），进入 doze | 背景起点 | live:17477 |
| 18:07:08.276 | `DreamController: Starting dream ... DozeService` | — | live:17526 |
| 18:07:08.375 | 会话 `Chrome/419` `PLAYING` pos=206999 ms | — | live:17789 |
| 18:07:32.146 | `abandonAudioFocus() uid/pid 10201/18631` | 切歌 A 开始 | live:19087 |
| 18:07:32.150 | `AAudioStream_requestStop(s#21)` + `AudioTrack: stop(13363): ... 11089924 frames` | 成功 | live:19088, live:19090 |
| 18:07:32.152 | `onSessionActiveStateChanged ... /419 active=false` | 成功 | live:19092 |
| 18:07:32.155 | `MediaSessionStack: removeSession /419`、`Media button session is changed to null` | 成功 | live:19093, live:19094 |
| 18:07:32.156 | `destroySessionLocked: /419` | 成功 | live:19096 |
| 18:07:32.165 | `isAnyActiveTrack: false`（音频空档起点） | 成功 | live:19101 |
| 18:07:32.180 | `setFgsInactiveLocked: pkg=com.android.chrome` | 成功 | live:19109 |
| 18:07:32.192 | `cr_BindingManager: onTrimMemory: level=20` | 成功 | live:19118 |
| 18:07:32.302 | `AAudioStream_requestStart(s#21)`（空档 152 ms） | 成功 | live:19214 |
| 18:07:32.315 | `isAnyActiveTrack: true`（空档 150 ms） | 成功 | live:19231 |
| 18:07:32.727 | `requestAudioFocus() uid/pid 10201/18631` | 成功 | live:19254 |
| 18:07:33.322 | `addSession ... /420` | 成功 | live:19435 |
| 18:07:33.331 | `onSessionActiveStateChanged ... /420 active=true` | 成功 | live:19437 |
| 18:07:33.343 | `/420 PLAYING pos=115 ms` | 成功 | live:19441 |
| 18:11:25.380–18:11:29.535 | 息屏→点按唤醒→再息屏→抬腕唤醒（**亮屏 18:11:29.6–18:11:39.5**） | 非后台 | live:29048, live:31159, live:32345 |
| 18:11:33.263 | `abandonAudioFocus` + 停流 + `AudioTrack stop ... 11568518 frames` | 切歌 B | live:35741, live:35742, live:35744 |
| 18:11:33.267 | `removeSession /420`、`setFgsInactiveLocked` | 成功 | live:35751, live:35758 |
| 18:11:33.432 | `AAudioStream_requestStart(s#21)`（空档 169 ms） | 成功 | live:35888 |
| 18:11:33.907 | `AudioHardening ... would be ignored ... exemption: 6` | 成功 | live:35927 |
| 18:11:33.908 | `requestAudioFocus()` | 成功 | live:35928 |
| 18:11:33.944 | `addSession ... /421`、`/421 active=true` | 成功 | live:35931, live:35933 |
| 18:11:33.960 | `/421 PLAYING pos=143 ms` | 成功 | live:35939 |
| 18:11:39.539 / 18:11:40.362 | 超时息屏，再次进入 doze（此后到 18:22 未再亮屏） | 背景起点 | live:36487, live:36726 |
| 18:16:05.147 | `abandonAudioFocus` | 切歌 C 开始 | live:46665 |
| 18:16:05.150 | `AAudioStream_requestStop(s#21)` + `AudioTrack stop ... 13046404 frames` | 成功 | live:46666, live:46668 |
| 18:16:05.155 | `removeSession /421` | 成功 | live:46670 |
| 18:16:05.161 | `setFgsInactiveLocked` | 成功 | live:46674 |
| 18:16:05.182 | `isAnyActiveTrack: false` | 成功 | live:46687 |
| 18:16:05.324 | `AAudioStream_requestStart(s#21)`（空档 174 ms） | 成功 | live:46788 |
| 18:16:05.330 | `isAnyActiveTrack: true`（空档 148 ms） | 成功 | live:46792 |
| 18:16:05.466 | `AudioHardening ... exemption: 6` | 成功 | live:46823 |
| 18:16:05.467 | `requestAudioFocus()` | 成功 | live:46824 |
| 18:16:05.832 | `addSession ... /422` | 成功 | live:46828 |
| 18:16:05.837 | `/422 active=true` | 成功 | live:46830 |
| 18:16:05.857 | `/422 PLAYING pos=91 ms` | 成功 | live:46834 |
| 18:20:22.350 | `AAudioStream_requestStop` + `AudioTrack stop ... 12341162 frames` | 切歌 D 开始 | live:54915, live:54917 |
| 18:20:22.354 | `abandonAudioFocus` | 成功 | live:54919 |
| 18:20:22.370 | `removeSession /422`、`Media button session is changed to null` | 成功 | live:54924, live:54925 |
| 18:20:22.368 | `isAnyActiveTrack: false`（空档起点） | 成功 | live:54922 |
| 18:20:22.536 | `AAudioStream_requestStart(s#21)`（空档 186 ms） | 成功 | live:55035 |
| 18:20:22.543 | `isAnyActiveTrack: true`（空档 175 ms） | 成功 | live:55040 |
| 18:20:22.752 | `AudioHardening ... exemption: 6` | 成功 | live:55069 |
| 18:20:22.754 | `requestAudioFocus()` | 成功 | live:55070 |
| 18:20:23.065 | `addSession ... /423` | 成功 | live:55073 |
| 18:20:23.085 | `/423 PLAYING pos=182 ms` | 成功 | live:55078 |

> 四次切歌的 `abandon → request` 间隔分别 581 / 645 / 320 / 400 ms；`removeSession → addSession` 间隔 1167 / 677 / 677 / 695 ms。
> 自动 vs 手动：系统日志里**没有**媒体键事件（`MediaButton` 0 条）。§2 的 A/C/D 与 §2.2 的两次都发生在息屏期间（18:11:40 之后再无亮屏事件），时间上支持“自动”，但系统侧不能证明；故时间线只标“系统侧成功”。

### 2.1 帧计数对账

| 切歌 | `AudioTrack stop` 帧数 | ÷48000 | 切歌前最后 `position` | 差 | 新会话首帧位置 |
|---|---|---|---|---|---|
| A (18:07:32) | 11089924 | 231.04 s | 230.369 s | +0.67 s | 115 ms |
| B (18:11:33) | 11568518 | 241.01 s | 239.900 s | +1.11 s | 143 ms |
| C (18:16:05) | 13046404 | 271.80 s | 270.654 s | +1.15 s | 91 ms |
| D (18:20:22) | 12341162 | 257.11 s | 255.892 s | +1.22 s | 182 ms |

差值稳定在 0.7–1.2 s（解码缓冲），说明每首都是**完整播完**再切，且切歌瞬间确实产生了新音频流。

### 2.2 延伸观察（分析截止后文件继续增长，不计入上述统计）

同一文件在写作期间又追加了两次**息屏期间**的切歌（18:11:40 之后再无亮屏事件），形态与前四次完全一致，仍是成功：

| 本地时间 | 事件 | 判定 | 证据 |
|---|---|---|---|
| 18:24:26.427 | `AudioTrack stop ... 11710746 frames`（243.97 s） | 成功 | live:62989 |
| 18:24:26.431 | `abandonAudioFocus` | 成功 | live:62991 |
| 18:24:26.446 | `isAnyActiveTrack: false` → `true`（18:24:26.647，空档 201 ms） | 成功 | live:62994, live:63092 |
| 18:24:27.127 | `AudioHardening ... exemption: 6` + `requestAudioFocus` | 成功 | live:63121, live:63122 |
| 18:24:27.671 | `addSession ... /424` | 成功 | live:63127 |
| 18:27:45.546 | `AudioTrack stop ... 9550418 frames`（198.97 s） | 成功 | live:70295 |
| 18:27:45.560 | `isAnyActiveTrack: false` → `true`（18:27:45.728，空档 168 ms） | 成功 | live:70305, live:70426 |
| 18:27:46.070 | `AudioHardening ... exemption: 6` + `requestAudioFocus` | 成功 | live:70466, live:70467 |
| 18:27:46.260 | `addSession ... /425` | 成功 | live:70470 |

帧计数与墙钟完全吻合（244 s / 199 s），进一步说明**息屏下自动切歌在本机上可以连续成功 6 次**，失败不是“后台切歌必现”。

---

## 3. 逐项清单：数据里有什么、没有什么

只统计 Chrome uid 10201 / pid 18631 及其系统代记行；计数截至 live 第 57494 行。

| 类别 | token | 有/没有 | 出现位置（成功边界 / 失败边界） | 行号 |
|---|---|---|---|---|
| 焦点 | `MediaFocusControl` | **有**（8 条） | 全部 4 次**成功**边界；失败边界无样本 | live:19087, 19254, 35741, 35928, 46665, 46824, 54919, 55070 |
| 焦点 | `AudioFocusDelegate` | **有**（作为 clientId 出现在上述每条） | 同上 | live:19087, 19254, 35741, 35928（其余同） |
| 焦点 | `onAudioFocusChange` | **有**（2 条） | 18:06:45.924 `-3`（DUCK）、18:06:48.081 `+1`（GAIN）；亮屏、**非**切歌边界 | live:16017, live:16025 |
| 焦点 | `requestAudioFocus` | **有**（4 条） | 每次成功切歌 1 条；失败边界无样本 | live:19254, 35928, 46824, 55070 |
| 焦点 | `abandonAudioFocus` | **有**（4 条） | 每次成功切歌 1 条；失败边界无样本 | live:19087, 35741, 46665, 54919 |
| 焦点 | `AUDIOFOCUS_LOSS` | **没有**（token 0 条；`onAudioFocusChange` 全程仅 2 条，为 `-3`/`+1`） | 全窗口无焦点丢失 | — |
| 焦点（附加） | `AS.HardeningEnforcer` | **有**（3 条） | 切歌 B/C/D 的 `requestAudioFocus` 前 1 ms；A 没有 | live:35927, 46823, 55069 |
| 焦点（附加） | `AS.FadeOutManager: unfadeOutUid() uid:10201` | **有**（5 条，其中 4 条在切歌边界） | 每次 `requestAudioFocus` 后 1–6 ms，说明请求被 AudioService 处理；另 1 条在 18:06:48.080 | live:19255, 35929, 46825, 55071, 16024 |
| 媒体会话 | `MediaSessionService` | **有**（857 条，1 Hz） | 成功边界前后连续；失败边界无样本 | live:17789（POS 示例）, 19092, 19096, 19441 |
| 媒体会话 | `MediaSessionStack` | **有**（12 条） | 每次切歌 3 条：remove / add / push top | live:19093, 19435, 19440, 35751, 35931, 35938, 46670, 46828, 46833, 54924, 55073, 55077 |
| 媒体会话 | `MediaSessionRecord` | **有**（60 条） | 全部是 `Ignoring call to destroyed session`，均落在所属切歌窗口内（销毁后 0–1.2 s；54 条在 0.26 s 内，4 条在新会话创建瞬间 0.7–1.2 s） | live:19097（首条）, 19098, 35759 |
| 媒体会话 | `MediaButton`（精确串） | **没有**（0 条） | 但 `Media button session is changed to ...` 有 8 条：切歌时先置 null、后指向新 session | live:19094, 19436, 35752, 35932, 46671, 46829, 54925, 55074 |
| 媒体会话 | `media.session` | **没有**（0 条） | — | — |
| 媒体会话 | `PlaybackState` | **有**（825 条） | 状态**只有** `PLAYING(3)`，窗口内从未出现 PAUSED/STOPPED/NONE | live:17789, 19441, 35939, 46834, 55078 |
| 媒体会话 | `MediaSessionCompat`（Chrome 侧） | **有**（4 条） | 每次新会话建立前 `Couldn't find a unique registered media button receiver` | live:19434, 35930, 46827, 55072 |
| 冻结/杀进程 | `freezing <pid> <pkg>` | **有**（65 条），但 Chrome **0 条** | 冻结日志在本缓冲内是活跃的（turbo/ims/messaging 等），Chrome 从未出现 | live:13611（示例）, 14215 |
| 冻结/杀进程 | `Frozen` / `frozen` | **有**（12 条），均属 pid 31466 等其它进程 | 与 Chrome 无关 | live:19889, 20508, 20509 |
| 冻结/杀进程 | `ActivityManager ... (kill|Killing|died)` | **有**（4 条 Killing，**0** 条 ` died`），Chrome **0 条** | 被杀者：calendar / outlook / gmail / webview sandbox | live:20509, 20610, 23950, 23985 |
| 冻结/杀进程 | `lmkd` / `am_kill` / `lowmemorykiller` / `oom_adj` / `adj=` | **全部 0 条** | 该 tag 未输出，**不能据此排除** LMK（见 §5） | — |
| 音频底层 | `AudioFlinger` | **有**（5 条），全部 pid 31466 uid 10137 | 与 Chrome 无关 | live:19889, 29951, 38018, 38445, 38852 |
| 音频底层 | `AudioTrack` | **有**：Chrome 自己 4 条 `stop(13363)` + 系统 `AS::AudioTrackMonitor` 8 条 | 只在成功边界 | live:19090, 35744, 46668, 54917；live:19101, 19231, 46687, 46792 |
| 音频底层 | `audio_hw` / `IAudioFlinger` / `direct output` / `offload` | **全部 0 条** | — | — |
| 音频底层 | `AudioPolicy` | **有**（2 条 `APM_AudioPolicyManager`），pid 1200、另一时刻 | 非切歌时刻，非 Chrome | live:30869, 31419 |
| 音频底层（附加） | `ASvc::DcHandler: setIsAnyPlaybackActive` | **有**（16 条） | 每次切歌 false→true，与 `isAnyActiveTrack` 互相印证 | live:19104, 19234, 35750, 35904, 46689, 46795, 54926, 55051 |
| Chrome 自身 | `cr_MediaSession` / `cr_Audio` | **0 条** | — | — |
| Chrome 自身 | `MediaPlayer` / `WebMediaPlayer` / `demuxer` | 仅系统 tag `MediaPlayerWrapper`（1629 条 `onMetadataChanged ... no new data`）；`WebMediaPlayer`/`demuxer` **0 条** | 全程连续，失败边界无样本 | live:17795（示例） |
| Chrome 自身 | `Pipeline` | **281 条，全部是相机 tag `Lyric`**，必须排除 | — | live:13708 |
| Chrome 自身 | `cr_BindingManager` | **有**（1 条 `onTrimMemory: level=20`） | 切歌 A 销毁后 36 ms | live:19118 |
| 屏幕/电源 | `PowerManagerService` | **有**（18 条） | 关键：息/亮屏时刻见 §2 | live:17477, 29048, 31159, 32345, 36487 |
| 屏幕/电源 | `Display` / `doze` | **有**（DreamController / DisplayPowerController） | 见 §2 | live:17526, 36726 |
| 屏幕/电源 | `suspend` | **有**（11 条），全是 `android.system.suspend-service` 的 BPF wakelock 统计告警 | 与播放无关，无系统 suspend/resume 事件 | live:17859 |
| 应用自身 | `audio:` / `audio:play` / `audio:ended` | **0 条** | 应用事件只写 IndexedDB playlog，不进 logcat | — |

---

## 4. 时区修正与两个失败形态的在线裁决

### 4.1 时区修正：设备是 EST（UTC−5），摘要 6 次事件全在窗口之前

- 设备时区 `America/Toronto`；2026-11-04 当天为 EST，现场 `adb shell 'date +%z'` 返回 `-0500`，`repro-prestate.md:7` 也标注为 `EST, America/New_York`。
- 因此摘要的 UTC 时间换算到本地**减 5 小时**（本文件早前按 −4 h 写，已作废）。

| 摘要事件 | 标注 UTC | 本地 EST | 系统侧对应证据 | 在 logcat 窗口（≥18:04:20） |
|---|---|---|---|---|
| #1 失败 | 21:27:27 | **16:27:27** | `prestate/dumpsys_audio.txt:294`（abandon 16:27:27.024）→ `:295`（request 16:27:27.971）；`playlog-full.json` id 69–78 | **否**（早 1 h 37 min） |
| #2 疑似 | 21:38:11 | **16:38:11** | `prestate/dumpsys_audio.txt:298`（16:38:11.555 abandon）→ `:299`（16:38:12.258 request） | **否** |
| #3 成功 | 21:44:33 | **16:44:33** | `prestate/dumpsys_audio.txt:302`（16:44:33.731 abandon）→ `:303` | **否** |
| #4 失败 | 21:48:37 | **16:48:37** | `prestate/dumpsys_audio.txt:304`（16:48:36.984 abandon）、`:265`（16:48:37.393 真拒绝） | **否**（早 1 h 16 min） |
| #5 成功 | 22:10:43 | **17:10:43** | `prestate/dumpsys_audio.txt:307`（17:10:43.054 abandon）→ `:308`（17:10:43.826 request） | **否** |
| #6 成功 | 22:19:49 | **17:19:49** | `prestate/dumpsys_audio.txt:317`（17:19:49.183 abandon）→ `:318`（17:19:49.715 request） | **否** |

**确定结论**：摘要全部 6 次事件都发生在 logcat 覆盖窗口（本地 18:04:20 起）之前；窗口内 6 次切歌（18:07:32 / 18:11:33 / 18:16:05 / 18:20:22 / 18:24:26 / 18:27:45，见 §2、§2.2）是摘要之后的新一轮播放。缓冲区内 16:27–17:20 这段只有 `trusty` 行（§1），所以两个失败样本**没有 logcat 覆盖**，只有 `dumpsys audio` 的焦点历史与 playlog 可用。

### 4.2 在线复现结果：28 次自动切歌 0 失败

- 环境：Pixel 9a (tegu) / Android 17 / Chrome 156，`mWakefulness=Dozing`、`mIsPowered=false`（真正熄屏、未插电），页面 `visibilityState=hidden`（`repro-prestate.md:7`、`repro-report.md:13`、`:16`）。
- 规模：21 次主动尝试（20 次有效后台自动切歌，1 次因手机被点亮作废）+ 只读期 6 次自然边界 + 试跑 2 次 = **28 次，0 失败**（`repro-report.md:67`）。每次边界的 `pre / +2 s / +10 s / +30 s` `dumpsys` 快照与自有 logcat 见 `repro-report.md:13`、`:130`、`:282`。
- 判据：成功后 30 s 观察窗内 `paused=false && ended=false` 且 `currentTime` 前进 > 1 s（`repro-report.md:39-42`）。
- 含义：失败是**低频**事件（245 行历史里恰好 2 次），不能靠“多切歌”碰运气；修复必须对准失败样本的机制，且以成功样本作为对照基线。

### 4.3 形态 (b)：开播 0.4 s 后被非用户 pause —— **R1（焦点被真拒绝）支持**

时间线（本地 EST；playlog 引用为 `playlog-full.json` 的 1-based id，与 `repro-report.md` 一致）：

| 时刻 | 事件 | 证据 |
|---|---|---|
| 16:48:36.983 | `trackchange{source:auto}` → アントワネットブルー | id 107 |
| 16:48:37.025 | `audio:play`，position 0 | id 108 |
| 16:48:37.027 / .182 | `audio:waiting`（0）/ `audio:suspend`（0.001846） | id 109 / 111 |
| **16:48:37.393** | `AudioHardening focus request for req 1 **ignored** for com.android.chrome ... level: partial`（真拒绝，非 dry-run） | `prestate/dumpsys_audio.txt:265` |
| **16:48:37.403** | **`audio:pause`，position 0.092494**；play → pause **378 ms**；前后 5 s 无 `control`/`mediasession` | id 112；`repro-report.md:144-145` |
| 16:48:36.984 → 17:06:22.375 | abandon 之后 **17 分 45 秒**没有新的 chrome `requestAudioFocus` | `prestate/dumpsys_audio.txt:304` → `:305` → `:306`；`repro-report.md:150` |
| 17:06:22.097 | `audio:play` 从 **0.092494** 继续 → 自证是真 `pause`，不是进度丢失 | id 116；`repro-report.md:152` |

对照：26 次成功边界的同位置日志一律是 `would be ignored`（dry-run，实际放行）并紧随 `requestAudioFocus`；自有 logcat 中真 `ignored` **0** 行、`would be ignored` **26** 行（`repro-report.md:124`、`:183`；该计数截至报告收尾，文件尾在 18:54:47 之后又追加了 1 行同措辞记录，不计入）。

裁决：
- **R1 支持**：`ignored` 是唯一与失败同刻（早 10 ms）出现的系统事件，方向正确；成功样本恰好都是 dry-run 放行；失败后 17 分 45 秒无焦点请求与“请求被丢弃”一致；元素跨边界复用（只换 `src`），同一个 `AudioFocusDelegate` 每次换源都 abandon→request（`repro-report.md:182-186`）。
- **R3 排除**：245+ 行 playlog 中 `playblocked` 0 条，失败样本已有 DOM `play` 事件（`repro-report.md:200-205`）。
- **R2 对 (b) 无证据支持**：这条路径不需要冻结——`play` 已发生、元素在跑，10 ms 后被外部撤销（`repro-report.md:190`、`:197`）。
- **不确定**：`level: partial`（真拒绝）与 `level: full`（dry-run）的触发条件未知（`prestate/dumpsys_audio.txt:262` vs `:265`；`repro-report.md:186`、`:188`）。

### 4.4 形态 (a)：开播约 26 s 后时间线冻结 —— **R2 未排除，首选假设**

| 时刻 | 事件 | 证据 |
|---|---|---|
| 16:27:27.168 | `trackchange{source:auto}` → 悲しみのキズ | id 70 |
| 16:27:27.232 / .233 / .395 | `audio:play`(0) / `waiting`(0) / `suspend`(0) | id 71 / 72 / 74 |
| 16:27:27.395 → 16:33:58.184 | **6 分 31 秒零媒体事件**：无 `pause`、无 `error`、无 `ended`、无 `trackchange` | id 74 → 75；`repro-report.md:166` |
| 恢复 | 16:34:12.128 `audio:play` 的 `position=26.26587` → 时间线冻结在 26.27 s | id 78；`repro-report.md:167` |
| 焦点 | **未丢失**：16:27:27.024 abandon → 16:27:27.971 request，焦点栈顶为 Chrome | `prestate/dumpsys_audio.txt:294-295`；`repro-report.md:169` |
| 同刻系统记录 | 仅 16:27:32.075 `background playback would be muted ... level: partial`（dry-run 措辞，非 enforced） | `prestate/dumpsys_audio.txt:263`；`repro-report.md:170` |

裁决：
- **R1 不解释 (a)**：失败时刻焦点已授予且 Chrome 持有，之后也没有 LOSS 记录；`would be muted` 是 dry-run。
- **R3 不解释 (a)**：`play` 事件已发生、时间线推进到 26.27 s；autoplay 拒绝会发生在 `play` 之前。
- **R2 未排除，且是首选**：每个边界都会 `destroySessionLocked` + `setFgsInactiveLocked`，若重建被拒/被驱逐，页面会进入 cached → frozen，定时器与 `ended` 不再触发，表现正是“时间线冻结、无任何事件、焦点仍名义持有”。该样本**没有 logcat 覆盖**（自有 logcat 18:19 才启动；`repro-report.md:195`），本轮 28 次成功也未复现。

### 4.5 共同触发点：边界 0.68–1.24 s 的“三无”窗口

每个自动切歌边界（实测，`repro-report.md:211-233`）：

| 相对时刻 | 事件 |
|---|---|
| +0 ~ +6 ms | `abandonAudioFocus()` |
| +3 ~ +9 ms | `onSessionActiveStateChanged active=false` → `removeSession` → `destroySessionLocked` |
| +10 ms | `setFgsInactiveLocked`（媒体 FGS 停） |
| +90 ~ +110 ms | 新曲 `audio:play` —— **此时无焦点、无 session、无 FGS** |
| +~700 ms | `requestAudioFocus()`（可能被 `HardeningEnforcer` 放行或丢弃） |
| +680 ~ +1240 ms | 新 session `active=true` + `Background started FGS: Allowed` |

实测空窗（`destroySessionLocked` → 新 session `active=true`）：680 / 681 / 702 / 1220 / 711 / 1273 ms（`repro-report.md:224-229`）；同时 `dumpsys audio` 的 player 侧 `stopped` → ~150 ms → `started`（`repro-report.md:231`）。

→ 这是两个失败形态的**共同结构原因**：形态 (b) 是窗口内焦点请求被真拒绝，形态 (a) 是窗口内 FGS/session 没有恢复。修复方向都应指向“不要让边界进入这个窗口”，或者“窗口后能自愈”。

---

## 5. 候选根因证据表（在线裁决后）

| 候选 | 现有证据 | 缺失证据 | 初步裁决 |
|---|---|---|---|
| **R1** 新播放的焦点请求被 `AudioHardening` 拒绝，Chromium 随即暂停元素 | 失败样本：16:48:37.393 `ignored`（level partial）→ 10 ms 后 pause（`prestate/dumpsys_audio.txt:265`、playlog id 112）；此后 17 分 45 秒无请求（`:304`→`:306`）。成功样本：26 次边界均为 `would be ignored` 放行（`repro-report.md:124`） | `level: partial` 与 `full` 的判定条件；`ignored` 只出现 2 次（`prestate/dumpsys_audio.txt:262` 的 14:08:06.850、`:265` 的 16:48:37.393）无法做统计 | **对形态 (b) 支持**；对 (a) 不解释（焦点当时已授予） |
| **R2** 边界后 FGS/会话未恢复 → 页面 cached → 冻结/静默停 | 每个边界都有 `destroySessionLocked` + `setFgsInactiveLocked` 的 0.68–1.24 s 空窗（`repro-report.md:220-233`）；形态 (a) 表现为时间线冻结、无任何事件、焦点未丢 | (a) 样本无 logcat（`repro-report.md:195`）；28 次成功里未观察到 FGS 重建被拒或冻结 | **对 (b) 排除；对 (a) 未排除，首选假设** |
| **R3** 后台 `play()` 被 autoplay 拒绝（`NotAllowedError`） | 245+ 行 playlog `playblocked` **0** 条；失败样本已有 DOM `play` 事件；`hasBeenActive=true` | — | **排除**（`repro-report.md:200-205`） |
| **④ 次要** 1 Hz 会话/通知/FGS 重建在边界叠加 | `MEDIA_SYNC_INTERVAL=1000`（`src/core/store.js:77`、`:1553-1557`）→ 每 1.063 s 一次会话推送；窗口内 825 条会话状态行、798 条 FGS 告警、1629 条 `no new data`、939 条通知告警；边界还要额外 destroy/create | 失败样本里该速率是否中断或爆量 | **初步**：加重边界的系统工作量，但不是决定性原因 |

---

## 6. 修法候选与倾向（只列，不实现）

| # | 修法 | 体积 | 无缝性 | OneDrive 流式兼容 | 实现风险 | 真机验证点 |
|---|---|---|---|---|---|---|
| 1 | **预先切歌，绕开 `ended` 边界**：`timeupdate` 到 `duration − N ms` 时对同一 `<audio>` 换源并立即 `play()`，让 Chrome 不经历 `ended → abandon → 销毁/重建` | 无变化（纯代码） | 提升（若 session 真不销毁）；需处理短重叠/漏尾 | 无影响（仍按需取整文件） | 中（切歌点精度、漏尾、e2e 需改） | A/B 对比每首的 `destroySessionLocked` / `setFgsInactiveLocked` / session 号是否递增；`AudioTrack stop` 是否仍出现 |
| 2 | **双元素无缝交接**：第二个 `<audio>` 在结尾前 ~100–300 ms 起播（音量渐变），前一个停 | 无变化（运行期多一路解码，内存↑） | 最高（tab 始终有 playing 元素，理论上不拆会话/FGS） | 无影响 | 中高（两路解码、单元素不变量改写、暂停/切歌一致性） | 观察是否仍有 session 销毁、是否出现两条同时 active 的 track（`isAnyActiveTrack`、`dumpsys audio` 的 players） |
| 3 | **边界看门狗 + 显式重试**：自动切歌后 3 s 检查 `paused` / `position`，异常则写诊断并 `play()` 重试（带 200–500 ms 退避） | 无变化 | 中性偏正 | 无影响 | 中（偶发双声/抢焦，必须写 playlog） | 人工构造焦点拒绝（或复现 (b)）后是否自愈；重试是否产生 `control` 之外的日志噪音 |
| 4 | **诊断补强**：page instance id、`document.wasDiscarded`、`audio.readyState/networkState/paused` 采样、`AudioContext.state`、FGS/焦点相关 playlog 标记 | 无变化 | 无影响 | 无影响 | 低 | 新字段是否随每次切歌落盘；能否区分“原地卡住”与“页面重建” |
| 5 | **1 Hz `setPositionState` 降频**（`MEDIA_SYNC_INTERVAL` → 5–10 s 或事件驱动） | 无变化 | 略升（边界少一次竞争） | 无影响 | 低 | `onSessionPlaybackStateChanged` 行数从 ~1 Hz 降到 ≤0.2 Hz；通知进度条变粗是否可接受 |

**倾向（初步）**：波 2 主修 = **1（失败则切 2）+ 3 + 4**；5 作为低风险顺带项；每个修法都必须用真机 A/B 验证是否真的消除了 `destroySessionLocked` / `setFgsInactiveLocked`，否则无缝性收益只是推测。

---

## 7. 给在线复现 Worker 的取证清单

### 7.1 采集

```sh
# 禁止清空缓冲：不要给 `adb logcat` 加 `-c`（会清掉既有抓取，本次复现明令禁止）。
adb logcat -v threadtime -b main,system,events > .scratch/adb/repro-logcat-<HHMM>.txt
```

- 另开文件、另起进程即可；已有 `live-1810.txt`（另一进程持续抓取）必须保持不动。
- 本轮实际用法：`-b main,system,events` → `.scratch/adb/repro-logcat-1819.txt`（`repro-report.md` 原始文件清单）。

失败发生时刻（或每 30 s 一次，围绕边界 ±10 s）另抓：

```sh
adb shell dumpsys media_session > .scratch/adb/dms-<ts>.txt
adb shell dumpsys audio         > .scratch/adb/dms-audio-<ts>.txt
adb shell dumpsys activity processes > .scratch/adb/dms-proc-<ts>.txt
adb shell dumpsys power         > .scratch/adb/dms-power-<ts>.txt
```

建议过滤/关注的 tag（本次窗口已验证有输出）：

`MediaSessionService`、`MediaSessionStack`、`MediaSessionRecord`、`MediaFocusControl`、`AS.HardeningEnforcer`、`AS.FadeOutManager`、`AudioManager`、`ASvc::DcHandler`、`AS::AudioTrackMonitor`、`AudioTrack`、`AAudio`、`AAudioStream`、`MediaSessionCompat`、`cr_BindingManager`、`ActivityManager`、`PowerManagerService`、`DreamController`。

### 7.2 `dumpsys` 要看的字段

| 命令 | 字段 | 判定意义 |
|---|---|---|
| `dumpsys media_session` | 每个 record 的 `PlaybackState {state=…, position=…}`、`active=`、`Media button session` | 失败时是否停在 `PAUSED`/`NONE`、position 是否冻结、session 是否消失 |
| `dumpsys audio` | `Audio Focus stack entries`、`Focus owner`、`faded out uids`、`players:` 的 `state:started/stopped`、`muted`、`## Hardening enforcement` 历史 | 焦点是否真授予 Chrome；该次请求是 `ignored` 还是 `would be ignored`；AudioService 是否认为它在播 |
| `dumpsys activity processes` | Chrome 各进程（browser/renderer/gpu）、`oom adj`、`cached`/`frozen`、`hasActivities`、服务列表 | 渲染进程是否被冻结/杀死；FGS 是否还在 |
| `dumpsys power` | `Wakefulness`、`Display Power` | 失败时是否处于 doze/屏幕状态 |

### 7.3 最小证据集

**成功边界（窗口内 6/6、在线 28/28 均满足）：**

1. `abandonAudioFocus() uid/pid 10201/18631`
2. `AAudioStream_requestStop(s#21)` + `AudioTrack: stop(...)` 带帧数
3. `removeSession` → `destroySessionLocked`
4. ≤ 250 ms 内 `AAudioStream_requestStart(s#21)` 且 `isAnyActiveTrack: true`
5. `requestAudioFocus()`（±1 ms 可有 `AudioHardening ... exemption`）
6. `addSession` → `active=true` → `PLAYING`，position < 300 ms
7. 随后 1 Hz 会话更新中断间隔 < 2.5 s（本窗口最大 2.127 s）

**失败边界（需要捕获的“缺环”）：**

- `removeSession` 后 > 5 s 无 `addSession`；或 `addSession` 后无 `active=true`；
- 有 `PLAYING` 但无 `AAudioStream_requestStart`（= 时间线在走、音频没起）；
- `AudioTrack stop` 后无 `requestStart`（= 流没重启）；
- `AS.HardeningEnforcer: ... focus request ... ignored`（**不是** `would be ignored`）出现在边界 ±20 ms 内 —— 形态 (b) 的判定点（`prestate/dumpsys_audio.txt:265`）；
- `requestAudioFocus` 出现但 `dumpsys audio` 的 focus stack 里没有 `com.android.chrome`；
- `dumpsys activity processes` 中 Chrome renderer 显示 `frozen` 或已消失。

---

## 8. 待验证问题（在线裁决后只剩三条）

1. **形态 (a) 的 26 s 机制**：16:27:27 起播后时间线冻结在 26.26587 s、6 分 31 秒零事件、焦点未丢。是 freezer（cached → frozen）、FGS 重建被拒，还是 Chrome 内部策略？需要在该时刻有 logcat 覆盖或下一次失败时抓 `dumpsys activity processes` 的 `cached/frozen` 与 `dumpsys power`。
2. **`level: partial` 与 `level: full` 的触发条件**：两次真拒绝（14:08:06.850、16:48:37.393）都是 `partial`，26 次成功边界全是 `full`（dry-run）。`dumpsys audio` 只有 `mHardeningOverride=0`，`device_config list media_safety` 为空，logcat 无 `HardeningPolicy/Config` 行——目前只能给出经验二分，无法给判定公式。
3. **早切 / 双元素是否真的避免 session 销毁**：修法 1/2 的核心假设是“不让 Chrome 经历 `ended` 边界就不会 `destroySessionLocked` + `setFgsInactiveLocked`”。必须真机 A/B 验证 session 号是否停止递增、FGS 是否不再被停。

---

## 附录：引用核对方法

```sh
# 任一行号回查（示例）
sed -n '19087p;19254p;35927p;46823p;55069p' .scratch/adb/live-1810.txt
# 计数（口径：截至第 57494 行的快照；live 会继续增长，不截断则计数会漂移）
head -57494 .scratch/adb/live-1810.txt | grep -c 'MediaFocusControl'
head -57494 .scratch/adb/live-1810.txt | grep -c 'AUDIOFOCUS_LOSS'
# 在线复现引用（本地 EST；dumpsys 行号）
sed -n '263p;265p;294p;295p;298,308p;317,318p' .scratch/adb/prestate/dumpsys_audio.txt
# 复现报告引用（R1/R2/R3 与边界空窗）
grep -n 'ignored for com.android.chrome\|0.68–1.24\|28 次自动切歌' .scratch/adb/repro-report.md
# playlog 引用为 1-based id（与 repro-report.md 一致），例如 id 71–78 / 107–116
```

行号对 `.scratch/adb/ringbuffer-1810.txt` 同样成立，直至 26071（两者前缀逐字节相同）。

---

## 附录 A：A/B 原型（2026-11-04 19:05–19:20，用户插话中止）

- 产物：`.scratch/ab/report.md`、`ab.html`、`server.mjs`、12 个 6–8 s WAV、逐边界 logcat。
- 路线 1（同一 `<audio>` 在 `duration − 150 ms` 换源并 `play()`）：**11/11 边界仍然出现** `abandonAudioFocus` + `destroySessionLocked` + `setFgsInactiveLocked` + `requestAudioFocus` + `addSession`（`abandon` 在 mark −0.04~−0.14 s，`request` +0.19~+0.65 s，`addSession` +0.62~+0.98 s）。按 Conductor 判据**否决**。
- 路线 2（双 `<audio>` 重叠交接）：原型首次起播的焦点请求被 AudioHardening 真拒绝（`Audio focus request blocked by hardening`），未取得有效边界数据，**未验证**；复测被用户叫停。
- 结论：修法 1 不能消除结构性窗口；若继续修，只能走路线 2，并需按“前台起播→息屏/后台→边界”的顺序复测。

## 附录 B：19:17:15 现场失败（形态 (b) 第二次直接证据）

`live-1810.txt` 189692–189888（片段存 `.scratch/adb/failure-1917.txt`）：

```
19:17:14.763 MediaFocusControl: abandonAudioFocus() ... com.android.chrome
19:17:15.041 AS.HardeningEnforcer: AudioHardening focus request for req 1 ignored ... level: partial
19:17:15.042 AS.AudioService: Audio focus request blocked by hardening
playlog: 19:17:14 audio:play pos=14.994205 → 19:17:15 audio:pause pos=15.100872（107 ms，无 control）
```

与历史 16:48:37 样本同构；证明 `level: partial` 时焦点请求会被真正丢弃，Chrome 随即暂停元素。
