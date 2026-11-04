# playlist-resolver

LocalTune 的播放列表解析 Worker。Spotify、网易云音乐、QQ 音乐都不返回 CORS 头（QQ 还强制要求 `Referer: https://y.qq.com/`），浏览器无法直连，所以由这个 Worker 在服务端抓取，把文字元数据归一化后回给 App。YouTube 不走这里（前端用用户自己的 Data API key 直连）。

## 部署

```sh
cd workers/playlist-resolver
npx wrangler deploy
```

无需任何密钥或环境变量。部署完成后把自定义域（或 `https://playlist-resolver.<account>.workers.dev`）填到 App 的 **设置 → 关于 → 播放列表代理 URL**。

本地验证：

```sh
node --test test/*.test.js     # 全部注入 fetch，不联网
npx wrangler dev               # 本地起 Worker 手测
```

## 支持的平台

| 平台 | 来源 | 稳定性 |
|---|---|---|
| Spotify | `open.spotify.com/embed/playlist/<id>` 页内 `__NEXT_DATA__` 的 `trackList` | 不稳定：Next.js 内部载荷，字段随时可能变 |
| 网易云 | `music.163.com/api/playlist/detail?id=` 旧接口，一次返回全量 `result.tracks` | 不稳定：未文档化私有接口，已观察到 `result`/`playlist`、`artists`/`ar` 两套字段漂移 |
| QQ 音乐 | `c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg` | 不稳定：未文档化老接口，可能随时下线 |

实测依据见根仓库 `docs/research/playlist-sources.md`。

平台差异已在本目录归一化：

- **时长**：统一为毫秒。Spotify / 网易云本来就是毫秒，QQ 的 `interval` 是秒，乘 1000。
- **歌手**：Spotify 的 `subtitle` 是 `",\xa0"` 拼接的字符串，按逗号拆分并去掉 NBSP；网易云 `artists[].name`、QQ `singer[].name` 用 `, ` 连接。
- **封面**：网易云 `album.picUrl` 常是 `http://`，统一升级成 `https://`；QQ 用 `albummid` 拼 `https://y.gtimg.cn/music/photo_new/T002R300x300M000<albummid>.jpg`。
- **QQ 必须由服务端注入 `Referer: https://y.qq.com/`**：浏览器改不了这个 forbidden header，缺失时上游返回 `code 0 / subcode 1`（`invalid referer`）。Worker 只认 `code === 0 && subcode === 0`。
- **Spotify 100 条上限**：embed payload 没有总曲目数字段，实测多个歌单都恰好 100 条，推断存在硬上限。`trackList.length >= 100` 时响应带 `truncated: true`，UI 需要提示"可能只解析了前 100 首"。

## 免费层

- Workers Free：**100,000 请求/天**，每次调用 **10 ms CPU**。本 Worker 只做一次上游 fetch 与 JSON 解析，通常远低于该额度。
- Cache API 命中不消耗主要 CPU 开销：成功结果按「平台 + id」缓存 10 分钟（`cache-control: public, max-age=600`）。
- 限流是**单 isolate 内存计数**（滑动窗口 60 秒 30 次），多 isolate 下只是近似值，不是全局限流。

## 隐私与安全

- 只传歌单文字元数据（歌名 / 歌手 / 时长 / 封面 URL），不传音频，不生成播放地址；Spotify 的 `audioPreview` 字段被显式丢弃。
- 不登录、不使用 cookie，也不转发请求里的 `cookie` / `authorization`。
- **不记录、不持久化请求 URL 内容**：只 `console.log({ count, status, ms })`，日志里没有歌单 URL、歌名或歌手。
- 只允许 `https`，只允许 fetch 白名单内的平台 host（`open.spotify.com`、`music.163.com`、`c.y.qq.com`、`u.y.qq.com`、`y.qq.com`、`i.y.qq.com`）；跟随重定向后再检查最终 hostname，否则返回 502。
- CORS 只允许 `https://tune.mainstayx.com` 与 `http://localhost:4173` 两个来源；新增来源需要改 `src/index.js` 的 `ALLOWED_ORIGINS`。

## 接口

- `GET /healthz` → `{ "ok": true }`
- `GET /resolve?url=<公开歌单 URL>` → `{ source, name, items: [{ title, artist, durationMs, coverUrl }], truncated }`
  - 400 `unsupported`：缺少 `url` 或不是受支持的平台 URL
  - 403 `origin_not_allowed`：`Origin` 不在白名单
  - 429 `rate_limited`：超过限流（带 `retry-after: 60`）
  - 502 `upstream_failed` / `upstream_changed`：上游失败或结构变化；解析出 0 条曲目时一律报错，不返回空歌单冒充成功。
