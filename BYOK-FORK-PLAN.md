# ZCode BYOK Fork 改造方案

> 版本基线：ZCode v3.14.0（Apache-2.0）｜方案状态：待确认，确认后按 P0→P8 顺序实施
> 前置文档：《ZCode 全维度安全审计报告》（本方案的风险定位均来自该审计的代码证据）

---

## 0. 目标与已确认决策

**目标**：将 ZCode 改造为完全 BYOK（Bring Your Own Key）的中性工具——去掉厂商登录认证与全部遥测，所有模型流量指向用户自配端点，可长期 rebase 上游主线。

### 已拍板的决策清单

| # | 决策项 | 结论 |
|---|---|---|
| D1 | 云功能（会话分享/官方 MCP/off-peak 闲时/厂商额度） | 全部删除 |
| D2 | 遥测（ARMS RUM / 数仓埋点 / OTLP / DAU 心跳） | 出网收口处物理删除；调用面留 no-op 接缝；协议 schema 保留 |
| D3 | 凭证存储 | AES-256-GCM 文件格式不变；主密钥改为 OS keychain 随机密钥（desktop 走 safeStorage，CLI 走系统 keychain）；删除本机信息推导 fallback |
| D4 | BYOK Provider 配置 | fork 自带 `byok-builtin.json`，经既有 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 指向，**不改上游 `config/provider/zcode-builtin.json`** |
| D5 | Onboarding | 去登录步骤与 occupation 问卷；动线改为「选 workspace → 配 Provider → 完成」 |
| D6 | 用量账本 | 保留并新建：仅记 token 数，本地 SQLite，不做价格/成本（v1） |
| D7 | 更新分发 | 关闭 autoUpdater；fork 走自己的 GitHub Releases 手动分发 |
| D8 | 远程 SSH workspace | **保留**；运行资源自托管（静态文件服务 / GitHub Releases），纯配置实现 |
| D9 | Web 三档鉴权 | A（无鉴权）/ B（CF Access JWT）/ C（静态 token）全部实现，**UI 可选**（非 env 切换） |
| D10 | 插件市场 | **保留**（安装链路为匿名 HTTPS 下载，无厂商认证、无用户身份；官方插件源可覆盖） |
| D11 | 迁移路径 | 手动：官方版退出登录 → 装 fork → 重录 API Key；`telemetry-state.json` 为死数据，不删无影响 |
| D12 | 崩溃转储 | 关闭 Electron crashReporter（BYOK 密钥在堆内，本地 dump 也是泄露面） |
| D13 | 品牌与数据目录 | v1 保留 ZCode 名称与 `~/.zcode` 目录（协议/上游兼容，rebase 成本最低） |
| D14 | 移动端远程控制 | **保留并复用**：本质就是手机浏览器访问 web（协议 `clientKind: "mobileRemote"`，`agentV4ConnectionHandshake.ts` 消费；服务端 web 承载与 `web-remote-replayable` 恢复链路不动），与 D9 三档鉴权是**同一入口、同一套鉴权**。官方版跨网 relay（env 注入 `VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`）不激活，跨网路径由 tailscale/cloudflared 承担。截图中的二维码引导卡片属官方闭源部分（开源仓库无此 UI 与文案），fork 在 P3 自建 |
| D15 | ACP 协议 | 上游已主动退役（`nonCliAcpRetirement` 测试可证），不做；未来接 Zed 属新增独立事项 |

---

## 1. 总原则：以 rebase 友好为第一约束

长期维护 fork、定期 rebase 上游，冲突成本取决于**改动落在哪些文件**。所有改动分三类：

1. **出网收口处 → 物理删除**。这些是遥测/厂商外发的最后一跳，模块自包含、注册点集中，删除后上游对它们的后续改动会自然落在已删文件上，冲突反而好解（整块接受删除）。
2. **调用面 → 保留 + no-op 接缝**。UI 埋点调用点散布在 `SessionPane.tsx` 等热文件，第一刀不删；`IPlatformService.reportTelemetryEvent` 的平台实现改为 no-op——上游后续新增的埋点调用会编译通过且静默无操作，避免每次 rebase 手工排查。调用面清理放到观察几个上游版本之后分批做。
3. **协议类型 → 保留 schema 删实现**。`zcode-protocol-v4/telemetry.ts`、`ConversationShare*` 等 zod schema 是纯类型层，留着不用零成本，删了每次上游动协议都冲突。

