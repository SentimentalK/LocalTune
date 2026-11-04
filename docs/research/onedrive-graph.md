# 浏览器直连 Microsoft Graph / OneDrive 可行性调研

- 调研时间: 2026-11-04
- 方法: 匿名 `curl` 探测响应头（本机无 Microsoft 凭据，未做任何登录）+ 官方文档查证。
- 标注约定: **实测** = 本次 `curl` 观察到的原始头；**文档** = learn.microsoft.com 明文；**推断** = 由实测 + 文档组合得出，未直接验证。
- 只读调研，除本文件外未修改任何源码/测试/配置。

## 0. 结论摘要

1. **Graph v1.0 支持浏览器 CORS，且不需要客户端自己配**：预检返回 `access-control-allow-origin: *`，允许 `authorization` 头，`max-age: 86400`（**实测**）。
2. **浏览器不能用 `/content` 取文件**：它返回 `302`，而带 `Authorization` 的请求需要预检，预检下跳转被浏览器禁止；必须改用 `@microsoft.graph.downloadUrl`（**文档**，且微软两份文档都明文写了这条）。
3. **`@microsoft.graph.downloadUrl` 的下载主机会回 CORS 头并允许 `Range` 预检**（在 `*.files.1drv.com` 上实测到 `access-control-allow-headers` 含 `Range`、`If-Match`、`If-None-Match`）；下载 URL 无鉴权、约 1 小时失效（**实测** CORS 头 / **文档** 时效）。
4. **SPA + 个人账户 + PKCE 可行，但 `token` 端点能否跨域取决于 App 注册里 redirect URI 的 `type` 必须是 `spa`**；`token` 端点本身已回 CORS 头（**实测**），而 `authorize` 端点不回 CORS、必须整页跳转（**实测**）。
5. **最硬的两个限制**：SPA 拿到的 refresh token **24 小时**过期，必须每天做一次顶层导航静默重授权（**文档**）；`downloadUrl` 秒级~小时级失效，播放长列表必须能重新取 URL（**文档** + **推断**）。

---

## 1. Graph REST API 的浏览器 CORS

### 1.1 `/me/drive/root` 预检（实测）

```bash
curl -sS -D - -o /dev/null -X OPTIONS 'https://graph.microsoft.com/v1.0/me/drive/root' \
  -H 'Origin: https://tune.mainstayx.com' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization'
```

原始响应头（节选，逐字）：

```http
HTTP/2 200
access-control-allow-origin: *
access-control-expose-headers: ETag, Location, Preference-Applied, Content-Range, request-id, client-request-id, ReadWriteConsistencyToken, Retry-After, SdkVersion, WWW-Authenticate, DPoP-Nonce, x-ms-client-gcc-tenant, X-Planner-Operationid, x-ms-permissions-recommendations, Rate-Limit-Reason
access-control-allow-methods: DELETE, GET, OPTIONS, POST, PUT, PATCH
access-control-allow-headers: authorization
access-control-max-age: 86400
content-length: 0
```

### 1.2 `/me/drive/root` 实际 GET（无 token，实测）

```bash
curl -sS -D - -o /dev/null 'https://graph.microsoft.com/v1.0/me/drive/root' \
  -H 'Origin: https://tune.mainstayx.com'
```

```http
HTTP/2 401
content-type: application/json
access-control-allow-origin: *
access-control-expose-headers: ETag, Location, Preference-Applied, Content-Range, request-id, client-request-id, ReadWriteConsistencyToken, Retry-After, SdkVersion, WWW-Authenticate, DPoP-Nonce, x-ms-client-gcc-tenant, X-Planner-Operationid, x-ms-permissions-recommendations, Rate-Limit-Reason
www-authenticate: Bearer realm="", authorization_uri="https://login.microsoftonline.com/common/oauth2/authorize", client_id="00000003-0000-0000-c000-000000000000"
```

**要点（实测）**：

