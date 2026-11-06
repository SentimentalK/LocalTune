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
5. **封面 Blob 当初被误判成 GB 级机制，已被干净的对照实验证伪**（§3.4）：1000 首 × 200 KB
   内嵌封面在旧构建上 60 s anon 只比无封面的 1000 首多 **24 MB**（186.0 vs 225.0 的 50 KB 组没有可比性，
   见 §3.4 的干净对照）。Chrome 的 IDB Blob 只是句柄，字节留在磁盘，**开机不会把封面字节读进内存**。
   早先那个 439.9 MB 是 harness 自己在被测量的页面里写入 200 MB 封面留下的，不是应用行为 ——
   测量陷阱写在 §3.5。
6. **修复后**（§6）：空曲库 anon 185.0 → 184.1（无变化，符合预期）；1000 首 × 200 KB 曲库
   186.0 → 161.0（−25 MB，−13%）；**空闲 renderer task 时间 1.04 s/60 s → 0.02 s/60 s**（−98%）。
7. **“打开就 1–3 GB”更可能是口径**：同一时刻把各进程 RSS 相加是 **1188 MB**（空白页都有 1085 MB），
   anon 的 6.4 倍。任何“把 working set 相加”的工具看一个空页面就已经是 GB 量级 `[推测，未在用户机器上观测]`。
8. **空闲 CPU 有真实浪费**：不播放也常驻 `requestAnimationFrame`，60 s 烧 1.04 s task 时间
   （空白页 0.01 s）≈ 1.7% CPU 常驻。已修（见 §6）。

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

### 3.4 封面：当初以为是主因，被干净对照证伪

`src/core/db.js:100 getAllTracks()` 返回 `tracks` 表的全部记录，v5 里每条的 `cover` 就是封面 `Blob`；
`src/core/store.js:434` 在 `createApp()` 里一次读全库。第一版测量写成「开机峰值 ≈ 基线 + 全库封面字节」，
那个数字（1000 × 200 KB → anon 439.9 MB）**是错的**：它把 harness 自己写 200 MB 封面的那份内存
算进了 t0。把「写入」和「读取」拆成两个进程跑之后：

| 1000 首 × 200 KB 封面（合计 200 MB） | t0 anon | t5 anon | t30 anon | t60 anon | t60 browser PSS | t60 footprint |
|---|---|---|---|---|---|---|
| 旧构建（v5，封面内嵌在 track 行里） | 199.7 | 200.0 | 186.9 | **186.0** | 151.3 | 239.0 |
| 新构建（v6，封面在 covers 存储） | 177.8 | 177.9 | 163.9 | **161.0** | 127.4 | 213.4 |
| 空曲库（旧构建，串行） | 201.9 | 203.1 | 188.3 | 188.8 | — | — |

结论：
- **没有开机峰值**。旧构建在 t0 只比稳态高 13.7 MB；Chrome 的 IDB Blob 是句柄，字节留在磁盘，
  只有真正 `URL.createObjectURL` + 绘制时才解码。
- 内嵌封面的真实代价是 **blob 注册表 + 行对象**：1000 首 200 KB 封面 ≈ **+25 MB anon / +24 MB browser PSS**
  （186.0 → 161.0），与封面字节数无关，与**条数**有关（1 KB 与 200 KB 封面的稳态几乎一样，见 §2）。
- 因此「封面总量 → GB 级」这条假设**不成立**。要把内存推到 GB，只有**同时渲染**海量封面被解码
  才可能（实测 200 行 ≈ +60 MB anon，见 §2 的 `lib1000-search`），而搜索最多渲染 200 行。
  10000 行同时渲染 ≈ 3 GB 只是外推，未实测，也没有用户数据支持。

### 3.5 测量陷阱：三个会骗人的数字

