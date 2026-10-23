# ZCode BYOK Fork 交接工作指南

> 用途：下一个 agent 将基于全新上游代码重新实现本 fork 的 BYOK 改造。本文总结 fork 已完成的 BYOK 能力、实现策略与验收要求，作为重做依据。权威细节以 `BYOK-FORK-PLAN.md`（D1–D15 决策清单）与 `FORK.md`（改造状态、白名单、回归点、风险登记）为准，重做前必读。

## 1. fork 定位与第一约束

- 目标：把 ZCode 改造为 **BYOK（Bring Your Own Key）中性工具**——移除厂商登录认证与全部遥测，模型流量只指向用户自配端点；同时保留官方版既有产品能力（会话、远程 SSH workspace、插件市场、Computer Use、手机远控等）。
- **第一约束是 rebase 友好**，所有改动按三类执行：
  1. 出网收口处 → **物理删除**（模块自包含、注册点集中，上游后续改动自然落在已删文件上，冲突好解）；
  2. 调用面 → **保留接口 + 平台实现改 no-op 接缝**（上游新增调用编译通过且静默无操作，避免每次跟随上游手工排查）；
  3. 协议 schema → **纯类型层保留**，只删实现（删了每次上游动协议都冲突）。
- fork 版本号独立（3.100.x）；数据目录沿用 `~/.zcode`（D13：协议兼容、迁移成本最低）。

## 2. 已完成的 BYOK 功能（重做范围）

### P0 遥测全删
- 删除：ARMS RUM 模块群（desktop main 下十余个模块）、数仓埋点 `telemetryCore`、CLI OTLP（`@zcode/telemetry` 整包）、DAU 心跳、Electron `crashReporter` 崩溃转储（D12：本地 dump 也是 BYOK 密钥泄露面）、设备遥测 env 捕获。
- 保留：`IPlatformService.reportTelemetryEvent / reportArmsCustomEvent` 接口与 preload/web 平台的 no-op 实现；`packages/shared` 遥测协议 schema；`runtimeEnv.ts` 中 OTEL/ZCODE_TELEMETRY 键保留在子进程 env 清洗黑名单（防泄漏给 Bash/MCP 子进程，不是遥测实现）。
- 成效：除用户配置的模型端点外零遥测出网；上游新增埋点自动失效，不产生跟随负担。
- 踩坑提醒：曾出现 no-op stub 破坏调用时序、静默杀死每个 prompt turn 的缺陷——删遥测必须用端到端对话验证，不能只看编译绿灯。

### P1 厂商认证与云功能删除
- P1a 云功能全删：会话分享、官方 MCP、off-peak 闲时任务、厂商额度（usage-stats / coding-plan-subscription）、feedback、`/api/v1/client/configs` 远程配置拉取、force-update gate。**注意保留本地 context window 用量条**——那是本地上下文计量，与厂商额度无关。
- P1b OAuth 全删：services / web / CLI 三层登录体系、deep-link OAuth 回调、token 刷新；CLI login 改为 API-key 流程；旧「连接使用」等登录 UI 入口全部退役。
- 内置 Provider（D4）：新增 `config/provider/byok-builtin.json`，仅 OpenAI-compatible / Anthropic-compatible 两个 api-key 模板，经既有 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 指向；上游 `zcode-builtin.json` 原样保留但不参与装配（零冲突、可对照）。产品 API 默认端点 fail-closed（`*.invalid` 占位）。
- 成效：源码零厂商云域名；官方版老会话数据原地可读，续聊引导重选 Provider。

### P2 凭证存储升级（keychain 主密钥）
- AES-256-GCM 文件格式不变；主密钥改为 OS keychain 随机密钥：Win=DPAPI / macOS=Keychain / Linux=secret-tool；desktop 侧经 safeStorage 包装（需 main↔host encrypt/decrypt IPC）；CLI TUI 与 Desktop 共享同一 `~/.zcode/credentials.json` 互通。
- `ZCODE_CREDENTIAL_SECRET` env 可显式固定主密钥（企业 KMS 下发场景）；删除「本机信息推导」fallback；keychain 不可用时**报错拒绝存储，绝不静默降级**（Linux basic_text 降级必须显式拦截）；旧格式密文首次读取自动重加密迁移；解密明文 buffer 用后 `fill(0)`。
- 成效：密文换机/拷贝不可解；损坏文件沿用「拒绝覆盖 + 备份」语义，用户不会被锁死。

