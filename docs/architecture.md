# LocalTune v1 架构与模块契约

本文件是 v1（W1 应用）的实现契约。Worker 之间的并行由这里的签名和状态结构约束，任何偏差都要先在 Ticket 里改本文件。

## 约束

- 纯静态产物：`dist/` 只有静态文件；运行时不访问第三方域（系统字体栈，无 CDN、无分析、无 API）。
- 无框架运行时；首屏 JS gzip 总计 ≤ 80 KB（`npm run size` 强制）。
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
 * @property {string} artist        // 解析失败用 '未知歌手'
 * @property {string} album         // 解析失败用 '未知专辑'
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
- `meta`：keyPath `key`；键 `dirHandle`、`lastScan`（`{at:number, added:number, updated:number, removed:number}`）、`playback`、`settings`。

## 模块契约

### `src/core/source.js` — 文件来源 adapter

v1 唯一实现是 File System Access；调用方只依赖接口，不依赖 `showDirectoryPicker`。

```js
/** @typedef {Object} SourceEntry
 * @property {string} path   // 相对根的 POSIX 路径
 * @property {File} file
 * @property {number} mtime
 * @property {number} size
 */

export const AUDIO_EXTENSIONS = new Set(['mp3','m4a','flac','ogg','oga','wav','webm']);

export class FsaSource {
  kind = 'fsa';
  name = '';                       // 根目录名，未连接为空串
  async connect()                  // showDirectoryPicker({mode:'read'})，句柄写进 meta.dirHandle
  async restore()                  // 读句柄并 queryPermission；不再弹窗
  permission()                     // 'granted' | 'prompt' | 'denied' | 'none'
  async ensurePermission()         // 'prompt' 时 requestPermission，返回 boolean
  async *scan()                    // 递归产出 SourceEntry；跳过隐藏目录；按扩展名过滤
  async getFile(path)              // 由缓存句柄按路径段取 File；找不到抛错
}
```

iOS / 未来来源只需实现同一组方法（`connect/restore/permission/ensurePermission/scan/getFile`），`store` 不改。

### `src/core/metadata/{index,id3,mp4}.js`

```js
export async function readMetadata(file) // 读文件头（ID3 全标签，MP4 至 moov），返回 PartialMeta
/** @typedef {{title?:string,artist?:string,album?:string,year?:number|null,trackNo?:number|null,duration?:number,cover?:Blob|null}} PartialMeta */
export function parseId3(bytes)   // Uint8Array → PartialMeta（ID3v2.3/2.4：TIT2 TPE1 TALB TYER/TDRC TRCK APIC；时长由首个 MPEG 帧 + Xing/Info 或比特率估算）
export function parseMp4(bytes)   // Uint8Array → PartialMeta（mvhd 时长；ilst：©nam ©ART ©alb ©day trkn covr）
```

