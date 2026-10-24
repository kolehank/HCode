# v3.100.0 真机测试指引

> 分支 `byok-rebuild`，tag `v3.100.0`。安装包：GitHub Releases → https://github.com/kolehank/HCode/releases/tag/v3.100.0
> 产物：Windows nsis `.exe`（x64）｜ macOS `.dmg`+.zip（arm64，未签名）｜ Linux AppImage/deb/rpm/pacman（x64）｜ CLI SEA 单文件 ×6 平台

## 安装前（从官方版迁移）

1. 官方版退出登录（可选；不退也不影响读取历史会话）。
2. `~/.zcode` 数据目录原地共用：历史会话、任务列表全部可读。
3. `~/.zcode/v2/telemetry-state.json` 是死数据，可手删（不删无影响）。
4. **凭证自动迁移**：旧 API Key 首次读取时自动用新 keychain 密钥重加密（无感）。

## 核心链路（按优先级）

### 1. BYOK 对话（最重要——turn 未启动类缺陷只有端到端能暴露）
设置 → 模型 Provider → 选模板（DeepSeek / Kimi / OpenAI / Anthropic / OpenRouter 等 20 个，或 zai/bigmodel 的 API Key 模板）→ 填 base URL + API Key → 保存。
新建会话发一条消息，**确认收到模型回复**。换一个 provider 再发一条。
> macOS 首次保存 Key 会弹 Keychain 授权（允许即可）；Linux 无 keyring 时会明确报错（设计如此，装 `libsecret-tools` 解决）；Windows 走 DPAPI 无感。

### 2. 用量账本
发过消息后：设置 → 数据与统计 → 本地用量。确认有今日记录（按 provider/model 聚合的 token 数）。

### 3. 远程访问（手机/浏览器）
设置 → 远程访问：
- **open 档**（默认）：desktop 内嵌 `127.0.0.1:30330`。同机浏览器打开即验。
- **token 档**：生成 token → 出二维码 + 复制链接（`#token=` 片段）。局域网另一设备扫码/输 URL。网卡枚举列表过滤了虚拟网卡；tailscale IP（100.x）有优先建议。
- 保存档位后**无需重启**，监听即时重建。
- 手机接入后跑一轮对话（`web-remote-replayable` 恢复链路：断开重连，会话应恢复）。

### 4. Computer Use（仅 Windows 真机可验）
设置 → Computer Use：开启后按 macOS 引导的对应流程（Windows 无需签名产线）。让 agent 执行 `list_windows` / 截屏描述 / 点击。
> macOS：CUA 区块默认报"不支持"（无 Developer ID 签名产线，v1 仅 Windows，FORK.md 已登记）。

### 5. 插件市场
设置 → 插件：默认两个源（官方 CDN + `zai-org/zcode-plugins` git 源）。从 git 源装一个社区插件（如 github/gitlab）确认可装可用。

### 6. 出网断言（可选，抓包/代理）
除你配置的模型端点 + 插件市场匿名下载外，应零连接。断网启动一次：无崩溃、无隐藏重试外呼。

## 已知限制（预期行为，非 bug）

| 项 | 说明 |
|---|---|
| macOS CUA | 不支持（无签名产线；`ZCODE_PACK_MAC_CUA_HELPER=1` + 证书后可开） |
| macOS 安装包未签名 | 首次打开需右键→打开，或 `xattr -dr com.apple.quarantine` |
| autoUpdater | 已关闭（设置页检查更新不会拉取；新版本手动下载） |
| 远程 SSH 资产 | 默认快速失败；自托管需设 `ZCODE_CDN_BASE_URL`（FORK.md P6） |
| Windows CUA 管道 | Host↔Helper 管道对同机进程开放（上游决策，FORK.md 风险登记） |
| CLI `zcode login` | 打印 BYOK 指引退出；`/login`（TUI）收敛为 coding-plan-api-key 手动配置 |

## 问题反馈

跑 `~/.zcode/v2/logs/`（或设置→导出日志）附带现象贴给开发。出网问题附抓包截图。