- `access-control-allow-origin: *` — 通配，不反射 `Origin`，因此**不能带 cookie 凭据**（Graph 也不需要，用 Bearer）。
- **错误响应同样带 CORS 头**，所以 401/404/429 的 JSON body 在浏览器里可读。
- `access-control-expose-headers` 里包含 `Retry-After`、`Content-Range`、`ETag`、`WWW-Authenticate` — 这三者对节流退避、分段读、条件请求都够用。
- `allow-headers: authorization` 只列了 `authorization`（未含 `content-range`、`if-match` 等）；写操作若要带额外头，预检可能被拒（本节未实测写操作预检）。

### 1.3 `children?$top=200` 预检与 GET（实测）

```bash
curl -sS -D - -o /dev/null -X OPTIONS \
  'https://graph.microsoft.com/v1.0/me/drive/root/children?$top=200' \
  -H 'Origin: https://tune.mainstayx.com' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization'
```

```http
HTTP/2 200
access-control-allow-origin: *
access-control-allow-methods: DELETE, GET, OPTIONS, POST, PUT, PATCH
access-control-allow-headers: authorization
access-control-max-age: 86400
content-length: 0
```

GET 同 `/me/drive/root`：`HTTP/2 401`、`access-control-allow-origin: *`（逐字同上，仅 `request-id` 不同）。

**结论（实测）**：带查询串的 URL 与根路径预检行为一致，`$` 前缀参数不影响 CORS。

### 1.4 文档佐证

- https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/working-with-cors — "The OneDrive API supports HTTP access control (CORS) to allow single page JavaScript applications to use the OneDrive API through the common XMLHttpRequest pattern."
- https://learn.microsoft.com/en-us/graph/api/driveitem-list-children?view=graph-rest-1.0 — 列表请求头表：`if-none-match` → "an `HTTP 304 Not Modified` response is returned."

---

## 2. `@microsoft.graph.downloadUrl`：跨域读取 + Range

### 2.1 结论

- **不能**用 `fetch` 直接打 Graph 的 `/content`：`302` + 预检 = 浏览器拒绝（**文档**，微软在 CORS 文档与 get-content 文档里都写了）。
- `@microsoft.graph.downloadUrl` 返回的 URL **无鉴权、可被浏览器直接请求**，且**下载主机会返回 CORS 头**（**实测**，见 2.2）。
- `Range: bytes=...` 语义**有文档**（206 + `Content-Range`），但**未实测** 206（拿不到真实 URL）。

### 2.2 实测：下载主机的 CORS 预检

用官方文档里出现的示例下载主机（`b0mpua-by3301.files.1drv.com`，路径必然失效，但主机级 CORS 行为可测）：

```bash
curl -sS -D - -o /dev/null -X OPTIONS 'https://b0mpua-by3301.files.1drv.com/y23vmag' \
  -H 'Origin: https://tune.mainstayx.com' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: range'
```

```http
HTTP/2 200
access-control-allow-origin: https://tune.mainstayx.com
access-control-allow-methods: GET, POST, DELETE, PATCH, PUT, HEAD, MOVE, COPY
access-control-allow-headers: Accept, Application, Authorization, Content-Range, Content-Type, If, If-Match, If-None-Match, Overwrite, Prefer, Range, Scenario, ScenarioType, SendExtendedOfficePlanInResponse, X-ClientService-ClientTag, X-HTTP-Method-Override, X-RequestStats, X-TransactionId, X-Upload-Content-Length, MS-CV, RequestFacts
access-control-expose-headers: Content-Range, ETag, Location, Preference-Applied, X-Resource-ID, X-ClientErrorCode, MS-CV, WWW-Authenticate
access-control-max-age: 2592000
```

带 `Range` 的 GET（路径无效）：

```http
HTTP/2 404
access-control-allow-origin: https://tune.mainstayx.com
access-control-expose-headers: Content-Range, ETag, Location, Preference-Applied, X-Resource-ID, X-ClientErrorCode, MS-CV, WWW-Authenticate
x-clienterrorcode: ItemDoesNotExist
```

