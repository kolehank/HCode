# Spec：web 远程访问（server 形态与 desktop 内嵌形态共用行为）

状态：生效中。审查来源：原始实现仓库的 `docs/reviews/2026-10-01-v3.100.0-code-review.md`（P1-2/3，P2-1/5/6/7/8；该文档未随 BYOK 重建迁入本仓库，可到 ZCode fork 前基线查阅）。
本 spec 描述三档鉴权、浏览器来源校验、生命周期与帧边界的产品规则；实现必须与本文一致。

## 所有权

```text
web-access.json（磁盘事实）── 唯一所有者：@zcode/server load/updateWebAccessConfig
        │  快照
        ▼
desktop: WebRemoteAccessController（生命周期唯一所有者：启停编排、#handle）
        │  start/stop
        ▼
desktop: webRemoteAccessHttpServer（监听器所有者：HTTP 路由 + WS 升级 + 三档鉴权执行）
        │  onClientConnected(ws)
        ▼
desktop: server.ts（electron 适配层：MessagePort 桥 bridgeWebSocketToHost）
```

- controller 不持久化第二份配置；内存 `#config` 仅为最近一次磁盘读的缓存，`getStatus()` 反映缓存 + 当前 handle。
- 鉴权纯函数（token 比对、CF 验签、Origin/Host 判定）唯一来源：`@zcode/server/webAccessAuthBridge`。hono 中间件（server 形态）与 desktop 内嵌 server 都调它，不复制实现。
- **desktop 内嵌形态在 open/token 档挂载 `/api/web-access` 路由**（GET config/interfaces、PUT config），与 server 形态共用同一套 `@zcode/server` 配置函数、入参 schema（`webAccessUpdateSchema`）与跨字段校验（`validateWebAccessUpdateCrossFields`）；CF 档不挂载（`/api/*` 一律 404 JSON）。desktop token 档写接口比 server 形态更严：仅 loopback（本机设置页），远程只读。
- 未挂载的 `/api/*` 路径统一回 404 JSON，**不得落入 SPA fallback**（回 HTML 会被浏览器端当 JSON 解析，报「Unexpected token '<'」误导排障）。
- **token 明文的本进程缓存（仅 desktop）**：controller 只在内存保留「本进程生成」的明文 token，用于在本次运行内重复展示同一访问链接（设置页与手机快捷弹窗）。磁盘仍只存 hash/前缀，明文不写日志、不进任何 HTTP 响应。
  - 暴露面：仅 IPC 快照 `WebRemoteAccessConfigSnapshot.accessUrl`；`/api/web-access/config` 的 GET/PUT 响应永远不含明文链接或明文 token。IPC 只面向本机受信 renderer，远程凭 token 访问的浏览器拿不到该字段。
  - 缓存写入：IPC 保存（`applyUpdate`）生成了 token 时写入；内嵌 HTTP PUT 生成了 token 时经 `onConfigUpdated(generated)` 回填——`restartFromDisk` 会先清空缓存再按回填值写入，避免「停旧起新」把刚生成的链接清掉。
  - 缓存失效：切离 token 档、`reloadFromDisk`（磁盘可能被外部改写，无法确认明文与 hash 对应）、重新生成（替换为新明文）。应用重启后缓存为空，UI 回到重新生成引导——这是「明文不落盘」的必然结果，不是缺陷。

## 鉴权矩阵

三档：`open` / `token` / `cloudflare-access`。受保护路径：`/ws*`（含升级）与 `/api/*`；静态资源放行（token 在连接层校验）。

| 场景                                | open                                       | token                                             | cloudflare-access                                                                      |
| ----------------------------------- | ------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| HTTP 受保护路径                     | 应用层不鉴权                               | Authorization Bearer 或 `/ws?token=` 常量时间比对 | 异步验 `Cf-Access-Jwt-Assertion` JWT（issuer/audience/JWKS），算法 `["RS256","ES256"]` |
| WS 升级                             | 同上（升级帧不携带 Bearer 时依赖来源校验） | 同上（浏览器允许 `?token=`）                      | 同 HTTP，异步验签后才 handleUpgrade                                                    |
| GET `/api/web-access*`              | 仅 loopback                                | 凭据放行（远程只读）                              | desktop 不挂载 → 404 JSON                                                              |
| 写接口（非 GET `/api/web-access*`） | 仅 loopback                                | 仅 loopback（desktop 与 server 形态一致约束）     | 由 CF 身份界定（desktop 不挂 /api 路由）                                               |

### 浏览器来源校验（CSWSH / DNS rebinding 防线）

浏览器发起的 WebSocket 必带 `Origin` 且不可伪造；非浏览器客户端（curl/脚本）通常不带。规则按档位：

