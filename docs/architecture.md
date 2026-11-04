# LocalTune v1 架构与模块契约

本文件是 v1（W1 应用）的实现契约。Worker 之间的并行由这里的签名和状态结构约束，任何偏差都要先在 Ticket 里改本文件。

## 约束

- 纯静态产物：`dist/` 只有静态文件；唯一允许的第三方域是 `login.microsoftonline.com`、`graph.microsoft.com` 与 `@microsoft.graph.downloadUrl` 的下载主机；无 CDN、无分析、无代理。
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
 * @property {'fsa'|'opfs'|'onedrive'} source
 * @property {Object<string,string>} externalIds  // onedrive: { onedrive: itemId }；本地为空对象
 */
```

IndexedDB（`localtune`，version 5）：

- `tracks`：keyPath `id`；index `album`（`album`）、`artist`（`artist`）。
- `meta`：keyPath `key`；键 `dirHandle`、`localMode`（`'import'|'reference'`）、`opfsRootName`、`lastScanBySource`（`{local?: {at,added,updated,removed}, onedrive?: {at,added,updated,removed}}`）、`lastBuildVersion`（最近一次乱码标签迁移针对的 `BUILD_VERSION` 字符串）、`playback`、`settings`、`onedriveToken`、`onedriveRoot`（`{driveId,itemId,path,name}`）、`onedriveItems`（`{ [相对路径]: itemId }`）、`onedriveAuthAt`。
- `cacheIndex`：keyPath `key`；`{ key, source, path, size, lastAccess }`（音频缓存 LRU，细节归 D2）。
- `pins`：keyPath `id`；固定（免驱逐）条目（细节归 D2）。
- `playlog`：keyPath `id`，`autoIncrement`；`{ id, t, type, detail }`，环形保留最新 500 条（见 `src/core/playlog.js`）。
- `opfsIndex`：keyPath `path`；`{ path, size, mtime }`，记录已导入 OPFS 的文件（见 `src/core/sources/opfs/index.js`）。
- `playlists`：keyPath `id`；index `createdAt`（`createdAt`，非唯一）。行即 `Playlist`：`{ id, name, source, sourceUrl, items, createdAt }`；`id` 为 `pl_<毫秒时间戳>_<6 位 hex>`，`items[]` 为 `{ title, artist, durationMs, matchedTrackId, status, reasons, coverUrl }`（见 `src/core/playlist/model.js`）。
- `stats`：keyPath `id`（即 `Track.id`）；`{ id, plays, lastPlayedAt, addedAt }`，`lastPlayedAt` 未播放过为 `null`（见 `src/core/stats.js`）。

## 模块契约

### `src/core/source.js` — 文件来源 adapter

v1 有两个实现：File System Access（桌面 Chromium / Android Chrome 132+）与 `<input webkitdirectory>` 回退（无 `showDirectoryPicker` 的浏览器）。调用方只依赖接口，不依赖具体实现。

```js
/** @typedef {Object} SourceEntry
 * @property {string} path   // 相对根的 POSIX 路径
 * @property {File} [file]   // 本地来源
 * @property {() => Promise<File|Blob>} [readFile]  // 远程来源按需构造 File-like 对象
 * @property {number} mtime
 * @property {number} size
 * @property {Object<string,string>} [externalIds]  // onedrive: { onedrive: itemId }
 */
```

`SourceEntry.file` 与 `SourceEntry.readFile()` 二选一：`store.rescan()` 优先调用 `readFile()`，否则使用 `file`。`readFile()` 返回的对象只需满足 `readMetadata` 的最小需求（`name`、`size`、`slice().arrayBuffer()`）。

```js
export const AUDIO_EXTENSIONS = new Set(['mp3','m4a','flac','ogg','oga','wav','webm']);

export function hasDirectoryPicker()  // typeof globalThis.showDirectoryPicker === 'function'
export function createSource(db)      // hasDirectoryPicker() ? new FsaSource(db) : new FileListSource(db)

export class FsaSource {
  kind = 'fsa';
  name = '';                       // 根目录名，未连接为空串
  async connect()                  // showDirectoryPicker({mode:'read'})，句柄写进 meta.dirHandle；
                                   // 同一手势内补一次 requestPermission()（best-effort，SecurityError 忽略）
  async restore()                  // 读句柄并 queryPermission；不再弹窗、不调用 requestPermission
  async forget()                   // 清空 root/dirs/permission/name，并把 meta.dirHandle 写为 null
  permission()                     // 'granted' | 'prompt' | 'denied' | 'none'
  async ensurePermission()         // 'prompt' 时 requestPermission，返回 boolean；不打开选择器
  async *scan()                    // 递归产出 SourceEntry；跳过隐藏目录；按扩展名过滤
  async getFile(path)              // 由缓存句柄按路径段取 File；找不到抛错
  async writeTextFile(path, text)  // 未连接抛 error.source.notConnected；有 requestPermission 时先请求 {mode:'readwrite'}，
                                   // 非 'granted' 抛 error.playlist.noWritePermission；目录段 create:true；createWritable → write → close
}