**Rebase 机制**：
- 跟上游 **release tag**，不跟 main。
- 维护 `FORK.md`：删除点清单 + grep 门禁清单 + 改造决策记录（本方案确认后其精华并入）。
- CI 两条门禁（见 §3）。

---

## 2. 分阶段改造清单

### P0 遥测全删

**P0.1 出网收口物理删除**

| 模块 | 文件/目录 |
|---|---|
| 数仓事件上报 | `packages/services/src/telemetry/telemetryCore.ts` |
| ARMS RUM 模块群 | `packages/desktop/src/main/`：`appARMSBootstrap.ts`、`desktopStabilityTelemetry.ts`、`appTelemetryRuntime.ts`、`armsEventRedaction.ts`、`armsBrowserPerfLoadNudge.ts`、`armsUserIdentity.ts`、`desktopArmsCustomEvent.ts`、`desktopNetworkTelemetry.ts`、`networkTelemetryAggregator.ts`、`desktopRemoteUsageArmsTelemetry.ts`、`desktopResourceTelemetry.ts`、`desktopTelemetryFetch.ts`、`desktopZCodeDataSizeTelemetry.ts`、`zcodeDataSizeTelemetryState.ts`、`startupTelemetryDelivery.ts`、`desktopDeviceMid.ts` |
| CLI OTLP 遥测 | `apps/zcode-cli/packages/telemetry/`（整包）；`packages/services/src/zcode-agent/agentTelemetryEnv.ts`；`packages/services/src/node.ts` 中 telemetry env 组装段 |
| 共享常量 | `packages/shared/src/env.ts` 中 `ZCODE_TELEMETRY_ENABLED`、`ZCODE_TELEMETRY_REPORT_ENDPOINT`、`ZCODE_ARMS_RUM_ENDPOINT`（保留函数签名兼容点，见 P0.2） |
| 崩溃转储 | crashReporter 初始化调用（`appCrashCaptureBootstrap.ts`、`desktopCrashCapture.ts`、`crashDumpAnnotations.ts`——D12） |

**P0.2 调用面 no-op 接缝**

- `IPlatformService.reportTelemetryEvent`（`packages/shared/src/platform.ts`）保留接口；desktop 平台实现改为 no-op（一处）；web 平台实现改为 no-op（一处）。
- `packages/ui/src/lib/*Telemetry.ts`、`packages/ui/src/v4/telemetry/`（`conversationTelemetrySupervisor.ts`、`ConversationTelemetryAttachment.tsx`）暂保留，后续批次清理。
- `messageTelemetry.ts`（1502 行）自包含，可删；热文件内挂载点仅 1–3 行删除。

**P0.3 协议 schema 保留**：`packages/shared/src/zcode-protocol-v4/telemetry.ts` 等类型层不动。

**验收**：出网冒烟测试零遥测域名连接（§3）；`rg "armsRum|telemetryCore|OTEL_EXPORTER"` 源码内仅剩协议 schema 与 no-op 接缝。

### P1 厂商认证与云功能删除

| 功能 | 删除点 |
|---|---|
| OAuth 登录体系 | `packages/services/src/oauth/`（zai/bigmodel provider adapter、oauthService）；`packages/web/src/auth/`（`zaiWebOAuthProvider`、`webAuthService`、`browserOAuthCredentialRepo`）；`useRootOAuthEffects.ts`、`useOAuth.ts` 登录动线 |
| Coding Plan 额度 | `services/src/coding-plan-subscription/`、`usage-stats/providers/`（bigmodel/zcode MCP quota）；UI：`startPlanQuotaReminderStore`、`startPlanQuotaBuckets`、`sessionQuotaBannerState`、`ConversationQuotaBanner`、`CodingPlanUsageRemainingPanel`、`chat-input-toolbar/CodingPlanContextUsage`（注意：**保留 context window 用量条**，那是本地上下文计量，与厂商额度无关） |
| 会话分享 | `services/src/conversation-share/`（8 文件）；UI `ConversationShare*` 组件群；web `share/` landing |
| 官方 MCP | `services/src/official-mcp/`、`usage-stats/providers/zcodeMcpQuotaProvider.ts` |
| off-peak 闲时 | `services/src/session/offPeak*`；UI `lib/offPeakTelemetry.ts` 及相关组件 |
| 产品服务触点 | `client-configService.ts`（`/api/v1/client/configs` 拉取）；`feedbackService.ts`（飞书表单）+ `config/default.json` 的 `feedback_url/community_urls`；`forceUpdateGuard.ts`（随 D7 一并处理） |
| 内置 Provider 配置 | 新增 `config/provider/byok-builtin.json`：仅保留 `api-key` 访问类型的 OpenAI-compatible 与 Anthropic-compatible 通用模板；运行时经 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 指向（上游原文件不动，零冲突） |