1. **Origin 校验（三档生效，仅当 Origin 头存在时）**：`Origin` 必须与请求 `Host` 同源（`http(s)://<Host>`），或与 `externalBaseUrl` 的 origin 相等；无法 parse 或协议非 http(s) 即拒。Origin 缺失 = 非浏览器客户端，放行（token/CF 档仍需凭据）。
2. **Host 校验（仅 open 档）**：`Host` 的 hostname 必须是 loopback（`localhost`/`127.*`/`::1`）。open 档监听器被 `resolveWebBindHost` 强制绑回环，Host 若为任意其他域名即 rebinding 特征，拒 403。token/CF 档允许任意 Host（LAN IP、自有域名是合法访问形态，且凭据已挡住 rebinding 收益）。
3. 校验失败统一 403，拒绝原因写 warn 日志（不含 token/JWT 原文）。

### CF email allowlist 语义

- `cfAllowedEmails` 空数组 = 不限制 email；非空 = JWT 的 email claim 必须（大小写不敏感、trim 后）命中任一候选。
- **空串候选不参与匹配**：解析层（desktop IPC `parseSaveRequest` 与 server PUT 路由一致）过滤空串；校验层跳过空候选。双保险的原因：allowlist 混入 `""` 会把「无 email claim 的合法 JWT」（email 视为 `""`）放行。

### 外部访问基址（externalBaseUrl）语义

- **可空**。已配置时参与 WS Origin 校验（`Origin` 可与其 origin 相等）并作为访问链接前缀；为空时 Origin 校验语义不变（只允许与请求 Host 同源）。
- **展示回退链（mode-aware，唯一来源 `@zcode/shared` 的 `resolveWebAccessDisplayBaseUrl`）**：运行中的临时公网通道 URL > 已配置基址 > 建议网卡地址（仅 token/CF 档）> 本机回环。**open 档监听被强制绑回环，LAN 地址必不可达，回退固定回环**；token/CF 档允许非回环 bind，二维码的意义是给其他设备扫，故优先建议网卡。回退值**仅用于展示**（二维码/复制链接），不落盘、不参与 Origin 校验——外部访问语义始终以磁盘配置为准。port 未就绪（server 未运行）时无回退值，UI 按无链接处理。隧道 URL 同样只用于展示：它随进程变化，绝不写回 `externalBaseUrl`。
- **访问链接拼接**：`buildAccessUrl(基址或回退值, token, deviceName?)` 单一来源，desktop 调用点（IPC 保存、desktop 内嵌 HTTP PUT）传入本机 hostname 生成 `#token=…&device=…`；server 形态不传 device（其鉴权不要求设备标识）。UI 弹窗共用同一回退链。
- **设置页网卡联动**：加载时基址为空则回显当前建议网卡的 `http://<ip>:<端口>`（可见可编辑，不静默写盘）；切换网卡时仅当基址为空或仍是上一条自动建议才跟随新选择，**用户手填的域名/反代地址优先，不被覆盖**。保存成功后从保存响应同步端口/令牌状态回 UI（port 未运行时为 0，保存启动 server 后须刷新，否则「服务端口」不显示、联动失效）。
- **手机快捷弹窗（QuickDialog）展示统一**：三档都以「二维码 + 完整链接 + 复制链接」为主卡片，差异只在链接来源与失效语义。
  - `open` 档：基址为空时展示回退地址（通常为本机回环），标注「自动建议、不落盘」。
  - `cloudflare-access` 档：链接 = `resolveWebAccessDisplayBaseUrl` 的基址（通常是配置的公网域名），无 token 片段；身份由 CF Access 在边缘完成，弹窗不再附加任何凭据。
  - `token` 档：链接 = 快照 `accessUrl`（本进程生成的明文）或弹窗内重新生成返回的链接。两者都为空（例如应用刚重启）时展示重新生成引导，并说明明文只在本机内存保留。重新生成后必须用保存响应刷新 `status`（running/port），否则二维码可能基于旧端口。
  - 弹窗内的重新生成会立即让旧链接失效，按钮文案与提示必须显式说明这一点。

## 公网临时通道（Cloudflare Quick Tunnel）

定位：**零账号的「公网可达」通道，不是身份认证方案**。Quick Tunnel 不绑定 Cloudflare 账号、无法挂 Access 策略、不注入 `Cf-Access-Jwt-Assertion`；公网侧保护由「随机 `*.trycloudflare.com` 域名 + 应用 token」承担。`cloudflare-access` 档继续作为稳定 URL/身份认证方案，两者不互斥、不替换。

