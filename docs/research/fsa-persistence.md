# FSA 持久授权与 Android Chrome 支持调研

- 调研时间: 2026-11-04
- 结论置信度: 逐条标注（高 = 官方文档/BCD 明文；中 = 单一来源或间接推断；低 = 未证实，需实测）
- 只读调研，未修改任何源码/测试/配置。

## 1. showDirectoryPicker 在 Android Chrome

- 结论（高）: 支持，Chrome for Android **132** 起可用（桌面 86 起）。不是桌面专属。同一版本起 `showOpenFilePicker` / `showSaveFilePicker` 也进入 Android + WebView。
- 结论（高）: `FileSystemDirectoryHandle` / `FileSystemFileHandle` / `queryPermission` / `requestPermission` 在 Android 自 **109** 起可用（与 picker 不同步：句柄类型早于 picker）。
- 结论（中）: 不支持的环境（如 Firefox/Safari）中属性不存在，`window.showDirectoryPicker` 为 `undefined`，直接调用抛 `TypeError`；文档未明文描述该表现，属推断 → 调用前必须特性检测（`typeof window.showDirectoryPicker === 'function'`）。
- 证据:
  - https://developer.chrome.com/release-notes/132 — "File System access shipped on Desktop in Chrome 86, with Chrome 132 it's available on Android and WebView."
  - https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Window.json — `showDirectoryPicker`: `"chrome": {"version_added": "86"}`, `"chrome_android": {"version_added": "132"}`, `"firefox": {"version_added": false}`, `"safari": {"version_added": false}`
  - https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/FileSystemHandle.json — `queryPermission` / `requestPermission` / `kind` / `name` / `isSameEntry`: `"chrome_android": {"version_added": "109"}`
  - https://developer.chrome.com/docs/capabilities/web-apis/file-system-access — "The File System Access API is supported on most Chromium browsers on Windows, macOS, ChromeOS, Linux, and Android."
  - https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker — "Limited availability ... This feature is not Baseline"; "Transient user activation is required."
- 版本/日期: Android Chrome 132（2025-01 stable）；WebView 同为 132。
- 冲突（需注意）: https://caniuse.com/native-filesystem-api 的 `and_chr` 仍标 `n`（数据里最新 and_chr 156 = `n`，仅桌面标 `y`），与 BCD + Chrome 132 release notes 矛盾；以 Chrome 官方 release notes 为准，caniuse 该条视为滞后。

## 2. 持久权限（每次访问时允许 / Allow on every visit）

- 结论（高）: Chrome **122** 起提供三选一权限弹窗：`Allow this time` / `Allow on every visit` / `Don't allow`。无新的开发者 API，行为完全由现有 `requestPermission()` 触发。
- 结论（高）: `Allow on every visit` 语义 — "Allows the app to have indefinite access unless access is revoked. Once the app has been granted persistent access, newly opened files and folders will be accessible persistently, too."
- 结论（高）: 普通标签页（未安装）要达到持久授权，需同时满足：上次访问已授权 + 句柄已存入 IndexedDB + 本次访问从 IndexedDB 取回句柄并调用 `requestPermission()`。满足后弹三选一；用户选 "Allow on every visit" 才持久。
- 结论（高）: **PWA 安装不是必需，但安装后自动获得持久权限** — "The user must have installed the app. Installed apps will automatically persist permissions once the user grants access. In this case, the three-way prompt won't be shown, instead the app gets the new behavior by default."（此条为三条触发条件之一）
- 结论（高）: `requestPermission()` 需要瞬时用户激活（按钮点击），否则抛 `SecurityError`。后台/自动调用不可行。
- 结论（未证实，必须实测）: 用户选 "Allow on every visit" 后重启浏览器，`queryPermission()` 是否直接返回 `"granted"` — Chrome blog 未写，MDN 只写 "a handle retrieved from IndexedDB is also likely to resolves with 'prompt'"，未覆盖持久授权场景。推断为 `granted`，但**不能作为设计前提**。
- 结论（高）: 旧行为基线（未持久 / 未安装）— "The web app can continue to save changes to the file without prompting until all tabs for its origin are closed. Once a tab is closed, the site loses all access."
- 结论（未证实）: 三选一弹窗按 one-time permission 规则计数，"if the user denies or dismisses the prompt more than three times, it will no longer trigger, and instead the regular permission prompt will show."（意味着反复 dismissed 会永久降级为每次重选）
- 结论（未证实）: Android 上是否存在同等的持久授权 UI — Chrome 未发布任何 Android 专属说明；132 只是把 API 打开。设计上必须假设 Android 需要重新授权。
- 证据:
  - https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api — "The new behavior can be observed as of Chrome 122." / "Allow on every visit: Allows the app to have indefinite access unless access is revoked." / "There are no developer-facing changes to the File System Access API." / "The user must have installed the app. Installed apps will automatically persist permissions once the user grants access."
  - https://developer.chrome.com/docs/capabilities/web-apis/file-system-access — "Since permissions are not always persisted between sessions, you should verify whether the user has granted permission ... using queryPermission()."; "Once a tab is closed, the site loses all access."
  - https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/requestPermission — "There was no transient user activation such as a button press."
  - https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/queryPermission — "Usually handles returned by the local file system handle factories will initially resolves with \"granted\" for their read permission state. However, other than through the user revoking permission, a handle retrieved from IndexedDB is also likely to resolves with \"prompt\"."

## 3. `<input type="file" webkitdirectory>` 在 Android Chrome