1. **在被测量的页面里播种数据。** 用 `page.evaluate` 往 IndexedDB 写 200 MB Blob，写入本身会把
   这些字节挂到 browser / renderer 进程上，`page.reload()` 之后 30 s 内才释放。
   先写入、再单独测量（`--profile <name> --skip-seed --keep`）才看得到应用真正读了多少。
   第一版报告就是栽在这里，把 439.9 MB 当成了应用的开机峰值。
2. **`Private_Clean` 会被回收。** 同一场景并行 4 个 Chromium：blank 的 footprint 139.4，单独跑 187.1；
   `Private_Dirty` 只从 134.8 变到 135.8。所以主判据必须是 `Private_Dirty + Swap`。
3. **PSS 会给共享页打折。** 并行实例越多，同一份 Chrome 共享页被分摊得越薄；browser 进程能差 20 MB。

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

## 5. 修复（阶段 2，已落地）

方案由 Conductor 2026-11-06 批准：**封面外置 + DB v5→v6 迁移 + UI 按需读封面**，并停掉空闲 `armTick`。

### 5.1 改动

| 文件 | 改动 |
|---|---|
| `src/core/db.js` | `DB_VERSION = 6`；新增 `covers` 存储（keyPath `id`）；`onupgradeneeded` 内用同一事务的游标把 v5 的内嵌 `cover` 搬进 `covers`（逐行 try/catch，坏行只 warn）；`putTracks` 在 `[tracks, covers]` 单事务里剥离/写入封面；`deleteTracksById` 同事务删两表；新增 `getCover` / `withoutCover` |
| `src/core/coverCache.js`（新） | 引用计数 + LRU（上限 64）的 object URL 缓存；同 id 并发只读一次；`release/retain/clear`；被 UI 持有时永不 revoke |
| `src/core/store.js` | 构造函数建 `covers`；`coverUrl(track)` / `releaseCover(id)`；`buildTrack` 只在真有 Blob 时带 `cover`；`carryCover` 在元数据没读到图时**删掉** `cover` 键（否则 `putTracks` 会把已存封面当成"显式删除"）；状态树只存无 Blob 的行 |
| `src/core/storage.js` | `coverBytes` 改为累加 `track.coverSize` |
| `src/core/mediaSession.js` | artwork 用 store 给的缓存 URL，不再自建第二个 Blob URL |
| `src/ui/app.js` | `coverNode` 改用 `loading="lazy"` + `decoding="async"` + `store.coverUrl`；列表重建时释放上一轮 id；正在播放的封面单槽持有；`armTick` 只在 `playing` 时续约，暂停时画一帧后停 |
| `src/ui/dom.js` | 删除整页生命周期的 `coverUrls` / `coverUrl` / `syncCoverCache` |
| 测试 | `tests/covers.test.js`（缓存语义）、`tests/storage.test.js`、`tests/migrate.test.js`、`e2e/covers.spec.js`（v5→v6 逐首字节一致 + 列表按需读）、`e2e/idle-raf.spec.js`（空闲 5 s rAF 计数为 0，播放后 >0，暂停后不再增长） |
| 文档 | `docs/architecture.md` 的 v6 schema、`estimateLibrary`、merge 规则 |

迁移保封面的证据：`e2e/covers.spec.js` 用 `addInitScript` 造 v5 库（2 首内嵌 Blob：1024 B png / 2048 B jpeg），
打开应用后断言 `tracks` 行无 `cover` 字段且 `hasCover:true`、`covers` 两条且 `size`/`type` 与原字节一致，
并且 `#cover` 与列表 `img[src^="blob:"]` 出现。
回归证据：把 `carryCover` 的修复临时回退后，`e2e/covers.spec.js` 的「rescan 重读保留封面」用例实跑变红
（`hasCover` 变 false、封面被删），恢复后变绿。

### 5.2 迁移安全

- 搬迁在 `onupgradeneeded` 的同一事务里完成：要么整库到 v6，要么留在 v5，不会半套。
- 单行异常只 `console.warn` 并跳过，不 abort 事务。
- 打不开库仍是既有行为（`main.js` 的 `renderFatal` 错误页），不会白屏。
- Clear all data 走 `reset.js` 的 `indexedDB.deleteDatabase`，整库删除，`covers` 一并清掉。

