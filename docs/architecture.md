# LocalTune v1 架构与模块契约

本文件是 v1（W1 应用）的实现契约。Worker 之间的并行由这里的签名和状态结构约束，任何偏差都要先在 Ticket 里改本文件。

## 约束

- 纯静态产物：`dist/` 只有静态文件；运行时不访问第三方域（系统字体栈，无 CDN、无分析、无 API）。
- 无框架运行时；首屏 JS gzip 总计 ≤ 100 KB（`npm run size` 强制，见「构建与 SW」）。
- 构建：esbuild 只做打包/压缩/内容哈希，Node 版本取 `node -v`（本机 v24.20.0，`engines: ">=22"`）。
- 运行时依赖 0；devDependencies 仅 `esbuild`、`@playwright/test`。
- 只在 Android Chrome + 桌面 Chrome 验证；iOS 兼容性靠 adapter 预留，不承诺。

## 目录与可写范围

```
src/
  index.html              # 模板，含 __CSS__ / __JS__ 占位符（UI Worker）
  main.js                 # 入口：createApp() + mountUi()（UI Worker）
  styles.css              # A · Soft Vinyl（UI Worker）
  ui/*.js                 # 视图与 DOM（UI Worker）
  core/*.js               # 见下（Core Worker）
  sw.template.js          # 含 __VERSION__ / __PRECACHE__ 占位符（Build Worker）
  manifest.webmanifest    # 静态（Build Worker）
  icons/*.png             # 192/512/512-maskable（Build Worker）
tests/                    # node --test 单元测试与 fixtures（Core Worker）
e2e/                      # Playwright spec（Build Worker）
scripts/build.mjs|size.mjs|serve.mjs   # Build Worker
Dockerfile, nginx.conf, .github/workflows/image.yaml   # Build Worker
```

`dist/` 不进 git。

## 数据模型

```js
/** @typedef {Object} Track
 * @property {string} id            // `${source}:${path}`
 * @property {string} path          // 相对授权目录的 POSIX 路径
 * @property {string} title
 * @property {string} artist        // 空串表示未知；展示层用 common.unknownArtist
 * @property {string} album         // 空串表示未知；展示层用 common.unknownAlbum
 * @property {number|null} year
 * @property {number|null} trackNo
 * @property {number} duration      // 秒，未知为 0
 * @property {number} mtime         // File.lastModified
 * @property {number} size          // bytes
 * @property {Blob|null} cover
 * @property {'fsa'} source
 * @property {Object<string,string>} externalIds  // v1 为空对象
 */
```

IndexedDB（`localtune`，version 1）：

- `tracks`：keyPath `id`；index `album`（`album`）、`artist`（`artist`）。
- `meta`：keyPath `key`；键 `dirHandle`、`lastScan`（`{at:number, added:number, updated:number, removed:number}`）、`lastBuildVersion`（最近一次乱码标签迁移针对的 `BUILD_VERSION` 字符串）、`playback`、`settings`。

## 模块契约

### `src/core/source.js` — 文件来源 adapter

v1 有两个实现：File System Access（桌面 Chromium / Android Chrome 132+）与 `<input webkitdirectory>` 回退（无 `showDirectoryPicker` 的浏览器）。调用方只依赖接口，不依赖具体实现。

```js
/** @typedef {Object} SourceEntry
 * @property {string} path   // 相对根的 POSIX 路径
 * @property {File} file
 * @property {number} mtime
 * @property {number} size
 */

export const AUDIO_EXTENSIONS = new Set(['mp3','m4a','flac','ogg','oga','wav','webm']);

export function hasDirectoryPicker()  // typeof globalThis.showDirectoryPicker === 'function'
export function createSource(db)      // hasDirectoryPicker() ? new FsaSource(db) : new FileListSource(db)

export class FsaSource {
  kind = 'fsa';
  name = '';                       // 根目录名，未连接为空串
  async connect()                  // showDirectoryPicker({mode:'read'})，句柄写进 meta.dirHandle；
                                   // 同一手势内补一次 requestPermission()（best-effort，SecurityError 忽略）
  async restore()                  // 读句柄并 queryPermission；不再弹窗、不调用 requestPermission
  permission()                     // 'granted' | 'prompt' | 'denied' | 'none'
  async ensurePermission()         // 'prompt' 时 requestPermission，返回 boolean；不打开选择器
  async *scan()                    // 递归产出 SourceEntry；跳过隐藏目录；按扩展名过滤
  async getFile(path)              // 由缓存句柄按路径段取 File；找不到抛错
}

export class FileListSource {
  kind = 'files';
  name = '';                       // 所选根目录名（webkitRelativePath 的第一段）
  async connect()                  // 隐藏 <input type="file" webkitdirectory multiple>，File 按 path 存 meta.fileList
  async restore()                  // 从 meta.fileList 读回 File；无选择器、无权限弹窗
  permission()                     // 有文件时 'granted'，否则 'none'
  async ensurePermission()         // 有文件即 true
  async *scan()                    // 产出 { path, file, mtime, size }
  async getFile(path)              // 从内存 Map 取 File；找不到抛错
}
```

