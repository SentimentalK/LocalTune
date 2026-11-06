# 网页端「打开即 2.9 GB」内存调查与修复（2026-11-06）

> 范围：APP-001-AA。基线 `main@4410a78`，阶段 1 报告提交 `1d9c4c1`。
> 仪器：本机 Chromium 156.0.7615.0（Playwright chromium-1248）、Intel UHD Graphics (CML GT2)、
> X11 `DISPLAY=:0`、14 GB RAM、Node v24.20.0；`ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL ES 3.2)`。
> 脚本：`scripts/memory-probe.mjs`（已入库，可复跑）。原始 JSON：`.scratch/memory-probe/runs/<label>.json`
> （gitignore；文件名就是下文表格里的 run 名）。推测一律标 `[推测]`，没测到的一律写“未观测”。

## 结论（TL;DR）

1. **本机 19 个配置下不能复现 2.9 GB。** 空曲库 + demo dismissed + 静止 60 s 的实测：
   **匿名私有内存 185.0 MB**（= `Private_Dirty + Swap`，下文简称 anon），
   PSS 合计 346.6 MB，私有 footprint 192.4 MB，RSS 相加 1188.3 MB。
   同机 `about:blank`：anon **134.8 MB**、PSS 282.3、footprint 139.4、RSS 相加 1084.8。
   即**页面自身只值 +50.2 MB anon**。
2. **没有泄漏。** 空曲库静止 9 min：anon 200.5 → 186.2（60 s）→ **184.1**（540 s）；
   JS 堆 3.7 → 1.7 MB；DOM 827 节点、106 listener 全程不动。
3. **“降 50%”在空曲库场景数学上不可达**：下限是浏览器自己的 134.8 MB anon。
4. **票里的 CSS 特效候选被量化排除**：filter / mask / mix-blend-mode / backdrop-filter /
   will-change / animation **全关**后 anon 194.2 MB，比基线 185.0 还高（噪声范围内）。
5. **唯一能长到 GB 级的应用机制（已量化）：启动时把全库封面 Blob 读进内存。**
   1000 首 × 200 KB 封面 → 开机 0–5 s anon **439.9 MB**（同样 1000 首、1 KB 封面只有 244.2），
   30 s 内回落到 230.5，60 s 225.8。Δ ≈ 封面总字节 ×1.0。
   3000 首 × 300 KB ≈ 0.9 GB；10000 首 ≈ 3 GB（线性外推，未实测）。
6. **“打开就 1–3 GB”更可能是口径**：同一时刻把各进程 RSS 相加是 **1188 MB**（空白页都有 1085 MB），
   anon 的 6.4 倍。任何“把 working set 相加”的工具看一个空页面就已经是 GB 量级 `[推测，未在用户机器上观测]`。
7. **空闲 CPU 有真实浪费**：不播放也常驻 `requestAnimationFrame`，60 s 烧 1.04 s task 时间
   （空白页 0.01 s）≈ 1.7% CPU 常驻。已修（见 §5）。

## 1. 测量口径与可复跑

### 1.1 命令

```bash
npm run build                                  # dist/ 对应 main
PORT=4199 node scripts/serve.mjs               # 本地静态站
node scripts/memory-probe.mjs \
  --label empty-local --url http://127.0.0.1:4199/ \
  --scenario empty --samples 5,30,60           # 有头、1440×900、DPR 1
```

`--scenario empty|demo|lib1000|blank`、`--variant baseline|no-heavy-effects|no-svg-filter|no-mask-blend|
no-backdrop|no-raf|no-gpu|swiftshader|cv-auto`、`--dpr`、`--width/--height`、`--play`、
`--search <q>`、`--cover-bytes <n>`、`--cache-bytes`、`--keep`。

### 1.2 四个数字