## 6. 阶段 2 实测（同一 harness，串行单实例）

| 指标 | 修复前 `4410a78` | 修复后 | 变化 |
|---|---|---|---|
| 空曲库静止 60 s · anon | 188.8 | 184.1 | −4.7 MB（在 ±5 MB 噪声内） |
| 空曲库静止 60 s · PSS | 457.4 | 454.7 | −2.7 MB |
| 空曲库静止 60 s · 私有 footprint | 242.9 | 240.5 | −2.4 MB |
| 空曲库静止 60 s · renderer task | 1.04 s | **0.02 s** | **−98%** |
| 1000 首 × 200 KB · t0 anon | 199.7 | 177.8 | −21.9 MB |
| 1000 首 × 200 KB · 60 s anon | 186.0 | **161.0** | **−25.0 MB（−13%）** |
| 1000 首 × 200 KB · 60 s browser PSS | 151.3 | 127.4 | −23.9 MB |
| 1000 首 × 200 KB · 60 s footprint | 239.0 | 213.4 | −25.6 MB |
| JS 堆（两个场景） | 2.22 / 2.30 MB | 2.16 / 2.26 MB | 不变 |
| DOM 节点 / listener | 827 / 106 | 827 / 106 | 不变 |

结论：

- **空曲库场景降不动，而且本来就没有可降的东西**：应用自身只占 +50 MB，其中一半是 V8 隔离区与
  一次真实页面的光栅。票里"降 50%"的分母是 Chrome 自己（134.8 MB anon），**数学上不可达**。
- **曲库场景 −25 MB（−13%）**：省掉的是 1000 条内嵌 Blob 的注册表与行拷贝，不是封面字节
  （字节本来就在磁盘上）。条数越多省得越多，与封面大小无关。
- **空闲 CPU −98%**：1.04 s → 0.02 s per 60 s。这是这次改动最确定的收益（电池 / 后台标签）。
- 曲库规模下"同时渲染的封面"仍是唯一可能到 GB 的路径，现在走进 `loading="lazy"` +
  引用计数回收；200 行实测 +60 MB anon，未在 1000+ 行规模上复测（没有真实大目录数据）。

### 6.1 验收结论

| 票面验收项 | 结果 |
|---|---|
| 复现 2.9 GB | **不能**（19 个配置，最大 anon 190.5 / PSS 417.1） |
| 至少一个被量化证据确认的主因 | 报告给出的是"没有主因"：应用自身 +50 MB anon，无泄漏；三个 GB 级候选（CSS 特效 / SW 缓存 / 封面 Blob 常驻）全部被量化排除 |
| 修复后 60 s 数字与基线对比 | 见 §6 表 |
| 目标下降 ≥50% | **不达标，且不可达**（下限是浏览器自身 134.8 MB anon） |
| JS 堆与 DOM 在 60 s 内稳定 | 满足（5 min / 9 min 也稳定） |
| `npm run build` / `npm test` / `npx playwright test` / `npm run size` | 全绿（299 unit、79 e2e、58044 B gzip / 102400） |

## 7. 用户侧如何复核

在用户机器上按顺序取三样东西（不需要装东西）：

1. Chrome 自带 Task Manager（`Shift+Esc`）→ 右键表头打开 **“Memory footprint”** 与
   **“JavaScript memory”** 两列 → 展开到进程粒度。看**单个标签页进程**；
   JavaScript memory 才是我们的堆（本机空曲库 2.3 MB）。如果是 GB 级，才是页面问题。
2. `chrome://gpu` 顶部 “Graphics Feature Status”，看是否 “Software only”。
3. 同一窗口只留这一个标签、关掉扩展，开一个**新窗口**再读一次；
   另外在打开瞬间（前 5 s）和 1 分钟后各读一次 —— 封面搬迁前后的差别就在前 30 s。
