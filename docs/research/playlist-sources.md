# 歌单来源可行性（2026-11-04）

- 调研时间: 2026-11-04，本机出网正常（`curl -sI https://open.spotify.com` → `HTTP/2 200`）。
- 方法: 全部匿名 `curl`，无登录、无 cookie、无付费 key；官方文档另用 `curl -sL` 取原文核对。
- 标注约定: **实测** = 本次 `curl` 观察到的原始响应；**文档** = 官方文档明文；**推断** = 实测 + 文档组合得出，未直接验证。
- 只读调研：除本文件外未修改任何源码/测试/配置；原始响应存 `/tmp/plr`，未提交。
- 每个平台只回答一件事：**无登录、无付费 key 时能否拿到 歌手 / 歌名 / 时长 / 封面**。

## 结论

| 平台 | 解析方式 | 浏览器直连 | 需代理 | 结论 |
|---|---|---|---|---|
| YouTube | Data API v3 `playlistItems.list` + `videos.list`，**必须用户自备免费 API key** | 可以（回 `access-control-allow-origin`，含错误响应） | 不需要（仅为隐藏 key 时可加） | 稳定 |
| Spotify | 抓 `open.spotify.com/embed/playlist/{id}` 页内 `__NEXT_DATA__` 的 `trackList` | 不可以（无 CORS 头） | 需要 | 不稳定 |
| 网易云 | `GET music.163.com/api/playlist/detail?id=` 旧版接口，返回 `result.tracks` 全量 | 不可以（无 CORS 头） | 需要 | 不稳定 |
| QQ 音乐 | `c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg`（或 `u.y.qq.com/cgi-bin/musicu.fcg`），**必须伪造 `Referer: https://y.qq.com/`** | 不可以（无 CORS 头） | 需要（且须注入 `Referer`） | 不稳定 |

一句话：**四个平台都能在无登录下拿到文字元数据，但只有 YouTube 是文档化接口且有 CORS；其余三个都得走 Worker 代理，且都是未文档化的私有/内部接口。**

---

## YouTube

### 实测

匿名请求（无 key，**实测**）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI&maxResults=1'
# 403
```

响应体（节选，逐字）：

```json
{
  "error": {
    "code": 403,
    "message": "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.",
    "errors": [
      {
        "message": "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.",
        "domain": "global",
        "reason": "forbidden"
      }
    ],
    "status": "PERMISSION_DENIED"
  }
}
```

加空 key（`&key=`，**实测**）：HTTP **403**，body 与上例**完全一致**，`error.errors[0].reason` 仍是 `forbidden` —— 空 `key=` 被当作"未提供"，不会走到 key 校验分支。

加伪造 key（`&key=NOT_A_REAL_KEY`，**实测**）：HTTP **400**，`error.errors[0].reason = "badRequest"`，`error.status = "INVALID_ARGUMENT"`，`details[0].reason = "API_KEY_INVALID"`：

```json
{ "error": { "code": 400, "message": "API key not valid. Please pass a valid API key.",
  "errors": [ { "reason": "badRequest", "domain": "global" } ],
  "status": "INVALID_ARGUMENT",
  "details": [ { "reason": "API_KEY_INVALID", "domain": "googleapis.com" } ] } }