| 口径 | 来源 | 用途 |
|---|---|---|
| **anon = `Private_Dirty + Swap`** | `/proc/<pid>/smaps_rollup` | **主判据**：匿名私有页，内核回收不了，跨并发度稳定 |
| 私有 footprint = `Private_Clean + Private_Dirty + Swap` | 同上 | ≈ Chrome Task Manager “Memory footprint” |
| PSS 合计 | `smaps_rollup` 的 `Pss`，按 `--user-data-dir` 归属 | 共享页按映射进程数分摊 |
| RSS 合计 | `/proc/<pid>/status` 的 `VmRSS` | “把各进程 working set 相加”的工具口径 |
| JS 堆 / Nodes / JSEventListeners | CDP `Performance.getMetrics` + `Memory.getDOMCounters` | V8 与 DOM |

**坑（本次实测，直接影响结论）**：
1. `Private_Clean` 是文件页，内核在内存压力下会回收，**同一场景**并行跑 4 个 Chromium 时
   blank 的 footprint 从 187.1 掉到 139.4，而 `Private_Dirty` 只从 135.8 变到 134.8。
2. PSS 按共享页的映射进程数分摊，并行实例之间会互相稀释（browser 进程能差 20 MB）。
3. 所以只有 **anon** 能跨 run 比较。下文所有对比都以 anon 为准，其余三列并排给出。

场景固定：新 `--user-data-dir`；`empty` = 清空 `tracks` + `meta.demoDismissed=true` + 删 `meta.playback`
（等价于点「清空队列」后 reload）；全程不交互；采样点 5 / 30 / 60 s，另有 5 min 与 9 min 稳定性跑法。

### 1.3 三个入口

- 线上 `https://tune.mainstayx.com`：`VERSION = 0aec7cd613`，`main-MCYHIKQ4.js`，
  Last-Modified 2026-11-06 06:55 UTC（不含 AB/AC 两个 commit）。
- 本地 `dist`：`VERSION = 0627868e62`，`main-RSAB3537.js`，源码 = `main@4410a78`。
- 两者 bundle 不同（源码差 AB/AC），**实测内存无差异**（§2）。
- 本地开发构建（esbuild 不压缩）未单测：同一份 `src`，没有第二套运行时路径；未压缩只影响解析期。
  这是推断，**未观测**。

## 2. 场景对比（各 run 的 60 s 采样点）

有头、新 profile、静止不交互。单位 MB。

| 场景 | 窗口/DPR | **anon** | footprint | PSS | RSS 相加 | JS 堆 | DOM 节点 | listener | 活 objURL |
|---|---|---|---|---|---|---|---|---|---|
| `blank-chromium`（about:blank） | 1440×900 @1 | **134.8** | 139.4 | 282.3 | 1084.8 | 0.7 | 4 | 0 | 0 |
| **空曲库 本地 dist** | 1440×900 @1 | **185.0** | 192.4 | 346.6 | 1188.3 | 2.3 | 827 | 106 | 0 |
| 空曲库 线上 | 1440×900 @1 | 184.0 | 193.2 | 358.1 | 1188.4 | 2.5 | 829 | 121 | 0 |
| 空曲库 @DPR2 | 1512×982 @2 | 190.5 | 196.7 | 351.5 | 1192.8 | 2.3 | 827 | 106 | 0 |
| 空曲库 4K | 3840×2160 @1 | 180.7 | 187.2 | 342.0 | 1180.6 | 2.2 | 827 | 106 | 0 |
| 空曲库 5K | 2560×1440 @2 | 186.5 | 211.1 | 417.1 | 1186.8 | 2.3 | 827 | 106 | 0 |
| 空曲库 手机 | 390×844 @3 | 188.2 | 195.0 | 349.7 | 1193.0 | 2.3 | 827 | 106 | 0 |
| 空曲库 SwiftShader | 1440×900 @1 | 146.1 | 154.3 | 327.7 | 1146.7 | 2.3 | 827 | 106 | 0 |
| 空曲库 `--disable-gpu` | 1512×982 @2 | 145.0 | 149.8 | 286.0 | 1149.9 | 2.3 | 827 | 106 | 0 |
| 有 demo（3 首，未播放） | 1440×900 @1 | 184.3 | 186.5 | 305.6 | 1186.8 | 1.9 | 880 | 113 | 0 |
| 1000 首曲库（1 KB 封面） | 1440×900 @1 | 225.0 | 233.1 | 388.8 | 1234.1 | 2.7 | 827 | 105 | 2 |
| 1000 首曲库（50 KB 封面） | 1440×900 @1 | 219.0 | 273.3 | 486.9 | 1224.4 | 2.7 | 827 | 105 | 2 |
| 1000 首曲库（200 KB 封面） | 1440×900 @1 | 225.8 | 232.2 | 390.6 | 1239.9 | 2.7 | 827 | 105 | 2 |
| 1000 首 + 搜索命中 200 行 | 1440×900 @1 | 246.1 | 254.8 | 411.8 | 1257.8 | 3.8 | 3441 | 1918 | 201 |