### P3 Web 三档鉴权（设置页「远程访问」，D9）
- 档 A open：无应用层鉴权，但 **bind 由代码强制 `127.0.0.1`**（不可配置组合出「无鉴权 + 非回环」），配 `tailscale serve` / cloudflared 隧道使用。
- 档 B cloudflare-access：`Cf-Access-Jwt-Assertion` 用 jose 验签（JWKS 缓存、exp、aud、可选邮箱白名单）。
- 档 C token：`crypto.randomBytes(32)` 随机生成，配置文件只存 SHA-256 哈希，明文仅在生成时刻经 UI 一次性展示（QR + 复制按钮 + `#token=` URL fragment 链接，不进代理日志）；支持重置轮换。
- 引导 UI：网卡枚举（过滤 docker/WSL/Hyper-V/VMware 等虚拟网卡、识别 100.64.0.0/10 tailscale 网段做优先建议）+ 自定义域名基址两种模式，建议值必须实时预览且可编辑；`ZCODE_WEB_BIND_HOST` 支持；网卡枚举仅在打开设置页时触发且接口受鉴权保护；档 B/C 下「修改鉴权配置」的写接口必须受当前鉴权保护。
- 成效：局域网直连、tailscale、cloudflared 三条路径都有安全默认值；手机 `mobileRemote` 与浏览器同链路接入（协议 `clientKind` 与 v4 握手不动，D14）。

### P4 Onboarding BYOK 动线（D5)
- 欢迎 → 选 workspace → 配 Provider（唯一路径，byok-builtin 模板）→ 完成；删除登录步骤与 occupation 问卷；无可用 provider 时 composer 引导到设置页而非报错。

### P5 本地用量账本（D6）
- `~/.zcode/v2/usage-ledger.sqlite`，按 provider / model / day 聚合五类 token 与请求数；数据源是 Provider 响应里现成的 usage（经 usage.delta fact bypass 注入，不动模型请求链路）；设置页「本地用量」区块。
- 红线：仅本地落盘，**永不作为任何上报源**（厂商额度面板的替代品）。

### P6–P8 自托管与分发
- autoUpdater 关闭（update-status 窗口保留但永不触发）；fork 发版走自己的 GitHub Releases。
- 远程 SSH workspace 资源自托管：构建产物按 `<base>/zcode/electron/releases/<version>/` 结构放任意静态文件服务器，`ZCODE_CDN_BASE_URL` / `ZCODE_DEPS_BASE_URL` 指向；未配置时快速失败，不再指向厂商 CDN；CI 用 `ZCODE_SKIP_REMOTE_ASSETS=1` 使安装包不内置远程资产。
- 文档/社区链接中性化；`updatePreparation.ts` / `releaseDownload.ts` 的 SHA-256 校验链路保留，服务自托管下载。

### A2 桌面内嵌远程访问
- main 进程内嵌 HTTP/WS 入口（`packages/desktop/src/main/webRemoteAccess/`）：静态 serve web 前端（`resources/web-dist`，打包前需构建 web）+ 复用 P3 三档鉴权；默认 `127.0.0.1:30330`（`ZCODE_WEB_REMOTE_PORT` 可覆盖，open 档强制回环）。
- `/ws` upgrade 鉴权后经 `AttachServicePort`（`clientMode=web-remote-replayable`）桥到主窗口 Host：手机/浏览器获得与 web 形态相同的前端与可恢复数据面；`web-access.json` 的 `desktopEnabled` 开关驱动启停；鉴权档位/开关保存后立即重建监听，无需重启应用；设置页桌面分支走 `IPlatformService.webRemoteAccess` IPC。
- 必须区分两条链路语义：desktop-continuous（实时）与 web-remote-replayable（恢复）；改 stream/snapshot/queue/重连时两条都要验证。
- 已修过的成熟度问题（重做时直接按修复后行为实现）：WS 桥曾混用两种帧协议；save IPC 曾把 invoke event 当 payload；保存失败错误详情未上 toast。

## 3. BYOK Provider 配置层的行为要求（模型请求正确性）

这组决定「配了 key 就能直接用」，重做时应作为行为契约并补测试：
- modelConfigRules 提供 catch-all 默认属性 + 默认 maxOutputTokens 映射；设置编辑器保存时**继承内置映射而不是清空**；字段按 api 类型解析；`defaultEnabled` 语义有契约测试。
- 采用上游 provider defaults 数据库作为默认值来源。
- 未配置任何 provider 时的兜底是引导到设置页，不报错。

## 4. fork 携带的其他自研特性（非 BYOK 手术，重做时自行决定去留）