export class FileListSource {
  kind = 'files';
  name = '';                       // 所选根目录名（webkitRelativePath 的第一段）
  async connect()                  // 隐藏 <input type="file" webkitdirectory multiple>，File 按 path 存 meta.fileList
  async restore()                  // 从 meta.fileList 读回 File；无选择器、无权限弹窗
  async forget()                   // 清空内存文件表，并把 meta.fileList 写为 null
  permission()                     // 有文件时 'granted'，否则 'none'
  async ensurePermission()         // 有文件即 true
  async *scan()                    // 产出 { path, file, mtime, size }
  async getFile(path)              // 从内存 Map 取 File；找不到抛错
}
```

### `src/core/sources/onedrive/source.js` — OneDrive 来源 adapter

`OneDriveSource` 与本地来源实现同一组 `connect/restore/permission/ensurePermission/scan/getFile` 语义（`connect` 换成顶层授权跳转），并额外提供：

```js
export class OneDriveSource {
  kind = 'onedrive';
  trackSource = 'onedrive';
  name = '';
  constructor({ meta, fetchImpl, cache = null, sessionStore, location, history, now })
  async startLogin({ prompt = 'select_account' }) // 生成 PKCE，写 sessionStorage，location.assign 授权页
  async handleRedirect(search = location.search)  // 校验 state → 换 token → 清 query；返回 boolean，不抛
  async restore()                                 // 只读 meta；token 缺失 'none'，过期 'prompt'
  permission()                                    // 'none' | 'granted' | 'prompt'
  async ensurePermission()                        // 过期且有 refresh_token 时刷新；invalid_grant → 'prompt'
  hasRoot(); root()                               // { driveId, itemId, path, name } | null
  async browse(path = '')                         // 只列文件夹，按 name 排序
  async setRoot({ driveId, itemId, path, name })
  async forget()
  async *scan({ signal })                         // 递归 children，过滤非音频与点开头项
  async getFile(path)                             // 先查缓存（token 过期也能播），未命中再鉴权下载
  async silentReauth()                            // 仅 init：prompt=none 整页跳转，10 分钟防循环
}
```

- token 只存 `meta.onedriveToken`（`{accessToken,refreshToken,expiresAt,scope}`），不写日志、不进 DOM；`meta.onedriveAuthAt` 记录最近一次写入时间。
- 消费级 SPA 的 refresh token 有效期 24 h；过期后 `ensurePermission()` 失败，用户需在设置里重新走顶层授权。
- `getFile()` 的缓存键是 `cacheKey('onedrive', path)`；命中直接返回 Blob，不调用 `ensurePermission()`、不发网络请求。
- 整首下载失败（非 2xx 或网络错误）时重取一次 item 的 `@microsoft.graph.downloadUrl` 再试一次；成功后 `void cache.write(...)`，不阻塞播放。
- `_fetchRange` 的任一次 Range 请求失败同样重取一次 downloadUrl 再试一次，第二次失败才向上抛。
- `src/core/sources/onedrive/remoteFile.js` 的 `createRemoteFile()` 把下载 URL 包装成 `{name,size,slice(start,end).arrayBuffer()}`：首次 `slice` 预取头 256 KB（大文件再取尾 128 B），缓冲外切片现取；`status === 200` 表示服务端忽略 Range，小文件当整文件缓冲，超过 `maxRangeBytes`（32 MB）抛 `range ignored for large file`。

### `src/core/sources/onedrive/graph.js` — Graph 客户端

`createGraphClient({ fetchImpl, getToken })` 只做 HTTP，不存 token：分页走 `@odata.nextLink`；`listChildren` 默认 `$top=200` 并显式 `$select`（含 `@microsoft.graph.downloadUrl`）；`getDownloadUrl` 从 item 注解取临时下载 URL；`fetchRange(url,start,end)` 发 `Range: bytes=start-end` 且不带 `Authorization`。downloadUrl 会过期，调用方在失败时重取 item。

### `src/core/sources/opfs/{source,import,index,mode}.js` — 导入式本地来源

Android Chrome 无法跨启动保留 File System Access 授权，因此提供“导入”模式：一次选择目录，把音频复制进同源的 origin private file system（OPFS），之后启动只需读 OPFS，不再授权、可离线播放。

- `OpfsSource`：`kind = 'opfs'`、`trackSource = 'opfs'`、`mode = 'import'`。实现与本地/OneDrive 相同的 `connect/restore/permission/ensurePermission/scan/getFile`：
  - `connect({ signal })` 用隐藏的 `<input type=file webkitdirectory multiple>` 取得文件列表（`cancel` 事件 → `AbortError`），再调 `importFiles()`；`importHandle(dirHandle)` 供目录句柄调用方复用。
  - `restore()` 只打开 OPFS 的 `music/` 与 `meta.opfsRootName`、`opfsIndex`；`permission()` 为 `opfsIndex` 有行时 `'granted'`，否则 `'none'`。不弹窗。
  - `scan()` 递归产出 `{ path, file, mtime, size }`，跳过点开头目录/文件、按扩展名过滤。
  - `getFile(path)` 按路径段从 `music/` 取 `File`，失败抛 `error.source.fileMissing`。
  - `writeTextFile(path, text)` 写入 `music/` 下（`getDirectoryHandle('music', { create: true })`），目录段 `create: true`，`createWritable → write → close`；空文件名抛 `error.source.invalidPath`。
  - `usage()` 递归统计 `music/` 的 `bytes/count`（存储卡）；`clear()` 递归删除 `music/`、清空 `opfsIndex`、`meta.opfsRootName = null`；`forget()` 只清索引与名称，**不删已导入文件**。
- OPFS 目录固定为 `music/`；文件保持选择目录内的相对路径。`meta.opfsRootName` 记住所选根目录名用于显示。`meta.localMode` 持久化 `'import'|'reference'`，`defaultLocalMode()`：UA 含 `Android` → 导入；否则有 `showDirectoryPicker` → 引用，否则导入。
- `opfsIndex` 行结构：`{ path, size, mtime }`（keyPath `path`）。增量规则：`path` 相同且 `size` + `mtime` 都相同视为未变（`skipped`）；新路径或任一字段变化则重新复制；索引有而本次选择没有的路径删除 OPFS 文件与索引行。每个文件复制完成后立即写索引，中止/崩溃留下可续传的前缀。
- 进度回调形状（`onProgress`，导入期间写入 `state.sources[local].progress`）：`{ phase: 'copy'|'remove'|'done', copied, total, removed, removedTotal, bytes, bytesTotal, skipped }`；`bytes` 为已复制字节。设置页只在 `copy`/`remove` 阶段显示进度行。

iOS / 未来来源只需实现同一组方法（`connect/restore/permission/ensurePermission/scan/getFile`）；可选写能力为 `writeTextFile(path, text)`（FSA 与 OPFS 实现）。OneDrive **不写回**：`OneDriveSource` 没有 `writeTextFile`，歌单导出按钮在 OneDrive 或未授权的本地来源下为灰态（`store.writePlaylistM3u8()` 抛 `error.playlist.writeUnsupported`）。`state.sources[].kind` 为 `'fsa' | 'files' | 'opfs' | 'onedrive'`。

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

### `src/core/storage.js` — 存储占用与音频缓存

```js
export function formatBytes(bytes)   // 0 → '0 B'；<1024 → 'N B'；KB/MB/GB 保留 1 位小数（整数省略 .0）
export async function estimateLibrary(tracks)      // → { indexBytes, coverBytes }
export async function estimateAudioCache(cachesImpl = globalThis.caches)  // → number
export async function clearAudioCache(cachesImpl = globalThis.caches)     // 删除音频条目 → 释放字节数
```

- `indexBytes`：每首曲目去掉 `cover` 后单独 `JSON.stringify` 的 UTF-8 字节和；`coverBytes`：所有 `track.cover?.size` 之和。
- 音频条目判定：请求 URL pathname 以 `.mp3/.m4a/.flac/.ogg/.oga/.wav/.webm` 结尾，或响应 `content-type` 以 `audio/` 开头；只处理同源条目，遍历全部 Cache，单条 `match`/`blob` 失败跳过。
- `clearAudioCache` 先累加命中响应 blob 的 size，再删除对应条目，返回总和；无命中返回 0。`cachesImpl` 可注入内存替身（`tests/storage.test.js`）。

### D2 契约 — 音频缓存、固定与上限

- 命名：音频 blob 全部放在 Cache Storage 的 `audio-v1`（`AUDIO_CACHE_NAME`）中，key 为同源合成 URL `/__audio/<encodeURIComponent(cacheKey(source, path))>`，从不发出网络请求；`cacheKey` = `<source>:<path 去前导 />`。
- `cacheIndex`：keyPath `key`；每行 `{ key, source, path, size, lastAccess }`。`size` 来自 blob；`lastAccess` 在每次命中时刷新。
- `pins`：keyPath `id`；每行 `{ id: "<source>:<dir>", source, dir, at }`，`dir === ''` 表示该来源的整个根。固定条目永不被 LRU 选中。
- LRU：写入后立即 `enforceLimit()`；超限时按 `lastAccess` 升序（同值按 key）驱逐，直到总量 ≤ 上限；全部固定且超限时一个都不驱逐。
- 上限：`CACHE_LIMIT_OPTIONS` = `[512 MiB, 1 GiB, 2 GiB, 5 GiB, 0(不限)]`，默认 `2 GiB`（`DEFAULT_CACHE_LIMIT`）。`persist.js` 直接 re-export 这两个常量（`CACHE_LIMIT_VALUES` / `DEFAULT_CACHE_LIMIT_BYTES`），`meta.settings.cacheLimitBytes` 缺失或非法一律回落到默认值；`0` 表示不限。
- 状态与动作：`state.pins` 是 `{ id, source, dir, running, done, total, error }` 的数组；`pinFolder` 先落库再逐首 `getFile`（并发 1，单曲失败跳过，全部失败保留 pin 并写 `error`），`unpinFolder` 只删 pin、缓存保留；`isPinned(source, dir)` 对 `dir === ''` 的根 pin 返回 true。
- 启动同步：`init()` 只在 `meta.lastScanBySource.onedrive.at` 距今超过 1 小时（或缺失）时后台 `syncSource('onedrive')`，不阻塞首屏。
- 清除：`store.clearAudioCache()` = `cache.clear()` + 删除全部 pins（`state.pins = []`），返回释放字节数；两条路径都不触碰源文件。

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
  loadUrl(url)         // 同步设 src；调用方拥有该 objectURL，旧 URL 在这里 revoke
  playNow()            // 同步调用 audio.play()，返回 Promise；不做加载等待
  async play(); pause()
  seek(seconds); setVolume(v /*0..1*/)
  get position(); get duration(); get playing()
  async enableLeveling()      // 建 AudioContext + MediaElementSource + GainNode；不可运行返回 false
  setGain(db)                 // 图未建时先记住，就绪后应用
  disableLeveling()           // gain 设 1；路由保持连接
  get levelingReady()         // 增益图是否就绪
  get canHandOffSynchronously() // 元素已有 src → 可同步交接
  destroy()            // revoke URL、移除监听
}
// events: 'timeupdate' {position,duration} | 'ended' | 'play' | 'pause'
//         | 'loaded' {duration} | 'error' {error}
```

`load` 内部负责 `URL.createObjectURL(file)` 与 `revokeObjectURL`。`loadUrl` 只接受已经创建好的 URL，所有权转给播放器（下一次 `loadUrl`/`destroy` 时 revoke）；预取路径用 `loadUrl` + `playNow`，避免 `await` 丢掉用户手势。

### `src/core/prefetch.js` — 单槽预取

```js
export class Prefetcher {
  constructor({ load, createUrl?, revokeUrl? })
  get state()                 // {status:'idle'|'priming'|'ready'|'taken'|'cleared', id, url}
  async prime(track)          // → {id,url}|null；同 id 已就绪直接返回
  take(id)                    // → {id,url}|null；把 URL 所有权交给调用方
  clear()                     // 丢弃槽位；未取走的 URL 在这里 revoke
}
```

- 状态机：`idle → priming → ready → taken`；任意状态可 `clear()` 到 `cleared`。并发 `prime()` 以 token 丢弃旧结果并 revoke 旧 URL；失败回到 `idle` 并返回 null。
- `store._primeNext()` 在每次成功切歌后预热队列里的下一首；远程来源（onedrive）整文件读取成本高，跳过并记 `prefetch {ok:false, skipped:'remote'}`。
- 自然播完时 `_handleEnded()` 先 `advance(auto)` 得到下一首，`prefetcher.take(id)` 命中就同步 `loadUrl` + `playNow`（不 await），未命中才走原来的异步 `_loadTrack`。`ended` 事件里发出的 `trackchange` 标记 `source:'auto'`，`prefetch` 行记录命中与否。

### `src/core/playlog.js` — 播放诊断环形日志

```js
export const PLAYLOG_LIMIT = 500;
export class PlayLog {
  constructor(db, { limit = PLAYLOG_LIMIT, now? })
  async record(type, detail = {})   // put 一行后 trim；任何错误吞掉
  async list({ limit? })            // 按 id 升序，返回最新 limit 条
  async trim()                      // 删除超出 limit 的最旧行
  async clear()
  static format(rows, { userAgent }) // 纯文本：头两行 + 每行 ISO 时间/type/JSON detail
}
```