**验收**：全仓 grep 无 `zcode.z.ai`（源码内）；登录相关 UI 入口消失；老会话可打开（历史记录可读），续聊提示重选 Provider。

### P2 凭证存储升级（keychain 主密钥）

- 改动集中两处同构文件：`packages/services/src/credential/providers/credentialCipherProvider.ts`、`apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts`。
- 密钥解析顺序：`ZCODE_CREDENTIAL_SECRET`（企业/KMS 显式配置）→ **OS keychain 随机主密钥**（首次运行 `crypto.randomBytes(32)` 生成存入 keychain；desktop 侧经 safeStorage 包装，CLI 侧走系统 keychain 命令）→ **删除本机信息推导 fallback**；keychain 不可用时报错拒绝存储，绝不静默降级（Linux 无 keyring 的 `basic_text` 降级必须显式拦截）。
- 补充加固：decrypt 出的明文 buffer 使用后 `fill(0)`（对齐 Chrome cookie 链路既有做法）。
- desktop 的 safeStorage 需 main↔host encrypt/decrypt IPC（上游 `credentialService.ts` 注释已预告此路径）。
- 兼容：读到旧格式（弱密钥加密）→ 迁移逻辑一次性重加密；解密失败按现有「拒绝覆盖、备份损坏文件」语义处理。

**验收**：`credentials.json` 密文在新机制下换机/拷贝不可解；CLI TUI 与 Desktop 共享同一凭证文件互通。

### P3 Web 三档鉴权（D9 详细设计）

**三档**：
- **档 A（默认）**：无应用层鉴权，**bind 强制 `127.0.0.1`**（代码约束，不可配置组合出「无鉴权 + 非回环」）。
- **档 B**：Cloudflare Access JWT 验签。中间件校验 `Cf-Access-Jwt-Assertion` 头：JWKS（`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`，缓存 1h）验 ES256 签名 + `exp` + `aud`（App 的 AUD tag），可选 email 白名单。前置条件：域名托管 Cloudflare + cloudflared 隧道 + Zero Trust Self-hosted App（免费档 50 用户内）。
- **档 C**：静态 Bearer token。

**Token 生命周期（随机生成、可轮换）**：
- 档 B/C 启动时若无有效 token → `crypto.randomBytes(32)` base64url 生成；**配置文件只存 SHA-256 哈希**，明文仅在生成时刻经 UI 展示一次（二维码 + 复制按钮 + 完整链接），此后 UI 只显示前 8 位前缀。
- UI 提供「重新生成」按钮：旧 token 立即失效（v1 重启 server 生效；热轮换后置）。
- 访问链接形态：`https://<地址>/#token=<token>`——用 **URL fragment** 携带，不进代理/访问日志；web 前端启动时从 `location.hash` 读取转入内存。
- QR 组件：`qrcode` 依赖已在 `packages/ui/package.json`（当前无使用点），新写一个展示组件：QR + 复制链接按钮 + token 前缀展示。触发时机：档 B/C 启动后首次打开设置页时展示，或 server 启动日志同步打印含 token 的完整 URL（headless 场景兜底）。

