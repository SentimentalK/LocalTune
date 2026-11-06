# Google Drive 与 Dropbox 接入配置

本页说明如何在各云服务侧准备好 OAuth 凭据，以及如何把它们注入 LocalTune 的构建。目前覆盖两个来源：

- **Google Drive**：Google Identity Services（GIS）的 **token model**，浏览器里只保存短命的 access token，不使用 refresh token。
- **Dropbox**：OAuth 2.0 + PKCE 的 **offline access** 流程，access token 短命，另有 refresh token 用于静默续期。

两者都不需要后端 token broker，也不涉及 client secret：应用从不发送 `client_secret`。

---

## Google Drive

LocalTune 的 Google Drive 来源使用 Google Identity Services（GIS）的 **token model**：浏览器里只保存短命的 access token，不涉及 client secret，也不使用 refresh token。应用只申请只读 scope：

```
https://www.googleapis.com/auth/drive.readonly
```

下面只讲如何在 Google Cloud 侧把 client ID 准备好，以及如何把它注入构建。

---

## 1. 创建 / 选择 GCP 项目并启用 Drive API

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)。
2. 顶部项目选择器 → **新建项目**（或选择一个已有项目）。
3. 进入 **API 和服务 → 库**，搜索 **Google Drive API**，打开后点 **启用**。
4. 确认该项目下 **API 和服务 → 已启用的 API** 中能看到 Google Drive API。

> 没有启用 Drive API 时，列表/下载请求会返回 403，应用里表现为“读取失败”。

---

## 2. 配置 OAuth consent screen

1. 进入 **API 和服务 → OAuth 同意屏幕**。
2. User Type 选择 **External**（外部）。
3. 填写应用名称、用户支持邮箱、开发者联系邮箱。
4. **Scopes**：添加 `.../auth/drive.readonly`（Google Drive API 的只读 scope）。
5. **Test users**：把需要使用的 Google 账号逐个加入。

关于未验证应用（重要）：

- `drive.readonly` 属于敏感 scope。应用处于 **Testing** 状态时，只有 **Test users** 里的账号能完成授权。
- Testing 状态下的 refresh token（本项目不使用）有 7 天过期限制；本项目用 GIS token model，token 本身就是短命的，过期后重新连接即可。
- 要让任意 Google 账号使用，必须把应用提交给 Google 验证（OAuth verification）。未验证时不要对外发布，否则其他账号会在授权页被拦截。

---

## 3. 创建 OAuth client

1. 进入 **API 和服务 → 凭据 → 创建凭据 → OAuth 客户端 ID**。
2. 应用类型选择 **Web application**。
3. **Authorized JavaScript origins** 添加：
   - `https://tune.mainstayx.com`
   - `http://localhost:4173`
4. 不要添加 redirect URI：token model 使用弹窗，不跳转回调地址。
5. 创建后复制 **Client ID**。

> 不需要 client secret。不要把 secret 写进仓库、构建产物或任何配置文件。

`localhost:4173` 对应本地预览端口（例如 `npm run build` 后用静态服务器在 4173 端口打开 `dist/`）。如果本地用了其他端口或域名，也要把那个 origin 原样加进列表。

---

## 4. 通过构建环境变量注入 client ID

client ID 不是运行时配置文件，而是构建时通过 esbuild 的 `define` 注入的常量。构建脚本读取环境变量 `GOOGLE_CLIENT_ID`：

```sh
GOOGLE_CLIENT_ID=1234567890-abcdefg.apps.googleusercontent.com npm run build
```

- 变量为空或未设置时，构建仍然成功，但应用会把 Google Drive 标记为 **需要配置**，连接入口不可用。
- 修改 client ID 后必须重新构建；已经部署的旧构建不会读取新的环境变量。
- 不要把这个值写进 `src/` 下的源码；它只应出现在构建环境的配置里。

CI / 部署环境里把 `GOOGLE_CLIENT_ID` 配成环境变量（或 secret），再执行 `npm run build` 即可。

---

## 5. 运行时的 token 行为

- 点击连接后弹出 Google 授权窗口，成功后拿到 access token（默认约 1 小时有效）。
- token 只写入 IndexedDB 的 `meta` 表，键为 `gdriveToken`；不会写日志，也不会出现在 URL 或 DOM 里。
- token 快过期或已过期时，来源状态变为 `prompt`，界面显示“重新连接”。应用不会静默续期，因为 token model 没有 refresh token。
- 已缓存的曲目在 token 过期后仍可直接播放；未缓存的曲目需要重新连接。

---