iOS / 未来来源只需实现同一组方法（`connect/restore/permission/ensurePermission/scan/getFile`），`store` 不改。`state.source.kind` 为 `'fsa' | 'files'`。

### `src/core/metadata/{index,id3,mp4}.js`

```js
export async function readMetadata(file) // 读文件头（ID3 全标签 + 末尾 128 字节，MP4 至 moov），返回 PartialMeta
/** @typedef {{title?:string,artist?:string,album?:string,year?:number|null,trackNo?:number|null,duration?:number,cover?:Blob|null}} PartialMeta */
export function parseId3(bytes, { fileSize, tail } = {}) // Uint8Array → PartialMeta（ID3v2.3/2.4：TIT2 TPE1 TALB TYER/TDRC TRCK APIC；时长由首个 MPEG 帧 + Xing/Info 或比特率估算；ID3v2 缺字段时用末尾 128 字节 ID3v1 补）
export function describeId3(bytes, { fileSize, tail } = {}) // Uint8Array → { version:3|4|0, frames:[{id,encoding,rawHex32,decoded,candidates}], id3v1:{title,artist,album}|null }；只收录 T* 文本帧与 APIC，compressed 帧跳过；encoding 0 列出 utf-8/shift_jis/gb18030/big5/euc-kr/latin1 全部候选及 legacyScore，其余编码单一候选（utf-16le/utf-16be/utf-8，score 1）
export function parseId3v1(bytes) // 末尾 128 字节（或整文件）→ {title?,artist?,album?,year?}；文本同样走 decodeLegacyText
export function decodeLegacyText(bytes) // encoding byte 0 的文本：ASCII 直出；否则 utf-8 → shift_jis → gb18030 → big5 → euc-kr 依次试解，按 CJK/假名/谚文占比打分取最高；都不像才回退 latin1
export function parseMp4(bytes)   // Uint8Array → PartialMeta（mvhd 时长；ilst：©nam ©ART ©alb ©day trkn covr）
export async function describeTags(file) // → { id3v2:{version,frames}|null, id3v1:{title,artist,album}|null, chosen:{title,artist,album} }；读法与 readMetadata 相同，chosen 取 readMetadata 的最终结果（缺失为空串）；m4a 与未知扩展名 id3v2/id3v1 均为 null
```

`readMetadata` 只读取必要字节（ID3 按 tag size 截取并额外读末尾 128 字节；MP4 只读到 `moov` 结束），不整文件读入。解析异常一律吞掉并返回 `{}`，由调用方回退文件名。

### `src/core/version.js` — 构建版本

```js
export const BUILD_VERSION = typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : 'dev';
```

`__BUILD_VERSION__` 由 `scripts/build.mjs` 的 esbuild `define` 注入（字符串）。测试、`node -e` 或未注入的构建里 `typeof` 让它安全回退 `'dev'`。

### `src/core/metadata/garbled.js` — 乱码判定

```js
export function isGarbledText(value) // 非字符串/空串 → false；以下任一命中 → true：
                                     // 含 U+FFFD；非 ASCII 字符全部落在 U+0080–U+00FF；
                                     // 半角片假名 U+FF61–U+FF9F 数量 / 非 ASCII 字符总数 ≥ 0.5
export function isGarbledTrack(track) // title / artist / album 任一 isGarbledText
```

### `src/core/metadata/diagnostics.js` — 用户可复制的标签报告

```js
export function formatTagReport(described) // describeTags 的结果 → 多行纯文本
```

