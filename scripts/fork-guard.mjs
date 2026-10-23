#!/usr/bin/env node
// BYOK fork 出网/遥测门禁（FORK.md「验收门禁」一节的可执行版）。
//
// 静态扫描两 类禁止项：
//  1) 厂商云域名出现在源码中（引号收口的 origin 精确匹配，允许 .invalid 占位与白名单文件）；
//  2) 遥测栈的 import/使用（@opentelemetry、@zcode/telemetry、@arms/rum、armsRum 运行时符号、
//     已删除的遥测端点常量）。
// 白名单文件代表 BYOK 语义下的合法保留（用户自有 API Key 的模型端点、匿名入站的官方插件
// 资产、旧配置迁移兼容、协议 schema、no-op 接缝），逐条理由见 FORK.md。
//
// 运行：node scripts/fork-guard.mjs（CI 与 pre-push 均应调用；退出码非 0 即违规）。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_ROOTS = ["packages", "apps", "scripts", "config", "harness"];
const SCAN_EXTS = new Set([".ts", ".tsx", ".mjs", ".cjs", ".js", ".json", ".html", ".css"]);
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  ".zcode",
  "coverage",
  "build",
  "out",
  "mock-cdn",
  "third-party",
]);

// 精确到「引号开头的 origin + 引号或路径斜杠」，避免误伤 .invalid 占位（如 chat.z.ai.invalid）
// 与子串；origin 后跟路径（/api/...）时以斜杠收口。
const FORBIDDEN_PATTERNS = [
  /["']https:\/\/zcode\.z\.ai[/"']/,
  /["']https:\/\/api\.z\.ai[/"']/,
  /["']https:\/\/chat\.z\.ai[/"']/,
  /["']https:\/\/open\.bigmodel\.cn[/"']/,
  /["']https:\/\/bigmodel\.cn[/"']/,
  /["']https:\/\/cdn-zcode\.z\.ai[/"']/,
  /feishu\.cn/,
  /zhipu-ai\.feishu\.cn/,
  /@opentelemetry\//,
  /@zcode\/telemetry/,
  /@arms\/rum/,
  /\barmsRum\./,
  /\bcreateTelemetryCore\b/,
  /\bZCODE_ARMS_RUM_ENDPOINT\b/,
  /\bZCODE_TELEMETRY_REPORT_ENDPOINT\b/,
  /\bZCODE_TELEMETRY_ENABLED\b/,
];

// 白名单：路径（相对仓库根，统一 / 分隔）→ 允许继续出现的模式（正则源字符串）。
// 新增白名单必须先在 FORK.md「允许保留清单」登记理由。
const ALLOWLIST = new Map(
  [
    // ── BYOK 重建补充白名单（FORK.md 登记；改动须先登记理由）──
    // 官方插件资产 CDN（匿名 GET，D10/R6 保留）：marketplace 图标与 office 建议卡。
    [
      "apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts",
      ["https://cdn-zcode.z.ai"],
    ],
    ["packages/ui/src/v4/officeSuggestedPrompts.ts", ["https://cdn-zcode.z.ai"]],
    ["packages/ui/src/v4/featureSuggestedPrompts.ts", ["https://cdn-zcode.z.ai"]],
    // no-op 接缝注释提及 @zcode/telemetry（包已删，注释说明语义）。
    [
      "apps/zcode-cli/packages/bootstrap/src/app/create-app.ts",
      ["@zcode/telemetry"],
    ],
    [
      "apps/zcode-cli/packages/bootstrap/src/telemetry-bootstrap.ts",
      ["@zcode/telemetry"],
    ],
    [
      "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/runtime-cleanup.ts",
      ["@zcode/telemetry"],
    ],
    // CLI coding-plan-api-key 客户端：用户自有 Coding Plan Key 的模型 API 通道。
    [
      "apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts",
      ["https://api.z.ai", "https://bigmodel.cn"],
    ],
    // 上游 zcode-builtin 原样保留作对照（不参与装配，D4）。
    [
      "config/provider/zcode-builtin.json",
      [
        "https://zcode.z.ai",
        "https://api.z.ai",
        "https://open.bigmodel.cn",
        "https://bigmodel.cn",
      ],
    ],
    [
      "config/provider/zcode-builtin.test.json",
      [
        "https://zcode.z.ai",
        "https://api.z.ai",
        "https://open.bigmodel.cn",
        "https://bigmodel.cn",
      ],
    ],
    // ── 测试 fixture 白名单（测试数据不出网；FORK.md 登记）──
    // ── 测试 fixture 白名单（测试数据不出网；FORK.md 登记）──
    // ── 测试 fixture 白名单（测试数据不出网；FORK.md 登记）──
    ["apps/zcode-cli/packages/adapters/tests/builtin-mcs-search-wire.test.ts", ["https://zcode.z.ai"]],
    ["apps/zcode-cli/packages/adapters/tests/config.test.ts", ["https://open.bigmodel.cn"]],
    ["apps/zcode-cli/packages/adapters/tests/marketplace-listing.test.ts", ["https://zcode.z.ai"]],
    ["apps/zcode-cli/packages/adapters/tests/model-execution.test.ts", ["https://api.z.ai"]],
    ["apps/zcode-cli/packages/adapters/tests/official-coding-plan-gateway.test.ts", ["https://api.z.ai", "https://open.bigmodel.cn"]],
    ["apps/zcode-cli/packages/adapters/tests/plugins.test.ts", ["https://zcode.z.ai"]],
    ["apps/zcode-cli/packages/adapters/tests/provider-endpoint-routing-fetch.test.ts", ["https://api.z.ai", "https://zcode.z.ai"]],
    ["apps/zcode-cli/packages/adapters/tests/runner-options.test.ts", ["https://zcode.z.ai"]],
    ["apps/zcode-cli/packages/adapters/tests/runner.test.ts", ["https://zcode.z.ai"]],
    ["apps/zcode-cli/packages/bootstrap/tests/model-default-headers-wire.test.ts", ["https://zcode.z.ai"]],
    ["apps/zcode-cli/packages/bootstrap/tests/plugin-reference-protocol.test.ts", ["https://zcode.z.ai"]],
    ["apps/zcode-cli/packages/bootstrap/tests/plugins.test.ts", ["https://zcode.z.ai"]],
    ["apps/zcode-cli/packages/bootstrap/tests/provider-endpoint-routing-source-headers.test.ts", ["https://zcode.z.ai"]],
    ["apps/zcode-cli/packages/bootstrap/tests/session-persistence.test.ts", ["https://api.z.ai"]],
    ["apps/zcode-cli/packages/tui/tests/tui-sidebar.test.ts", ["https://open.bigmodel.cn"]],
    ["packages/desktop/test/browserDataManager.test.ts", ["https://chat.z.ai"]],
    ["packages/desktop/test/cdnPreloadScript.test.ts", ["https://zcode.z.ai"]],
    ["packages/desktop/test/desktopArchitectureGuard.test.ts", ["https://zcode.z.ai"]],
    ["packages/desktop/test/desktopCommandHandlers.test.ts", ["https://zcode.z.ai"]],
    ["packages/desktop/test/desktopRuntimeEnv.test.ts", ["https://api.z.ai", "https://chat.z.ai", "https://zcode.z.ai"]],
    ["packages/desktop/test/desktopWindowChrome.test.ts", ["https://api.z.ai", "https://zcode.z.ai"]],
    ["packages/desktop/test/e2e/conversation-session/conversation-session-plugin-reference.test.ts", ["https://zcode.z.ai"]],
    ["packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-plugin-store-try-states.test.ts", ["https://zcode.z.ai"]],
    ["packages/desktop/test/e2e/helpers/model-provider-catalog-mock-server.ts", ["https://open.bigmodel.cn"]],
    ["packages/desktop/test/e2e/helpers/plugin-cdn-zip-marketplace.ts", ["https://zcode.z.ai"]],
    ["packages/desktop/test/e2e/helpers/toolsearch-desktop.ts", ["https://open.bigmodel.cn"]],
    ["packages/desktop/test/e2eProviderEndpoint.test.ts", ["https://bigmodel.cn", "https://zcode.z.ai"]],
    ["packages/desktop/test/remoteCdn.test.ts", ["https://zcode.z.ai"]],
    ["packages/desktop/test/viteRendererConfig.test.ts", ["https://zcode.z.ai"]],
    ["packages/provider-node/test/glm-flash-pdf-turbo-defaults.test.ts", ["https://api.z.ai", "https://open.bigmodel.cn"]],
    ["packages/provider-node/test/mcs-capability-rules.test.ts", ["https://zcode.z.ai"]],
    ["packages/provider-node/test/openrouter-reasoning-contract.test.ts", ["https://api.z.ai", "https://open.bigmodel.cn"]],
    ["packages/provider-node/test/provider-node-runtime.test.ts", ["https://api.z.ai"]],
    ["packages/provider-node/test/zcode-builtin-integrity.test.ts", ["https://api.z.ai"]],
    ["packages/provider-node/test/zhipu-api-templates.test.ts", ["https://bigmodel.cn"]],
    ["packages/provider/test/manual-coding-plan-access.test.ts", ["https://api.z.ai"]],
    ["packages/provider/test/model-rule-collections.test.ts", ["https://api.z.ai", "https://open.bigmodel.cn", "https://zcode.z.ai"]],
    ["packages/provider/test/provider-config-kinds.test.ts", ["https://zcode.z.ai"]],
    ["packages/server/test/remoteConnect.test.ts", ["https://chat.z.ai", "https://zcode.z.ai"]],
    ["packages/services/test/agentProxyEnv.test.ts", ["https://zcode.z.ai"]],
    ["packages/services/test/codexConfigToml.test.ts", ["https://zcode.z.ai"]],
    ["packages/services/test/legacyPersonalProviderConfigImporter.test.ts", ["https://api.z.ai", "https://open.bigmodel.cn"]],
    ["packages/services/test/nodeApiClient.test.ts", ["https://bigmodel.cn"]],
    ["packages/services/test/nodeApiClientEndpoint.test.ts", ["https://api.z.ai", "https://zcode.z.ai"]],
    ["packages/services/test/offPeakModelSelectionView.test.ts", ["https://zcode.z.ai"]],
    ["packages/services/test/settingService.test.ts", ["https://zcode.z.ai"]],
    ["packages/services/test/zcodeAgentService.providerRegistry.test.ts", ["https://open.bigmodel.cn", "https://zcode.z.ai"]],
    ["packages/shared/test/projectAccessTokenClient.test.ts", ["https://bigmodel.cn"]],
    ["packages/shared/test/sharedContextImportState.test.ts", ["https://zcode.z.ai"]],
    ["packages/shared/test/zcodeEndpoint.test.ts", ["https://api.z.ai", "https://bigmodel.cn", "https://chat.z.ai", "https://zcode.z.ai"]],
    ["packages/shared/test/zcodeSourceHeaders.test.ts", ["https://zcode.z.ai"]],
    ["packages/ui/test/automationAgentConfigOptions.test.ts", ["https://open.bigmodel.cn"]],
    ["packages/ui/test/browser/manual-review/pending/provider-settings-batch.test.mjs", ["https://bigmodel.cn"]],
    ["packages/ui/test/embeddedBrowserHelpers.test.ts", ["feishu.cn"]],
    ["packages/ui/test/endpointSuggestionFocus.test.ts", ["https://open.bigmodel.cn"]],
    ["packages/ui/test/messageTelemetry.test.ts", ["https://api.z.ai"]],
    ["packages/ui/test/modelProviderDraftSave.test.ts", ["https://api.z.ai"]],
    ["packages/ui/test/providerApiKeyPersistence.test.ts", ["https://api.z.ai"]],
    ["packages/ui/test/providerFamilyConnectionVisibility.test.ts", ["https://bigmodel.cn"]],
    ["packages/ui/test/v4ComposerToolbarRecovery.test.ts", ["https://open.bigmodel.cn"]],
    ["packages/ui/test/windowsCaptionMenuButton.test.ts", ["https://zcode.z.ai"]],
    ["packages/ui/test/workspaceHeaderActionSection.test.ts", ["https://zcode.z.ai"]],
    ["packages/web/test/viteConfigLoad.test.ts", ["https://bigmodel.cn", "https://chat.z.ai", "https://zcode.z.ai"]],
    ["packages/desktop/test/cdnPreloadScript.test.ts", ["https://cdn-zcode.z.ai"]],
    ["packages/desktop/test/e2e/conversation-session/conversation-session-plugin-reference.test.ts", ["https://cdn-zcode.z.ai"]],
    ["packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-plugin-store-try-states.test.ts", ["https://cdn-zcode.z.ai"]],
    ["packages/desktop/test/e2e/helpers/plugin-cdn-zip-marketplace.ts", ["https://cdn-zcode.z.ai"]],
    ["packages/desktop/test/remoteCdn.test.ts", ["https://cdn-zcode.z.ai"]],
    ["apps/zcode-cli/packages/adapters/tests/marketplace-listing.test.ts", ["https://cdn-zcode.z.ai"]],
    ["apps/zcode-cli/packages/adapters/tests/plugins.test.ts", ["https://cdn-zcode.z.ai"]],
    ["apps/zcode-cli/packages/bootstrap/tests/plugin-reference-protocol.test.ts", ["https://cdn-zcode.z.ai"]],
    ["apps/zcode-cli/packages/bootstrap/tests/plugins.test.ts", ["https://cdn-zcode.z.ai"]],
    // e2e/wdio 的 provider 端点 fixture：测试数据（测试进程不出网）。
    ["packages/desktop/wdio.conf.ts", ["https://zcode.z.ai", "https://open.bigmodel.cn"]],
    [
      "packages/desktop/test/e2e/helpers/e2e-provider-endpoint.ts",
      ["https://zcode.z.ai", "https://bigmodel.cn"],
    ],
    // 用户自配 Z.ai/BigModel API Key（coding-plan-api-key 访问类型）的模型推理端点——
    // 流量指向模型 API 而非产品云，属 BYOK 合法模型通道。
    [
      "apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts",
      ["https://open.bigmodel.cn", "https://api.z.ai", "https://zcode.z.ai"],
    ],
    // 内置 Provider 模板与模型默认值数据库：各第三方模型端点的 baseUrl/字段映射，
    // 均为用户自有 API Key 的模型 API 通道（BYOK 合法），无产品云调用。
    // 裸域 https://bigmodel.cn（coding-plan 概览与用户中心 APIKeys 管理页）与
    // https://z.ai（manage-apikey 管理页）来自同文件的 apiKeyManagementUrl 字段，
    // 与 baseUrl 同属用户自有 Key 的模型 API/管理页通道（BYOK 合法），且是模板数据
    // 而非代码出网；必须显式登记，不能依赖文件级豁免碰巧通过。
    [
      "config/provider/byok-builtin.json",
      [
        "https://open.bigmodel.cn",
        "https://api.z.ai",
        "https://zcode.z.ai",
        "https://bigmodel.cn",
        "https://z.ai",
      ],
    ],
    // 官方插件市场清单与资产：匿名入站下载（HTTP GET，无鉴权、无用户数据），D10 保留。
    [
      "packages/shared/src/plugin-marketplaces.ts",
      ["https://cdn-zcode.z.ai"],
    ],
    [
      "apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
      ["https://cdn-zcode.z.ai"],
    ],
    [
      "packages/ui/src/v4/featureSuggestedPrompts.ts",
      ["https://cdn-zcode.z.ai"],
    ],
    // 旧版 ~/.zcode 配置文件迁移兼容：仅作 provider baseUrl 常量，不出网。
    [
      "packages/services/src/model-provider/legacyZCodeConfigProviderReader.ts",
      ["https://open.bigmodel.cn"],
    ],
    // provider family 元数据（模板/图标分类用域名归属判断），无网络行为。
    ["packages/shared/src/model-provider-family.ts", ["bigmodel.cn"]],
    // 遥测协议 schema 保留（纯类型层，利于上游 rebase）。
    [
      "packages/shared/src/telemetry.ts",
      ["TelemetryEventPayload", "ArmsCustomEventPayload", "armsRum"],
    ],
    ["packages/shared/src/platform.ts", ["reportTelemetryEvent", "reportArmsCustomEvent"]],
    // no-op 接缝本身。
    ["apps/zcode-cli/packages/bootstrap/src/telemetry-noop.ts", ["telemetry"]],
    // OTEL_*/ZCODE_TELEMETRY_* 键名保留在 sanitize 黑名单里，作为防泄漏边界（阻止这类
    // env 泄漏给 Bash/MCP 子进程），并非遥测实现。
    ["packages/shared/src/runtimeEnv.ts", ["OTEL_", "ZCODE_TELEMETRY_"]],
    // CLI 遥测禁用开关的 env 键名（兼容旧文档语义，读取处为空实现）。
    ["packages/shared/src/env.ts", ["ZCODE_TELEMETRY"]],
    // 本地设备 ID 历史文件名/注释。
    // 打包/构建脚本中说明移除事实的注释措辞。
    ["packages/desktop/scripts/bundle.mjs", ["BYOK"]],
    ["packages/desktop/electron-builder.config.js", ["BYOK"]],
  ].map(([file, patterns]) => [file, patterns.map((source) => new RegExp(source))]),
);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      yield* walk(full);
      continue;
    }
    if (!SCAN_EXTS.has(extname(entry.name))) continue;
    yield full;
  }
}

function toRepoRelative(fullPath) {
  return fullPath.slice(repoRoot.length + 1).split(sep).join("/");
}

const violations = [];
let scannedFiles = 0;
/** 白名单仍被使用的文件（文件级，供名单自检）。 */
const stillMatching = new Set();

for (const root of SCAN_ROOTS) {
  const rootDir = join(repoRoot, root);
  for (const file of walk(rootDir)) {
    const relative = toRepoRelative(file);
    if (relative === "scripts/fork-guard.mjs") continue;
    if (/^(FORK\.md|BYOK-FORK-PLAN\.md|NOTICE\.md|THIRD-PARTY-NOTICES\.md)$/.test(relative)) {
      continue;
    }
    let content;
    try {
      if (statSync(file).size > 4 * 1024 * 1024) continue;
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    scannedFiles += 1;
    const allowedPatterns = ALLOWLIST.get(relative);
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (!pattern.test(content)) continue;
      if (allowedPatterns?.some((allowed) => allowed.test(content))) {
        // 白名单命中：不算违规，但记为"仍在使用"，供名单自检。
        stillMatching.add(relative);
        continue;
      }
      violations.push({ file: relative, pattern: pattern.source });
    }
  }
}

// 白名单自检：条目指向的文件若已不存在，说明删除后忘了回收白名单（硬失败，防名单腐化）；
// 文件仍存在但当前未命中任何禁止模式的条目只提示（防御性保留是合法状态）。
for (const file of ALLOWLIST.keys()) {
  if (!existsSync(join(repoRoot, file))) {
    violations.push({
      file,
      pattern: "<allowlist-file-missing>",
    });
    continue;
  }
  if (!stillMatching.has(file)) {
    console.warn(`fork-guard: 提示：白名单条目当前未命中任何禁止模式（防御性保留）：${file}`);
  }
}

if (violations.length > 0) {
  console.error("fork-guard: 违规 %d 处：", violations.length);
  for (const violation of violations) {
    console.error(`  - ${violation.file}\n    pattern: ${violation.pattern}`);
  }
  console.error(
    "\n处理方式：1) 若为真实残留，删除或收口对应代码；2) 若属 BYOK 合法保留，先在 FORK.md 登记理由，再把该文件与命中的模式加入本脚本 ALLOWLIST。",
  );
  process.exit(1);
}

console.log(`fork-guard: OK（扫描 ${scannedFiles} 个文件，0 违规）`);