**要点（实测）**：

- 该主机**反射 `Origin`**（不是 `*`），说明可按带凭据模式工作（实际上不需要凭据）。
- `Range`、`If-Match`、`If-None-Match`、`Content-Range` 都在预检白名单里 → 浏览器发带 `Range` 的 `fetch` **不会**被预检拦下。
- `Content-Range`、`ETag` 在 `expose-headers` 里 → JS 可读（否则 Range 响应体的 `Content-Range` 读不到）。
- 404 响应也带 CORS 头 → 错误分支可读 body。
- **未验证**：真实 URL 的 `200`/`206` 与 `Content-Range` 值；`*.sharepoint.com`（企业账户下载主机）是否有同等 CORS 配置。

### 2.3 文档原文

- https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0
  - "Returns a `302 Found` response redirecting to a preauthenticated download URL ... **Preauthenticated download URLs are valid for a limited time. Use them immediately, as they might expire within minutes.** You don't need to include an `Authorization` header when you access the download URL."
  - "To download files in a JavaScript app, you can't use the `/content` API, because this responds with a `302` redirect. A `302` redirect is explicitly prohibited when a CORS *preflight* is required, such as when providing the **Authorization** header."
  - "You must append the `Range` header to the actual `@microsoft.graph.downloadUrl` URL and not to the request for `/content`." / "The call returns an `HTTP 206 Partial Content` response ... If the range can't be generated the Range header may be ignored and an `HTTP 200` response would be returned with the full contents of the file."
- https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0
  - "`@microsoft.graph.downloadUrl` | string | A URL that can be used to download this file's content. Authentication isn't required with this URL. Read-only."
  - "The `@microsoft.graph.downloadUrl` value is a short-lived URL and can't be cached. The URL is invalidated after for a short period of time (1 hour). Removing file permissions for a user might not immediately invalidate the URL."

**矛盾点（需注意）**：两处文档给的时效不一致 —— get-content 说 "might expire within minutes"，driveItem 资源页说 "1 hour"。设计上按"分钟级"处理（更保守），并在 401/403 时无条件重取 URL。

---

## 3. 公共 SPA 客户端 + 个人账户（consumers）的 authorization code + PKCE

### 3.1 端点与必填参数（文档）

- authorize: `https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize`
- token: `https://login.microsoftonline.com/consumers/oauth2/v2.0/token`
- 来源: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow

authorize 必填：`client_id`、`response_type=code`、`redirect_uri`、`scope`；强烈建议 `state`、`code_challenge` + `code_challenge_method=S256`。
token 必填：`client_id`、`code`、`redirect_uri`、`grant_type=authorization_code`、`code_verifier`（用了 PKCE 就必填）。**公共客户端禁止 `client_secret`**：
> "Public clients, which include native applications and single page apps, must not use secrets or certificates when redeeming an authorization code."

PKCE 对 SPA 是硬要求：
> "`code_challenge` ... is now recommended for all application types, both public and confidential clients, and **required by the Microsoft identity platform for single page apps using the authorization code flow**."

### 3.2 token 端点是否允许浏览器跨域 POST（实测）

**预检**：

```bash
curl -sS -D - -o /dev/null -X OPTIONS \
  'https://login.microsoftonline.com/consumers/oauth2/v2.0/token' \
  -H 'Origin: https://tune.mainstayx.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'
```

```http
HTTP/1.1 200 OK
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Content-Length,Content-Encoding,x-ms-request-id
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: content-type
```

→ 允许 `POST`，只允许 `content-type` 请求头（**不能**带 `authorization`，公共客户端本来也不需要）。

**空 body POST（参数缺失）**：`HTTP/1.1 400`，`Content-Length: 494`，**响应头里没有 `Access-Control-Allow-Origin`**（逐字头见附录 A）。这一点重要：极端畸形请求会让浏览器把它当网络错误（读不到 body）。