报告至少含：`ID3v2` 版本（无标签时 `ID3v2: none`）；每个帧的 id、`enc=<n>`、raw hex、decoded、按 score 降序的候选（`label score(2位小数) text`）；ID3v1 的 title/artist/album；chosen 的 title/artist/album。

### `src/core/migrate.js` — 乱码标签迁移

```js
export async function migrateGarbledTracks({ tracks, getFile, readMetadata, onProgress = () => {} })
// → { changed: Track[], checked: number, failed: number }
```

- 只对 `isGarbledTrack(track)` 的曲目调用 `getFile(track.path)` + `readMetadata(file)`；`checked` 为可疑曲目数。
- 单曲 `getFile`/`readMetadata` 抛错计入 `failed`，该曲目原样返回，不中断整体。
- 合并规则：`title`/`artist`/`album` 新值非空才覆盖；`year`/`trackNo` 新值为有限数才覆盖；`duration` 新值 > 0 才覆盖；`cover` 新值非空才覆盖；`id`/`path`/`mtime`/`size`/`source`/`externalIds` 原样保留。
- 每首完成调用 `onProgress({ done, total, changed, failed })`，`total` = 可疑曲目数；`changed` 只含字段实际变化的曲目。

### `src/core/scan.js`

```js
export function diffScan(previous, entries)
// previous: Array<Pick<Track,'id'|'path'|'mtime'|'size'>>
// entries:  Array<Pick<SourceEntry,'path'|'mtime'|'size'>>
// → { added: SourceEntryLike[], updated: SourceEntryLike[], removedIds: string[], unchanged: number }
// 规则：path 相同且 mtime+size 相同 = unchanged；path 相同但 mtime 或 size 变 = updated；
//       新 path = added；previous 有而 entries 没有 = removedIds。
```

### `src/core/queue.js` — 纯状态机（无 DOM、无存储）

```js
/** @typedef {Object} QueueState
 * @property {Track[]} tracks
 * @property {number} index        // 当前曲目在 tracks 的下标；-1 = 空
 * @property {boolean} shuffle
 * @property {'off'|'all'|'one'} repeat
 * @property {number[]} order      // tracks 下标的播放顺序
 * @property {number} cursor       // 在 order 中的位置
 */
export function createQueue(tracks = [])
export function setQueue(state, tracks, startIndex = 0)   // 返回新 state（不原地改）
export function currentTrack(state)
export function advance(state, { auto = false } = {})     // → { state, ended: boolean }
export function back(state)                               // → { state }
export function toggleShuffle(state)                      // 开启时 order 洗牌但当前曲目排第一
export function cycleRepeat(state)                        // off → all → one → off
export function removeAt(state, index)                    // 移除后保持当前曲目；空队列 index=-1
```

语义（测试以此为准）：

- `auto: true`（自然播完）：`repeat === 'one'` → 同曲重播（`ended:false`，state 不变）；否则走下一首；到末尾时 `repeat === 'all'` 回绕，`'off'` 返回 `ended:true` 且 state 不变。
- `auto: false`（用户点 next）：`repeat === 'one'` 也前进；越过末尾时 `'all'` 回绕、`'off'` 停在最后一首并返回 `ended:true`。
- `back`：在 `order` 中后退一位，到头部时 `'all'` 回绕，`'off'` 停在第一首。
- `shuffle` 关闭时 `order` 恢复 `[0..n-1]`；`toggleShuffle` 不改变当前曲目。

### `src/core/player.js`

```js
export class AudioPlayer extends EventTarget {
  constructor(audio: HTMLAudioElement)
  async load(file)     // 释放旧 objectURL，set src，等待 canplay
  async play(); pause()
  seek(seconds); setVolume(v /*0..1*/)
  get position(); get duration(); get playing()
  destroy()            // revoke URL、移除监听
}
// events: 'timeupdate' {position,duration} | 'ended' | 'play' | 'pause'
//         | 'loaded' {duration} | 'error' {error}
```

`load` 内部负责 `URL.createObjectURL(file)` 与 `revokeObjectURL`，其他模块不接触 object URL。

### `src/core/db.js`