读法：

- 1440×900 到 5120×2880 设备像素之间，anon 只从 185.0 到 186.5 —— **窗口大小不解释内存**。
- 软件渲染（SwiftShader / `--disable-gpu`）反而少 40 MB：省掉的是 GPU 进程那份。
- 空曲库、有 demo、1000 首曲库，anon 都在 185–226 之间。**没有 GB 级来源。**

### 2.1 空曲库静止 9 min（`empty-idle-9min`）

| t | anon | PSS | RSS 相加 | JS 堆 | DOM 节点 | listener | renderer task 累计 |
|---|---|---|---|---|---|---|---|
| 0 s | 200.5 | 358.7 | 1200.8 | 3.7 | 1782 | 281 | 0.19 s |
| 60 s | 186.2 | 456.4 | 1194.8 | 2.3 | 827 | 106 | 1.24 s |
| 180 s | 185.6 | 458.8 | 1199.2 | 2.3 | 827 | 106 | 3.26 s |
| 300 s | 185.6 | 459.3 | 1199.9 | 2.3 | 827 | 106 | 5.27 s |
| 420 s | 184.6 | 458.5 | 1199.2 | 2.1 | 827 | 106 | 7.30 s |
| 540 s | 184.1 | 458.2 | 1198.9 | 1.7 | 827 | 106 | 9.40 s |

- 0 s 的 1782 节点 / 3.7 MB 堆是 **reload 后的上一份 document 还没回收**
  （`Memory.getDOMCounters` 统计整个 renderer），60 s 归位到 827，不是增长。
- anon 在 60 s 到 540 s 之间从 186.2 **降到** 184.1；JS 堆从 3.7 收到 1.7 MB。
  **9 分钟里没有任何单调增长。**
- 同期 renderer task 时间 1.24 → 9.40 s：9 分钟约 1.5% CPU 纯烧在空闲 `armTick` 上。
- 另一次 5 min 跑（`empty-local-r2-5min`）：anon 202.1 → 186.8 → 188.5 → 188.7，同样平。

### 2.2 播放中（`demo-playing-180`，3 首 demo，播放 3 min）

| t | anon | renderer PSS | utility(audio) PSS | JS 堆 | DOM 节点 |
|---|---|---|---|---|---|
| 0 s（刚点播放） | 222.8 | 75.6 | 58.2 | 3.2 | 965 |
| 5 s | 239.9 | 91.7 | 58.2 | 3.7 | 1193 |
| 60 s | 290.0 | 152.5 | 57.9 | 2.8 | 920 |
| 180 s | 285.9 | 155.3 | 58.1 | 3.1 | 1088 |

- 开始播放后 60 s 内 anon +67 MB，之后 120 s 不再涨 → **一次性**，不是泄漏。
  `qingtian.mp3` 2.4 MB 被完整取回并解码（3 min 立体声 44.1 kHz float32 ≈ 63 MB），增量同量级。
- 应用侧只持有 1 个 `<audio>` 的 blob URL 与 1 个预取槽（`player.js`、`prefetch.js`），
  没有可改的句柄；**这是浏览器的音频解码行为**，未找到应用侧旋钮。

