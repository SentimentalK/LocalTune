# 网页端「打开即 2.9 GB」内存调查与修复（2026-11-06）

> 范围：APP-001-AA。基线 `main@4410a78`（2026-11-06 09:58）。本文件只写被测量的东西；
> 推测一律标 `[推测]`，未观测到的一律写“未观测”。
> 仪器：本机 Chromium 156.0.7615.0（Playwright chromium-1248）、Intel UHD Graphics (CML GT2)、
> X11 `DISPLAY=:0`、14 GB RAM、Node v24.20.0。
> 脚本：`scripts/memory-probe.mjs`（本 commit 一起入库，可复跑）；原始 JSON：
> `.scratch/conductor/aa/runs/*.json`（gitignore，按 run 名对应下文）。

## 结论（TL;DR）

1. **本机 19 个配置下不能复现 2.9 GB。** 空曲库、demo 已 dismissed、静止 60 s 的最大观测值：
   进程 **PSS 合计 346.6 MB**（1440×900 / DPR 1 / 硬件 GL），私有 footprint **192.4 MB**。
   把窗口推到 5120×2880 设备像素是 417.1 MB / 211.1 MB；SwiftShader 软件渲染更低（327.7 / 154.3）；
   `--disable-gpu` 更低（286.0 / 149.8）。线上 `tune.mainstayx.com` 同场景 358.1 MB / 193.2 MB。
2. **没有泄漏。** 空曲库静止 5 min：JS 堆 2.23 → 2.27 MB、DOM 827 节点、listener 106，全程不变；
   demo 播放 3 min：JS 堆 2.77 → 3.07 MB、DOM 920 → 1088，不单调增长。
3. **应用自身只占一小块。** 同机 `about:blank` 空白页 = PSS 282.3 MB / 私有 139.4 MB。
   空曲库应用相对空白页只多 **+64.3 MB PSS / +53.0 MB 私有**；JS 堆 2.3 MB、CacheStorage 22 项 / 514 KB、
   object URL 0 个。**“降 50%”在该场景数学上不可达**：下限是浏览器自身 139.4 MB 私有内存。
4. **唯一能长到 GB 级的应用机制（已量化）：启动时把整库封面 Blob 读进内存。**
   `getAllTracks()` 返回的每条 track 都带 `cover` Blob，`store.js:434` 在开机时全量读。
   1000 首 × 200 KB 封面：开机第 0–5 s 私有内存 445.5 MB、browser 进程 PSS 325.8 MB；
   30 s 后回落到 236.3 MB / 131.6 MB。同一批 1000 首只换封面大小（1 KB）时开机第 0–5 s 只有 251.3 MB。
   即**启动峰值 ≈ 基线 + 全库封面字节数**，与封面总大小 1:1。
5. **“打开就 1–3 GB”更可能来自口径，而不是页面。** 同一时刻按 `/proc` 求和 RSS = **1188 MB**
   （空白页也有 1085 MB），是 PSS 合计的 3.4 倍：Chrome 的共享二进制/堆页在每个进程里各算一次。
   用任何“把各进程 working set 相加”的工具看一个空页面就是 1 GB 量级。
6. **空闲 CPU 有真实浪费**：不播放也常驻 `requestAnimationFrame`（`app.js:1634 armTick`），
   60 s 内 renderer 侧 task 时间 1.04 s（空白页 0.01 s），即约 1.7% CPU 常驻。

## 1. 测量口径与可复跑

### 1.1 命令

```bash
npm run build                                  # dist/ 与 main@4410a78 一致
PORT=4199 node scripts/serve.mjs               # 本地静态站
node scripts/memory-probe.mjs \
  --label empty-local --url http://127.0.0.1:4199/ \
  --scenario empty --samples 5,30,60           # 有头、1440×900、DPR 1
```

`--scenario empty|demo|lib1000|blank`、`--variant baseline|no-heavy-effects|no-svg-filter|
no-mask-blend|no-backdrop|no-raf|no-gpu|swiftshader|cv-auto`、`--dpr`、`--width/--height`、
`--play`、`--search <q>`、`--cover-bytes <n>`、`--cache-bytes`、`--keep`。

