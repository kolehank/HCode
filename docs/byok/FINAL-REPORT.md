# BYOK Fork 重做 · 最终报告

> 交付：`byok-rebuild` 分支（25 commits）｜版本 `v3.100.0`｜安装包 https://github.com/kolehank/HCode/releases/tag/v3.100.0
> 基线：ZCode v3.16.2（上游 main 同步）｜方法：以当前代码为基础全新实现，旧 fork（kolehank/ZCode v3.100.0）仅作参考

## 一、交付物

| 产物 | 状态 |
|---|---|
| Windows x64 nsis 安装包（200MB，含 Computer Use 运行时） | ✅ Release 可下载 |
| macOS arm64 dmg+zip（未签名） | ✅ Release 可下载 |
| Linux x64 AppImage/deb/rpm/pacman | ✅ Release 可下载（4 格式） |
| CLI SEA 单文件二进制 ×6 平台 | ✅ CI 构建成功（artifact 可取；Release 上传因网络中断改从 artifacts 获取） |
| fork:guard 出网门禁 + ci.yml 常规 CI | ✅ 0 违规 / push·PR 自动跑 |
| FORK.md / BYOK-FORK-PLAN.md / 真机测试指引 | ✅ 随仓库 |

## 二、改造内容（全部完成）

| 阶段 | 内容 | 关键点 |
|---|---|---|
| P0 | 遥测全删 | ARMS RUM 模块群/数仓埋点/CLI OTLP 整包/崩溃转储/设备标识；数据库启动状态同步等本地功能保留；协议 schema 保留 |
| P1a | 云功能删除 | 会话分享/官方 MCP/厂商额度/off-peak 厂商端/client-config/feedback/force-update |
| P1b | OAuth 删除 + BYOK 模板 | 四层登录体系删除；`byok-builtin.json`（20 个 api-key 模板含 zai/bigmodel 自有 Key 型）；内置 Provider CDN 远程同步器删除；产品端点 fail-closed（.invalid） |
| P1c | Bot 渠道删除 | Telegram/飞书/微信全链（-5.5 万行，lark-sdk 移除）；任务通知/broadcast 基础设施保留 |
| P1d | 营销族删除 | rewards webview/marketing-touch/highspeed 加速卡/领套餐/cloud-content |
| P2 | 凭证 keychain 升级 | 主密钥 OS keychain（DPAPI/Keychain/secret-tool）；旧密文自动重加密迁移；明文 buffer 清零；CI Linux 无 secret-tool 时 fail-closed（设计行为） |
| P3a | 官方中继删除 | desktop relay 模块群 + web 手机端 relay 模块；mobileRemote 协议保留 |
| P3b | Web 三档鉴权 | open（强制回环）/ cloudflare-access（jose 验签）/ token（SHA-256+timingSafeEqual）；单测 3/3 |
| P4 | Onboarding BYOK 动线 | 欢迎（纯 API Key 屏）→ workspace → Provider → 完成 |
| P5 | 本地用量账本 | usage-ledger.sqlite，usage.delta 旁路落盘；设置页聚合视图；**永不外发** |
| P6-P8 | 自托管/更新/杂项 | CDN fail-closed（ZCODE_CDN_BASE_URL）；autoUpdater 默认关闭；链接中性化 |
| A2 | 桌面内嵌远程访问 | 127.0.0.1:30330 HTTP/WS + 三档鉴权 + QR/网卡枚举 UI；单测 24/24 |
| CUA | Computer Use | vendored producer 0.6.3 替换占位包；检测门自动激活；**v1 仅 Windows**（mac 需签名产线）；Windows 载荷入库 + 完整性链路 |
| R6 | 插件市场第二源 | zai-org/zcode-plugins git 源（~53 社区插件） |

## 三、质量验证

| 项 | 结果 |
|---|---|
| fork:guard（厂商域名/遥测栈扫描 10053 文件） | 0 违规 |
| pnpm typecheck | 0 错误 |
| pnpm lint | 0 errors（266 warnings 为上游预存） |
| pnpm test 全量 | **15697 passed / 0 failed**（另修复 3 个 stub 误伤真实 bug：SessionPane/Subagents/AutomationEditView 模型提交被拦） |
| CI gate（同上四项在 Ubuntu runner） | ✅ |
| 三平台打包 + SEA | ✅（经 6 轮迭代修复 4 个打包期 bug，见下） |

## 四、过程中的关键修复（根因记录）

1. **测试期望未跟上删除**（996→158→7→0 三轮）：纯测已删功能的删文件；混合文件删过时用例；3 个真实 stub bug 修复。
2. **CI 环境差异**：credentialCacheRecovery 测试注入显式 secret cipher（Linux runner 无 secret-tool）。
3. **vendored CUA 运行时在 CJS bundle 崩溃**：顶层 `createRequire(import.meta.url)` 改惰性解析（影响 SEA+桌面打包全链）。
4. **tsup 残留 entry**：P0 删的 zcodeDataSizeWorker 仍列在 tsup entry，干净 checkout 必挂（本地有缓存干扰判断，git worktree 干净环境定位）。
5. **A2 的 beforePack 覆盖 bug**：第二个 beforePack 键覆盖原 hook，node-pty linux 预编译拷贝与 NSIS patch 失效——合并修复。
6. **CUA Windows 载荷被 .gitignore 拦截**：`dist/` 与 `**/build/Release/*.node` 规则挡了 vendored 载荷——gitignore 例外 + 强制入库。
7. **Release job 缺 checkout**：gh release create 无 git 上下文失败——已修复（本版资产手动补传）。

## 五、已知限制与风险登记（非 bug，FORK.md 同步登记）

| 项 | 说明 |
|---|---|
| macOS CUA 不支持 | 无 Developer ID 签名产线（`ZCODE_PACK_MAC_CUA_HELPER=1` + 证书后可开） |
| macOS 安装包未签名 | 右键→打开 或 xattr 解隔离 |
| Windows CUA Host↔Helper 管道无对端鉴权 | 上游 vendored 载荷的刻意决策（Windows 原生缺校验原语，DPL 决策 Q12a 维持+登记） |
| autoUpdater 关闭 | 手动下载更新 |
| 远程 SSH 资产 | 默认快速失败；自托管设 `ZCODE_CDN_BASE_URL` |
| CLI adapters 个别 bash 类用例满载并发 flaky | 环境负载问题（fork 未触碰 src/exec/，git diff 证据） |

## 六、真机验收清单（按优先级）

1. **BYOK 对话**（最重要）：设置→Provider→填 Key→发消息收到回复（turn 未启动类缺陷只有端到端能暴露）
2. 用量账本出现记录；3. 远程访问 token 档手机接入+断线恢复；4. Windows Computer Use；5. 插件市场装社区插件；6. 抓包断言除模型端点外零外呼

详见 `docs/byok/DEVICE-TEST-GUIDE.md`。

## 七、后续建议

- 真机反馈的问题按 FORK.md 的 rebase 指南修复（跟 upstream main）
- SEA 二进制可后续补传 Release（网络稳定时从 artifacts 重传）
- `v3.100.1+` 发版：push tag 即全自动（Release job 已修）