## 3. 归因

### 3.1 确认：应用自身在空曲库静止时 = 空白页 + 50 MB anon

| 组成 | 空曲库 | 空白页 | 差 |
|---|---|---|---|
| **anon** | **185.0**（串行重跑 188.8） | **134.8**（串行 135.8） | **+50.2**（串行 +53.0） |
| footprint | 192.4 | 139.4 | +53.0 |
| GPU 进程 PSS | 89.6 | 61.2 | +28.4 |
| renderer PSS | 64.9 | 37.4 | +27.5 |
| browser PSS | 93.5 | 86.5 | +7.0 |
| JS 堆 | 2.3 | 0.7 | +1.6 |

即：半个 V8 隔离区 + 一次真实页面的光栅 + 2.3 MB 业务堆。**没有 GB 级来源。**

### 3.2 排除：CSS 特效不是内存原因

在同一页面上注入覆盖样式后重测（60 s，anon / PSS）：

| variant | 关掉什么 | anon | PSS |
|---|---|---|---|
| baseline | — | **185.0** | 346.6 |
| `no-svg-filter` | 唱臂 `drop-shadow`、`stylus-point` 发光、`:focus-visible` | 189.2 | 296.3 |
| `no-mask-blend` | 所有 `mask-image` + `mix-blend-mode: screen` | 189.2 | 292.4 |
| `no-backdrop` | 所有 `backdrop-filter` | 189.3 | 296.9 |
| `no-heavy-effects` | filter + backdrop + blend + mask + box-shadow + will-change + animation，**全关** | 194.2 | 298.0 |

**全关不减反增。** 唱臂 SVG filter、黑胶 `mask` / `mix-blend-mode`、`backdrop-filter` 在静止时
不持有可观内存；它们影响绘制成本，不影响驻留。

### 3.3 排除：SW 缓存、object URL、JS 堆、DOM

- CacheStorage：空曲库 `caches.keys()` = `localtune-0627868e62`，**22 项 / 514 570 B**
  （`--cache-bytes` 逐条读 body 求和）。播放 demo 后仍是 22 项 —— demo 音频走 Range，
  `sw.template.js` 明确不缓存 `/demo/`。
- 活 object URL：空曲库 **0**；demo 未播放 0；播放中 0；1000 首曲库 2（当前曲 + 预取）。
- JS 堆：全程 1.7–3.8 MB。
- DOM：827 节点 / 106 listener 恒定；1000 行搜索结果才到 3441 / 1918。
  `content-visibility:auto` 注入（`lib1000-search-cv`）对 anon 无影响（243.6 vs 246.1）。

### 3.4 确认（并量化）：启动期把整库封面 Blob 读进内存

`src/core/db.js:100 getAllTracks()` 返回 `tracks` 表的全部记录，每条的 `cover` 就是封面 `Blob`
（`src/core/metadata/id3.js:459`、`mp4.js:82` 生成）；`src/core/store.js:434` 在 `createApp()` 里一次读全库。
同一批 1000 首、只改封面大小：

| 曲库 | 0 s anon | 5 s anon | 30 s anon | 60 s anon | 0 s browser PSS |
|---|---|---|---|---|---|
| 1000 × 1 KB（合计 1 MB） | 244.2 | 244.8 | 225.3 | 225.0 | 131.9 |
| 1000 × 50 KB（合计 49 MB） | 236.3 | 237.4 | 219.8 | 219.0 | 111.1 |
| 1000 × 200 KB（合计 200 MB） | **439.9** | 439.8 | 230.5 | 225.8 | **325.8** |
| 1000 × 200 KB（串行重跑，无并发干扰） | 439.7 | 440.6 | 228.0 | 226.4 | — |

- 200 KB 封面把开机 0–5 s 的 anon 推高 **+195.7 MB**，browser 进程 PSS 从 131.9 推到 325.8；
  形状与「封面总字节」完全同步：0–5 s 平台 → 30 s 内释放。