## 6. 排查

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| 授权弹窗报 `origin_mismatch` / 空白页 | Authorized JavaScript origins 与当前页面的 origin 不完全一致 | 把协议、域名、端口都核对一遍，例如 `http://localhost:4173` 不能写成 `localhost:4173` |
| 弹窗报 `access_denied` 或“应用未验证” | 当前账号不在 Test users 里，或应用未通过验证 | 在 OAuth 同意屏幕的 Test users 中加账号；正式开放前提交验证 |
| 列表请求 403 `Google Drive API has not been used` | 项目未启用 Drive API | 在 API 库中启用 Google Drive API |
| 列表请求 403 `insufficientPermissions` | 授权时没给到 `drive.readonly`，或 scope 被撤销 | 断开后重新连接，确认同意屏幕里勾选 Drive 只读 |
| 构建后仍显示“需要配置” | 构建时未设置 `GOOGLE_CLIENT_ID`，或设置了空串 | 带环境变量重新构建并检查部署产物 |
| 一段时间后播放未缓存的曲目失败 | access token 过期（token model 没有 refresh token） | 点“重新连接”重新授权 |

---

## Dropbox

Dropbox 使用 OAuth 2.0 授权码 + PKCE。应用只申请两个只读权限：

```
files.metadata.read files.content.read
```

`files.metadata.read` 用于 `files/list_folder`，`files.content.read` 用于 `files/download`；没有任何写入权限。

### 1. 创建应用

1. 打开 [Dropbox App Console](https://www.dropbox.com/developers/apps)。
2. **Create app** → **Scoped access**。
3. 选择 **App folder**（推荐）或 **Full Dropbox**，然后命名应用。

App folder 只能看到应用自己的文件夹；Full Dropbox 可以浏览整个账号。应用内的选择器在两种模式下都能工作。

### 2. Permissions 标签页

在 **Permissions** 中只勾选：

- `files.metadata.read`
- `files.content.read`

不要勾选任何写权限。权限发生变化后，已有 token 需要重新授权。

### 3. OAuth 2 设置

在 **OAuth 2** 区域添加 Redirect URI，必须与应用的 origin **完全一致并带结尾斜杠**，例如：

- `https://tune.mainstayx.com/`
- `http://localhost:4173/`

不一致会得到 `redirect_uri` 相关错误。Dropbox 要求非 localhost 的 redirect URI 使用 HTTPS。

应用不使用 client secret：PKCE（`code_challenge_method=S256`）就是唯一的凭据。构建时注入的是 **app key**，不是 secret。

### 4. PKCE 与 offline access

应用在授权 URL 中附加 `token_access_type=offline`，因此 token 响应会带 refresh token。注意：使用 `files.content.read` / `files.metadata.read` 的 scoped app 若要面向团队外账号正式使用，需要通过 **App review**；未通过审核时只有应用所有者团队的账号能完成授权。用自己的账号开发/测试不受影响。

### 5. 构建注入

```sh
DROPBOX_APP_KEY=xxxxxxxxxxxxx npm run build
```

构建脚本通过 esbuild 的 `define` 注入 `__DROPBOX_APP_KEY__`，与 `GOOGLE_CLIENT_ID` 的方式一致。变量为空或未设置时构建仍然成功，但 Dropbox 卡片显示“需要配置”，连接按钮禁用，且不产生任何网络请求。

### 6. 运行时 token 行为

- `meta.dropboxToken = { accessToken, refreshToken, expiresAt, scope }` 保存在 IndexedDB。
- access token 约 4 小时有效；过期前/过期后会用 refresh token 静默刷新。
- Dropbox 的刷新响应通常不带新的 `refresh_token`，此时保留旧的 refresh token。
- API 返回 401 时，应用静默刷新一次并重试一次。
- refresh token 被撤销或过期时，来源变为 `prompt`，卡片显示“重新连接”；已缓存的曲目仍然可以播放。

### 7. 排查

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| 授权后回到应用报 `redirect_uri` 错误 | Redirect URI 与当前 origin 不完全一致（协议、端口、结尾斜杠） | 在 App Console 的 OAuth 2 设置里加入完全一致的 URI |
| 刷新 token 时返回 `invalid_grant` | refresh token 被撤销或已过期 | 点“重新连接”重新授权 |
| 列表/下载返回 `insufficient_scope` | App Console 的 Permissions 缺少 `files.metadata.read` 或 `files.content.read` | 勾选权限并重新授权 |
| 浏览/下载返回 409 `path/not_found` | 文件已被移动或删除，或路径大小写不匹配 | 重新同步；应用按大小写不敏感匹配 Dropbox 路径 |
| 构建后仍显示“需要配置” | 构建时未设置 `DROPBOX_APP_KEY`，或设置为空串 | 带环境变量重新构建并检查部署产物 |

> LocalTune 没有后端 token broker：所有 token 交换都在浏览器里通过 PKCE 完成，应用从不发送 `client_secret`。