```

CORS（**实测**，带 `Origin` 的实际 GET，即使 403 也回 CORS 头）：

```http
HTTP/2 403
access-control-allow-origin: https://app.example
access-control-expose-headers: vary,vary,vary,content-encoding,date,server,content-length
```

预检（**实测**）：

```http
HTTP/2 200
access-control-allow-origin: https://app.example
access-control-allow-methods: DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT
access-control-max-age: 3600
```

### 结论

- **匿名不可行**（**实测**）：无 key 一律 403 `forbidden`，`key=` 空值同样 403；必须用户自备 API key。key 免费（Google Cloud 项目启用 YouTube Data API v3 即可），不涉及付费。
- **浏览器可直连**（**实测**）：`access-control-allow-origin` 反射请求的 `Origin`，且 403/400 错误响应也带该头，前端能读到 `error.errors[0].reason` 做提示。走代理的唯一理由是**隐藏 key**，不是 CORS。
- 配额（**文档**，<https://developers.google.com/youtube/v3/determine_quota_cost>）：
  - `playlistItems.list` = **1 unit**；`videos.list` = **1 unit**（同页表格逐行核对）。
  - 默认额度：**10,000 units/天**（另有 `search.list` 100 次/天、`videos.insert` 100 次/天的单独额度）；"All API requests, including invalid requests, incur a quota cost of at least one point"，**每日太平洋时间午夜重置**。
  - 成本换算（**推断**）：一个 50 曲歌单 = 1 次 `playlistItems.list`（拿 `videoId`）+ 1 次 `videos.list`（拿时长）≈ 2 units ⇒ 每日约 5,000 个 50 曲歌单，个人 key 足够。
- `playlistItems.list` 的 `maxResults` 取值 **0–50，默认 5**（**文档**，<https://developers.google.com/youtube/v3/docs/playlistItems/list#parameters>）⇒ 长歌单必须按 `nextPageToken` 翻页。
- `contentDetails.duration` **是 ISO 8601 时长**（**文档**，<https://developers.google.com/youtube/v3/docs/videos>）："The property value is an ISO 8601 duration… format is `PT#M#S`… `P#DT#H#M#S`"。它只在 `videos.list` 的 `contentDetails` 里，**不在** `playlistItems` 里 ⇒ 必须两段请求。
- `videoOwnerChannelTitle` **在 `playlistItems` 的 `snippet` 中**（**文档**，<https://developers.google.com/youtube/v3/docs/playlistItems>，`snippet` 资源字段表同时列 `channelTitle`、`videoOwnerChannelTitle`、`videoOwnerChannelId`）。注意它表示"该视频所属频道的名字"，不是歌手 ⇒ 只能当"上传者"，不能当艺人字段用。
- **不做**：抓 `youtube.com/playlist?list=` 网页 HTML 反解 `ytInitialData`。无文档、随版本失效、且要处理同意页/地区跳转；API 已能覆盖需求，没有理由走 HTML。

---

## Spotify

### 实测

embed 页（**实测**）：

```bash
curl -sL -w '\nstatus=%{http_code} size=%{size_download}\n' \
  'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M'
# status=200 size=84568
```

页内存在 `<script id="__NEXT_DATA__" type="application/json">`（24,776 字节），曲目在 `props.pageProps.state.data.entity.trackList`。首曲与结构（**实测**，字段值逐字）：

```json
{
  "name": "Today’s Top Hits",
  "duration": 0,
  "coverArt": { "sources": [ { "url": "https://i.scdn.co/image/ab67706f00000002960019ea66cba66a44fdd4c2" } ] },
  "trackList": [
    { "uri": "spotify:track:7bxaFZ1O3cHkgLKMsdC3xR",
      "title": "Loser", "subtitle": "Tame Impala",
      "duration": 223069, "isExplicit": true,
      "audioPreview": { "format": "MP3_96", "url": "https://p.scdn.co/mp3-preview/0015e934..." },
      "entityType": "track" }
  ]
}
```

- 曲目条数：该歌单 **50** 条；`trackList[0].title = "Loser"`，`[-1].title = "SWIM"`。
- **带时长**：`trackList[].duration`，单位**毫秒**（223069 ≈ 3:43）。
- 歌手在 `subtitle`，是**拼接字符串**，多名用 `",\xa0"`（逗号 + NBSP）分隔，例：`"KAROL G,\xa0Judeline,\xa0rusowsky"` ⇒ 需要自己 split。
- `entity.duration = 0`：**歌单总时长不提供**。
- 封面在 `entity.coverArt.sources[0].url`（`i.scdn.co`），另有 `visualIdentity.image[1].url`（300×300）。

另外两个歌单（**实测**）：`37i9dQZF1DWXRqgorJj26U`（Rock Classics）→ 100 条；`37i9dQZF1DX4UtSsGT1Sbe`（All Out 80s）→ 也是 100 条。两个都恰好 100 条，**推断** embed 有 100 条硬上限，但无登录条件下无法确认这两个歌单的真实曲目数，故上限未证实；embed JSON 里也没有任何 `trackCount`/`totalTracks` 字段（**实测**，grep 计数为 0）。