- 存储：IDB v3 的 `playlog`，keyPath `id` + `autoIncrement`，环形保留 500 条。写入失败（磁盘满、升级被阻塞）不得影响播放。
- 事件类型：`audio:*`（`play/pause/ended/waiting/stalled/suspend/error`，带 `position` 等）、`control`（`toggle/resume/pause`）、`trackchange`（`source:'user'|'auto'`，repeat-one 带 `repeat:'one'`）、`prefetch`（`{id, ok, skipped?}`）、`playblocked`（`{error}`）、`visibility`（`{state}`）、`network`（`{online}`）。每行 detail 统一附加 `trackId` 与 `online`。
- `PlayLog.format()` 输出 `LocalTune play log`、`UA: …`，随后每行 `${ISO(t)} ${type} ${JSON.stringify(detail)}`；detail 不能序列化时退化为 `String(detail)`。
- store：`log(type, detail)`（best-effort）、`playLog()`（行数组）、`playLogText()`（格式化文本）、`clearPlayLog()`（清空后 emit）。

### `src/core/db.js`

```js
export const DB_NAME = 'localtune', DB_VERSION = 5;
export const PLAYLISTS_STORE = 'playlists';
export function openDb()                         // Promise<IDBDatabase>（onupgradeneeded 逐 store 补建）
export function putTracks(db, tracks)            // 单事务覆盖写
export function deleteTracksById(db, ids)
export function getAllTracks(db)                 // Promise<Track[]>
export function putPlaylist(db, playlist)        // 单事务 put；失败消息 error.db.writePlaylist
export function deletePlaylist(db, id)           // 单事务 delete；失败消息 error.db.deletePlaylist
export function getAllPlaylists(db)              // Promise<Playlist[]>；非数组结果回落 []
export function getMeta(db, key)                 // Promise<any>
export function setMeta(db, key, value)
export function getAllStats(db)                   // Promise<StatsRow[]>
export function putStat(db, row); export function putStats(db, rows)
```

### `src/core/playlist/*` — 歌单

歌单只存匹配结果，不存音频：`PlaylistItem.status` 为 `'matched' | 'suspect' | 'missing'`，`reasons` 为 `'artist' | 'duration'` 的子集，`matchedTrackId` 为 `Track.id` 或 `null`。

```js
// src/core/playlist/model.js —— 纯函数，无 DOM/IDB/网络
export const PLAYLIST_SOURCES = ['text','youtube','spotify','netease','qq'];
export function normalizePlaylistItem(item)   // 补默认：title/artist 为 ''，durationMs/matchedTrackId/coverUrl 为 null，
                                              // status 'missing'，reasons []；非法 status → 'missing'；
                                              // 非 missing 且无 matchedTrackId → 'missing'
export function normalizePlaylist(input, { now = Date.now, id } = {})
                                              // → Playlist；id 缺省 `pl_${now()}_${6 位 hex}`；name trim 后空 → t('playlists.untitled')；
                                              // source 非法 → 'text'；sourceUrl 非 http(s) → null；createdAt 缺失取 now()
export function playlistCounts(playlist)      // → { matched, suspect, missing }
export function missingText(playlist)         // 仅 missing：有 artist 写 `${artist} - ${title}`，否则 `${title}`；'\n' 连接，
                                              // 非空时末尾带一个 '\n'；无缺失 → ''
export function sanitizeFileName(name)        // 去 / \ : * ? " < > | 与控制字符，trim，折叠空白，截 80 字符；空 → 'playlist'
export function m3u8Text(playlist, tracks)    // 只写 status === 'matched' 且 matchedTrackId 能在 tracks 中解析的行，按 items 顺序；
                                              // 首行 '#EXTM3U'，每行 `#EXTINF:<秒>,<艺人> - <歌名>` + `./<path>`；
                                              // 秒 = duration > 0 ? round(duration) : -1；无艺人只写歌名；空歌单 → '#EXTM3U\n'
export async function rematchPlaylist(playlist, tracks, options = {})
                                              // 只重跑 missing 行（await matchItem）；命中时替换 matchedTrackId/status/reasons；
                                              // → { playlist: 新对象, added }，不改入参
// src/core/playlist/repo.js —— 存储无关
export function createPlaylistRepo(ops)       // ops: { all(), put(playlist), remove(id) }
                                              // → { list(): 过滤非法行 + createdAt 降序 + 同值按 id 字典序,
                                              //     save(playlist): normalize 后 put，返回落库对象,
                                              //     remove(id) }
```

`src/core/playlist/match.js`（`matchItem`/`matchPlaylist`/相似度）与 `src/core/playlist/parse-text.js`（粘贴文本 → `{ items, delimiter, order, warnings }`）只做算法，不认识歌单存储。

### `src/core/persist.js`

```js
export async function loadPlayback(db)   // meta.playback → {trackId,position,queueIds,queueIndex,repeat,shuffle,volume}|null
export function savePlayback(db, snapshot) // 1s 防抖；调用 stop() 可 flush（模块内导出 savePlayback.flush）
export async function loadSettings(db)   // {language, cacheLimitBytes, youtubeApiKey, playlistProxyUrl}
export async function saveSettings(db, settings) // 写四个字段并返回同一形状；非法值落盘为默认
```

`meta.settings.language` 缺省 `'auto'`：`'auto'` 表示跟随 `navigator.languages`，其余为显式语言。`youtubeApiKey` 为 trim 后 ≤ 200 字符的字符串，`playlistProxyUrl` 为 trim 后 ≤ 300 字符且以 `https://` 开头的字符串，两者不满足时读/写都落 `''`。旧库残留的 `vinylSpin` 字段读取时忽略，下次保存后消失。

### `src/core/mediaSession.js`

```js
export function installMediaSession(store)   // 绑定 play/pause/previoustrack/nexttrack/seekto/seekforward/seekbackward
export function syncMediaSession(state)      // metadata + playbackState + positionState（duration>0 才设）
```

### `src/core/install.js` — PWA 安装状态

```js
export function classifyInstall({ displayMode='browser', canPrompt=false, installed=false })
// 已安装（standalone/fullscreen/minimal-ui/installed）→ 'installed'；
// 否则 canPrompt → 'installable'；否则 'browser'
export function initInstall({ window = globalThis.window })
// → { state(): {status, canPrompt}, prompt(): Promise<{outcome}>, onChange(fn), destroy() }
```

`initInstall` 只监听 `beforeinstallprompt`（`preventDefault()` 后保存事件）与 `appinstalled`；`prompt()` 只在有事件时调用，并清空事件。页面从不自动 `prompt()`。store 持有实例（`store.install`），`_emit()` 把 `state()` 镜像到 `state.install`，所以 UI 只需读状态。

### `src/core/battery.js` — Android 电池优化指引

```js
export const BATTERY_BRANDS = ['samsung','xiaomi','huawei','stock'];
export function batteryTarget({ userAgent = '', model = '' }) // → 品牌
export const BATTERY_INTENT_URL = null;
export const BATTERY_STEP_KEYS = { samsung: [3 个 i18n key], xiaomi: [...], huawei: [...], stock: [...] };
```

- `batteryTarget` 优先 UA-CH `model`（Chrome 精简 UA 已不含机型）：`SM-`/`SAMSUNG` → samsung；`M\d{4}`/`2\d{3}`/`POCO`/`Redmi`/`MI ` → xiaomi；`ELS|ANA|NOH|ALN-`/`HUAWEI`/`HarmonyOS` → huawei。`model` 为空或不匹配时才用 UA 关键词（`SamsungBrowser|SM-`、`MIUI|Xiaomi|Redmi|POCO|HyperOS`、`HuaweiBrowser|EMUI|HarmonyOS`），其余 `stock`。
- `BATTERY_INTENT_URL` 固定 `null`：`intent:` 只在 Android 14+ AOSP 声明了 `BROWSABLE`，Android 12/13 必然失败且 OEM 行为不可验证，所以 UI 只做分品牌指引；常量保留供未来渐进增强。
- `BATTERY_STEP_KEYS` 每个品牌恰好三个 key，UI 用 `t(key)` 渲染步骤列表。

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

四张表 `src/i18n/{en,zh-CN,zh-TW,ja}.js` 都是默认导出的扁平对象，key 为点分命名（`common.*`、`tabs.*`、`player.*`、`empty.*`、`settings.*`、`update.*`、`migration.*`、`diagnostics.*`、`aria.*`、`error.*`、`fatal.*`），四张表 key 集合必须完全一致（`tests/i18n.test.js` 断言），en 是唯一兜底表。