**带完整参数但 code 无效的 POST**：

```bash
curl -sS -D - -X POST 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token' \
  -H 'Origin: https://tune.mainstayx.com' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'client_id=00000000-0000-0000-0000-000000000000&grant_type=authorization_code&code=bogus&redirect_uri=https%3A%2F%2Ftune.mainstayx.com%2Fcb&code_verifier=...'
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Content-Length,Content-Encoding,x-ms-request-id,x-ms-srs
Access-Control-Allow-Methods: POST, OPTIONS

{"error":"invalid_grant","error_description":"AADSTS7000012: The grant was obtained for a different tenant. ..."}
```

**结论（实测）**：正常形态的错误响应带 `ACAO: *` 且 body 可读；`invalid_grant` 的 `error_description` 在浏览器里拿得到。（本次 client_id 为全 0，微软返回的是租户不匹配而非 `invalid_client`，说明参数校验顺序如此；不影响 CORS 结论。）

### 3.3 关键陷阱：redirect URI 必须是 `spa` 类型（文档）

> "Redirect URIs for SPAs that use the auth code flow require special configuration." / "Update a redirect URI: Set the redirect URI's `type` to `spa`"
> "If you attempt to use the authorization code flow without setting up CORS for your redirect URI, you'll see this error in the console: `access to XMLHttpRequest at 'https://login.microsoftonline.com/common/oauth2/v2.0/token' ... has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present`"
> "Single page apps may receive an `invalid_request` error indicating that **cross-origin token redemption is permitted only for the 'Single-Page Application' client-type**."
> "the Microsoft identity platform also **prevents the use of client credentials in all flows in the presence of an `Origin` header**"

即：token 端点物理上支持 CORS，但**是否回 CORS 头由 App 注册里 redirect URI 的 `type=spa` 决定**。注册错（用 Web 平台）→ 浏览器硬失败。

### 3.4 refresh_token 有效期与续期（文档）

- `offline_access` 是拿到 refresh token 的**必要条件**："`refresh_token` ... **Only provided if `offline_access` scope was requested.**"（两处表格都这么写）
- access token 约 1 小时：响应示例 `"expires_in": 3599`。
- **SPA 的 refresh token 24 小时过期**（对浏览器直连是决定性的）：
  > "For refresh tokens sent to a redirect URI registered as `spa`, the refresh token **expires after 24 hours**. Additional refresh tokens acquired using the initial refresh token carries over that expiration time, so apps must be prepared to re-run the authorization code flow using an interactive authentication to get a new refresh token every 24 hours. Users do not have to enter their credentials ... **The browser must visit the login page in a top level frame**."
  > "Single page apps get a token with a 24-hour lifetime, requiring a new authentication every day."
- 续期请求：`POST /token`，`grant_type=refresh_token` + `refresh_token`，`scope` 可省略或取原 scope 子集；文档建议**丢弃旧 refresh token**。

### 3.5 authorize 端点：不回 CORS，只能整页跳转（实测）

```bash
curl -sS -D - -o /dev/null -X OPTIONS 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize' \
  -H 'Origin: https://tune.mainstayx.com' -H 'Access-Control-Request-Method: GET'
```

```http
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
X-Frame-Options 未出现在响应头
（响应头中无 access-control-allow-origin，无 access-control-allow-methods）
```

GET 同样返回 `Content-Type: text/html`（`Content-Length: 24467`），**没有** CORS 头。

**结论（实测 + 推断）**：`authorize` 是一个 HTML 登录页，不是 XHR 端点 —— 浏览器里**只能**用 `location.assign()` 整页跳转（或顶层 window），不能 `fetch`。这也与 3.4 里"must visit the login page in a top level frame"一致。**未验证**：该页面是否真的设了 `X-Frame-Options`/`frame-ancestors`（本次响应头未见 CSP `frame-ancestors`，但 CSP 是 `Report-Only`，且响应头被截断，不能下结论）。

