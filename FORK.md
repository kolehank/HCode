# HCode — ZCode BYOK Fork

本仓库是 ZCode（v3.16.2）的 **BYOK（Bring Your Own Key）中性 fork**：移除厂商登录认证与全部遥测，模型流量只指向用户自配端点，可长期 rebase 上游。改造方案与 D1–D15 决策记录见 `BYOK-FORK-PLAN.md`；重建交接见 `BYOK-HANDOFF.md`；实施过程笔记见 `docs/byok/REBUILD-NOTES.md`。

- 版本线：**3.100.x**（与上游 3.14/3.15/3.16 脱钩；数据目录沿用 `~/.zcode`，官方版会话数据原地可读）。
- 基线：`zai-org/ZCode` v3.16.2（upstream main 同步），参考实现：`kolehank/ZCode` v3.100.0（前一轮 fork）。

## 改造状态（2026-10-24 完成）

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 遥测全删：ARMS RUM 模块群、数仓埋点、CLI OTLP 整包、崩溃转储、设备标识；UI 调用面保留 no-op 接缝（`reportTelemetryEvent` → 平台实现为空）；协议 schema 保留 | ✅ |
| P1a | 云功能删除：会话分享、官方 MCP、off-peak 厂商端、厂商额度（usage-stats/coding-plan-subscription）、client-config 拉取、feedback | ✅ |
| P1b | OAuth 登录体系删除（services/web/UI/desktop/CLI 四层）；byok-builtin provider 模板（20 个 api-key 模板）；内置 provider CDN 远程同步器删除；产品端点 fail-closed（`.invalid`） | ✅ |
| P1c | Bot 渠道删除（Telegram/飞书/微信，`@larksuiteoapi/node-sdk` 移除） | ✅ |
| P1d | 营销族删除（rewards webview / marketing-touch / highspeed 加速卡 / 领套餐 / cloud-content） | ✅ |
| P2 | 凭证升级：AES-256-GCM 格式不变，主密钥改 OS keychain（Win=DPAPI / macOS=Keychain / Linux=secret-tool）；`ZCODE_CREDENTIAL_SECRET` 显式覆盖；legacy 本机推导密文自动重加密迁移；明文 buffer 用后清零 | ✅ |
| P3a | 官方跨网中继删除（desktop relay 模块群 + web 手机端 relay 模块） | ✅ |
| P3b | Web 三档鉴权：open（强制 `127.0.0.1`）/ cloudflare-access（jose 验签）/ token（SHA-256 哈希 + timingSafeEqual）；`web-access.json` 持久化；`ZCODE_WEB_BIND_HOST` 别名 | ✅ |
| P4 | Onboarding BYOK 动线：欢迎（纯 API Key 屏）→ workspace → Provider 配置 → 完成；occupation 问卷删除 | ✅ |
| P5 | 本地用量账本：`~/.zcode/v2/usage-ledger.sqlite`，usage.delta 事实旁路落盘，按 provider/model/day 聚合；设置页「本地用量」；**仅本地，永不作为上报源** | ✅ |
| P6–P8 | 远程资源 CDN fail-closed（`ZCODE_CDN_BASE_URL` 自托管入口）；autoUpdater 默认关闭（`ZCODE_AUTO_UPDATE=1` 显式启用）；feedback/community 链接中性化 | ✅ |
| A2 | 桌面内嵌远程访问：main 内嵌 HTTP/WS（默认 `127.0.0.1:30330`，`ZCODE_WEB_REMOTE_PORT` 覆盖），静态 serve web 前端，WS 桥 `web-remote-replayable` 到主窗口 Host，复用三档鉴权，保存即时重建监听；设置页「远程访问」（QR/复制链接/网卡枚举双模式） | ✅ |
| CUA | Computer Use：vendored producer 0.6.3 运行时替换占位包（Windows helper 载荷 + runtime-manifest 契约 + sharp 依赖）；检测门自动激活打包链；**v1 仅 Windows**（macOS 需 Developer ID 签名产线，`ZCODE_PACK_MAC_CUA_HELPER=1` 显式开启） | ✅ |
| 插件 | 市场第二源：`zai-org/zcode-plugins` git 源（社区 ~53 插件按需安装）；官方 CDN 匿名资产源保留 | ✅ |
| CI | `pnpm fork:guard`（出网/遥测门禁 0 违规）+ `ci.yml`（push/PR：guard+typecheck+lint）+ `build.yml` gate | ✅ |

## 使用配置

### BYOK Provider（核心）
设置 → 模型 Provider → 选择模板（OpenAI / Anthropic / DeepSeek / Kimi / Qwen / OpenRouter / Z.ai Coding Plan API Key 等 20 个）→ 填 base URL 与 API Key。Key 经 OS keychain 主密钥加密存 `~/.zcode/credentials.json`（CLI TUI 与 Desktop 互通）。企业批量：`ZCODE_CREDENTIAL_SECRET` 固定主密钥。

