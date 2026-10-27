# Cloudflare Access 档：逐步测试指引

> 适用：设置 → 远程访问 → 鉴权方式选 **Cloudflare Access**（`cloudflare-access`）。
> 目标形态：桌面端内嵌入口（默认 `127.0.0.1:30330`）挂在 Cloudflare Tunnel 后面，由 CF Access 完成身份认证，ZCode 侧校验 JWT。
> 相关实现与规则：`docs/specs/web-remote-access.md`（鉴权矩阵、Origin/Host 校验、allowlist 语义）。
> 只想「零账号、临时公网访问」时请用设置页的「临时公网通道（Cloudflare Quick Tunnel）」：它走 token 鉴权、随机 `trycloudflare.com` 域名，无需 Cloudflare 账号，但地址每次启动变化且没有身份认证——与本指南的 CF Access 是两套方案，不要混用。

## 0. 先理解这条链路（排障时按层定位）

```text
手机/浏览器
   │  HTTPS https://zcode.example.com
   ▼
Cloudflare Edge / Access         ← 未登录先跳 CF 登录页；登录后注入 Cf-Access-Jwt-Assertion
   │  反代（cloudflared tunnel 或其它）
   ▼
ZCode 内嵌入口 127.0.0.1:30330   ← 每个 /ws* 与 /api/* 请求验 JWT（issuer/audience/签名/email）
   │  WS 升级通过后桥接到 Host
   ▼
桌面会话运行时
```

两个关键结论，后面用例会反复用到：

- **静态页面（`/`、assets）不鉴权，`/ws*` 与 `/api/*` 必验 JWT**。所以「页面能打开」不等于「CF 档生效」。
- **CF 档下 desktop 不挂载 `/api/web-access/*`**（一律 404 JSON）。本机浏览器设置页在 CF 档下不使用该接口，IPC 不受影响。

## 1. 前置条件

1. 一个已托管在 Cloudflare 的域名（NS 已切到 CF）。
2. Cloudflare 账号已开通 **Zero Trust**（首次进入会要求设置 team name，即 team domain 的前缀）。
3. ZCode 桌面端已安装，设置 → 远程访问里能看到入口开关（当前版本 ≥ 3.100.9）。
4. 本机 30330 端口未被占用。想换端口：设环境变量 `ZCODE_WEB_REMOTE_PORT`（Windows 改完需重启应用）。

## 2. 建隧道（把公网域名接到本机 30330）

### 2.1 安装 cloudflared

Windows（PowerShell，管理员）：

```powershell
winget install --id Cloudflare.cloudflared
cloudflared --version
```

macOS：`brew install cloudflared`；Linux：按官方 apt/rpm 源安装。

### 2.2 创建隧道并落 DNS

```powershell
cloudflared tunnel login
cloudflared tunnel create zcode
cloudflared tunnel route dns zcode zcode.example.com
```

> `zcode.example.com` 换成你的子域。DNS 会生成一条指向 `<tunnel-id>.cfargotunnel.com` 的 CNAME。

### 2.3 配置 ingress

新建 `%USERPROFILE%\.cloudflared\config.yml`（macOS/Linux 为 `~/.cloudflared/config.yml`）：

```yaml
tunnel: zcode
credentials-file: C:\Users\<你的用户名>\.cloudflared\<tunnel-id>.json

ingress:
  - hostname: zcode.example.com
    service: http://127.0.0.1:30330
  - service: http_status:404
```

启动并保持运行：

```powershell
cloudflared tunnel run zcode
```

> **不要**在 ingress 里改 `httpHostHeader`。默认会把公网 Host 透传给源站，这是 ZCode 的 Origin/Host 校验所期望的（浏览器 `Origin` 与请求 `Host` 同源）。

### 2.4 此时出口还未加保护

现在直接用浏览器打开 `https://zcode.example.com` 应该能加载页面（因为静态资源不鉴权）。这一步只验证隧道通了，**先不要**把它当成公网可用的入口——第 3 步加上 Access 才算完成。

## 3. 建 Access 应用（身份认证层）

1. Cloudflare Dashboard → **Zero Trust** → **Access controls** → **Applications** → **Create new application** → **Self-hosted and private**。
2. **Application name**：`ZCode Remote`（随意）。
3. **Public hostname**：`zcode.example.com`（与隧道一致）。
4. **Session Duration**：建议 `8 hours` 或按需；到期后重新登录。
5. **Access policies** → **Add a policy**：
   - Action：`Allow`
   - Include → 选择 `Emails`，填入你自己的邮箱（或选 `Login methods` 里的 Google/GitHub 等）。
   - 想验证 allowlist 负向用例（见 6.3），这里先只放行你本人。
