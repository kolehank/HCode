# BYOK 重做实施笔记（byok-rebuild 分支）

> 工作分支 `byok-rebuild`（基线 = main @ 2be4a772, ZCode v3.16.2）。
> 方法：以当前代码为基础按共识全新实现；旧 fork（/tmp/zcode-oldfork，kolehank/ZCode v3.100.0）仅作参考。
> 共识清单见对话记录；本文是防上下文丢失的施工状态单。完成后本文件内容并入 FORK.md。

## 已定决策（浓缩）

- 范围：P0–P8 全量 + A2 + CUA（v1 仅 Windows）+ Bots 删除 + 营销族删除 + 官方中继删除 + 插件市场第二源 + CI 门禁。
- CUA：vendored 0.6.3 producer（旧 fork 拷载荷）恢复 + 上游检测门自动激活；断点修复清单见下。
- 版本 3.100.0 起；分支阶段化 commit；fork:guard + ci.yml 重建。
- 桌面本地资源遥测（hostSelfResourceTelemetry）不做；§4 其他自研特性不迁移。

## 关键技术事实（已核实，防重查）

1. **P0 扩容清单**（相对旧计划）：desktop main 新增 desktopMcpTelemetry、databaseStartupTelemetry、databaseStartupRelay、processResourceMcpTelemetrySource、zcodeDataSizeScanner、zcodeDataSizeWorker*；conversation-share 已 12 文件；official-mcp 仅剩 2 文件（officialMcpCredentials/IssuanceAudit）。
2. 路径漂移：clientConfigService → `packages/services/src/client-config/`；feedbackService → `packages/services/src/feedback/`；forceUpdateGuard 消散为 `packages/shared/src/forceUpdate.ts` + bigmodelCodingPlanSubscriptionProvider.ts:1441 消费。
3. `ZCODE_TELEMETRY_ENABLED` 上游已删；剩 `ZCODE_ARMS_RUM_ENDPOINT`(env.ts:53)、`ZCODE_TELEMETRY_REPORT_ENDPOINT`(env.ts:56)；`ZCODE_AUTO_UPDATE_ENABLED`(env.ts:61) 可直接用于 P7。
4. request-verification：上游 v3.15.1 起自带空实现（shared/ui/desktop/CLI 五层 stub），无需重做，fork:guard 加防回归检查。
5. P3：bind 变量是 `ZCODE_SERVER_HOST`（entry-http.ts:18 + http.ts:473 options.host 默认 localhost）；已有 `ZCODE_SERVER_AUTH_TOKEN`/authRequired 静态 token 雏形可扩展。
6. 内置 provider 消费链（3.16）：cli/provider-runtime-env.ts → provider-node materializer/download → desktop desktopProviderConfig.ts → services node.ts。**zcode-builtin-download.ts 有 CDN 下载逻辑**，P6 时删（fail-closed）。
7. zcode-builtin.json：20 模板 + 9 zhipu-account providerRules；byok-builtin.json 保留全部 api-key 型第三方模板（deepseek/moonshot/openai/anthropic/openrouter/qwen 等），剔除 zai/bigmodel 系模板 + 全部 providerRules + 隐藏 start/offpeak/highspeed 规则。
8. autoUpdater 调用点：desktop/src/main/index.ts:2208（`enabled: ZCODE_PRODUCT_FLAVOR==="production" && ZCODE_AUTO_UPDATE_ENABLED`）；crashReporter：desktopCrashCapture.ts:374 + appCrashCaptureBootstrap.ts:6。
9. P2 凭证 fallback：credentialCipherProvider.ts:30-37 与 cli/adapters credential-cipher.ts:93-100 的 defaultCredentialSecret() = platform+homedir+username 拼接 SHA-256。
10. Bots 删除面（完整地图见摸底报告，要点）：services/src/bots/（33 文件）+ bots/providers/（11）+ bot-project-runtime/ + server http webhook + BotsDialog UI 群 + @larksuiteoapi/node-sdk 依赖 + lark-cli 原生捆绑。勿伤：任务完成通知、broadcast 基础设施、WRC 对话框本体（只拆"管理机器人"区块）。
11. 营销族删除面：rewards webview 族、marketing-touch/（含 marketingAssetRegistry——注意 node.ts:2660 CloudContentService 复用它，cloud-content 随营销一起删）、highspeed/ 全目录 + UI 18 文件、manual-claim-plan、CodingPlanEmbeddedWebviewDialog 等。勿伤：contextUsage 本地用量条、global-notice、saved-workflows。
12. 官方中继删除面：desktop/src/main/web-remote-relay/、shared/src/web-remote-relay/、web/src/web-remote-control/ 的 transport 适配器、desktop webRemoteControlManager.ts、index.ts:898 env 注入段、WebRemoteControlDialog 中继配对 UI。
13. CUA 断点清单（R5 实施时用）：(1) 包根缺 zcodeCuaRuntime 契约（在 helper/win32-x64/package.json）→ 包根合并 {schema:1,windows:{entry:"helper/win32-x64/dist/windows-helper.js",nativeAddon:"helper/win32-x64/build/Release/ax_native.node"}}；(2) Sharp 闭包缺失 → producer 声明 sharp 依赖（激活 assertPackagedCuaSharp）或改 staging；(3) macOS bundled-cua-helper 无产物 → macOS 段单独门控跳过；(4) broker-server.js:887 injectPermissionBrokerAgentMcpServers 加 export；(5) 仅 win32-x64；(6) okResponse/parseRequestLine 签名漂移（零调用点，注释跟踪）；(7) export * 可能撞名（TS2308 观察）。d.ts 全用 HCode 占位版（冻结契约）。vendor/dist-index.js + helper/ 拷贝。
14. 旧 fork 提交史（参考顺序）：3c186e8 是 P0-P8 主手术 commit；8be4299/054b76e/d58dbcf/d576d08 是 byok-config 修复链；f1b6d96 是"no-op 杀 turn"教训；703d261 是删 lark-sdk relock；a53232e 是 vendor 插件+CUA 运行时；08089e0/9966d99 是 A2 两段；8ff0bce/45076ce/f4a90b0/aa6f0c6 是 A2 成熟度修复；c2697ae SEA manifest 断言。
15. CI：build.yml 已有三平台+SEA+Release；补 fork:guard 进 gate + 新 ci.yml（push/PR: lint+typecheck+fork:guard）。CUA 完整性门禁复用 desktop/scripts/windows-cua-helper-assets.mjs 的 verify 函数。
16. 插件市场第二源：packages/shared/src/plugin-marketplaces.ts DEFAULT_PLUGIN_MARKETPLACES 加 zai-org/zcode-plugins（git 源，参照 claude 市场的 source 格式 "zai-org/zcode-plugins"）。
17. 出网白名单（fork:guard 基线，旧 FORK.md 移植 + 扩充）：模型端点用户自配；官方插件市场 CDN 匿名 GET（cdn-zcode.z.ai/zcode/official-plugin/*）+ 新增 github 源；zcode-builtin-download 删除后无 CDN 刷新。
18. request-security-edition 各层 stub 保持空实现；fork:guard 检查关键文件保持空（防上游恢复实装）。

## 验收红线

- typecheck/lint 真实通过；fork:guard 0 违规；mock 端到端一轮对话成功；断网启动无外呼；官方老会话可读；CLI/桌面凭证互通；web 三档 + QR；mobileRemote 浏览器模拟验证；三端安装包 CI 出包。
- 版本号 3.100.0。

## 施工状态

| 阶段 | 状态 | commit |
|---|---|---|
| P0 遥测 | 进行中 | - |
| P1a 云功能 | 未开始 | - |
| P1b OAuth | 未开始 | - |
| P1c Bots | 未开始 | - |
| P1d 营销 | 未开始 | - |
| P2 凭证 | 未开始 | - |
| P3 web 鉴权+中继删除 | 未开始 | - |
| P4 Onboarding | 未开始 | - |
| P5 账本 | 未开始 | - |
| P6-P8 | 未开始 | - |
| A2 | 未开始 | - |
| CUA | 未开始 | - |
| 插件第二源 | 未开始 | - |
| CI | 未开始 | - |
| 验收 | 未开始 | - |