### 远程访问（tailscale / cloudflared）
设置 → 远程访问：
- **open**：无鉴权，server 强制回环；配 `tailscale serve` 或 cloudflared 隧道。
- **cloudflare-access**：填 team domain + AUD（+可选邮箱白名单），边缘完成认证。
- **token**：随机生成（配置只存哈希），QR/链接 `#token=` fragment 一次性展示。
桌面端（A2）：同一设置页开关打开内嵌入口（`127.0.0.1:30330`）。

### 远程 SSH workspace 资源自托管
```
pnpm build:bootstrap
# 产物按 <base>/zcode/electron/releases/<version>/ 放静态服务器
ZCODE_CDN_BASE_URL=https://your-host pnpm dev:desktop
```
未配置时远程资源下载快速失败（不出网）。

### 从官方版迁移
官方版退出登录 → 安装 fork → 历史会话（`~/.zcode/v2/sessions/`）全部可读；首次续聊重选 BYOK provider；旧密文凭证首次读取自动重加密迁移；`telemetry-state.json` 为死数据可手删。

## CI 打包（GitHub Actions）
- `ci.yml`：push/PR → fork:guard + typecheck + lint。
- `build.yml`：手动 / `v*` 标签 → gate（fork:guard+lint+typecheck+单测）→ 三平台安装包（Windows nsis / macOS dmg 未签名 / Linux AppImage+deb+rpm+pacman）+ CLI SEA 单文件二进制 → GitHub Release。
- CI 打包前需构建 web 前端（A2 内嵌静态资源断言依赖 `build:bootstrap` 含 web build）。

## 验收门禁
`pnpm verify:pre-push` = lint + db schema + architecture + affected 单测 + **fork:guard**。
- 出网冒烟（发版前手动）：跑完 onboarding + 一轮 BYOK 会话（本地 mock 端点），断言除用户配置端点外零连接；断网启动无隐藏重试外呼。
- 回归点：官方版会话数据原地可读；远程 SSH 连通；CLI/Desktop 凭证互通；web 三档切换与 QR；手机 `mobileRemote` 扫码接入。

## fork:guard 白名单（允许保留清单）

| 类别 | 文件/模式 | 理由 |
|---|---|---|
| 用户自有 Key 模型通道 | `byok-builtin.json`、`coding-plan-api-key.ts`、`official-coding-plan-gateway.ts` 等 | 指向模型 API 而非产品云（BYOK 合法） |
| 官方插件资产 CDN | `plugin-marketplaces.ts`、`official-plugin-definitions.ts`、`officeSuggestedPrompts.ts` 等 | 匿名入站 GET（D10/R6 保留） |
| 上游对照 | `config/provider/zcode-builtin{,.test}.json` | 不参与装配（D4），仅对照 |
| no-op 接缝注释 | `create-app.ts` / `telemetry-bootstrap.ts` / `runtime-cleanup.ts` | 注释说明已删除语义，非实现 |
| 测试 fixture | 各 test 文件的 API 端点常量 | 测试数据，测试进程不出网 |

## 已知风险登记

- **Windows CUA Host↔Helper 管道无对端鉴权（Q12a 决策）**：vendored helper 的 `WINDOWS_PEER_IDENTITY_GATE_TEMPORARILY_OPEN = true` 对同机任意进程开放输入/屏幕观察。上游 Windows 原生模块缺全部四个对端校验原语，DACL 需原生改动；gate 关闭等于 Windows 禁用 CU。等上游原语落地后重审。（Agent↔broker 管道已有 bearer token 鉴权。）
- **macOS CUA 未随包分发**：需 Developer ID 签名 + notarization 产线；未配置前 macOS 设置区块报不支持。
- **CUA Windows e2e / 三端安装包**：CI 出包后需真机验证（fork 树仅验证检测门翻转 + typecheck + manifest 契约兼容）。
- **上游预存问题**（非本 fork 引入）：desktop `desktopBrowserPlatformBridge` 的 window.zcode 类型报错、`styles.css` 副作用导入、test 文件 node 类型——已在 CI gate 中按预存豁免。

## Rebase 指南
- 跟 upstream main（`chore: sync ZCode source` 节奏）；冲突高发区：`packages/services/src/node.ts`、`packages/desktop/src/main/index.ts`、`packages/ui/src/v4/SessionPane.tsx`。
- 上游新增遥测/云功能模块：按 P0/P1 模式物理删除出网收口、保留 no-op 接缝；上游新增 api-key 型 provider 模板：并入 `byok-builtin.json`。
- rebase 后必跑：`pnpm verify:pre-push` + CLI `turbo run typecheck`。
- 白名单改动必须先在本文件登记理由。