---

## 4. 列目录：分页、`$top`、`$select`

- 端点：`GET /drives/{driveId}/items/{itemId}/children`（`/me/drive/root/children` 等价），支持 `$expand`、`$select`、`$skipToken`、`$top`、`$orderby`（**文档**，driveitem-list-children）。
- 分页：超过一页时返回 `@odata.nextLink`，**必须原样复用整个 URL**：
  > "Use the entire URL in the `@odata.nextLink` property in a GET request" / "Don't try to extract the `$skiptoken` or `$skip` value and use it in a different request."（**文档**，/graph/paging）
- `$top` 上限：文档只说 "The minimum value of `$top` is 1 and **the maximum depends on the corresponding API**"；paging 文档举例 `/users` 默认 100 条。**`children` 的具体上限没有明文** → **推断**：默认一页 200 条、`$top` 超过上限时服务端可能截断或忽略（paging 文档原文："The requested page size might be ignored, it might default to the maximum page size for that API, or Microsoft Graph might return an error."）。**未实测**（无凭据，401 前拿不到分页）。
- `$select` 是否支持 `@microsoft.graph.downloadUrl`：**文档间接支持** —— 微软示例就是 `GET /drive/items/{item-ID}?select=id,@microsoft.graph.downloadUrl`（且这是推荐的浏览器取文件路径）。**但"在 `children` 集合上一并 select 该注解"没有官方明文** → **推断可用，未实测**；实现上应对每个 item 是否带该字段做回退（缺失时再单条 GET）。
- 增量：`/delta` 返回 `@odata.nextLink`（还有变更）与 `@odata.deltaLink`（本轮结束，凭它下次增量），删除项带 `deleted` facet（**文档**，/graph/api/driveitem-delta）。

---

## 5. 限制与坑

| 项 | 结论 | 证据等级 |
| --- | --- | --- |
| CORS 不覆盖的端点 | `authorize`（HTML 页，无 CORS 头）只能整页跳转；`/content`（302）不可 XHR | 实测 / 文档 |
| token 端点的 CORS 触发条件 | 取决于 App 注册 redirect URI `type=spa`，否则浏览器报 "No 'Access-Control-Allow-Origin' header" | 文档 |
| 畸形请求的 CORS 头 | 空 body 的 400 **不带** `ACAO` → 浏览器侧表现为网络错误，读不到错误码 | 实测 |
| downloadUrl 时效 | 分钟级~1 小时，不可缓存；文档两处说法不一致 | 文档 |
| 条件请求 | `if-none-match` → `304`（children/`/content` 均支持）；下载主机预检允许 `If-Match`/`If-None-Match`，且 `ETag` 在 expose 列表 | 文档 + 实测（头） |
| 增量 | 用 `/delta` + `deltaLink`；文档明确不要轮询全量：轮询"more likely to lead to applications being throttled" | 文档 |
| 速率限制 | `429 Too Many Requests` + `Retry-After`（秒）；必须按 `Retry-After` 退避，不要立即重试（立即重试仍计入配额）；batch 内每个子请求独立计数，batch 本身仍 200 | 文档 |
| CORS 通配 | Graph 回 `ACAO: *`，因此不能走 cookie 凭据模式（用 Bearer 即可） | 实测 |
| 浏览器内禁止 client credentials | 带 `Origin` 头的请求里禁用 client secret/证书 | 文档 |

文档链接（速查）：
1. https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/working-with-cors
2. https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0
3. https://learn.microsoft.com/en-us/graph/api/driveitem-list-children?view=graph-rest-1.0
4. https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0
5. https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0
6. https://learn.microsoft.com/en-us/graph/paging
7. https://learn.microsoft.com/en-us/graph/query-parameters
8. https://learn.microsoft.com/en-us/graph/throttling
9. https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
10. https://learn.microsoft.com/en-us/entra/identity-platform/reference-third-party-cookies-spas

