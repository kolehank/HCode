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
- **展示回退链（mode-aware，唯一来源 `@zcode/shared` 的 `resolveWebAccessDisplayBaseUrl`）**：已配置基址 > 建议网卡地址（仅 token/CF 档）> 本机回环。**open 档监听被强制绑回环，LAN 地址必不可达，回退固定回环**；token/CF 档允许非回环 bind，二维码的意义是给其他设备扫，故优先建议网卡。回退值**仅用于展示**（二维码/复制链接），不落盘、不参与 Origin 校验——外部访问语义始终以磁盘配置为准。port 未就绪（server 未运行）时无回退值，UI 按无链接处理。
- **访问链接拼接**：`buildAccessUrl(基址或回退值, token)` 单一来源，三处调用点（desktop IPC 保存、desktop 内嵌 HTTP PUT、server 形态 PUT）与 UI 弹窗共用同一回退链。
- **设置页网卡联动**：加载时基址为空则回显当前建议网卡的 `http://<ip>:<端口>`（可见可编辑，不静默写盘）；切换网卡时仅当基址为空或仍是上一条自动建议才跟随新选择，**用户手填的域名/反代地址优先，不被覆盖**。保存成功后从保存响应同步端口/令牌状态回 UI（port 未运行时为 0，保存启动 server 后须刷新，否则「服务端口」不显示、联动失效）。
- **手机快捷弹窗（QuickDialog）**：数据面走 desktop IPC（getConfig + getInterfaces）。open 档基址为空时直接展示回退地址二维码；token 档无一次性明文时维持 regenerate 引导。展示回退地址时须标注「自动建议、不落盘」。

## 生命周期与并发

- 事件顺序（保存配置）：`updateWebAccessConfig 落盘 → stop 旧监听（强断全部 WS 桥）→ 按新配置 start`。mode/bind 变更必须先停后起，不允许新旧快照并存。
- **事件顺序（desktop HTTP PUT 保存）**：`updateWebAccessConfig 落盘 → HTTP 响应回包（res end 回调后才算完成）→ onConfigUpdated → controller restartFromDisk（停旧起新）`。**响应必须先于监听器重启**——stop 会 terminate 包括当前连接在内的全部 socket，先停后回会把保存请求自身的连接掐断。PUT 落盘与 IPC 保存不经同一把锁，磁盘 web-access.json 是唯一事实：若回包失败导致 restartFromDisk 未触发，任何后续生命周期操作（或下次启动）都会从磁盘重同步。
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