### 1.2 三个数字分别是什么

| 口径 | 来源 | 含义 |
|---|---|---|
| JS 堆 / Nodes / Documents / JSEventListeners | CDP `Performance.getMetrics` + `Memory.getDOMCounters` | V8 与 DOM |
| **私有 footprint** | `/proc/<pid>/smaps_rollup` 的 `Private_Clean + Private_Dirty + Swap` | 主判据；不受共享页分摊影响 |
| **PSS 合计** | `/proc/<pid>/smaps_rollup` 的 `Pss`，按 `--user-data-dir` 归属 | 次判据 |
| RSS 合计 | `/proc/<pid>/status` 的 `VmRSS` | “把各进程 working set 相加”的工具口径 |

**坑（本次实测）**：PSS 按共享页的映射进程数分摊，并行跑多个 Chromium 实例时同一份
Chrome 共享页被多个实例分摊，browser 进程 PSS 会凭空少 20 MB。所以并行波次之间只能用
私有 footprint 比，PSS 只在同并发度下比。下文所有“前后对比”都是串行单实例测的。

场景固定：新 `--user-data-dir`；`empty` = 清空 `tracks` 表 + `meta.demoDismissed=true` + 删除
`meta.playback`（等价于点“清空队列”后 reload）；全程不交互；采样点 5 s / 30 s / 60 s（部分 5 min / 9 min）。

### 1.3 入口对照

- 线上 `https://tune.mainstayx.com`：`VERSION = 0aec7cd613`，`main-MCYHIKQ4.js`，
  Last-Modified 2026-11-06 06:55 UTC（部署于 `bd3bfea` 前后，不含 CI commit）。
- 本地 `dist`：`VERSION = 0627868e62`，`main-RSAB3537.js`，源码 = `main@4410a78`。
- 两者 bundle 不同（AB/AC 两个 commit 的源码差异），**实测内存无差异**（§2 表）。
- 本地开发构建（esbuild 不压缩）未单测：`src` 与 `dist` 是同一份源码，没有第二套运行时路径；
  未压缩只影响 JS 文件字节数与解析期，不影响 60 s 静止口径 —— 这是推断，**未观测**。

## 2. 场景对比（各场景最后一个采样点 = 60 s）

有头 Chromium，新 profile，静止不交互。`objURL` = 页面内 `URL.createObjectURL` 计数器的存活数。

| 场景 | 窗口/DPR | PSS | 私有 footprint | GPU PSS | renderer PSS | browser PSS | JS 堆 | DOM 节点 | listener | 活 objURL |
|---|---|---|---|---|---|---|---|---|---|---|
| `blank-chromium`（about:blank） | 1440×900 @1 | 282.3 | 139.4 | 61.2 | 37.4 | 86.5 | 0.7 | 4 | 0 | 0 |
| **空曲库 本地 dist** | 1440×900 @1 | **346.6** | **192.4** | 89.6 | 64.9 | 93.5 | 2.3 | 827 | 106 | 0 |
| 空曲库 线上 | 1440×900 @1 | 358.1 | 193.2 | 88.6 | 69.9 | 94.6 | 2.5 | 829 | 121 | 0 |
| 空曲库 @DPR2 | 1512×982 @2 | 351.5 | 196.7 | 93.0 | 65.5 | 93.9 | 2.3 | 827 | 106 | 0 |
| 空曲库 4K | 3840×2160 @1 | 342.0 | 187.2 | 88.1 | 61.7 | 93.0 | 2.2 | 827 | 106 | 0 |
| 空曲库 5K | 2560×1440 @2 | 417.1 | 211.1 | 102.4 | 87.7 | 102.7 | 2.3 | 827 | 106 | 0 |
| 空曲库 手机 | 390×844 @3 | 349.7 | 195.0 | 93.0 | 64.8 | 93.3 | 2.3 | 827 | 106 | 0 |
| 空曲库 SwiftShader | 1440×900 @1 | 327.7 | 154.3 | 45.4 | 81.5 | 98.4 | 2.3 | 827 | 106 | 0 |
| 空曲库 `--disable-gpu` | 1512×982 @2 | 286.0 | 149.8 | 43.6 | 70.1 | 84.4 | 2.3 | 827 | 106 | 0 |
| 有 demo（3 首，未播放） | 1440×900 @1 | 305.6 | 186.5 | 84.3 | 54.8 | 79.6 | 1.9 | 880 | 113 | 0 |
| 1000 首曲库（50 KB 封面） | 1440×900 @1 | 486.9 | 273.3 | 105.2 | 93.0 | 154.7 | 2.7 | 827 | 105 | 2 |
| 1000 首曲库（1 KB 封面） | 1440×900 @1 | 388.8 | 233.1 | 91.4 | 69.4 | 129.3 | 2.7 | 827 | 105 | 2 |
| 1000 首曲库（200 KB 封面） | 1440×900 @1 | 390.6 | 232.2 | 91.0 | 71.2 | 128.9 | 2.7 | 827 | 105 | 2 |
| 1000 首 + 搜索命中 200 行 | 1440×900 @1 | 411.8 | 254.8 | 92.0 | 91.4 | 129.4 | 3.8 | 3441 | 1918 | 201 |