```js
export const DB_NAME = 'localtune', DB_VERSION = 1;
export function openDb()                         // Promise<IDBDatabase>
export function putTracks(db, tracks)            // 单事务覆盖写
export function deleteTracksById(db, ids)
export function getAllTracks(db)                 // Promise<Track[]>
export function getMeta(db, key)                 // Promise<any>
export function setMeta(db, key, value)
```

### `src/core/persist.js`

```js
export async function loadPlayback(db)   // meta.playback → {trackId,position,queueIds,queueIndex,repeat,shuffle,volume}|null
export function savePlayback(db, snapshot) // 1s 防抖；调用 stop() 可 flush（模块内导出 savePlayback.flush）
export async function loadSettings(db)   // {vinylSpin:boolean, language:'auto'|'zh-CN'|'zh-TW'|'ja'|'en'}
export async function saveSettings(db, settings) // 非法/缺失的 language 落盘为 'auto'
```

`meta.settings.language` 缺省 `'auto'`：`'auto'` 表示跟随 `navigator.languages`，其余为显式语言。老的 `{vinylSpin}` 记录读上来时自动补 `language: 'auto'`。

### `src/core/mediaSession.js`

```js
export function installMediaSession(store)   // 绑定 play/pause/previoustrack/nexttrack/seekto/seekforward/seekbackward
export function syncMediaSession(state)      // metadata + playbackState + positionState（duration>0 才设）
```

### `src/i18n/*` — 文案与语言

```js
export const LOCALES = ['zh-CN', 'zh-TW', 'ja', 'en'];
export function resolveLocale(languages = [])      // 依次看每一项：'zh-TW'|'zh-HK'|'zh-Hant*' → 'zh-TW'；
                                                   // 'zh*' → 'zh-CN'；'ja*' → 'ja'；其余看下一项；都不匹配 → 'en'
export function resolveLanguage(setting, languages) // setting ∈ LOCALES 时原样返回；
                                                    // 'auto' 或非法值按 resolveLocale(languages)
export function getLocale(); export function setLocale(locale)  // 非法 locale 忽略
export function t(key, params = {})                // 当前表 → 缺 key 回退 en → 仍缺返回 key 并 console.warn（同 key 只警告一次）
                                                   // 插值：{name} 替换为 params.name
export function applyDocumentLang()                // 有 document 时写 documentElement.lang
```

四张表 `src/i18n/{en,zh-CN,zh-TW,ja}.js` 都是默认导出的扁平对象，key 为点分命名（`common.*`、`tabs.*`、`player.*`、`empty.*`、`settings.*`、`aria.*`、`error.*`、`fatal.*`），四张表 key 集合必须完全一致（`tests/i18n.test.js` 断言），en 是唯一兜底表。

- 模块加载时默认 locale = `resolveLocale(navigator.languages ?? [navigator.language])`（无 `navigator` 时 `'en'`）；导入不访问 DOM，Node 测试可直接 import。
- `src/main.js` 在 `createApp()` 之后、`mountUi()` 之前用 `store.state.settings.language` 调 `setLocale(resolveLanguage(...))` + `applyDocumentLang()`；fatal 页文案也走 `t('fatal.*')`。
- `src/index.html` 的 `<html lang="zh-CN">` 只是无 JS 时的回退，运行时由 `applyDocumentLang()` 覆盖。
- 语言只持久化在 `meta.settings.language`，不进 localStorage。
- UI 约定：`src/ui/**` 与 `src/main.js` 不得硬编码用户可见文案（按钮、空状态、状态栏、tab、更新 banner、设置卡片、`aria-label`），一律 `t(key, { ... })`；计数用 `{count}` / `{done}` / `{total}` 模板。`src/core/{db,player,source,store}.js` 抛出的用户可见 `Error` 消息同样走 `t('error.*')`。unknown artist/album 在 `Track` 里只存空串，展示时用 `common.unknownArtist` / `common.unknownAlbum`；`src/ui/app.js` 的 `UNKNOWN` 集合兼容旧库里已存的中文哨兵值。

### `src/core/store.js` — app 状态与动作（UI 唯一入口）