**Bind 矩阵（tailscale/cloudflared 两路径）**：
- 新增 `ZCODE_WEB_BIND_HOST`（默认 `127.0.0.1`）。
- **tailscale 路径一（推荐）**：`tailscale serve`——bind 保持 `127.0.0.1`，tailscaled 本机反代进 tailnet，自动 HTTPS + ACL 鉴权，**不需要绑 tailscale IP**。
- **tailscale 路径二**：直连 tailnet IP（100.x.y.z）——此时 `ZCODE_WEB_BIND_HOST=100.x.y.z`（或 `0.0.0.0` + 防火墙），必须搭配档 B/C。
- **cloudflared 路径**：cloudflared 连 `127.0.0.1`，bind 不变，搭配档 B。
- 约束固化：档 A 时 bind 配置强制回环（覆盖用户配置并告警）；bind 地址不进 UI，仅配置文件/env。

**Chicken-and-egg 细节**：档 B/C 下「修改鉴权配置」的写接口必须受当前鉴权保护；首次引导由「token 在本机生成 + QR/日志展示」闭环（部署者即本机操作者），无需独立引导 token。

**引导 UI（参照官方「移动端远程控制」卡片形态）**：
- 设置页「远程访问」卡片：二维码 + 「复制链接」 + 「刷新二维码」 + 状态行（等待连接/已连接） + 停止入口。
- **外部访问基址双模式**（二维码/链接内容 = 基址 + `/#token=<token>`）：
  - **模式一·网卡选择（默认快捷路径）**：server 侧 `os.networkInterfaces()` 枚举本机网卡，过滤虚拟/无效地址（docker0、vEthernet(WSL)、Hyper-V、VMware、VirtualBox host-only、loopback、169.254 链路本地），列表展示接口名 + 对应 IP；识别 `100.64.0.0/10`（tailscale 段）与默认路由网卡做**优先建议**；选中后实时预览最终链接 `http://<ip>:<端口>` 与二维码。覆盖局域网直连与 tailscale 直连（100.x 即网卡地址）。
  - **模式二·自定义基址**：手填域名/反代地址（`https://xxx.ts.net`、Cloudflare 域名等）。网卡枚举**覆盖不了域名型入口**（DNS 名不是网卡地址，且涉及 https/端口/路径），此模式兜底。
  - 设计红线：建议值必须**可见可编辑**（实时预览），不允许回到"静默探测、猜错不报"的模式。
- 档 A（无鉴权）时链接不含 token 段；档 B（CF Access）时链接即域名本身（认证在边缘完成），token 展示区块隐藏。
- 安全细节：网卡枚举仅在打开远程访问设置页时触发（不启动即扫）；枚举走配置 API——首次配置发生在档 A（强制 127.0.0.1）时仅本机可查，档 B/C 下该接口受鉴权保护，防止未认证请求探测内网拓扑。
- 官方发行版的该引导卡片不在开源仓库内（语言包与组件均无对应实现），fork 需自建；`qrcode` 依赖已在 `packages/ui/package.json`。

**实现落点**：web 前端由 `packages/server` HTTP 入口承载静态资源（`ZCODE_WEB_STATIC_ROOT` + SPA fallback）；鉴权中间件加在该 HTTP 入口（含 `/ws` 升级请求）；协议层 `clientKind: "mobileRemote"` 与 v4 握手（`agentV4ConnectionHandshake.ts`）不动，手机与浏览器同链路接入；配置读取 server 侧配置文件；改动重启生效。

### P4 Onboarding 改造

- 删登录步骤、occupation 问卷（`OccupationOnboarding*` 一族）。
- 动线：选择 workspace → 配置 BYOK Provider（唯一路径，`byok-builtin.json` 模板）→ 完成。
- 兜底：无任何 provider 配置时，composer 引导至设置页而非报错。
- 检查 `useOnboardingTrigger` 默认触发逻辑。

### P5 用量账本（token 数）

- 数据源现成：Provider 响应 usage（input/output/cache tokens）已通过 `ZCodeUsage` 协议事件流入 UI。
- 新增本地 `usageLedger`（`services/src/storage/` 基础设施，SQLite）：每次模型请求落一行——时间、providerId、model、四类 token、请求数。
- 设置页聚合视图：按 provider / model / workspace 维度。
- 红线：仅本地落盘，永不作为任何上报源；vendor 额度面板已删，ledger 是替代品。

### P6 远程 SSH 资源自托管（纯配置）