---

## 6. 对本项目的实现含义

前置事实：`docs/architecture.md` 的 v1 约束写死"**运行时不访问第三方域**（系统字体栈，无 CDN、无分析、无 API）"。接入 Graph 会**直接违反**该条，需要先改架构契约，而不是悄悄加一个 `fetch`。

1. **PKCE redirect 用整页跳转：可行**（实测 `authorize` 返回 HTML、无 CORS 头）。实现上在 `sessionStorage` 存 `code_verifier` + `state`（同一标签页生命周期，跨整页跳转可用），回跳页（同源）读 `?code=&state=` 校验后 `POST /token`。代价：一旦跳走，正在播放的音频会中断 —— 应把"连接 OneDrive"做成显式的一次性设置动作，不在播放中触发。
2. **token 端点必须 CORS：必须按 `spa` 注册**。这是 App 注册的硬配置项，不是代码能补救的；若注册成 Web 平台，浏览器端 100% 失败，只能退回服务端代理。且 token 端点只接受 `content-type` 请求头 → 用 `fetch` + `URLSearchParams` body，不要加自定义头（加 `x-*` 会触发额外预检被拒）。
3. **播放用 downloadUrl 直连：不需要代理**。`<audio src={downloadUrl}>` 是媒体元素加载，无 `Authorization` 头、无预检；即使要 `fetch` 读字节，下载主机也回 CORS 且允许 `Range`（实测头）。**唯一必须做的事**：URL 会过期 —— 播放失败（403/404/网络错误）时重新 `GET /me/drive/items/{id}?$select=@microsoft.graph.downloadUrl` 换新 URL 再 `load()`；**绝不把 downloadUrl 落盘**（IndexedDB 里只存 `driveId`/`itemId`/`eTag`）。
4. **Range 读头尾：可行**（预检允许 `Range`，`expose-headers` 含 `Content-Range`、`Content-Length`）。适合封面/时长/波形首块解析：`Range: bytes=0-65535` 一次拿头部；ID3v2 在尾部的情况再发 `Range: bytes=-128`。注意 `Range` 可能被忽略而回 `200` 全量（文档明文），所以必须检查 `response.status === 206`，否则按"拿到了整个文件"处理或放弃解析。大文件上被忽略 `Range` = 整首下载进内存，需设上限（例如 `content-length` 超阈值就放弃预读）。
5. **拿不到 CORS 时的退路**：
   - 用 `downloadUrl` 已经绕开了 `/content`，所以**不需要代理**即可播放/取字节。
   - 只有两种情况必须代理：App 注册只能给 `type=web`（token 端点无 CORS）、或需要长期持有 refresh token 而不想每天重新授权（SPA 24h 限制）。代理方案即：后端持 `client_secret` + `httpOnly` cookie，浏览器不再直连 login.microsoftonline.com —— 这会彻底破坏"纯静态产物"约束，属于产品级取舍。
   - **不要**尝试用 `no-cors` 打 `/content`：`302` + opaque response 拿不到数据。
6. **列目录与增量**：首次 `children` 分页（每页按 `@odata.nextLink` 原样跟，不自己拼 `$skip`），之后用 `/delta` + `deltaLink` 做增量；`eTag`/`cTag` 配 `if-none-match` 做单文件 304 检查。429 必须读 `Retry-After`。
7. **每天一次静默重授权**：SPA refresh token 24h 过期，且"must visit the login page in a top level frame"。所以最迟每天要一次顶层导航（用户通常无感）。这条应写进产品预期：**不能让用户以为"连一次用一年"**。

---

## 7. 未验证项清单（无凭据无法验证）