- **开启条件**：`quickTunnelEnabled=true` 且 `mode="token"`。其他组合由 controller 归一化为 false 并记 warn（UI 同时禁用开关）。该字段是 desktop-only 配置：IPC 保存生效，HTTP PUT 不接收（与 `desktopEnabled` 同语义），浏览器设置页不展示该区块。
- **所有权**：`WebRemoteAccessController` 同时拥有 listener 与 tunnel 子进程。tunnel 是 listener 的子资源（端口变化必须重建），不放进 host；不使用独立 controller。
- **进程参数**：`cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate`。URL 从 stderr 的 `https://<随机>.trycloudflare.com` 解析；`--no-autoupdate` 必须保留，否则自动更新重启会换 URL。二进制按 `ZCODE_CLOUDFLARED_PATH` > PATH > 平台常见安装路径解析，v1 只做检测与引导安装，不自动下载/不内置。
- **事件顺序（启动）**：`停旧 tunnel（仅当通道不再合法）→ 停旧 listener → 启新 listener（拿到实际 port）→ 启 tunnel → 解析 publicUrl → 推送 running`。停止顺序相反；tunnel 必须先于 listener 停止，避免残留进程指向已关闭端口。**端口未变且通道仍合法时保持 tunnel 进程**（例如只改基址/重新生成 token），URL 不因一次保存而变化；端口变化必须重建。URL 解析是异步的：状态先 `starting`，拿到 URL 后 `running`，经 IPC 推送（`WebAccessTunnelStatusChanged`）刷新 UI，保存响应不等待 URL。
- **失败与退避**：启动 25s 内未解析到 URL → 终止本次尝试并按退避重试；进程异常退出同样重试。退避 `1/2/4/8/16s`，5 分钟窗口内最多 5 次；超限进入 `error(crashed)`，由 UI「重启通道」显式恢复。未检测到二进制 → `error(binary-missing)`，不重试。
- **传输协议回退**：首次用默认 `auto`（QUIC/UDP）；启动阶段失败后，下一次重试追加 `--protocol http2`（TCP 7844，国内 UDP 被限速时的常见解法）。曾经成功运行过的崩溃重试保持 `auto`，不无谓降级。当前协议经 `tunnel.transport` 暴露，UI 在 http2 时提示。
- **可达性探测**：URL 解析后立即进入 `running`（Cloudflare 明确提示地址可能过几秒才可达）；后台最多 3 次探测（间隔 3s/5s，单次 5s 超时），失败只置 `tunnel.reachable=false` 并提示「可能仍在生效」，不把 `running` 改成 `error`。
- **孤儿进程清理**：进程启动后把 `{pid, startedAt}` 写入 `~/.zcode/v2/quick-tunnel.json`，停止/退出时删除；下次 `start` 前读取该文件，**确认进程名仍是 cloudflared** 才终止（PID 可能被复用；文件损坏只删除不杀进程）。
- **退出屏障**：`webRemoteAccess.stop()` 先停 tunnel 再停 listener；必须使用进程树终止（Windows `taskkill /T /F`、POSIX 进程组），保证 app 退出不留孤儿 `cloudflared`。
- **URL 生命周期**：每次 tunnel 启动分配新 URL，进程退出即失效；URL 仅存 main 内存并经 IPC 暴露，不落盘、不写入 info 日志。
- **安全（必须）**：
  - **代理/隧道请求的 `remoteAddress` 是回环，不能作为 loopback 依据**。凡携带 `CF-Connecting-IP`、`CF-Ray` 或 `X-Forwarded-For` 的请求一律按非 loopback 处理：`/api/web-access` 写操作一律 403。该规则同时覆盖用户自建反代，属于既有缺口修复。
  - 受保护路径的 401/403 按 `CF-Connecting-IP`（缺失时用 socket 地址）限流：60s 内 10 次失败后返回 429，防止公网扫描消耗资源。
  - token 明文仍只存 main 内存 + IPC；HTTP 响应不含 `accessUrl` 或明文 token。
- **非目标**：不做 SSO/邮箱白名单（Quick Tunnel 不支持）；不保证 URL 稳定；不承诺可用性——Cloudflare 官方定位为测试/开发用途、无 SLA、单隧道 200 并发上限。静态页面壳仍可公开加载（与 token 档一致），数据面由 token 与限流保护。

## 设备标识与单会话互斥