6. 保存应用。

> 不建议用 `Bypass` 策略或 Service Auth 策略绕过身份：前者等于没有 Access，后者不注入用户 email，ZCode 的 email allowlist 会一律拒绝。

## 4. 收集两个必填值

在刚创建的应用详情页：

| ZCode 字段     | CF 取值                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `cfTeamDomain` | **Team domain**，形如 `myteam.cloudflareaccess.com`（**裸主机名**，不带 `https://`、不带斜杠）     |
| `cfAud`        | **Application Audience (AUD) Tag**，形如 `a1b2c3…`（应用概览页「Application Audience (AUD) Tag」） |

> Team domain 也可在 Zero Trust → Settings → General 查看。代码按 `issuer = https://<cfTeamDomain>` 与 `audience = <cfAud>` 验签，任何一个填错都会 401。

## 5. ZCode 侧配置

1. 设置 → 远程访问。
2. 打开「启用手机远程访问」开关（`desktopEnabled`）。
3. 鉴权方式选 **Cloudflare Access**。
4. 填第 4 步的两个值；「允许的邮箱」可留空（= 不限制 email，只要通过 CF Access），也可填你的邮箱做第二道白名单。
5. **外部访问基址**填 `https://zcode.example.com`（与 Access 应用域名一致）。
   - 这是 Origin 校验的白名单来源；填错或留空时，若前面还有反代会改写 Host，WS 升级会被 403 拒绝。
6. 保存。保存成功不需要重启：内嵌监听会按新配置停旧起新。

保存时如果报 `cfTeamDomain must be a bare hostname`，说明域名带了 `https://` 或路径，去掉即可。

> CF 档的配置请在**桌面 App 的设置页**完成（走 IPC）。本机浏览器打开的 `127.0.0.1:30330` 设置页在 CF 档下读取配置会得到 404 JSON——CF 档不挂载 `/api/web-access/*` 是既定设计（见 spec 鉴权矩阵），不是故障。

## 6. 验收用例

> 下面的 `curl` 都在**运行 ZCode 的这台机器**上执行，直连内嵌入口，绕过 CF 边缘，用来单独验证源站验签。JWT 是凭据，测试完请丢弃，不要贴到工单或聊天里。

### 6.1 正向：浏览器全链路

1. 用无痕窗口打开 `https://zcode.example.com`。
2. 期望：先跳转 CF Access 登录页（team domain 的登录页）。
3. 登录后回到应用，页面加载。
4. 新开一个会话发一条消息，确认有模型回复（验证 WS 升级也被放行、Host 桥接通）。
5. 手机（同一账号）扫码/打开同一域名，重复第 4 步。

**通过标准**：登录前后行为符合预期；登录后对话正常收发；断网重连后会话可恢复。

### 6.2 负向：未带 JWT 直连源站

```powershell
curl.exe -i http://127.0.0.1:30330/ws
```

期望：

```text
HTTP/1.1 401 Unauthorized
{"error":"missing Cf-Access-Jwt-Assertion header"}
```

再验证伪造的 JWT：

```powershell
curl.exe -i -H "Cf-Access-Jwt-Assertion: not-a-jwt" http://127.0.0.1:30330/ws
```

期望：`401`，日志里只记结果摘要，不记 JWT 原文。

### 6.3 负向：email allowlist

1. 设置 → 远程访问 → 「允许的邮箱」填一个**不是你当前登录账号**的地址，保存。
2. 从浏览器复制当前 JWT（开发者工具 → Application → Cookies → `CF_Authorization`，或任一请求头 `Cf-Access-Jwt-Assertion`）。
3. 执行（PowerShell）：

```powershell
$env:JWT = "<粘贴 JWT>"
curl.exe -i -H "Cf-Access-Jwt-Assertion: $env:JWT" http://127.0.0.1:30330/ws
```

期望：`403`，响应体 `{"error":"email not in allowlist"}`（内嵌入口统一用 `error` 字段回失败原因）。
然后把 allowlist 改回你的邮箱，重复命令，期望放行（返回静态 fallback 的 HTML 或 200，而非 401/403）。