- 模块加载时默认 locale = `resolveLocale(navigator.languages ?? [navigator.language])`（无 `navigator` 时 `'en'`）；导入不访问 DOM，Node 测试可直接 import。
- `src/main.js` 在 `createApp()` 之后、`mountUi()` 之前用 `store.state.settings.language` 调 `setLocale(resolveLanguage(...))` + `applyDocumentLang()`；fatal 页文案也走 `t('fatal.*')`。
- `src/index.html` 的 `<html lang="zh-CN">` 只是无 JS 时的回退，运行时由 `applyDocumentLang()` 覆盖。
- 语言只持久化在 `meta.settings.language`，不进 localStorage；同一 `meta.settings` 还存 `cacheLimitBytes`（允许值见 D2，缺失/非法回落 2 GiB）。
- UI 约定：`src/ui/**` 与 `src/main.js` 不得硬编码用户可见文案（按钮、空状态、状态栏、tab、更新 banner、设置卡片、`aria-label`），一律 `t(key, { ... })`；计数用 `{count}` / `{done}` / `{total}` 模板。`src/core/{db,player,source,store}.js` 抛出的用户可见 `Error` 消息同样走 `t('error.*')`。unknown artist/album 在 `Track` 里只存空串，展示时用 `common.unknownArtist` / `common.unknownAlbum`；`src/ui/app.js` 的 `UNKNOWN` 集合兼容旧库里已存的中文哨兵值。

### `src/core/store.js` — app 状态与动作（UI 唯一入口）

```js
export async function createApp()  // → Store（已 init）
export class Store extends EventTarget {
  get state()                      // 只读快照，见下
  local; onedrive; sources         // adapters: { local, onedrive }
  localMode                        // 'import'|'reference'（meta.localMode）
  install                          // initInstall() 实例：state()/prompt()/onChange()
  cache                            // AudioCache（Cache Storage + cacheIndex/pins）
  async connectSource()            // 本地来源：当前模式选择目录（reference）或导入（import）
  async setLocalMode(mode)         // 切模式：写 meta、换 adapter、丢弃旧策略的曲目索引（不删导入文件）
  async clearImported()            // opfs.clear() + 删除 source === 'opfs' 的曲目索引
  async requestSourcePermission()  // 本地 'prompt' 时只调 requestPermission；granted 后 rescan('local')
  async connectOneDrive()          // onedrive.startLogin()（整页跳转）
  async browseOneDrive(path = '')  // 打开 picker 并列出子文件夹；失败写入 onedrive 行 error
  closeOneDrivePicker()
  async chooseOneDriveRoot({ id, path, name })  // setRoot → rescan('onedrive') → 关闭 picker
  async reauthenticateOneDrive()   // forget + connectOneDrive
  async rescan(kind = 'local')     // 只扫描该来源；diff 只影响该来源的 track.source；返回 {at,added,updated,removed}|null
  async syncSource(kind = 'onedrive') // rescan(kind)，结果同时写入该行 sync
  async rescanTags()               // 遍历 permission === 'granted' 的来源；按 track.source 选 adapter
  async removeSource(kind = 'local') // adapter.forget()；该行复位，保留已索引曲目
  async clearLibrary()             // 删除全部曲目索引，暂停播放并清空队列/current，不动授权与 settings
  async storageEstimate()          // → {indexBytes, coverBytes, audioBytes, importBytes, importCount, usage, quota, limitBytes, pinnedCount}
                                   // audioBytes = cache.total()；import* = opfs.usage()
  async clearAudioCache()          // cache.clear() + 删除全部 pins → 释放字节数
  async pinFolder({ source, dir, trackIds })  // 记录 pin 后按序拉取每首（并发 1）写入缓存；已存在同 id 直接返回
  async unpinFolder(id)            // 只删 pin，不删缓存
  isPinned(source, dir)            // 该来源的 dir（或 dir === '' 的根）已固定
  async describeTrackTags(trackId) // 按 track.source 选 adapter → describeTags → formatTagReport
  // 歌单：id 不存在时抛 t('error.playlist.notFound')
  async createPlaylist({ name, source = 'text', sourceUrl = null, items = [] })
                                   // normalize → repo.save → 插到 state.playlists 头部 → emit；返回落库对象
  async deletePlaylist(id)         // repo.remove → 从 state 移除 → emit
  async playlistTracks(id)         // status 为 matched/suspect 的 matchedTrackId 命中曲目，按 items 顺序
  async confirmPlaylistItem(id, index)        // 已是 matched/suspect 且有 matchedTrackId → matched、reasons []；否则不改
  async assignPlaylistItem(id, index, trackId) // 曲目存在且下标有效 → matchedTrackId=trackId、matched、reasons []；否则不改
  async rematchPlaylist(id)        // 只重跑 missing 行；有新命中才保存/更新 state/emit；返回新增数
  async playlistMissingText(id)    // → missingText(playlist)
  async exportPlaylistM3u8(id)     // → { name: sanitizeFileName(name) + '.m3u8', text }；不写盘
  async writePlaylistM3u8(id)      // 本地未授权抛 error.playlist.writeUnsupported；写入引用根或 OPFS music/，→ { name, path }
  clearRematchNotice()             // state.rematch = null；emit
  setView(view)                    // 'tracks'|'albums'|'artists'|'folders'|'playlists'|'queue'|'settings'|'lyrics'
  async playTrack(trackId)         // 以全部歌曲为队列，从该曲开始
  async playQueue(tracks, startId) // 以给定列表为队列
  appendQueue(tracks)              // 追加到队列末尾，不切歌、不自动播放
  toggle()                         // 播放/暂停
  async next(); async prev()
  async seek(seconds)
  setVolume(v)
  toggleShuffle(); cycleRepeat()
  async loadLyrics(trackId)        // 侧车 .lrc/.LRC → 内嵌 SYLT/USLT(©lyr)；结果写 state.lyrics 并缓存（LRU 20）
  setSleepMode(mode)               // 'off'|'15'|'30'|'45'|'60'|'end'；非法值回落 'off'；立即写 state.sleep 并 emit
  setSetting(key, value)           // 'language'、'cacheLimitBytes'（校验合法值、写 meta、更新 cache.limit 并 enforceLimit）、
                                   // 'youtubeApiKey'（trim 截 200）、'playlistProxyUrl'（trim 截 300，非 https:// 或空串则忽略）、
                                   // 'leveling' / 'gapless'（仅接受 boolean；leveling 切换同时 enable/disable Web Audio 增益图）
  async jumpTo(index)              // 队列内跳转
  removeQueueAt(index)
  log(type, detail = {})           // 播放诊断行（best-effort，见 playlog）
  async playLog(); async playLogText(); async clearPlayLog()
  setUpdateReady(flag)             // SW 检测到新版本
}
// 每次 state 变化 dispatch Event('change')；UI 每帧自行节流（requestAnimationFrame）。
```

`state` 结构（UI 只读）：

```js
{
  ready: boolean,
  view: 'tracks'|'albums'|'artists'|'folders'|'playlists'|'queue'|'settings'|'lyrics',
  tracks: Track[],
  queue: { tracks: Track[], index: number, shuffle: boolean, repeat: 'off'|'all'|'one' },
  current: { track: Track|null, playing: boolean, position: 0, duration: 0, volume: 1 },
  sources: [ // 固定两行，顺序 local、onedrive
    { id: 'local'|'onedrive', kind: 'fsa'|'files'|'opfs'|'onedrive', name: string,
      connected: boolean, permission: 'none'|'granted'|'prompt'|'denied',
      trackCount: number, scanning: boolean,
      progress: { done: 0, total: 0 } | { phase:'copy'|'remove'|'done', copied, total,
                 removed, removedTotal, bytes, bytesTotal, skipped }, // import 模式
      mode: 'import'|'reference',  // 仅 local 行
      error: string|null, sync: null|{ at, added, updated, removed }, root: string|null }
  ],
  onedrivePicker: { open: boolean, path: string, items: [{id,name,path,isFolder}],
                    loading: boolean, current: {id,name,path}|null },
  playlists: [ // 按 createdAt 降序；新建的排在最前
    { id: 'pl_<ms>_<hex6>', name: string, source: 'text'|'youtube'|'spotify'|'netease'|'qq',
      sourceUrl: string|null, items: [ { title, artist, durationMs, matchedTrackId,
      status: 'matched'|'suspect'|'missing', reasons: ('artist'|'duration')[], coverUrl } ],
      createdAt: number }
  ],
  rematch: { added: number } | null, // rescan 后自动补匹配的数量；clearRematchNotice() 清空
  stats: { [trackId: string]: { plays: number, lastPlayedAt: number|null, addedAt: number } },
                                     // init 时 getAllStats → ensureAdded 补行（新增行 best-effort putStats）
  sleep: { mode: 'off'|'15'|'30'|'45'|'60'|'end', endsAt: number|null,
           remaining: number|null, fading: boolean },  // 由 createSleepTimer 的 onTick 镜像
  lyrics: { trackId: string|null, loading: boolean,
            lines: [{ time: number, text: string }], plain: string,
            source: 'lrc'|'lrc-plain'|'sylt'|'uslt'|'lyr'|'none', error: string|null },
  settings: { language: 'auto'|'zh-CN'|'zh-TW'|'ja'|'en', cacheLimitBytes: number,
              youtubeApiKey: string, playlistProxyUrl: string,
              leveling: boolean, gapless: boolean }, // leveling 缺省 false，gapless 缺省 true
  pins: [ // 每个来源的目录一条；根目录 dir === ''
    { id: `${source}:${dir}`, source: 'fsa'|'onedrive', dir: string,
      running: boolean, done: number, total: number, error: string|null }
  ],
  updateReady: false,
  install: { status: 'installed'|'installable'|'browser', canPrompt: boolean } | null,
  migration: { running: false, done: 0, total: 0, error: null }
}
```