- **访问链接格式（desktop 内嵌入口，token 档）**：`{base}/#token=<token>&device=<hostname>`。`device` 取桌面机 `os.hostname()`，与 token 一样放在 fragment：fragment 不进代理/访问日志，Web 端读取后存入 `sessionStorage` 并从地址栏清除。
- **回传方式**：浏览器 WS 不能带自定义头 → WS 用 `?device=`；HTTP API 用 `X-Zcode-Device`。两者由 `packages/ui/src/lib/webAccessToken.ts` 统一注入（`attachWebAccessTokenToUrl` / `fetchWithWebAccessToken`）。
- **校验（token 档）**：`authorizeRequest` 在 token 命中后比对设备标识：缺失 → 401 `missing device identifier`；不匹配 → 403 `device identifier mismatch`（大小写不敏感、容忍末尾点）。open 档无凭据、CF 档已有 JWT 身份，均不强制设备标识。
- **定位说明**：设备标识只是「链接绑定到哪台机器」的显式作用域，不是秘密——拿到链接的人同样能看到/伪造它；真正的凭据仍是 token。它的价值是让跨机器直接复用链接产生明确的 403，而不是静默可用。
- **单会话互斥**：同一内嵌入口同一时刻只允许一个 Web 会话（一个 WS 桥），**open / token / CF 三档与回环 / 局域网 / 临时公网三种入口一致**。新 WS 升级成功后，旧连接以应用自定义关闭码 `4001`（`WEB_ACCESS_SESSION_REPLACED_CLOSE_CODE`）关闭；2s 内未关闭则强断。旧页面展示「已在其他设备登录，本页面已退出」，且**不自动重连**（Web 入口本身无重连）；刷新页面即视为新登录，反过来挤掉当前会话。
- **不是限制**：设置页 HTTP 配置接口、静态资源请求不计入会话；会话互斥只约束承载桌面 Host 的 WebSocket。

## 生命周期与并发

- 事件顺序（保存配置）：`updateWebAccessConfig 落盘 → stop 旧监听（强断全部 WS 桥）→ 按新配置 start`。mode/bind 变更必须先停后起，不允许新旧快照并存。
- **事件顺序（desktop HTTP PUT 保存）**：`updateWebAccessConfig 落盘 → HTTP 响应回包（res end 回调后才算完成）→ onConfigUpdated(generatedToken?) → controller restartFromDisk（停旧起新）`。**响应必须先于监听器重启**——stop 会 terminate 包括当前连接在内的全部 socket，先停后回会把保存请求自身的连接掐断。PUT 落盘与 IPC 保存不经同一把锁，磁盘 web-access.json 是唯一事实：若回包失败导致 restartFromDisk 未触发，任何后续生命周期操作（或下次启动）都会从磁盘重同步。
- **controller 生命周期操作（applyUpdate / reloadFromDisk / restartFromDisk / stop）串行化**：前序操作完成后才执行下一个。原因：并发 applyUpdate 的 start 在 `await` 后赋值 `#handle`，交错时后发操作的失败分支会把先发操作刚赋值的存活 handle 置 null，监听器孤儿化、永远无法 stop。`restartFromDisk` 与 `reloadFromDisk` 的差别：后者只在监听器未运行时拉起（服务 app ready 恢复），前者对运行中的监听器强制停旧起新（mode/bind/token 变更必须重建监听才生效）。
- `stop()` 语义：先 `terminate()` 全部活动 WS 桥与 `closeAllConnections()`，再 `wss.close()` + `server.close(cb)`；**必须无条件在有限时间内 resolve**。存在在线客户端时若只 `close()` 等待客户端自行断开，`server.close` 回调永不触发 → 设置页保存/停用挂死、新 token 永不生效。
- controller `stop()`（退出屏障）不改 `desktopEnabled`，下次启动按磁盘恢复。

## 帧与缓冲边界

- 浏览器方向是 SocketProtocol 分帧（13 字节头：type u8 | id u32BE | ack u32BE | length u32BE），Host 端 MessagePort 是裸消息；桥做帧转换，非 Regular 帧丢弃。
- **解码器自带增量缓冲，不使用 ChunkStream**：VSBuffer 底层是普通 Uint8Array，其 slice 是整段拷贝，ChunkStream 逐帧 read 对大 chunk + 多小帧是 O(n²)（实测单条 1MB 消息 / 8 万小帧烧 25s main 进程 CPU）。自实现缓冲必须均摊线性：倍增扩容、按 offset 零拷贝解析、返回独立拷贝的 payload。
- **上限**：单帧声明 length > 64MiB 立即拒绝；解码缓冲累积 > 32MiB（永远凑不齐一帧的恶意字节流）拒绝。超限断开该 WS（close 1009）并释放对应 port。`WebSocketServer.maxPayload` 取 64MiB 兜底。
- Host → 浏览器方向：flow-control 对象不透传；数据帧无应用层背压（与 server 形态一致，已知取舍）。

## 静态资源

- 路径判定与 server 形态 `isInsideDirectory` 同语义（`path.relative` + `..` 段检查），拒绝兄弟目录与穿越。
- 统一响应头：`x-content-type-options: nosniff`、`referrer-policy: no-referrer`。CSP / X-Frame-Options 暂不设置（远端 UI 是否允许嵌入未决策，后续按需收紧）。
- SPA fallback：未命中资产且路径**非 `/api` 前缀**时回 `index.html`；`/api` 空间未挂载的路径一律 404 JSON（见「所有权」末条）。