回退路径（spec 要求，embed 已有时长所以只做验证）：`https://open.spotify.com/playlist/37i9dQZF1DX4UtSsGT1Sbe` → **200**，但页内**没有** `__NEXT_DATA__`，只有一个 `application/ld+json`，其 `@type` 是 `MusicGroup`（艺人对像，不是歌单）⇒ 歌单页是客户端渲染，HTML 里拿不到曲目。

CORS（**实测**）：

```http
# curl -sI 'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M' -H 'Origin: https://app.example'
HTTP/2 200
content-type: text/html; charset=utf-8
x-content-type-options: nosniff
# 无 access-control-allow-origin
```

歌单页同样无 `access-control-allow-origin`。

### 结论

- **无登录可解析**（**实测**）：只要歌单是公开的，embed 页返回 200 且内嵌完整文字元数据——歌名、歌手、毫秒时长、封面全都有，不需要 cookie、不需要 UA 伪装。
- **浏览器不可直连**（**实测**）：`open.spotify.com` 不回 CORS 头 ⇒ 前端 `fetch` 会被浏览器拦掉，**必须代理**。
- **不稳定**：`__NEXT_DATA__` 是 Next.js 内部载荷，字段名/嵌套随时可能变；且 embed 的 100 条上限未证实（**推断**），超过 100 曲的歌单可能静默截断，而 payload 里没有总数可校验 ⇒ 无法向用户报告"只解析了前 100 首"。
- 不登录就拿不到歌单总曲目数（**实测**）：embed 无 `trackCount`，歌单页无 SSR JSON。这是最大的产品风险点：**截断对用户不可见**。

---

## 网易云

### 实测

```bash
curl -s 'https://music.163.com/api/playlist/detail?id=3778678' \
  -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36' \
  -H 'Referer: https://music.163.com/'
# HTTP 200
```

响应结构（**实测**）：顶层是 `{"result": {...}, "code": 200}`，**不是** spec 预期的 `playlist` 键；`ar`/`dt`/`al` 也不存在，旧接口用的是 `artists`/`duration`/`album`。关键字段：

```json
{
  "code": 200,
  "name": "热歌榜",
  "trackCount": 200,
  "tracks_len": 200,
  "track0": {
    "name": "Hong Kong (feat. 王菲季候风)",
    "artists": [ "The Weeknd" ],
    "duration": 216993,
    "album": { "name": "Hong Kong (feat. 王菲季候风)",
               "picUrl": "http://p2.music.126.net/12-Tl1d-BT-_AwXMl7-MzQ==/109951174206326909.jpg" }
  }
}
```

- `code = 200`（HTTP 也是 200），`result.name = 热歌榜`，`result.trackCount = 200`，`result.tracks` 长度 **200**（一次全量，无翻页）。
- 单曲：`name` 歌名、`artists[].name` 歌手（数组）、`duration` **毫秒**（216993）、`album.picUrl` 封面。注意 `picUrl` 是 **`http://`**（非 https），混内容风险。

POST 变体（**实测**）：`curl -X POST 'https://music.163.com/api/playlist/detail' --data 'id=3778678'`（带 UA + Referer）→ HTTP **200**，`code 200`，`result.tracks` 仍 200 条。**与 GET 无差异**。

依赖探测（**实测**）：

| 变体 | 结果 |
|---|---|
| 去掉 `Referer` | HTTP 200，`code 200`，`name 热歌榜`，200 条 —— **不依赖 Referer** |
| 去掉浏览器 UA（`User-Agent: curl/8.0`） | HTTP 200，`code 200`，200 条 —— **不依赖 UA 伪装** |

对比 v6 接口（**实测**，`/api/v6/playlist/detail?id=3778678`）：HTTP 200，`code 200`，`playlist.trackCount = 200` 但 `playlist.tracks` 只有 **10** 条，字段是 spec 预期的 `ar`/`dt`/`al`：