轨道来源与 id：

- `local` 引用模式 → `track.source = 'fsa'`，`id = 'fsa:' + path`（与旧库一致，不迁移）。
- `local` 导入模式 → `track.source = 'opfs'`，`id = 'opfs:' + path`，`path` 相对所选根。
- `onedrive` → `track.source = 'onedrive'`，`id = 'onedrive:' + path`，`path` 相对所选根，`externalIds = { onedrive: itemId }`。
- `state.sources[].trackCount` 按 `track.source` 统计；`syncSource` 只替换该来源的轨道，`removedIds` 也只影响该来源。

`init()` 顺序：`onedrive.handleRedirect()` → restore 两个来源 → 仅在 onedrive 已登录但尚无 root 时进入设置并打开 picker（有 root 的常规启动与重授权回跳都留在曲库）→ onedrive 有 root 且 `permission === 'prompt'` 时 `await onedrive.silentReauth()`（`prompt=none` 顶层跳转，10 分钟 guard，仅 init 调用）→ 读 tracks/playlists/playback/settings/pins，把 `settings.cacheLimitBytes` 写入 `cache.limit` 并构建 `state.sources`/`state.pins`/`state.playlists` → 恢复队列与播放位置 → emit。末尾以 `void this._maybeMigrateTags()` 启动后台迁移，**不 await**；若 onedrive 有 root、已授权且 `meta.lastScanBySource.onedrive.at` 距今超过 1 小时（或缺失），再 `void this.syncSource('onedrive')`。

播放计数：`timeupdate` 每次把位置交给 `createPlayCounter().update(position)`；有效播放累计到 `min(30 s, duration / 2)`（`stats.PLAY_COUNT_SECONDS`，单次向前跳变超过 5 s 不计入）时只触发一次 `_recordPlay(trackId)` → `applyPlay` 生成新 `state.stats`、`putStat` best-effort 落库、记 `stats` 日志并 emit。会话在 `_loadTrack` 成功、无缝 handoff、repeat-one 与 `playQueue` 后由 `_startPlaySession` 重开；`pause`/`play` 只是挂起/恢复累计。`rescan` 新增曲目与 `clearLibrary` 后调用 `_syncStats()`：`ensureAdded` 补零行（新增行 `putStats` best-effort）；`clearLibrary` 只清 `state.stats` 与曲目索引，stats store 的历史行保留（db.js 没有 clear 接口，不为此扩 API）。

歌词：`loadLyrics(trackId)` 命中 20 条 LRU 缓存时直接写 `state.lyrics`；否则先置 `loading: true` 并 emit，再 `resolveLyrics({ track, getFile })`（侧车 `.lrc` → `.LRC` → 内嵌 SYLT → USLT/©lyr）。异常只记 `lyrics` 日志并落到 `source: 'none'`，不写 `state.sources[].error`，也不抛给播放路径。当前曲目变化（`_loadTrack` 成功、无缝 handoff、`playQueue` 之后）把 `state.lyrics` 复位为 `{ trackId: null, loading: false, lines: [], plain: '', source: 'none', error: null }`；缓存保留，且过期请求的 resolve 不会覆盖新曲目的歌词。

睡眠定时：`setSleepMode(mode)` 交给 `createSleepTimer.set`（非法值回落 `'off'`）并把 `state.sleep` 立即镜像到 state；`onTick` 更新倒计时，`onFade` 把系数乘到播放器音量上（不改 `state.current.volume`），`onStop` 暂停、恢复音量、记 `sleep { stopped: true }`。`_handleEnded()` 在 `advance` 之前检查 `mode === 'end'`：命中则 `fireEnd()`（停止且不续播）并保存快照。

音量均衡：`leveling` 为真时每次成功加载/无缝 handoff 异步读文件头（≤ 512 KiB），`parseReplayGain` + `decideGain` 得到 dB 后 `player.setGain(db)`；OneDrive 曲目（整文件读取成本高）、无 player、设置关闭或任何异常一律 `setGain(null)`（Unity）。Web Audio 图只在用户手势（`playTrack`/`playQueue`/`toggle`/`resume`）里 `enableLeveling()`，失败静默。`gapless` 只决定 `_handleEnded` 是否 `prefetcher.take(next.id)`：关闭时走原异步 `_loadTrack`，不新增 audio 元素。

`rescan(kind)` 成功分支在写完 `meta.lastScanBySource` 之后、`_reconcileQueue()` 之前，对 `state.playlists` 逐条 `await rematchPlaylist()`（只重跑 missing 行）：有新增才 `repo.save` 并替换 state 中对应项，累计 `added > 0` 时置 `state.rematch = { added }`。rescan 成功后自动 rematch 缺失项，UI 在 `render(state)` 里以 toast（`playlists.rematchAdded`）提示并立即 `clearRematchNotice()` 清空 `state.rematch`。任何异常被吞掉，扫描结果不受影响。首次匹配会懒加载繁简表（数十毫秒），因此重匹配只在扫描路径里做，不进入播放路径。

`_maybeMigrateTags()` 触发条件：`meta.lastBuildVersion !== BUILD_VERSION` 且至少一个来源 `permission === 'granted'`。按来源分组调用 `migrateGarbledTracks`（`getFile` 用该来源的 adapter），合并结果后 `putTracks` 并用同 id 覆盖 `state.tracks`（`sortTracks` 后），再 `_reconcileQueue([])`；每 5 首或最后一首 emit 一次进度。成功后写 `meta.lastBuildVersion = BUILD_VERSION`（可疑曲目为 0 也写）；任何异常写 `state.migration.error` 且**不写版本号**，下次启动重试；无已授权来源时直接跳过且不写版本号。finally 里 `running = false` 并 emit。`running` 期间顶部状态栏显示 `t('migration.progress', { done, total })`，优先于扫描/就绪文案；`error` 在设置视图曲库卡显示一行 muted 文案。

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

### `src/core/playlist/*` — 播放列表解析与匹配

```js
// src/core/playlist/match.js
export async function ensureNormalizer()     // 首次调用 import('./t2s-table.js') 填表；幂等，并发共享同一个 import
export function isNormalizerLoaded()         // T2S.size > 0
export async function matchItem(item, tracks, options = {})
export async function matchPlaylist(items, tracks, options = {})  // 保序，长度同 items

// 同步（签名不变）：normalizeText / normalizeTitle / splitArtists / normalizeArtist /
// artistMatches / similarity
```

繁简表（约 21 KB gzip）通过 `import()` 懒加载为独立 chunk，不进入首屏包。`matchItem` / `matchPlaylist` 为 async：调用前自动 `await ensureNormalizer()`，失败时清掉缓存以便重试并向上抛。同步规范化函数在表未加载时按 identity 处理（繁中字符原样保留），不得抛错。

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

// src/ui/settings.js
export function createSettingsView(store, sw) // → { node, render(state) }

// src/ui/diagnostics.js
export function openTagInfo(track, { loadReport }) // 标签信息弹层；loadReport: () => Promise<string>