1. 真实 `downloadUrl` 的 `200`/`206` 响应、`Content-Range` 具体值、以及 URL 的实际有效期（文档说分钟~1 小时，未实测衰减曲线）。
2. **企业账户（`*.sharepoint.com` / `*-my.sharepoint.com`）下载主机是否与 `files.1drv.com` 有同等 CORS 配置** —— 本次只测了 1drv 主机；本项目只做 consumers，但若以后支持工作账户需重测。
3. `children` 的实际每页条数默认值与 `$top` 上限（401 前无法观察）。
4. 在 `children` 集合上 `$select=...,@microsoft.graph.downloadUrl` 是否每项都返回该注解（文档只有单条 GET 的示例）。
5. `429` 的真实响应头（`Retry-After` 是否存在、与 `x-ms-throttling-*` 的关系）。
6. `consumers` 租户下 `spa` 类型 redirect URI + 个人账户是否完全按文档工作（含 `offline_access` 是否真发 refresh token、个人账户是否要求额外 scope 同意）。
7. `authorize` 页面的 `frame-ancestors`/`X-Frame-Options`（决定"iframe 静默重授权"是否可行；文档已明确推荐顶层 frame，故按顶层 frame 设计）。
8. 个人账户的 token 是否可读（文档明确警告 consumers 的 token 可能被加密/非 JWT，**不要解析**）。
9. `files.1drv.com` 之外的 1drv/onedrive 下载域（如 `*.1drv.com` 其它前缀、`api.onedrive.com`）的 CORS 差异。

---

## 附录 A：原始响应头（逐字，未删改关键行）

### A.1 Graph `OPTIONS /v1.0/me/drive/root`

```http
HTTP/2 200 
strict-transport-security: max-age=31536000
request-id: cf49ac4a-3dee-474e-a868-a87200a7e809
client-request-id: cf49ac4a-3dee-474e-a868-a87200a7e809
x-ms-ags-diagnostic: {"ServerInfo":{"DataCenter":"Canada East","Slice":"E","Ring":"3","ScaleUnit":"000","RoleInstance":"QB1PEPF00020703"}}
access-control-allow-origin: *
access-control-expose-headers: ETag, Location, Preference-Applied, Content-Range, request-id, client-request-id, ReadWriteConsistencyToken, Retry-After, SdkVersion, WWW-Authenticate, DPoP-Nonce, x-ms-client-gcc-tenant, X-Planner-Operationid, x-ms-permissions-recommendations, Rate-Limit-Reason
access-control-allow-methods: DELETE, GET, OPTIONS, POST, PUT, PATCH
access-control-allow-headers: authorization
access-control-max-age: 86400
date: Wed, 04 Nov 2026 19:00:30 GMT
content-length: 0
```

### A.2 Graph `GET /v1.0/me/drive/root`

```http
HTTP/2 401 
content-type: application/json
strict-transport-security: max-age=31536000
request-id: 343c233f-c924-4e41-8f3b-68d237db75ea
client-request-id: 343c233f-c924-4e41-8f3b-68d237db75ea
x-ms-ags-diagnostic: {"ServerInfo":{"DataCenter":"Canada East","Slice":"E","Ring":"3","ScaleUnit":"000","RoleInstance":"QB1PEPF00005799"}}
access-control-allow-origin: *
access-control-expose-headers: ETag, Location, Preference-Applied, Content-Range, request-id, client-request-id, ReadWriteConsistencyToken, Retry-After, SdkVersion, WWW-Authenticate, DPoP-Nonce, x-ms-client-gcc-tenant, X-Planner-Operationid, x-ms-permissions-recommendations, Rate-Limit-Reason
www-authenticate: Bearer realm="", authorization_uri="https://login.microsoftonline.com/common/oauth2/authorize", client_id="00000003-0000-0000-c000-000000000000"
date: Wed, 04 Nov 2026 19:00:30 GMT
```

### A.3 Graph `OPTIONS /v1.0/me/drive/root/children?$top=200`