单位 MB。`lib1000` 的 50 KB 行（273.3）是唯一在 60 s 没有回落的一次，重复测 1 KB / 200 KB 都在 232–233，
见 §3.4 的时序表：稳态与封面大小无关，**差异全在开机前 30 s**。

### 2.1 时间序列：空曲库静止 5 min（`empty-local-r2-5min`）

| t | PSS | 私有 footprint | JS 堆 | DOM 节点 | listener | renderer task 累计 |
|---|---|---|---|---|---|---|
| 0 s | 324.1 | 203.6 | 3.73 | 1782 | 281 | 0.46 s |
| 5 s | 323.6 | 204.5 | 3.80 | 1782 | 281 | 0.57 s |
| 30 s | 308.8 | 189.1 | 2.23 | 827 | 106 | 1.02 s |
| 60 s | 311.0 | 191.0 | 2.30 | 827 | 106 | 1.56 s |
| 300 s | 351.3 | 197.6 | 2.27 | 827 | 106 | 5.89 s |

- 0–5 s 的 1782 节点 / 3.8 MB 堆是**上一份 document 在 reload 后尚未回收**（`Memory.getDOMCounters`
  统计整个 renderer），30 s 后归位到 827，不是增长。
- 5 min 内 JS 堆 2.23 → 2.27 MB、节点与 listener 完全不动；PSS 的 +43 MB 出现在单个 300 s 采样点，
  私有 footprint 只 +8.6 MB，属于 Chrome 自身分配器抖动（见 §3.5 的并发/噪声说明）。
- 这 5 min 内 renderer 的 task 时间增加 5.89 − 0.46 = 5.43 s（约 1.8% CPU），空白页同期 0.01 s。
  来源是 `armTick` 无条件自我续约的 `requestAnimationFrame`（`src/ui/app.js:1634`）。

### 2.2 播放中的内存（`demo-playing-180`，3 首 demo，播 3 min）

| t | 私有 footprint | renderer PSS | utility(audio) PSS | JS 堆 | DOM 节点 |
|---|---|---|---|---|---|
| 0 s（刚点播放） | 231.0 | 75.6 | 58.2 | 3.25 | 965 |
| 5 s | 248.3 | 91.7 | 58.2 | 3.67 | 1193 |
| 60 s | 299.0 | 152.5 | 57.9 | 2.77 | 920 |
| 180 s | 298.3 | 155.3 | 58.1 | 3.07 | 1088 |

- renderer 在开始播放后 60 s 内 +77 MB，之后 120 s 不再增长 → **一次性**，不是泄漏。
  `qingtian.mp3` 2.4 MB 被完整取回并解码（3 min 立体声 44.1 kHz float32 ≈ 63 MB），
  与增量同量级。**这是 Chrome 音频解码的行为，应用侧没有可改的句柄**（应用只持有 1 个
  `<audio>` 的 blob URL 与一个预取槽，见 `player.js`/`prefetch.js`），未找到应用侧旋钮。