`readMetadata` 只读取必要字节（ID3 按 tag size 截取；MP4 只读到 `moov` 结束），不整文件读入。解析异常一律吞掉并返回 `{}`，由调用方回退文件名。

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
export async function loadSettings(db)   // {vinylSpin:boolean}
export async function saveSettings(db, settings)
```

### `src/core/mediaSession.js`

```js
export function installMediaSession(store)   // 绑定 play/pause/previoustrack/nexttrack/seekto/seekforward/seekbackward
export function syncMediaSession(state)      // metadata + playbackState + positionState（duration>0 才设）
```

### `src/core/store.js` — app 状态与动作（UI 唯一入口）

```js
export async function createApp()  // → Store（已 init）
export class Store extends EventTarget {
  get state()                      // 只读快照，见下
  async connectSource()            // 首次授权 / 重新授权
  async rescan()                   // 扫描 + diff + 元数据 + 写库 + 刷新 state
  setView(view)                    // 'tracks'|'albums'|'artists'|'queue'
  async playTrack(trackId)         // 以全部歌曲为队列，从该曲开始
  async playQueue(tracks, startId) // 以给定列表为队列
  toggle()                         // 播放/暂停
  async next(); async prev()
  async seek(seconds)
  setVolume(v)
  toggleShuffle(); cycleRepeat()
  setSetting(key, value)           // 'vinylSpin'
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
  view: 'tracks',
  tracks: Track[],
  queue: { tracks: Track[], index: number, shuffle: boolean, repeat: 'off'|'all'|'one' },
  current: { track: Track|null, playing: boolean, position: 0, duration: 0, volume: 1 },
  source: { kind:'fsa', connected: false, permission:'none'|'granted'|'prompt'|'denied',
            name: '', error: null, scanning: false, progress: { done: 0, total: 0 } },
  settings: { vinylSpin: boolean },
  updateReady: false
}
```

### `src/core/selectors.js`

```js
export function groupByAlbum(tracks)   // [{name, artist, year, cover, tracks}]，按 album+artist 聚合，曲目按 trackNo
export function groupByArtist(tracks)  // [{name, cover, tracks}]
export function formatTime(seconds)    // 'm:ss'
```

### UI（`src/ui/`）

```js
// src/main.js
import { createApp } from './core/store.js';
import { mountUi } from './ui/app.js';
const store = await createApp();
mountUi(document.getElementById('app'), store);

// src/ui/app.js
export function mountUi(root, store)  // 首次渲染 + store.on('change') 重渲染
```

UI 不得直接访问 IndexedDB、`<audio>`、File System Access 或 `navigator.mediaSession`；全部经 Store。

## 构建与 SW

- `scripts/build.mjs`：清 `dist/`；esbuild 打包 `src/main.js`（ESM、minify、target es2022）与 `src/styles.css`，输出 `dist/assets/<name>-<hash>.js|css`；读 `src/index.html` 用 `__CSS__`/`__JS__` 替换；复制 `src/manifest.webmanifest`、`src/icons/*`；用 `src/sw.template.js` 生成 `dist/sw.js`（`__VERSION__` = 本次构建哈希，`__PRECACHE__` = 全部产物相对 URL 的 JSON 数组）。
- `scripts/size.mjs`：gzip（`zlib.gzipSync`，level 9）每个 `dist/assets/*.js` 与总计；> 80 KB 退出码 1。
- SW 策略：install 预缓存壳；activate 清旧版本缓存；导航请求 network-first → 失败回退缓存 `index.html`；`sw.js` 自身 network-first；`/assets/` cache-first；`manifest.webmanifest` network-first 回退缓存。检测到新版本时 `postMessage({type:'update-ready'})`，UI 显示“有新版本，刷新”。
- `index.html` 引用：`./manifest.webmanifest`、`./sw.js` 由 `main.js` 注册（`navigator.serviceWorker.register('./sw.js')`）。
- e2e 由 `scripts/serve.mjs`（Node 内置 http，静态服务 `dist/`，端口 4173）提供页面；`playwright.config.js` 的 `webServer` 指向它。

## 部署契约（W2）

- `Dockerfile`：多阶段，`node:22-alpine` build → `nginx:stable-alpine`；非 root（`USER nginx`，uid 101）；8080；`/healthz` 200；`nginx.conf` 中 `/assets/` immutable，`/index.html`、`/sw.js`、`/manifest.webmanifest` no-cache（且 manifest 为 `application/manifest+json`），其余 `try_files $uri $uri/ /index.html`。
- CI：push 任意分支 → amd64 load + curl 冒烟（`/healthz`、`/`、`/manifest.webmanifest`、`/sw.js`；`sw.js` 头含 `no-cache`；一个 `/assets/*.js` 含 `immutable`）；非 PR 推 `linux/amd64,linux/arm64` 到 `ghcr.io/sentimentalk/localtune`，tag `sha-<short>` 与分支名，main 更新 `latest`。
