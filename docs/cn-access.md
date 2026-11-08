# 国内访问优化

国内打开首页"巨慢"（LCP 500 ms–5 s）不是 JS 的问题：首屏 JS/CSS 已经边缘命中，
慢的是 HTML 每次回源和封面图。本文记录仓库侧已做的改动，以及 Cloudflare 侧还需要
手动点的三件事。

## 实测（2026-11-07，Cloudflare 回源到家里的 k3s）

| 资源 | 改前响应头 | 问题 |
| --- | --- | --- |
| `/` | `cache-control: no-cache`, `cf-cache-status: DYNAMIC` | 每次都跨国回源 |
| `/assets/main-*.js` | `immutable`, `HIT` | 正常 |
| `/demo/baby-girl.jpg` | `max-age=14400`, `REVALIDATED`，516,120 B | 每个访问都要回源 revalidate，且单张 516 KB 就是 LCP 元素 |
| `/demo/ziyou-de-ni.jpg` | 510,593 B | 同上 |
| `/sw.js` | 被 CF 改成 `max-age=14400` | 延迟版本更新（CF 侧规则问题） |

根因在 `nginx.conf`：`/demo/` 与 `/icons/` 没有 location，落进 `location /`
的 `no-cache`，所以 CF 只能 4 小时 revalidate 一次；封面本身是未压缩的 145–516 KB
JPEG。

## 仓库侧改动

### 1. 封面：JPEG → 内容寻址 WebP

`npm run covers`（`scripts/demo-covers.mjs`，需要带 libwebp 的 `ffmpeg`）把
`design/demo-covers/*.jpg` 转成两组 WebP，命名带内容指纹，源图保留在 `design/`、
不再进 `dist/`：

- `<slug>.<hash>.webp`：长边 640，质量 78，舞台（LCP 元素）用；
- `<slug>.<hash>-96.webp`：96×96 裁切，列表行用。

`<hash>` 是输出文件 SHA-256 的前 8 位，文件变了 URL 就变，所以 `/demo/` 可以放心
`immutable` 一年。`src/core/demoCovers.generated.js` 由脚本重写，`src/core/demo.js`
引用它：`coverSrc` 是 640 版、`coverThumb` 是 96 版。

只发 WebP、不保留 JPG 回退：项目 target 是 ES2022 + Service Worker，支持矩阵内的
浏览器（Chrome 32+/Firefox 65+/Safari 14+，2020 年起）都能解 WebP。

体积（`dist/demo/` 里的图片文件）：

| 封面 | 改前 JPG | 640 WebP | 96 WebP | 改后合计 | 降幅 |
| --- | ---: | ---: | ---: | ---: | ---: |
| baby-girl | 516,120 B | 81,720 B | 3,338 B | 85,058 B | −83.5% |
| hachimitsu | 219,859 B | 80,856 B | 3,166 B | 84,022 B | −61.8% |
| just-communication | 144,633 B | 56,208 B | 3,204 B | 59,412 B | −58.9% |
| ziyou-de-ni | 510,593 B | 75,340 B | 3,350 B | 78,690 B | −84.6% |
| **合计** | **1,391,205 B** | **294,124 B** | **13,058 B** | **307,182 B** | **−77.9%** |

### 2. LCP 与 CLS

- 舞台封面（`#cover`）：`fetchpriority="high"`、`decoding="async"`、显式
  `width="640" height="640"`。
- 列表封面：`loading="lazy"`，并且改用 96 px 缩略图。

### 3. nginx 缓存头

`nginx.conf` 新增：

```nginx
location /demo/ {
  add_header Cache-Control "public, max-age=31536000, immutable" always;
  try_files $uri =404;
}

location /icons/ {
  add_header Cache-Control "public, max-age=31536000, immutable" always;
  try_files $uri =404;
}
```

`/sw.js`、`/index.html`、`/manifest.webmanifest` 保持 `no-cache`：更新仍由
Service Worker 负责。封面换图不需要 purge，因为文件名随内容变。

> 取舍：`/icons/` 的文件名没有内容指纹，设为 immutable 后换图标必须改文件名，
> 否则老客户端一年内都会用缓存图。PWA 图标改动极少，这个代价可以接受；若不能
> 接受，把 `location /icons/` 的 `max-age` 降到 30 天。

## Cloudflare 侧需要做的三件事

仓库只能保证源站响应头正确；CF 的缓存行为要在面板里改。按顺序：

### 1. 静态资源 Cache Rule：Edge TTL 1 年

**Rules → Cache Rules → Create rule**

- 表达式：
  ```
  starts_with(http.request.uri.path, "/assets/") or
  starts_with(http.request.uri.path, "/demo/") or
  starts_with(http.request.uri.path, "/icons/")
  ```
- **Cache eligibility**：Eligible for cache
- **Edge TTL**：Ignore cache-control header and use this TTL → **1 year**
- **Browser TTL**：Respect origin（源站已经发 `immutable`，不要在 CF 再拉长）

目的：`/demo/` 不再出现 `REVALIDATED`，边缘命中后国内用户完全不回源。

### 2. `/sw.js`：Bypass cache

同一条规则列表里再加一条（优先级放在静态资源规则之上）：

- 表达式：`http.request.uri.path eq "/sw.js"`
- **Cache eligibility**：Bypass cache

目的：当前 CF 把 `sw.js` 改写成 `max-age=14400`，导致发布后最长 4 小时才更新
Service Worker；源站一直是 `no-cache`，CF 侧绕过即可恢复即时更新。

### 3. `/` HTML：短 Edge TTL

- 表达式：`http.request.uri.path eq "/" or http.request.uri.path eq "/index.html"`
- **Cache eligibility**：Eligible for cache
- **Edge TTL**：Ignore cache-control header and use this TTL → **30–60 s**
- **Browser TTL**：Respect origin（`no-cache`）

取舍：HTML 会最多旧 30–60 秒，换来同一 PoP 内的回源合并。资源靠 hashed URL +
SW 更新，短 TTL 不影响发布正确性。若暂时不想改 HTML，至少开启
**Tiered Cache**（或 Argo Smart Routing），让海外边缘节点共享回源。

## 复核

改完后连续请求两次，第二次应为 `HIT` 且 `age` 增长：

```sh
curl -sI https://<域名>/demo/baby-girl.<hash>.webp \
  | grep -iE 'cache-control|cf-cache-status|age'
```

期望：

```
cache-control: public, max-age=31536000, immutable
cf-cache-status: HIT
```

`/` 期望在第二次请求出现 `cf-cache-status: HIT` 或 `REVALIDATED`（TTL 到期后），
而不是每次 `DYNAMIC`；`/sw.js` 不应再出现 `max-age=14400`。