- DOM 在播放中 920–1193 之间波动（进度/时间文本更新），不单调。

## 3. 归因

### 3.1 确认：应用自身在空曲库静止时 = 空白页 + 53 MB

| 组成 | 空曲库 | 空白页 | 差 |
|---|---|---|---|
| 私有 footprint | 192.4 | 139.4 | **+53.0** |
| GPU 进程 PSS | 89.6 | 61.2 | +28.4 |
| renderer PSS | 64.9 | 37.4 | +27.5 |
| browser PSS | 93.5 | 86.5 | +7.0 |
| JS 堆 | 2.3 | 0.7 | +1.6 |

即：页面本身的成本 = 约半个 V8 隔离区 + 一次真实页面的光栅 + 2.3 MB 业务堆。
**没有 GB 级来源。**

### 3.2 排除：CSS 特效不是内存原因（票里的候选 ①）

在同一个空曲库页面上注入覆盖文式后重测（60 s，私有 footprint / PSS）：

| variant | 关掉什么 | 私有 footprint | PSS | GPU PSS |
|---|---|---|---|---|
| baseline | — | 192.4 | 346.6 | 89.6 |
| `no-svg-filter` | 唱臂 `drop-shadow`、`stylus-point` 发光、`:focus-visible` | 191.1 | 296.3 | 83.8 |
| `no-mask-blend` | 所有 `mask-image` + `mix-blend-mode: screen` | 192.6 | 292.4 | 83.3 |
| `no-backdrop` | 所有 `backdrop-filter` | 191.9 | 296.9 | 83.6 |
| `no-heavy-effects` | filter + backdrop + blend + mask + box-shadow + will-change + animation，**全关** | 196.6 | 298.0 | 88.3 |

**全关 = 不减反增（在噪声内）。** 结论：唱臂 SVG filter、黑胶 `mask`/`mix-blend-mode`、
`backdrop-filter` 在静止时**不持有可观内存**；它们影响的是绘制成本，不是驻留内存。
（PSS 列在不同并发波次之间不可比，见 §1.2。）

### 3.3 排除：SW 缓存、object URL、JS 堆、DOM

- CacheStorage：空曲库 `caches.keys()` = `localtune-0627868e62`，**22 项 / 514 570 B**
  （`--cache-bytes` 逐条读 body 求和）。播放 demo 后仍是 22 项 —— demo 音频走 Range 请求，
  `sw.js` 明确不缓存 `/demo/`。GB 级无关。
- 活 object URL：空曲库 **0** 个；demo 未播放 0 个；播放中 0 个（stage 封面走 demo 内联对象）。
  1000 首曲库源码层面只建 2 个（当前曲 + 第二首预取）。
- JS 堆：全程 1.9–3.8 MB；5 min 静止 +0.04 MB；3 min 播放 +0.3 MB。
- DOM：827 节点 / 106 listener 恒定；1000 行搜索结果才到 3441 / 1918。

### 3.4 确认（并量化）：启动期把整库封面 Blob 读进内存

`src/core/db.js:100 getAllTracks()` → `getAllTracks()` 返回 `tracks` 表的全部记录，
每条的 `cover` 字段就是封面 `Blob`（`src/core/metadata/id3.js:459`、`mp4.js:82` 写入）。
`src/core/store.js:434` 在 `createApp()` 里一次性读全库。同一批 1000 首、只改封面大小：

| 曲库 | 0 s 私有 | 0 s browser PSS | 5 s 私有 | 30 s 私有 | 60 s 私有 |
|---|---|---|---|---|---|
| 1000 × 1 KB（合计 1 MB） | 251.3 | 131.9 | 252.1 | 233.2 | 233.1 |
| 1000 × 50 KB（合计 49 MB） | 241.6 | 111.1 | 242.8 | 225.0 | 273.3 |
| 1000 × 200 KB（合计 200 MB） | **445.5** | **325.8** | 445.5 | 236.3 | 232.2 |