### 6.4 负向：AUD 填错

1. 在设置里把 `cfAud` 改成一个错误值并保存。
2. 用有效 JWT 执行 6.3 的命令。

期望：`401`，详情含 `unexpected "aud" claim value`。改回正确值后恢复。

### 6.5 负向：Team domain 填错

把 `cfTeamDomain` 改成不存在的域名。期望：JWKS 拉取失败 → `401`。改回后恢复。

> JWKS 在进程内缓存 1 小时，且按 team domain 区分。改回正确值会触发新的 JWKS 拉取；若仍异常，重启应用排除缓存因素。

### 6.6 路由与静态资源边界

```powershell
# 静态首页：不鉴权，返回 HTML（说明 CF 是唯一的页面级防线）
curl.exe -i http://127.0.0.1:30330/

# /api 空间：CF 档不挂载，带不带 JWT 都应是 404 JSON（不是 HTML）
curl.exe -i http://127.0.0.1:30330/api/web-access/config
```

期望：首页 `200 text/html`；`/api/web-access/config` 返回 `404` 且 `content-type: application/json`。

### 6.7 远程 bind（可选）

如果 cloudflared 跑在**另一台机器**上，需要让内嵌入口监听非回环地址：

```powershell
[Environment]::SetEnvironmentVariable("ZCODE_WEB_BIND_HOST", "0.0.0.0", "User")
```

重启 ZCode 应用后生效（CF 档允许非回环 bind；open 档会被强制改回 127.0.0.1）。改完用 `netstat -ano | findstr 30330` 确认监听地址。

## 7. 排障对照表

| 现象                                            | 最可能原因                                                     | 处理                                                     |
| ----------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| 保存时报 `cfTeamDomain must be a bare hostname` | 域名带了 `https://` 或路径                                     | 只填 `xxx.cloudflareaccess.com`                          |
| 保存成功但浏览器一直跳登录页                    | CF 策略未放行该邮箱 / 应用域名与隧道不一致                     | 检查 Access 策略 Include 与应用 Public hostname          |
| 页面能打开，WS 立即失败（401）                  | 请求没经过 Access（直连 IP/LAN）或走了 Bypass 策略             | 只能经公网域名访问；检查策略类型                         |
| WS 403 `cross-origin request is not allowed`    | 前置反代改写了 Host，或 `externalBaseUrl` 与实际访问域名不一致 | 统一 `externalBaseUrl`；反代保留原始 Host                |
| 401 `unexpected "aud" claim value`              | `cfAud` 与当前应用 AUD 不一致                                  | 重新复制 AUD Tag                                         |
| 401 `email not in allowlist`                    | allowlist 不含 JWT 的 email claim                              | 修正 allowlist 或清空                                    |
| 一直 401 且日志显示 JWKS 失败                   | team domain 错 / 本机出网被拦                                  | `curl https://<team>/.well-known/...` 验证出网；修正域名 |
| 改了配置仍按旧档位鉴权                          | 保存后监听重建失败                                             | 看 `~/.zcode/v2/logs/` 的 `[web-remote-access]` 日志     |
| 手机能登录但一直转圈                            | 静态资源加载了，WS 被拒                                        | 按 6.2/6.4 用 curl 区分是凭据问题还是 Origin 问题        |

## 8. 清理

1. 设置 → 远程访问：关闭「启用手机远程访问」，或把鉴权方式改回 `open`。
2. Cloudflare：删除 Access 应用、删除隧道与对应 DNS 记录：

```powershell
cloudflared tunnel delete zcode
```

3. 若设置过 `ZCODE_WEB_BIND_HOST`，删除该用户环境变量并重启应用。

## 9. 勾选清单（贴给开发时可对照）

- [ ] 隧道 `cloudflared tunnel run` 在线，公网域名可达
- [ ] Access 应用已建，策略 Allow + 指定邮箱
- [ ] `cfTeamDomain` 裸主机名正确
- [ ] `cfAud` 为当前应用 AUD Tag
- [ ] `externalBaseUrl` = 公网域名
- [ ] 未登录访问跳 CF 登录页
- [ ] 登录后对话可收发，断线重连会话恢复
- [ ] 无 JWT 直连 `/ws` → 401
- [ ] allowlist 不含当前账号 → 403
- [ ] AUD 填错 → 401
- [ ] CF 档 `/api/web-access/config` → 404 JSON