- 会话分组视图：`ZCodeGroupedTaskView` 类型族（services/session）、`WorkspaceGroupedTasksSection` 等 UI、grouped draft 发送状态机、planShortcut slash kind；taskIndexRepo 的 fork 语义（syncTaskMeta、ACP 退役 guard、legacy claude snapshot 升级）。
- 桌面本地资源遥测 `hostSelfResourceTelemetry`：仅本地采样展示，无外发。
- Computer Use：设置页区块 + vendored 运行时，完整性由 `check-cua-vendor-integrity.mjs` 按 `runtime-manifest.json` sha256 门禁。
- Windows 标题栏帮助菜单、workspace web 远控触发、频道图标等 UI 小件。
- 动态工作流模式设置：用户的选择始终优先、设置行保持可见。

## 5. CI 与门禁（必须重建）

- `.github/workflows/build.yml`：三平台打包（Windows nsis / macOS dmg 未签名，签名钩子已预留 / Linux AppImage+deb+rpm+pacman）+ 可选 CLI SEA 单文件二进制；手动触发或 `v*` 标签自动建 Release 并上传产物；gate = fork:guard + lint + typecheck。
- `scripts/fork-guard.mjs`（`pnpm fork:guard`）：扫描厂商云域名与遥测栈 import/常量，0 违规才通过；白名单逐条登记理由于 FORK.md，**改白名单必须先登记**。这是防「上游改动悄悄恢复出网」的核心闸门。
- `pnpm verify:pre-push` = lint + 各包单测 + architecture:check + fork:guard。

## 6. 验收要求（重做的完成定义）

1. 静态：`pnpm typecheck`、`pnpm lint` 真实通过（不将已有失败写成通过）；fork:guard 0 违规。
2. 出网冒烟：跑完 onboarding + 一轮 BYOK 会话，**发送一条消息并收到模型回复**，断言除用户配置端点外零连接（含 WS）；断网启动无崩溃、无隐藏重试外呼。注意：turn 未启动类缺陷没有任何报错，配置绿灯 ≠ 对话链路可用，只有端到端聊天能暴露。
3. 回归点：官方版会话数据原地可读；远程 SSH workspace 连通且自托管下载成功；CLI TUI 与 Desktop 凭证互通；web 三档鉴权切换与 QR/token 流程；手机 mobileRemote 扫码/链接接入完成一轮对话（`web-remote-replayable` 恢复链路）。
4. 迁移路径（D11）：官方版退出登录 → 装 fork → 历史会话可读，续聊重选 BYOK provider；`~/.zcode/v2/telemetry-state.json` 为死数据，可手删。

## 7. 重做策略与注意事项

- 实施顺序：P0 → P1 → P2 → P3 → P4 → P5 → P6–P8 → 门禁收口；每阶段独立可交付、可回滚，P0/P1 完成即达到「中性 BYOK」最小可用状态。
- 环境：node/pnpm 版本以 `mise.toml` 为准；验证链条必须完整（typecheck 注意 `tsc -b` 增量脏缓存，必要时清 `dist/*.d.ts` 与 `.tsbuildinfo` 强制重建）；Windows 下 pnpm patch 要求字节级 LF 一致，`.gitattributes` 需对 `patches/*.patch` 固化 LF。
- 冲突高发区（历史经验）：`packages/ui` 的 `SessionPane.tsx`（遥测调用面所在）、`packages/services/src/node.ts`（服务装配）、`packages/desktop/src/main/index.ts`。
- 上游演进带来的新中性化点：上游引入了与厂商端点绑定的 request-verification 请求校验机制，BYOK 需要 no-op edition——保留类型形状、运行时全空实现，模式与遥测 no-op 接缝一致。
- 红线汇总：用量账本永不上报；档 A 强制回环不可配置绕过；keychain 失败拒绝存储不降级；产品 API 默认端点 fail-closed；出网只允许「用户配置的模型端点 + 匿名资产 GET 白名单」。

## 8. 交接物清单

| 文件 | 内容 |
|---|---|
| `BYOK-FORK-PLAN.md` | 全量改造方案与 D1–D15 决策记录（权威） |
| `FORK.md` | 改造状态、使用配置、fork:guard 白名单及理由、rebase 指南、已知风险登记 |
| `docs/specs/web-remote-access.md` | P3/A2 远程访问规格 |
| `config/provider/byok-builtin.json` | BYOK 内置 Provider 模板 |
| `scripts/fork-guard.mjs` | 出网/遥测门禁脚本 |
| `.github/workflows/build.yml` | 三平台打包 CI |