```http
HTTP/2 200 
strict-transport-security: max-age=31536000
request-id: 52127c5b-b288-49a0-b0e2-65be7aeb42df
client-request-id: 52127c5b-b288-49a0-b0e2-65be7aeb42df
x-ms-ags-diagnostic: {"ServerInfo":{"DataCenter":"Canada East","Slice":"E","Ring":"3","ScaleUnit":"000","RoleInstance":"QB1PEPF00005798"}}
access-control-allow-origin: *
access-control-allow-methods: DELETE, GET, OPTIONS, POST, PUT, PATCH
access-control-allow-headers: authorization
access-control-max-age: 86400
content-length: 0
```

### A.4 token 端点 `OPTIONS`

```http
HTTP/1.1 200 OK
Cache-Control: no-store, no-cache
Pragma: no-cache
Expires: -1
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Content-Length,Content-Encoding,x-ms-request-id
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: content-type
x-ms-request-id: f36a9fc2-3865-43ea-869c-aeb841b9aa00
Content-Length: 0
```

### A.5 token 端点 空 body POST（**无 ACAO**）

```http
HTTP/1.1 400 Bad Request
Cache-Control: no-store, no-cache
Pragma: no-cache
Content-Type: application/json; charset=utf-8
Expires: -1
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
x-ms-clientdata: e|900144||microsoftonline.com|none
x-ms-request-id: dedcf58e-e1b3-428d-a4da-87b8bea55f01
Content-Length: 494
```
（此响应头中不存在 `Access-Control-Allow-Origin`。）

### A.6 token 端点 完整参数 + 无效 code 的 POST

```http
HTTP/1.1 400 Bad Request
Cache-Control: no-store, no-cache
Pragma: no-cache
Content-Type: application/json; charset=utf-8
Expires: -1
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
x-ms-clientdata: e|7000012||microsoftonline.com|none
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Content-Length,Content-Encoding,x-ms-request-id,x-ms-srs
Access-Control-Allow-Methods: POST, OPTIONS
x-ms-request-id: 07fbb688-fc98-489f-88f7-cc6571676a00
Content-Length: 406

{"error":"invalid_grant","error_description":"AADSTS7000012: The grant was obtained for a different tenant. Trace ID: 07fbb688-fc98-489f-88f7-cc6571676a00 ...","error_codes":[7000012],...}
```

### A.7 `files.1drv.com` `OPTIONS`（带 `Range` 预检请求头）

```http
HTTP/2 200 
p3p: CP="BUS CUR CONo FIN IVDo ONL OUR PHY SAMo TELo"
strict-transport-security: max-age=31536000; includeSubDomains
ms-cv: WFPXYhAGF0ikwbX7FnEMLw.0
access-control-allow-origin: https://tune.mainstayx.com
access-control-allow-methods: GET, POST, DELETE, PATCH, PUT, HEAD, MOVE, COPY
access-control-allow-headers: Accept, Application, Authorization, Content-Range, Content-Type, If, If-Match, If-None-Match, Overwrite, Prefer, Range, Scenario, ScenarioType, SendExtendedOfficePlanInResponse, X-ClientService-ClientTag, X-HTTP-Method-Override, X-RequestStats, X-TransactionId, X-Upload-Content-Length, MS-CV, RequestFacts
access-control-expose-headers: Content-Range, ETag, Location, Preference-Applied, X-Resource-ID, X-ClientErrorCode, MS-CV, WWW-Authenticate
access-control-max-age: 2592000
content-length: 0
```

### A.8 `files.1drv.com` `GET` + `Range`（路径无效）

```http
HTTP/2 404 
p3p: CP="BUS CUR CONo FIN IVDo ONL OUR PHY SAMo TELo"
strict-transport-security: max-age=31536000; includeSubDomains
access-control-allow-origin: https://tune.mainstayx.com
access-control-expose-headers: Content-Range, ETag, Location, Preference-Applied, X-Resource-ID, X-ClientErrorCode, MS-CV, WWW-Authenticate
x-clienterrorcode: ItemDoesNotExist
x-errorcodechain: ItemNotFound
content-length: 0
```