- 30 s 后 Chrome 把 Blob 数据页还回磁盘，所以**只看 60 s 稳态的测量会漏掉这段峰值**；
  这也让「打开就 N GB、放一会儿又好了」能同时成立 `[推测]`。
- 规模：3000 首 × 300 KB ≈ 0.9 GB；10000 首 ≈ 3 GB（线性外推）。
  **这是代码里唯一能到票面量级的机制**，也正是票里列的第 1 个候选。
- 它要求**库非空**。真正空的库不成立 —— 所以本机 `empty` 场景复现不到 2.9 GB。
  注意「没有歌、demo 也没有」在本应用里可以由 `clearQueue()` 造成：`store.js:1290` 只清队列，
  **不动曲库**，此时队列是空的、`state.tracks` 仍是整库。`[推测]` 这正是用户看到的状态。

## 4. “2.9 GB 从哪来”——本机能确认与不能确认的

| 口径 | 空曲库 1440×900 | 空白页 | 倍数/差值 |
|---|---|---|---|
| anon（内核回收不了的匿名页） | 185.0 MB | 134.8 MB | +50.2 MB |
| 私有 footprint（≈ Chrome Task Manager "Memory footprint"） | 192.4 MB | 139.4 MB | +53.0 MB |
| PSS 合计 | 346.6 MB | 282.3 MB | +64.3 MB |
| **RSS 相加** | **1188.3 MB** | **1084.8 MB** | **6.4× anon** |

单实例、单标签、空曲库、静止不动，只要按「各进程 RSS / working set 相加」读，就已经 1.2 GB；
再加两个标签或 DevTools，2.9 GB 不需要页面做错任何事 `[推测，未在用户机器上观测]`。

本机无法判定、只有用户机器能确认的因素：Chrome 版本与 GPU 驱动、是否 PWA 安装态、
是否开着 DevTools、同 profile 的其他标签与扩展、profile 里累积的 CacheStorage/audio cache
（`DEFAULT_CACHE_LIMIT = 2 GB`，`src/core/cache/audioCache.js:9`）。

## 5. 修复（阶段 2）

见 §6。方案由 Conductor 2026-11-06 批准：**封面外置 + DB v5→v6 迁移 + UI 按需读封面**，
并同时停掉空闲 `armTick`。

### 5.1 方案

- `tracks` 行不再带 `cover` Blob；新 `covers` 存储（keyPath `id`）存 `{id, cover}`。
- 开机 `getAllTracks()` 只读元数据（`hasCover` / `coverSize` / `coverType`），**不触发封面字节**。
- UI 只对**当前渲染行 + 正在播放的那一首** `acquire` object URL；`createCoverCache` 用
  引用计数 + LRU（上限 64）回收，列表重建时释放上一轮的 id。
- 迁移在 `onupgradeneeded` 的同一事务内完成（原子），逐行 try/catch，单行坏不中止升级。
- Media Session artwork 复用同一份缓存 URL，不再单独建 Blob URL。

### 5.2 前后对比

见 §6（阶段 2 完成后补）。

## 6. 阶段 2 实测（完成前留空）

## 7. 用户侧如何复核

在用户机器上按顺序取三样东西（不需要装东西）：

1. Chrome 自带 Task Manager（`Shift+Esc`）→ 右键表头打开 **“Memory footprint”** 与
   **“JavaScript memory”** 两列 → 展开到进程粒度。看**单个标签页进程**；
   JavaScript memory 才是我们的堆（本机空曲库 2.3 MB）。如果是 GB 级，才是页面问题。
2. `chrome://gpu` 顶部 “Graphics Feature Status”，看是否 “Software only”。
3. 同一窗口只留这一个标签、关掉扩展，开一个**新窗口**再读一次；
   另外在打开瞬间（前 5 s）和 1 分钟后各读一次 —— 封面搬迁前后的差别就在前 30 s。