```js
export async function createApp()  // → Store（已 init）
export class Store extends EventTarget {
  get state()                      // 只读快照，见下
  async connectSource()            // 首次授权 / 重新授权（目录选择器）
  async requestSourcePermission()  // 'prompt' 时只调 requestPermission，不打开选择器；granted 后 rescan
  async rescan()                   // 扫描 + diff + 元数据 + 写库 + 刷新 state
  async rescanTags()               // 对已索引曲目重新读取标签（不重新扫描目录），保留 duration
  setView(view)                    // 'tracks'|'albums'|'artists'|'folders'|'queue'
  async playTrack(trackId)         // 以全部歌曲为队列，从该曲开始
  async playQueue(tracks, startId) // 以给定列表为队列
  appendQueue(tracks)              // 追加到队列末尾，不切歌、不自动播放
  toggle()                         // 播放/暂停
  async next(); async prev()
  async seek(seconds)
  setVolume(v)
  toggleShuffle(); cycleRepeat()
  setSetting(key, value)           // 'vinylSpin' | 'language'
  async jumpTo(index)              // 队列内跳转
  removeQueueAt(index)
  setUpdateReady(flag)             // SW 检测到新版本
}
// 每次 state 变化 dispatch Event('change')；UI 每帧自行节流（requestAnimationFrame）。
```

`state` 结构（UI 只读）：

```js
{
  ready: boolean,
  view: 'tracks'|'albums'|'artists'|'folders'|'queue',
  tracks: Track[],
  queue: { tracks: Track[], index: number, shuffle: boolean, repeat: 'off'|'all'|'one' },
  current: { track: Track|null, playing: boolean, position: 0, duration: 0, volume: 1 },
  source: { kind:'fsa'|'files', connected: false, permission:'none'|'granted'|'prompt'|'denied',
            name: '', error: null, scanning: false, progress: { done: 0, total: 0 } },
  settings: { vinylSpin: boolean, language: 'auto'|'zh-CN'|'zh-TW'|'ja'|'en' },
  updateReady: false,
  migration: { running: false, done: 0, total: 0, error: null }
}
```

`init()` 末尾以 `void this._maybeMigrateTags()` 启动后台迁移，**不 await**，不阻塞播放。触发条件：`meta.lastBuildVersion !== BUILD_VERSION` 且 `source.permission() === 'granted'`。迁移对可疑曲目重读标签（不可疑的不读文件），把字段实际变化的曲目 `putTracks` 写库并用同 id 覆盖 `state.tracks`（`sortTracks` 后），再 `_reconcileQueue([])`；每 5 首或最后一首 emit 一次进度。成功后写 `meta.lastBuildVersion = BUILD_VERSION`（可疑曲目为 0 也写）；任何异常写 `state.migration.error` 且**不写版本号**，下次启动重试；权限未授予时直接跳过且不写版本号。finally 里 `running = false` 并 emit。

### `src/core/selectors.js`

```js
export function groupByAlbum(tracks)   // [{name, artist, year, cover, tracks}]，按 album+artist 聚合，曲目按 trackNo
export function groupByArtist(tracks)  // [{name, cover, tracks}]
export function formatTime(seconds)    // 'm:ss'
```

### `src/core/folders.js`

```js
export function groupByFolder(tracks)  // [{dir, count, trackIds}]：每个直接含音频的目录（含嵌套）一项；
                                       // trackIds 含该目录所有子孙目录的曲目，按 trackNo、再文件名自然排序、再路径；
                                       // 结果按 dir 升序；根目录直接放歌时 dir = ''
```

### UI（`src/ui/`）

```js
// src/main.js
import { createApp } from './core/store.js';
import { mountUi } from './ui/app.js';
const store = await createApp();
const sw = registerServiceWorker(() => store?.setUpdateReady(true));
mountUi(document.getElementById('app'), store, sw);

// src/ui/app.js
export function mountUi(root, store, sw)  // 首次渲染 + store.on('change') 重渲染
```

`sw` 是 `registerServiceWorker()` 的返回值（`{ applyUpdate, checkForUpdate }`），UI 只通过它触发更新，不直接碰 `navigator.serviceWorker`。

语言切换即时生效：`render(state)` 开头比较 `resolveLanguage(state.settings.language, navigator.languages)` 与 `getLocale()`，不同则 `setLocale()` + `applyDocumentLang()` + 用 `createShell` 重建整个壳（重新绑定进度条事件、`root.replaceChildren(ui.app)`、清空视图缓存后重渲染）。**不得用 `location.reload()` 切换语言**；`store` 的 `change` 监听只绑一次。