// src/ui/playlist.js
export function createPlaylistView(store)     // → { node, render(state) }；歌单列表 + 详情
export function createImportDialog(store)     // → { node, open(), close() }；文本/链接导入弹层
```

`sw` 是 `registerServiceWorker()` 的返回值（`{ applyUpdate, checkForUpdate }`），UI 只通过它触发更新，不直接碰 `navigator.serviceWorker`。

设置视图是全屏视图（`state.view === 'settings'`），不重建壳：

- 头部右上角齿轮（`data-testid="settings-open"`）进入设置并隐藏自身；UI 局部变量记录进入前的 view（默认 `'tracks'`），`settings-back` 恢复该 view。齿轮/曲目行菜单/返回都走事件委托，`createSettingsView` 只持有 `store` 与 `sw`。
- 六张卡（`settings-section-library|background|storage|playback|language|about`，OneDrive picker 另有独立 card）只创建一次；`render(state)` 只改文本、数值、chip 与 disabled，不重建节点。顺序固定为曲库 → picker → 后台播放 → 存储 → 播放 → 语言 → 关于。
- 曲库卡：固定两行来源（`data-testid="source-row-local|onedrive"`；类型图标、名称、曲目数、授权 chip、该行 `error`）。本地行后跟模式分段控件（`data-testid="local-mode"`，按钮 `local-mode-reference|local-mode-import`，当前值 `aria-pressed` + `.is-active`）：点击 `store.setLocalMode(mode)`，`import` 后立即 `store.connectSource()` 打开目录选择。导入期间显示 `data-testid="import-progress"`：`copy` 阶段用 `settings.library.importProgress`（`{copied,total,bytes}`，`formatBytes`），`remove` 阶段用 `settings.library.importRemoving`（`{removed,removedTotal}`），`done` 或空闲时隐藏。每行动作：同步（`settings-sync-<id>`，运行中禁用并显示 `settings.source.syncing`，完成后 toast `settings.source.syncResult`）、更换（本地 `settings-source-change` / OneDrive `settings-onedrive-change` 重新打开 picker；import 模式下本地按钮文案为 `settings.library.import`）、移除（`settings-source-remove` / `settings-onedrive-remove`，确认后调 `store.removeSource(id)`）。添加来源：本地文件夹；OneDrive 按钮（`settings-source-onedrive`）按状态显示 `settings.source.onedriveSignIn` / `onedrivePick` / `onedriveChange`，`permission === 'prompt'` 时显示 `settings.source.onedriveReauth` 并调 `store.reauthenticateOneDrive()`。另有重新读取标签。扫描中禁用动作并显示正在扫描那一行的 `progress`。
- 后台播放卡（`settings-section-background`，位于曲库卡与存储卡之间）：标题/说明 `settings.background.title|hint`；`data-testid="install-status"` 按 `state.install.status` 显示 `settings.background.installed|installable|browserMode`；`install-button` 只在 `installable` 时出现，点击 `store.install.prompt()`，状态随 store `change` 更新，安装后隐藏说明与按钮。Android（UA 含 `Android`）显示 `battery-button`（`settings.background.batteryOpen`），点击打开 `battery-guide` 弹层：品牌 tab `battery-brand-samsung|xiaomi|huawei|stock`（`aria-pressed`），步骤列表 `battery-steps` 渲染 `BATTERY_STEP_KEYS[brand]` 的三个 key；默认品牌先按 UA 渲染，再异步用 `navigator.userAgentData.getHighEntropyValues(['model'])` + `batteryTarget()` 校正；`battery-guide-close` 关闭。桌面不渲染按钮，只显示 `settings.background.batteryDesktop`。
- OneDrive 目录选择器：`state.onedrivePicker.open` 时作为独立 card 渲染在曲库卡下方（`data-testid="onedrive-picker"`）：面包屑（`settings.onedrive.root` + 已进入的路径段）、上一级（`onedrive-picker-up`，根层禁用）、文件夹列表（`onedrive-folder`）、选择此文件夹（`onedrive-picker-choose`，根层或没有记录当前项时禁用）、取消（`onedrive-picker-cancel`）。加载中显示 `settings.onedrive.loading`，空目录显示 `settings.onedrive.empty`；当前目录项（`{id,name,path}`）记在 `state.onedrivePicker.current`。
- 存储卡：上限分段控件（`data-testid="cache-limit"`，`0.5 GB / 1 GB / 2 GB / 5 GB / 不限`，当前值 `aria-pressed` + `.is-active`，点击 `store.setSetting('cacheLimitBytes', value)`）、索引/封面/缓存音乐/导入文件/固定条目数五行（`formatBytes`；导入行 `storage-import` 显示 `formatBytes(importBytes)` + `settings.storage.importCount`（`{count}`），按钮 `storage-clear-import` 先 `confirm(settings.storage.clearImportConfirm)` 再 `store.clearImported()`，toast `settings.storage.importCleared`；固定行用 `settings.storage.pinnedCount` + `state.pins.length`），挂载后及每次 store change 异步调 `store.storageEstimate()`（1s 节流，失败忽略）；`usage/quota` 都可用时显示「已用/可用」。清除缓存的音乐先 `confirm(settings.storage.clearConfirmCache)`，再调 `store.clearAudioCache()`，toast `settings.storage.cacheCleared`；清空曲库同样 `confirm`，完成后由 app 的 toast 提示。
- 语言卡：五个 `segmented` 选项（`data-testid="language-auto|zh-CN|zh-TW|ja|en"`），点击 `store.setSetting('language', value)`；除 `auto` 外显示各语言本地名。
- 关于卡：`BUILD_VERSION`（`data-testid="about-version"`）、检查更新（`sw.checkForUpdate()`，waiting 时 `store.setUpdateReady(true)`）、更新状态行（`state.updateReady` 时给出「立即更新」→ `sw.applyUpdate()`）、重新加载与播放日志（`playlog-open`）。日志弹层 `playlog-panel`：`<pre data-testid="playlog-text">` 内容来自 `store.playLogText()`；`playlog-copy` 优先 `navigator.clipboard.writeText`，失败用隐藏 textarea + `document.execCommand('copy')`，成功后 toast `settings.about.playLogCopied`；`playlog-clear` 调 `store.clearPlayLog()` 并清空文本；`playlog-close`/Esc/遮罩关闭。
- 更新 banner 固定在底部，文案 `update.available` + `update.apply`，`data-testid="update-apply"` 保留。
- 曲目/队列行尾「⋯」（`data-testid="row-more"`）、长按 500ms、右键都打开同一菜单（一项「标签信息」）；点击后 `openTagInfo(track, { loadReport: () => store.describeTrackTags(track.id) })`。弹层 `role="dialog" aria-modal="true"`（`data-testid="tag-info-modal"`），Esc/遮罩/关闭按钮关闭；复制失败时选中 `<pre>` 文本。数据全部来自 store，UI 不读文件。
- toast 固定在底部一条，`role="status"`，3 秒后消失。

歌单视图（`state.view === 'playlists'`，`store.js` 的 `VIEWS` 白名单包含它）复用主 tab 行：`TABS` 顺序为歌曲/专辑/歌手/文件夹/歌单/队列，行右侧是 `data-testid="import-open"` 的导入按钮（`.tabs-import`，`margin-left:auto`）。`renderView` 在「无授权」「无曲目」判断之前调用 `playlistView.render(state)`，rebuild 条件额外比较 `state.playlists` 的引用；列表与详情全部来自 `state.playlists`，不自行请求。

- 列表行 `data-testid="playlist-row"`：名称、来源 chip（`playlists.source.<source>`）、代理来源旁的 `source-experimental` chip、`playlists.counts` 计数、`toLocaleString()` 创建的本地时间；行内按钮 `playlist-play`（`store.playlistTracks` → `store.playQueue`，空则 toast `playlists.emptyTracks`）、`playlist-open`、`playlist-delete`（`confirm(playlists.deleteConfirm)` → `store.deletePlaylist`）。无歌单时显示 `playlists.empty`。
- 详情 `data-testid="playlist-detail"`：标题/来源/计数 + 三栏 `result-matched|result-suspect|result-missing`（共用 `renderColumns`，行 `result-row`；suspect 行带原因 chip 与 `confirm-item`，missing 行带 `assign-select` + `assign-item`）+ 动作 `missing-copy`（复制内容去掉末尾换行）、`missing-download`（`<name>-missing.txt`，保留末尾换行）、`m3u8-write`（`store.writePlaylistM3u8`，本地来源未授权或 OneDrive 时 `disabled` 且 `title=playlists.m3u8Unsupported`）。
- 导入弹层 `role="dialog" aria-modal="true"`（`data-testid="import-dialog"`，`.import-dialog` 内层，`max-height:90vh`、`max-width:960px`）：`import-name`、`import-text`、`import-url`、列顺序 `import-order-auto|artist-title|title-artist`、`import-submit`、`import-close`、`import-error`、`import-result`。URL 非空时先按主机名走 YouTube（`resolveYouTubePlaylist`，key 取 `state.settings.youtubeApiKey`），再走 `platformOfUrl` + `resolveViaProxy`（`state.settings.playlistProxyUrl`），其余 URL 报 `playlists.error.unsupportedUrl`；URL 为空时 `parsePlaylistText` + `matchPlaylist`。未保存的 draft 由弹层闭包维护（`import-result` 内直接改 status/reasons 并重渲染）；`playlist-create` 调 `store.createPlaylist` 后关闭弹层、`store.setView('playlists')`、toast `playlists.created`。draft 的缺失清单与 `.m3u8` 走 `missingText`/`m3u8Text` 纯函数（id 用 `'draft'`）。Spotify 且 `truncated`（或 ≥100 行）时显示 `import-truncated`；代理来源在结果与列表行显示实验性 chip。
- 弹层内的 toast 与视图 toast 都通过 `CustomEvent('toast', { bubbles:true, detail:{text} })` 冒泡给 app，由 app 的 `showToast` 统一显示。

设置 → 关于卡在版本行之前新增两个输入：`setting-youtube-key`（`settings.about.youtubeKey` / hint `settings.about.youtubeKeyHint`）与 `setting-proxy-url`（`settings.about.proxyUrl` / hint `settings.about.proxyUrlHint`）。`change` 时调 `store.setSetting('youtubeApiKey'|'playlistProxyUrl', value.trim())`，值落库后 toast `settings.about.saved`；无校验弹窗（store 清洗非法值）。`render(state)` 只在输入框未聚焦时回填，避免 4 Hz 播放更新覆盖正在输入的文本。

语言切换即时生效：`render(state)` 开头比较 `resolveLanguage(state.settings.language, navigator.languages)` 与 `getLocale()`，不同则 `setLocale()` + `applyDocumentLang()` + 用 `createShell` 重建整个壳（重新绑定进度条事件、`root.replaceChildren(ui.app)`、清空视图缓存后重渲染）。**不得用 `location.reload()` 切换语言**；`store` 的 `change` 监听只绑一次。

UI 不得直接访问 IndexedDB、`<audio>`、File System Access 或 `navigator.mediaSession`；全部经 Store。

视图：歌曲 / 专辑 / 歌手 / 文件夹 / 歌单 / 队列 / 歌词（全屏）/ 设置（全屏）。设置区不再有唱片旋转开关；来源、存储、播放、语言、关于都在设置视图。文件夹视图整行点击 = 以该目录曲目替换队列并播放；行尾「加入队列」= 追加到队列末尾；行尾固定按钮（`data-testid="pin-<dir|root>"`）= 对该目录出现过的每个 `track.source` 调 `store.pinFolder`，已全部固定时改为 `unpinFolder`。固定运行中按钮禁用并显示 `settings.storage.pinning`（跨来源求和 `done/total`），完成后显示 `settings.storage.pinned`；状态由 `store.isPinned` + `state.pins` 决定，`aria-pressed` + `.is-on` 表达开关。

歌曲视图顶部（仅 `state.view === 'tracks'` 且库非空）是搜索与自动列表：搜索框 `data-testid="search-input"`（`aria-label`=`search.label`，`placeholder`=`search.placeholder`），输入 150 ms 防抖后调 `runSearch(当前列表, 查询)`；`Escape` 或非空时出现的 `search-clear` 清空。`auto-lists` 容器内是 `auto-list-all|recent|most|never` 四个 `segment` 按钮（`aria-pressed` + `.is-active`），把列表来源切到 `state.tracks` / `recentlyAdded(tracks, stats, 50)` / `mostPlayed(...)` / `neverPlayed(...)`。查询非空时按分组渲染结果：每组一个 `search-group-title|artist|album|fileName` 标题与命中行，计数行 `search-count` 用 `search.results`（`{count}` = `total`），无命中 `search-empty`，自动列表为空 `auto-list-empty`；搜索在所选列表内进行。查询与选中列表是 `mountUi` 闭包里的局部变量，语言切换重建壳后重置；输入框与 chips 只在 tracks 视图重建，行区域每次重渲染只替换 `search-results` 的内容以保住焦点。

歌词视图（`state.view === 'lyrics'`，`VIEWS` 白名单包含它，全屏、与设置同级）由播放器控制区的 `lyrics-open` 进入：`store.setView('lyrics')` + `void store.loadLyrics(state.current.track.id)`，无当前曲目时按钮 disabled。`renderView` 保证 `lyrics-view` 容器存在，`render(state)` 在歌词视图里发现 `state.current.track.id` 与 `state.lyrics.trackId` 不一致时再调一次 `store.loadLyrics`（store 同步写入 `trackId`，因此 4 Hz 位置更新不会重复请求）。头部 `lyrics-back` 回 `tracks`，标题 `lyrics.title` 加曲目标题/副标题。行容器 `lyrics-lines` 的状态优先级：`state.lyrics.loading` → `lyrics.loading` 文本；有 `lines` → 每行 `<p data-testid="lyric-line" data-time>`；无行但有 `plain` → `<pre data-testid="lyrics-plain">`；否则 `lyrics-empty`。行节点只在 `lines` 引用变化时创建一次，`activeLineIndex(lines, state.current.position)` 变化时只对两行切 `is-active`/`aria-current` 并对新当前行 `scrollIntoView({ block: 'center', behavior: 'smooth' })`，位置更新不重建列表，也不滚动非当前行。

设置视图新增播放卡（`settings-section-playback`，位于存储卡与语言卡之间，只创建一次）：标题/说明 `settings.playback.title|hint`；睡眠定时分段按钮 `sleep-off|sleep-15|sleep-30|sleep-45|sleep-60|sleep-end` 点击 `store.setSleepMode(value)`，`aria-pressed` + `.is-active` 反映 `state.sleep.mode`；分钟模式且有 `remaining` 时 `sleep-remaining` 显示 `settings.playback.sleepRemaining`（`{time}` 为 `formatTime(remaining/1000)`），`state.sleep.fading` 时改为 `settings.playback.sleepFading`；`setting-leveling` / `setting-gapless` 是 `btn-pill ghost toggle` 开关（`aria-pressed` + `.is-on`），点击 `store.setSetting(key, !当前值)`，旁边 `.hint` 用 `settings.playback.levelingHint|gaplessHint`。`render(state)` 只改文本、属性和 `hidden`。

data-testid 约定：搜索/自动列表用 `search-*` / `auto-list-*` / `search-group-*`；歌词用 `lyrics-open|lyrics-back|lyrics-view|lyrics-lines|lyric-line|lyrics-plain|lyrics-empty`；播放设置用 `settings-section-playback` / `sleep-*` / `sleep-remaining` / `setting-leveling|setting-gapless`。

## 构建与 SW

- `scripts/build.mjs`：清输出目录（默认 `dist/`，`--out <dir>` 可指定，所有产物路径都基于它，e2e 用它生成 v1/v2 两份构建）；esbuild 打包 `src/main.js`（ESM、minify、target es2022）与 `src/styles.css`，输出 `<out>/assets/<name>-<hash>.js|css`；JS 构建开 `splitting: true`（`charset: 'utf8'`），入口为 `main` 与 `t2s-table`，`match.js` 的繁简表通过 `import()` 懒加载为独立 chunk，不进首屏包；读 `src/index.html` 用 `__CSS__`/`__JS__` 替换；复制 `src/manifest.webmanifest`、`src/icons/*`、`src/.well-known/*`；用 `src/sw.template.js` 生成 `<out>/sw.js`（`__VERSION__` = 构建版本，`__PRECACHE__` = 全部产物相对 URL 的 JSON 数组，含 chunk）。
- 构建版本：`sha256`（`src/` 下所有文件按相对路径排序后逐个 update 路径与内容，再 update `process.env.BUILD_LABEL ?? ''`）取前 10 位 hex。只改一个 src 里的字符串版本就变；同一份源码 + 同一标签结果确定。该值同时注入 esbuild 的 `define: { __BUILD_VERSION__ }`（JS/CSS 两次构建都传，供源码引用）与 `sw.js` 的 `__VERSION__`（SW 在运行时即持有构建号，并用于缓存名）。
- `scripts/size.mjs`：只统计 `dist/index.html` 里实际引用的 `<script src>`（首屏入口；其静态 import 链已被 esbuild 内联），gzip（`zlib.gzipSync`，level 9）后与总计；未被 HTML 引用的 `dist/assets/*.js`（懒加载 chunk）单独打印 `chunk:` 行，不计入 total。上限 `LIMIT = 102400`（100 KB gzip，APP-001-H：i18n 表 + 设置项把首屏预算从 80 KB 提高），超出退出码 1。
- SW 策略：install 预缓存壳；activate 清旧版本缓存并 `clients.claim()`；导航请求 network-first → 失败回退缓存 `index.html`；`sw.js` 自身 network-first；`/assets/` cache-first；`manifest.webmanifest` network-first 回退缓存。`sw.js` 的 message 处理器只认 `SKIP_WAITING` → `self.skipWaiting()`。
- 更新流程（`src/pwa.js`，状态机 `createUpdateFlow` 无 DOM，可单测）：新 worker 装好后仍是 waiting，页面收到 `update-ready`（或 `updatefound` → `installed`）显示 banner；点「更新」调 `applyUpdate()`，它把 `SKIP_WAITING` 发给 `registration.waiting` 并在 `sessionStorage` 写入 `localtune:reloading`；waiting worker 激活触发 `controllerchange`，只有存在该标记时才删除标记并 `location.reload()` 一次。没有 waiting worker 时 `applyUpdate()` 返回 false、不 reload，因此不会退回「刷新 → 又是旧 SW → 再刷新」的死循环。
- 注册 URL 固定 `./sw.js`，不带查询串（`controller.scriptURL` 的 `search` 为空）。
- e2e 由 `scripts/serve.mjs`（Node 内置 http，静态服务 `dist/`，端口 4173）提供页面；`playwright.config.js` 的 `webServer` 指向它。`e2e/update.spec.js` 自带 `e2e/support/static-server.js`（root 可运行时切换），用两份构建复现真实更新。

## 部署契约（W2）

- `Dockerfile`：多阶段，`node:22-alpine` build → `nginx:stable-alpine`；非 root（`USER nginx`，uid 101）；8080；`/healthz` 200；`nginx.conf` 中 `/assets/` immutable，`/index.html`、`/sw.js`、`/manifest.webmanifest` no-cache（且 manifest 为 `application/manifest+json`），其余 `try_files $uri $uri/ /index.html`。
- CI：push 任意分支 → amd64 load + curl 冒烟（`/healthz`、`/`、`/manifest.webmanifest`、`/sw.js`；`sw.js` 头含 `no-cache`；一个 `/assets/*.js` 含 `immutable`）；非 PR 推 `linux/amd64,linux/arm64` 到 `ghcr.io/sentimentalk/localtune`，tag `sha-<short>` 与分支名，main 更新 `latest`。

AD
AD
### search 模块（APP-001-F1）

- `normalizeQuery(value)`：直接返回 `normalizeText(value)`；非字符串或空串返回 `''`。
- `searchGroup(track, query)`：对 `title`、`artist`、`album`、文件名（`track.path` 的 basename，保留扩展名）逐个规范化后做子串匹配，按 title → artist → album → fileName 返回首个命中的分组，全不命中返回 `null`。
- `searchTracks(tracks, query, { limit = 200 } = {})`：同步搜索，返回 `{ items: [{ track, group }], counts: { title, artist, album, fileName }, total }`；`items` 先按分组优先级、组内按输入顺序排列并截断到 `limit`，`total` 与 `counts` 统计全部命中（不受 `limit` 影响）；query 规范化后为空时返回空结果。
- `runSearch(tracks, query, options = {})`：先 `await ensureNormalizer()` 再调用 `searchTracks`；繁简表加载失败时返回空结果，不向 UI 抛错。
- 规范化规则：`title`/`album`/文件名走 `normalizeText`（NFKC、全角转半角、繁→简、小写、去版本标签）；`artist` 走 `splitArtists(track.artist).join(' ')`，保留 feat 合作者以便按合作者搜索；模块顶层只静态导入 `./playlist/match.js`，繁简表仍由其内部 `import()` 懒加载。

### stats 与自动列表（APP-001-F1）

`src/core/stats.js` 全是纯函数（不碰 DOM/IDB，不取时钟），store 与 UI 各自接线。`stats` store 的 row 结构：

```js
{ id: string, plays: number, lastPlayedAt: number|null, addedAt: number }
```

`plays` 为累计播放次数；`lastPlayedAt` 是最近一次计数的时间戳，从未播放为 `null`；`addedAt` 首次入库时写入（`mtime`，缺失时退化为当前时间），之后不再变。`applyPlay(stats, { id, now })` 返回新 map（不改入参），`ensureAdded(stats, tracks, …)` 为没有行的曲目补零行并返回新增的 id。

计数规则：一次播放会话（`createPlayCounter()` 的 `start` → 计数 → `pause`/结束）在听到 `min(30 s, duration / 2)` 后计一次，duration 未知按 30 s。`update(position)` 只累计 `0 < delta ≤ 5` 的正向增量，更大的跳跃视为 seek 不计时；`pause`/`resume` 保留已听时长，同一次会话只返回一次 `{ justCounted: true }`。

三个选择器都返回 `Track[]`，只读入参、不修改：

- `recentlyAdded`：按 `addedAt` 降序（缺行按 0），同值按 `path` 升序，取前 `limit`（默认 50）。
- `mostPlayed`：只保留 `plays > 0`，按 `plays` 降序、`lastPlayedAt` 降序（`null` 按 0）、`path` 升序，取前 `limit`（默认 50）。
- `neverPlayed`：`plays` 为 0 或没有行，按 `path` 升序，无上限。
### 播放扩展（APP-001-F2）

- 睡眠定时状态机（`src/core/sleepTimer.js`，纯逻辑，时钟与 `setInterval`/`clearInterval` 全部注入）：`SLEEP_MODES = ['off','15','30','45','60','end']`，`sleepMinutes(mode)` 只对分钟模式返回 `15|30|45|60`。`set(mode)` 非法值按 `'off'`（等价 `cancel()`）；分钟模式 `endsAt = now() + 分钟 * 60000`，每个 `intervalMs`（默认 1000 ms）tick 一次并立即 `onTick(state())`；剩余 `0 < remaining <= fadeMs`（默认 5000 ms）时 `fading = true` 并以 `remaining / fadeMs`（1→0 线性）调 `onFade`；归零时清 interval、复位 `'off'`、`fading = false`，并只调一次 `onStop`。`'end'` 不排 interval，由 `fireEnd()` 在队列结束时调 `onStop`（只生效一次）。`cancel()` 清 interval 但不调 `onStop`；`destroy()` 之后所有动作（含已排的 tick）无效。`state()` → `{ mode, endsAt, remaining, fading }`，`off`/`end` 的 `remaining` 为 `null`。
- 增益解析（`src/core/gain.js`）：`parseGainDb` 只接受 `-7.25 dB` / `+3.0 dB` / `-7.25` / `7.2 db` 这类单个数值（可带 `dB` 后缀），夹到 ±24 dB，非法或空 → `null`；`gainFactor(db) = 10 ** (db / 20)` 夹到 `[0.1, 4]`，非有限数 → 1；`decideGain` 在 `enabled` 为假时返回 `reason:'off'`，缺少有限 `trackGainDb` 时 `reason:'none'`，否则 `reason:'tag'`。只认 ID3v2.3/v2.4 的 `TXXX` 帧（`REPLAYGAIN_TRACK_GAIN` / `REPLAYGAIN_TRACK_PEAK` / `REPLAYGAIN_ALBUM_GAIN`，描述大小写不敏感，压缩帧跳过）；`iTunNORM` 只解成整数数组供诊断（`parseItunNorm`，少于四个 8 位十六进制词即 `null`），**不参与增益**。
- GainNode 启用（`AudioPlayer.enableLeveling()`）：上下文优先用注入的 `createAudioContext`，否则用全局 `AudioContext`/`webkitAudioContext`，两者都没有则返回 `false`。必须先 `await ctx.resume()` 且 `ctx.state === 'running'` 才建 `createMediaElementSource → createGain → destination`；状态不是 running 时 `ctx.close()` 并返回 `false`——**绝不在不可运行的上下文里建图**，否则元素被路由后静音（iOS 上 `resume()` 需要用户手势）。重复调用只 `resume()` 并返回 `true`；任何异常都返回 `false`，不抛。`setGain(db)` 在图未建时只记住数值，`levelingReady` 报告图是否就绪，`disableLeveling()` 把 gain 设回 1 并保持连接（Web Audio 无法断开已接的路由）。
- `get canHandOffSynchronously()`：`true` 当且仅当元素已有 `src`，即 `playNow()` 不会因「未加载」抛错；store 据此判断能否不 `await` 直接交接下一首（避免等待丢掉用户手势）。
### lyrics 模块（APP-001-F1）

歌词数据层是纯模块，不访问 DOM/IndexedDB，也不 import 任何 adapter；来源文件统一由调用方注入的 `getFile(path)` 读取。

```js
// src/core/lyrics/lrc.js
export function parseLrc(text)
// → { offset: number, lines: Array<{ time: number, text: string }>, plain: string }

export function activeLineIndex(lines, position)
// → number：最后一个 time <= position 的下标；空数组或 position 小于首行时为 -1

export function decodeLyricsBytes(bytes)
// → string：去 UTF-8 BOM；UTF-8（fatal）失败时按 decodeLegacyText 回退；异常返回 ''

export function sidecarCandidates(path)
// → ['<dir>/<base>.lrc', '<dir>/<base>.LRC']；去掉最后一个扩展名，base 为空时返回 []
```

`parseLrc` 支持 `[m:ss]`、`[mm:ss]`、`[h:mm:ss.xx]`（毫秒 1–3 位）、一行多时间标签、`[offset:±N]`（毫秒，文件内全局生效并夹到 0）、增强格式 `<m:ss.xx>` 剥离；`[ar|ti|al|by|offset|length|re|ve|tool:]` 不产生歌词行。结果按时间升序稳定排序；没有任何带时间的行时，所有非空、非元数据行以 `\n` 拼进 `plain`，否则 `plain` 为 `''`。

```js
// src/core/lyrics/embedded.js
export async function readEmbeddedLyrics(file)
// → { synced: Array<{ time: number, text: string }>, plain: string }
// 仅按文件名扩展名处理 mp3/m4a；其余扩展名或任何解析异常返回空结果
```

mp3 直接读 ID3v2 头与不超过 4 MiB 的 tag，遍历 v2.3（uint32 帧长）/v2.4（syncsafe 帧长）帧，跳过 compressed 帧：`USLT` 进 `plain`（多帧按出现顺序以 `\n` 拼接），`SYLT` 时间格式 2（毫秒）进 `synced` 并按时间排序，格式 1 整帧忽略。m4a 沿 `moov → udta → meta（跳过 4 字节 version/flags）→ ilst → ©lyr → data` 取 UTF-8 文本进 `plain`。

```js
// src/core/lyrics/index.js
export async function resolveLyrics({ track, getFile, readEmbedded = readEmbeddedLyrics })
// → { source: 'lrc'|'lrc-plain'|'sylt'|'uslt'|'lyr'|'none',
//     lines: Array<{ time: number, text: string }>, plain: string }
```

优先级：同目录 `.lrc` > `.LRC` > 内嵌 SYLT > 内嵌 USLT（mp3）/©lyr（m4a）。sidecar 依次经 `getFile` → `decodeLyricsBytes` → `parseLrc`，有行返回 `lrc`，否则有 `plain` 返回 `lrc-plain`；sidecar 全部缺失/为空/失败后对 `track.path` 调用一次 `getFile` 交给 `readEmbedded`，有 `synced` 返回 `sylt`，否则按扩展名返回 `uslt` 或 `lyr`；全失败返回 `none`。OPFS 导入保留 `.lrc` sidecar（扩展名大小写不敏感），但 `scan()` 仍只产出音频。