```json
{ "name": "Hong Kong (feat. 王菲季候风)",
  "ar": [ { "name": "The Weeknd" } ],
  "dt": 216993,
  "al": { "picUrl": "http://p1.music.126.net/12-Tl1d-BT-_AwXMl7-MzQ==/109951174206326909.jpg" } }
```

⇒ v6 只回前 10 条，要全量得再拿 `trackIds` 逐个查；旧 `/api/playlist/detail` 一次给全，实现应选旧接口。

CORS（**实测**）：`GET` 带 `Origin` → HTTP 200，响应头只有 `content-type: application/json;charset=UTF-8`，**无 `access-control-allow-origin`**；`OPTIONS` 预检 → HTTP 200 但同样无任何 `access-control-*` 头。

### 结论

- **无登录可解析**（**实测**）：旧接口一次返回 200 曲全量元数据，歌名/歌手数组/毫秒时长/封面齐全，且不校验 `Referer`、不校验 UA —— 代理实现最省事的一个。
- **浏览器不可直连**（**实测**）：无 CORS 头，预检也不放行 ⇒ 必须代理。
- **不稳定**：未文档化私有接口。三处已观察到的漂移：键名 `result` vs `playlist`、字段 `artists/duration/album` vs `ar/dt/al`、v6 只回 10 条。上游随时可能加签名（`weapi` 的 `csrf`/`encSecKey` 那套）或直接下线旧接口。
- 未测：`trackCount > 200` 的歌单是否也一次全量（本机只测了 200 曲的榜单）。

---

## QQ 音乐

### 实测

旧 fcg 接口（**实测**）：

```bash
curl -s 'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&disstid=7011264342&format=json' \
  -H 'Referer: https://y.qq.com/' -H 'User-Agent: Mozilla/5.0'
# HTTP 200
```

关键字段（**实测**）：

```json
{
  "code": 0,
  "subcode": 0,
  "dissname": "温暖的今日私享",
  "songnum": 30,
  "songlist_len": 30,
  "song0": {
    "songname": "在你的世界迷路 (抒情版)",
    "singer": [ "糖晓晓" ],
    "interval": 231,
    "albummid": "000v6G9a48jTpr",
    "albumname": "在你的世界迷路"
  }
}
```

- `code = 0`（注意：QQ 用 `code 0` 表示成功，不是 200）、`cdlist[0].dissname` 歌单名、`songlist` **30** 条。
- 单曲：`songname` 歌名、`singer[].name` 歌手（数组）、`interval` 时长**秒**（231）、`albummid`（封面用 `https://y.gtimg.cn/music/photo_new/T002R300x300M000{albummid}.jpg`，**推断** URL 模板，未逐字请求验证）、`albumname`。

新版 musicu 接口（**实测**，POST JSON，`req_0` = `music.srfDissInfo.aiDissInfo` / `uniform_get_Dissinfo`，`disstid: 7011264342`，`song_num: 30`）：

```json
{ "code": 0, "req_0.code": 0,
  "title": "温暖的每日30首",
  "songlist_len": 24,
  "song0": { "name": "在你的世界迷路", "singer": [ { "name": "糖晓晓" } ],
             "interval": 231, "mid": "0013mfRK2LSm3h",
             "album": { "mid": "000v6G9a48jTpr", "name": "在你的世界迷路" } } }
```

- HTTP 200，`req_0.code = 0`，`dirinfo.title` 歌单名，`songlist` **24** 条（请求 `song_num: 30`，实际 24 —— 有过滤，数量不可信）；`dirinfo.picurl` 直接给封面 `https://y.gtimg.cn/music/photo_new/T002R500x500M000000v6G9a48jTpr.jpg`。
- 同一歌单两个接口的**名字都不一样**（`温暖的今日私享` vs `温暖的每日30首`），说明 `disstid` 到日更歌单的映射在两边不一致。

`Referer` 依赖（**实测**，去掉 `-H 'Referer: https://y.qq.com/'`）：

```json
{"code":0,"subcode":1,"msg":"invalid referer"}
```