UI 不得直接访问 IndexedDB、`<audio>`、File System Access 或 `navigator.mediaSession`；全部经 Store。

视图：歌曲 / 专辑 / 歌手 / 文件夹 / 队列。设置区：唱片旋转、重新扫描、重新读取标签。文件夹视图整行点击 = 以该目录曲目替换队列并播放；行尾「加入队列」= 追加到队列末尾。

## 构建与 SW

- `scripts/build.mjs`：清输出目录（默认 `dist/`，`--out <dir>` 可指定，所有产物路径都基于它，e2e 用它生成 v1/v2 两份构建）；esbuild 打包 `src/main.js`（ESM、minify、target es2022）与 `src/styles.css`，输出 `<out>/assets/<name>-<hash>.js|css`；读 `src/index.html` 用 `__CSS__`/`__JS__` 替换；复制 `src/manifest.webmanifest`、`src/icons/*`、`src/.well-known/*`；用 `src/sw.template.js` 生成 `<out>/sw.js`（`__VERSION__` = 构建版本，`__PRECACHE__` = 全部产物相对 URL 的 JSON 数组）。
- 构建版本：`sha256`（`src/` 下所有文件按相对路径排序后逐个 update 路径与内容，再 update `process.env.BUILD_LABEL ?? ''`）取前 10 位 hex。只改一个 src 里的字符串版本就变；同一份源码 + 同一标签结果确定。该值同时注入 esbuild 的 `define: { __BUILD_VERSION__ }`（JS/CSS 两次构建都传，供源码引用）与 `sw.js` 的 `__VERSION__`（SW 在运行时即持有构建号，并用于缓存名）。
- `scripts/size.mjs`：gzip（`zlib.gzipSync`，level 9）每个 `dist/assets/*.js` 与总计；上限 `LIMIT = 102400`（100 KB gzip，APP-001-H：i18n 表 + 设置项把首屏预算从 80 KB 提高），超出退出码 1。
- SW 策略：install 预缓存壳；activate 清旧版本缓存并 `clients.claim()`；导航请求 network-first → 失败回退缓存 `index.html`；`sw.js` 自身 network-first；`/assets/` cache-first；`manifest.webmanifest` network-first 回退缓存。`sw.js` 的 message 处理器只认 `SKIP_WAITING` → `self.skipWaiting()`。
- 更新流程（`src/pwa.js`，状态机 `createUpdateFlow` 无 DOM，可单测）：新 worker 装好后仍是 waiting，页面收到 `update-ready`（或 `updatefound` → `installed`）显示 banner；点「更新」调 `applyUpdate()`，它把 `SKIP_WAITING` 发给 `registration.waiting` 并在 `sessionStorage` 写入 `localtune:reloading`；waiting worker 激活触发 `controllerchange`，只有存在该标记时才删除标记并 `location.reload()` 一次。没有 waiting worker 时 `applyUpdate()` 返回 false、不 reload，因此不会退回「刷新 → 又是旧 SW → 再刷新」的死循环。
- 注册 URL 固定 `./sw.js`，不带查询串（`controller.scriptURL` 的 `search` 为空）。
- e2e 由 `scripts/serve.mjs`（Node 内置 http，静态服务 `dist/`，端口 4173）提供页面；`playwright.config.js` 的 `webServer` 指向它。`e2e/update.spec.js` 自带 `e2e/support/static-server.js`（root 可运行时切换），用两份构建复现真实更新。

## 部署契约（W2）

- `Dockerfile`：多阶段，`node:22-alpine` build → `nginx:stable-alpine`；非 root（`USER nginx`，uid 101）；8080；`/healthz` 200；`nginx.conf` 中 `/assets/` immutable，`/index.html`、`/sw.js`、`/manifest.webmanifest` no-cache（且 manifest 为 `application/manifest+json`），其余 `try_files $uri $uri/ /index.html`。
- CI：push 任意分支 → amd64 load + curl 冒烟（`/healthz`、`/`、`/manifest.webmanifest`、`/sw.js`；`sw.js` 头含 `no-cache`；一个 `/assets/*.js` 含 `immutable`）；非 PR 推 `linux/amd64,linux/arm64` 到 `ghcr.io/sentimentalk/localtune`，tag `sha-<short>` 与分支名，main 更新 `latest`。