- 资源内容：远端服务端运行时（服务端 CLI/agent bundle、预编译原生工具如 ripgrep、依赖包）。
- 获取链路（既有，不改动）：桌面端从 CDN 下载经 SFTP 上传远端（SHA-256 校验）；或远端自行下载 release。
- 自托管：自己 `pnpm build` 出产物 → 静态文件服务器（nginx/caddy/GitHub Releases 均可，http/https 皆接受）→ 按 `<base>/zcode/electron/releases/<version>/...` 目录结构放置 → 配 `ZCODE_CDN_BASE_URL`（`desktop/src/main/remoteCdn.ts` 支持 env 覆盖）+ `ZCODE_DEPS_BASE_URL`（`shared/src/intranetDefaults.ts` 已有完整内网机制）。
- 官方插件资产（`zcodeAgentOfficialPluginAssets.ts`）为本地构建产物经 SFTP 白名单复制，无厂商依赖，不动。

### P7 更新分发

- 关闭 autoUpdater（`desktop/src/main/autoUpdater.ts` 初始化断开），删除 force update 远程配置检查（`forceUpdateGuard.ts`）。
- fork 发版：GitHub Releases 挂安装包，手动更新。

### P8 收尾杂项

- `config/default.json`：feedback/community 链接置空或移除展示。
- `updatePreparation.ts`/`releaseDownload.ts`（zcode-server-cli）保留——它们服务 P6 自托管下载，校验逻辑（SHA-256）不动。
- `telemetry-state.json`：不删（死数据）；迁移说明里写一句可选手动删除。

---

## 3. 验收门禁（CI 常驻）

1. **grep 门禁**：源码内禁止出现 `zcode.z.ai`、`armsRum`、`OTEL_EXPORTER`（白名单：协议 schema、no-op 接缝、FORK.md 文档）。
2. **出网冒烟测试**：起应用跑完 onboarding → 一轮 BYOK 会话（模拟 provider 用本地 mock 端点），断言除用户配置端点外**零网络连接**（含 WS）。
3. **离线测试**：断网启动 + 断网会话，无崩溃、无隐藏重试外呼。
4. **回归点**：官方版会话数据原地可读可搜；远程 SSH workspace 连通 + 资源自托管下载成功；CLI TUI 独立会话与 Desktop 凭证互通；web 三档鉴权切换与 QR/token 流程；手机浏览器以 `mobileRemote` 客户端扫码/链接接入并完成一轮对话（`web-remote-replayable` 恢复链路验证）。

## 4. 工作量评估

| 阶段 | 内容 | 估算 |
|---|---|---|
| P0 | 遥测全删 + no-op 接缝 | 2–3 人天 |
| P1 | 厂商认证与云功能删除 | 4–6 人天 |
| P2 | 凭证 keychain 升级 | 2–3 人天 |
| P3 | Web 三档鉴权 + QR | 3–4 人天 |
| P4 | Onboarding 改造 | 1–2 人天 |
| P5 | 用量账本 | 3–4 人天 |
| P6–P8 | 自托管配置/updater 关闭/杂项 | 1–2 人天 |
| 门禁+验收 | CI 门禁 + 出网/离线/回归测试 | 2 人天 |
| **合计** | | **约 18–26 人天** |

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 上游热文件（SessionPane 等）rebase 冲突 | 调用面留 no-op 接缝；删除挂载点控制在 1–3 行；`FORK.md` 记录每处改动 |
| 上游新增遥测调用点悄悄恢复出网 | CI grep 门禁 + 出网冒烟测试双保险；no-op 接缝保证行为无效 |
| 协议 schema 演进与 fork 删除的实现不一致 | schema 保留策略；门禁中加 schema↔实现一致性检查 |
| 凭证迁移失败导致用户被锁 | 损坏文件拒绝覆盖语义已内建（备份 + 报错）；`ZCODE_CREDENTIAL_SECRET` 显式配置可绕过 keychain 依赖 |
| 档位配置被未认证请求篡改 | 写接口受当前鉴权保护；token 本机生成 + QR 闭环引导 |

## 6. 实施顺序建议

P0（遥测，独立可验收）→ P1（认证删除，范围最大）→ P2（凭证）→ P3（web 鉴权）→ P4 → P5 → P6–P8 → 门禁收口。每阶段独立可交付、可回滚，P0/P1 完成后即达到「中性 BYOK」的最小可用状态。