⇒ HTTP 仍是 200、`code` 仍是 0，但 `subcode = 1`、`msg = "invalid referer"`、**没有 `cdlist`**。**必须校验 `subcode`，只看 `code` 会把失败当成功。**

CORS（**实测**）：`c.y.qq.com` 带 `Origin` 的实际 GET → HTTP 200，响应头仅 `content-type: application/json;charset=utf-8`，**无 `access-control-allow-origin`**；`u.y.qq.com` 的 POST 同样无任何 `access-control-*` 头。

### 结论

- **无登录可解析**（**实测**）：两个接口都给出歌名、歌手数组、秒级时长、专辑 mid（可拼封面），无需 cookie、无需付费 key。
- **必须伪造 `Referer: https://y.qq.com/`**（**实测**）：缺了它只回 `subcode 1 / invalid referer`。浏览器里改不了 `Referer`（是 forbidden header），⇒ **这个平台没有代理就完全走不通**。
- **浏览器不可直连**（**实测**）：无 CORS 头 ⇒ 必须代理；代理还必须由服务端注入 `Referer`。
- **不稳定**：未文档化；`code 0` 掩盖错误（必须看 `subcode`）；新旧接口返回条数与歌单名都不一致（30 vs 24）；`c.y.qq.com` 是老 qzone 接口，随时可能下线。

---

## 对实现的含义

- **YouTube**：唯一可以"前端直连"的平台，但要用户在设置里填自己的 API key（免费）。两次请求：`playlistItems.list`（`maxResults=50` + `nextPageToken` 翻页）拿 `videoId`/`title`/`videoOwnerChannelTitle`，再 `videos.list?part=contentDetails`（每次 ≤50 个 id）拿 ISO 8601 时长并解析成秒；艺人字段只能落到"频道名"，不能当歌手。配额按 2 units/50 曲估算，10,000/天足够个人使用。不做网页 HTML 抓取。
- **代理需要支持的平台**：Spotify（`open.spotify.com/embed/*`）、网易云（`music.163.com/api/playlist/detail`）、QQ（`c.y.qq.com` 或 `u.y.qq.com`）。YouTube 不需要代理，除非要隐藏 key（可选加固，不是必需）。
- **代理必须处理的差异**：
  - **时长单位**：Spotify 毫秒 / 网易云毫秒 / QQ **秒** / YouTube **ISO 8601 字符串**（`PT3M43S`、`PT1H2M3S`）⇒ 统一在代理里归一化成秒。
  - **歌手字段**：Spotify 是 `subtitle` 单字符串（`",\xa0"` 分隔，需 split）/ 网易云 `artists[].name` / QQ `singer[].name` / YouTube 无歌手（只有 `videoOwnerChannelTitle` 上传者）。
  - **封面**：Spotify `i.scdn.co`（https）/ 网易云 `album.picUrl`（**http，需升级成 https 或走代理**）/ QQ `albummid` 拼 `y.gtimg.cn` / YouTube `snippet.thumbnails`。
  - **翻页**：YouTube `nextPageToken`（50/页，配额随页数线性增长）/ Spotify embed 无翻页且**上限疑为 100 条**、payload 无总数 ⇒ 截断不可见，UI 需要提示"最多 100 首"/ 网易云一次全量 200（更大歌单未测）/ QQ 旧接口一次 30 条、新版用 `song_begin`+`song_num` 但会过滤，`songnum` 与实际条数可能不符。
  - **Referer**：只有 QQ 强制要求 `Referer: https://y.qq.com/`，且必须由代理注入；网易云实测不依赖 Referer 和 UA。
  - **错误码语义**：QQ 用 `code 0` 表成功、失败藏在 `subcode`（`1` = invalid referer）；网易云成功码是 `code 200`；YouTube 用标准 HTTP 状态 + `error.errors[].reason`（`forbidden` = 无 key，`badRequest`/`API_KEY_INVALID` = key 无效）。三者不能共用一套判定。
  - **稳定性**：除 YouTube 外全部是未文档化接口 ⇒ 代理层应把"上游结构变了"映射成明确的错误码，而不是空歌单。