- 结论（高）: 目录选择在 Android Chrome **132** 起完整可用；131 为 partial（选目录会崩浏览器），131 之前只能用文件多选。
- 结论（高）: Chrome 桌面自 7 起支持；caniuse "Directory selection from file input" 对 `and_chr` 标 `y`。
- 结论（未证实）: Android 132+ 上 `File.webkitRelativePath` 是否被填充 — 规范/BCD 未对平台做区分，只能实测。桌面行为是按所选根目录给出相对路径。
- 结论（高）: 回退行为（<131）: 用户只能选单个/多个文件，无法选目录（crbug 40248532）；此时按定义不会有目录相对路径。
- 证据:
  - https://raw.githubusercontent.com/mdn/browser-compat-data/main/html/elements/input.json — `webkitdirectory.chrome_android`: `{"version_added": "132"}`, plus `{"version_added": "131", "version_removed": "132", "partial_implementation": true, "notes": ["In Chrome for Android 131, choosing a directory crashes the browser (see bug 376834374).", "Before version 131, users cannot choose a directory, only individual files (see bug 40248532)."]}`
  - https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file — "The Boolean webkitdirectory attribute, if present, indicates that only directories should be available to be selected by the user in the file picker interface."
  - https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file — "webkitRelativePath: A string specifying the file's path relative to the base directory selected in a directory picker."
  - https://caniuse.com/input-file-directory — feature "Directory selection from file input", `and_chr` = 支持。

## 4. IndexedDB 中的 File

- 结论（高）: `File` 是可结构化克隆类型，因此可存入 IndexedDB（IndexedDB 用 structured clone 存储值）。`FileList`、`FileSystemDirectoryHandle`、`FileSystemFileHandle`、`FileSystemHandle` 同样在可克隆列表内。
- 结论（高）: 句柄入 IndexedDB 是官方推荐路径 — "File handles and directory handles are serializable, which means that you can save a file or directory handle to IndexedDB".
- 结论（未证实，必须实测）: 来自 `<input type=file>` 的 `File` 对象在浏览器重启后 `arrayBuffer()` 是否仍可读 — 规范只声明失败的可能性，未承诺持久可读："A File or Blob may be unreadable. This may be due to permission problems that occur after a reference to a File or Blob has been acquired ... Additionally, the snapshot state may have changed. See NotReadableError." → 设计上必须把"重启后读取 File 可能抛 `NotReadableError`"当作正常分支，而不是异常。
- 证据:
  - https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm — supported types list contains "File FileList FileSystemDirectoryHandle FileSystemFileHandle FileSystemHandle"
  - https://developer.chrome.com/docs/capabilities/web-apis/file-system-access — "File handles and directory handles are serializable, which means that you can save a file or directory handle to IndexedDB, or call postMessage()"
  - https://w3c.github.io/FileAPI/ — "A File or Blob may be unreadable. This may be due to permission problems that occur after a reference to a File or Blob has been acquired (e.g. concurrent lock with another application). Additionally, the snapshot state may have changed."

## 5. 对 APP-001-C 的建议

1. **桌面已安装 PWA**：安装本身就是"持久"开关 — 用户授权一次后浏览器自动持久化，无需三选一弹窗。代码路径：`showDirectoryPicker({mode:'readwrite', id:'...'})` → 句柄存 IndexedDB → 下次启动读回句柄 → 在按钮点击（用户激活）里 `queryPermission() !== 'granted'` 时 `requestPermission()`。**不要**在页面加载时静默调用 `requestPermission()`（无用户激活会 `SecurityError`）。
2. **桌面普通标签页**：同样路径，但首次触发 `requestPermission()` 时才会出现三选一；必须把 `Allow on every visit` 作为"持久"分支，选 `Allow this time` 则下次仍需授权。授权失败/被 dismiss 要有降级 UI（重新选择目录）。
3. **Android Chrome**：API 自 132 存在，但"持久授权"在 Android 上的行为无任何官方文档 → 按"每次访问需重新授权"设计。真正的无重选路径只有**把文件内容复制进 OPFS**（`navigator.storage.getDirectory()`，Android 109 起支持），或让用户每次通过 `showDirectoryPicker()` / `<input webkitdirectory>` 重新选目录。`<input webkitdirectory>` 只提供 File 对象（无句柄、无写回），适合"导入一次"的快照式工作流。
4. **能力探测**：`typeof window.showDirectoryPicker === 'function'` 同时覆盖桌面旧版与 Android <132；为 false 时走 `<input type="file" webkitdirectory multiple>`，再为 false 时走普通多选。
5. **必须在真机验证的三个点**（文档未覆盖）：持久授权后重启浏览器的 `queryPermission()` 返回值；Android 132+ 是否出现"每次访问时允许"选项；IndexedDB 中 `File` 跨重启的 `arrayBuffer()` 可读性。

## 未能证实的点

1. 持久授权后（重启浏览器）`queryPermission()` 是否返回 `"granted"` — 无官方文档。
2. Android Chrome 是否存在持久 FSA 授权 UI，以及是否与安装 PWA 绑定 — 无官方文档。
3. Android Chrome 132+ 上 `webkitRelativePath` 是否被正确填充 — 无平台级说明，需实测。
4. 浏览器重启后 IndexedDB 中 `<input>` 来源的 `File` 是否仍可 `arrayBuffer()` — File API 仅声明可能 `NotReadableError`，无保证。
5. caniuse `native-filesystem-api` 的 `and_chr` 数据（`n`）与 Chrome 官方 release notes（Android 132 起支持）矛盾，未找到 caniuse 侧说明。