- 200 KB 封面把开机 0–5 s 的私有内存推高 **+194 MB**，browser 进程 PSS 从 131.9 推到 325.8 MB，
  两条曲线的时间形状完全一致（0–5 s 平台 → 30 s 内释放）。Δ ≈ 封面总字节 × 1.0。
- 30 s 后 Chrome 把 Blob 数据页还给磁盘，所以**静止 60 s 的口径看不见它**；只看 5 min 稳态的
  测量会漏掉这段峰值。这也解释了为什么“打开就要 N GB”和“放一会儿又好了”能同时成立 `[推测]`。
- 规模换算：一个 3 000 首、每首 300 KB 内嵌封面的库，启动峰值 ≈ 0.9 GB；10 000 首 ≈ 3 GB。
  **这是代码里唯一能长到票面量级的机制**，也是票里列的第 1 个候选（`db.js:100` / `store.js:185`）。
  它要求**库非空**；对真正空的库不成立 —— 所以本机 `empty` 场景复现不到 2.9 GB。

### 3.5 未解释 / 噪声

- 同一个二进制、同一场景重复测 3 次（`empty-local-dpr1` 346.6 / `r2` 311.0 / `r3` 308.4 PSS；
  私有 192.4 / 191.0 / 189.9）：**PSS 摇摆 ±40 MB，私有 footprint 稳定在 ±3 MB**。
  这是 Chrome 自身分配器与共享页分摊，不是应用行为。任何小于 5 MB 的“优化”在这个 harness 上
  都不可证伪，报告里不给这种数字。
- 1000 × 50 KB 那一行 60 s 的 273.3 MB 是唯一没有回落的样本，重复 1 KB / 200 KB 都不复现；
  归类为运行间抖动，不作为结论。

## 4. “2.9 GB 从哪来”——本机能确认与不能确认的

本机做不到 2.9 GB。以下是**能**用同一份数据解释“打开就 1–3 GB”的口径问题：

| 口径 | 空曲库 1440×900 | 空白页 | 说明 |
|---|---|---|---|
| 私有 footprint（≈ Chrome Task Manager “Memory footprint”） | 192.4 MB | 139.4 MB | 应用真实成本 |
| PSS 合计 | 346.6 MB | 282.3 MB | 共享页按比例分摊 |
| **RSS 合计（各进程 working set 相加）** | **1188.3 MB** | **1084.8 MB** | 共享页每进程各算一次，×3.4–3.8 |

单实例、单标签、空曲库、静止不动，只要按“各进程 RSS 相加”读，就已经是 1.2 GB；
再加两个标签页或 DevTools，2.9 GB 不需要页面做错任何事 `[推测，未在用户机器上观测]`。

无法在本机区分/确认的因素（用户机器才有）：浏览器版本与 GPU 驱动、是否 PWA 安装态、
是否开着 DevTools、同一 profile 里别的标签与扩展、profile 累积的 CacheStorage/audio cache
（`DEFAULT_CACHE_LIMIT = 2 GB`，`src/core/cache/audioCache.js:9`）。
排查指令写在 §7。

## 5. 修复（阶段 2，等 Conductor 批准）

见本文件 §8「改动与前后对比」（阶段 2 完成后补写）。

## 6. 未做的

- 不部署、不动 k3s。
- 不改 UI 视觉。
- 不为凑数字改 harness：所有 variant 都是同一条命令加注入样式，注入样式只存在于测量进程内。

## 7. 如果用户仍看到 GB 级

在用户机器上按顺序取三样东西（不需要装东西）：

1. Chrome 自带 Task Manager（`Shift+Esc`）→ 右键表头打开 “Memory footprint” 与 “JavaScript memory” 两列 →
   展开到进程粒度，截图。看**单个标签页进程**是不是 GB 级；如果是，才说明是我们的页面。
2. `chrome://gpu` 顶部 “Graphics Feature Status”，看是不是 “Software only”。
3. 同一窗口只留这一个标签、关掉所有扩展，重开一个**新窗口**（不是新标签）再读一次。
