import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelClient, ChannelServer, createQueuePair } from "@zcode/rpc";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const originalCredentialSecret = process.env.ZCODE_CREDENTIAL_SECRET;
const tempHomes: string[] = [];
const RETIRED_ZAPI_PROVIDER_ID = "builtin:zapi";

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-local-services-remote-authority-"));
  tempHomes.push(home);
  return home;
}

function writeLegacyZapiConfig(home: string): void {
  const configDir = join(home, ".zcode", "v2");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify(
      {
        provider: {
          [RETIRED_ZAPI_PROVIDER_ID]: {
            name: "ZAPI",
            kind: "anthropic",
            options: {
              apiKey: "",
              baseURL: "http://192.168.100.166:8080",
            },
            models: {
              "gpt-5.4": {
                limit: { context: 128_000 },
                modalities: {
                  input: ["text"],
                  output: ["text"],
                },
              },
            },
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function writeZCodeBuiltinProviderConfig(home: string): string {
  const configDir = join(home, ".zcode", "provider-test");
  mkdirSync(configDir, { recursive: true });
  const filePath = join(configDir, "zcodeBuiltin.json");
  writeFileSync(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      config: {
        // 装配测试必须使用当前发布合同；上面的 config.json 才是待迁移的旧数据。
        providerConfigRules: { templateRules: [], providerRules: [] },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    }),
    "utf-8",
  );
  return filePath;
}

describe("createLocalServices remote authority", () => {
  beforeAll(() => {
    // BYOK fork：P2 主密钥默认走 OS keychain（测试进程会弹钥匙串授权），
    // 统一用显式覆盖的 ZCODE_CREDENTIAL_SECRET 保证单测确定性与 CI 可运行。
    process.env.ZCODE_CREDENTIAL_SECRET = originalCredentialSecret ?? "test-credential-secret";
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    // BYOK fork：P2 主密钥默认走 OS keychain（测试进程会弹钥匙串授权），
    // 统一用显式覆盖的 ZCODE_CREDENTIAL_SECRET 保证单测确定性。
    process.env.ZCODE_CREDENTIAL_SECRET = originalCredentialSecret ?? "test-credential-secret";
    vi.restoreAllMocks();
    vi.resetModules();
    for (const home of tempHomes.splice(0)) {
      // 根因：Windows 删除目录必须先关闭其下所有句柄，而 service 释放（日志文件、
      // 配置 watcher、SQLite 句柄）是异步收口的，`force: true` 并不会重试——它只吞
      // ENOENT。于是 afterEach 稳定抛 `EPERM, Permission denied: \\?\C:\...\Temp\...`，
      // 用例本身的断言其实都已通过。POSIX 上因为允许删除仍被打开的 inode 所以看不到。
      // 用 rm 自带的有界重试等句柄收口；重试只对 EBUSY/EPERM/ENOTEMPTY 等生效，
      // 真正的权限故障仍会在耗尽重试后抛出。
      try {
        rmSync(home, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100,
        });
      } catch {
        // 极端情况下句柄仍未释放。临时目录由操作系统回收，清理失败不该把已经通过
        // 断言的用例判为失败。
      }
    }
  });

  it("desktop-attached remote services hide stale ZAPI providers", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    writeLegacyZapiConfig(home);

    const [{ createLocalServices, disposeServiceResources }, { IModelSelectionService }] =
      await Promise.all([import("../src/node.js"), import("../src/index.js")]);
    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: writeZCodeBuiltinProviderConfig(home),
      serviceAuthorityMode: "desktop-attached-remote",
    });

    const providers = (await services.get(IModelSelectionService).getView()).providers;

    expect(providers.some((provider) => provider.id === RETIRED_ZAPI_PROVIDER_ID)).toBe(false);
    disposeServiceResources(services);
  });

  it("desktop-attached Remote Host 不恢复旧 Model Preset 刷新", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 0, data: { configs: {} } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const { createLocalServices, disposeServiceResources } = await import("../src/node.js");
    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: writeZCodeBuiltinProviderConfig(home),
      serviceAuthorityMode: "desktop-attached-remote",
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));

      const requestedUrls = fetchImpl.mock.calls.map(([input]) => String(input));
      expect(requestedUrls.some((url) => url.includes("/releases/latest"))).toBe(false);
      expect(requestedUrls.every((url) => url.includes("/client/configs"))).toBe(true);
    } finally {
      disposeServiceResources(services);
    }
  });

  it("provider runtime services do not refresh legacy model presets on startup", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const zcodeBuiltinProviderConfigFilePath = writeZCodeBuiltinProviderConfig(home);
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 0, data: { configs: {} } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const { createLocalServices, disposeServiceResources } = await import("../src/node.js");
    const services = createLocalServices({ zcodeBuiltinProviderConfigFilePath });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));

      const requestedUrls = fetchImpl.mock.calls.map(([input]) => String(input));
      expect(requestedUrls.some((url) => url.includes("/releases/latest"))).toBe(false);
    } finally {
      disposeServiceResources(services);
    }
  });

  it("desktop-attached remote 使用远端 Registry 的就绪状态，不等待 Desktop 推送", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const zcodeBuiltinProviderConfigFilePath = writeZCodeBuiltinProviderConfig(home);
    const commandResolver = vi.fn(() => null);
    const [{ createLocalServices, disposeServiceResources }, { IZCodeAgentService }] =
      await Promise.all([import("../src/node.js"), import("../src/index.js")]);
    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath,
      serviceAuthorityMode: "desktop-attached-remote",
      zcodeAgentCommandResolver: commandResolver,
    });

    try {
      await expect(
        services.get(IZCodeAgentService).initialize({ workspacePath: "/remote/workspace" }),
      ).resolves.toMatchObject({ available: false });
      expect(commandResolver).not.toHaveBeenCalled();
    } finally {
      disposeServiceResources(services);
    }
  });

  it("只在 desktop-attached-remote Environment 暴露 Provisioning target", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const { createLocalServices, disposeServiceResources } = await import("../src/node.js");
    const { IProviderProvisioningTargetService } = await import("../src/index.js");
    const remoteServices = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: writeZCodeBuiltinProviderConfig(home),
      serviceAuthorityMode: "desktop-attached-remote",
    });
    const localServices = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: writeZCodeBuiltinProviderConfig(home),
      serviceAuthorityMode: "desktop-local",
    });

    try {
      expect(remoteServices.getOptional(IProviderProvisioningTargetService)).toBeDefined();
      expect(localServices.getOptional(IProviderProvisioningTargetService)).toBeUndefined();
    } finally {
      disposeServiceResources(remoteServices);
      disposeServiceResources(localServices);
    }
  });

  it("只在本进程成功持久化 Provisioning Source 事实后通知 Host", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    const onProviderProvisioningSourceChanged = vi.fn();
    const [{ createLocalServices, disposeServiceResources }, serviceDescriptors] =
      await Promise.all([import("../src/node.js"), import("../src/index.js")]);
    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: writeZCodeBuiltinProviderConfig(home),
      onProviderProvisioningSourceChanged,
    });

    try {
      await services.get(serviceDescriptors.IProviderSettingsService).createPersonalProvider({
        initialConfig: {
          access: { type: "api-key", apiKey: "key" },
          api: { type: "openai-chat-completions", baseUrl: "https://example.com/v1" },
          personalModelIds: [],
        },
      });
      await services.get(serviceDescriptors.ISettingService).update({ locale: "zh-CN" });
      await services
        .get(serviceDescriptors.ISettingService)
        .update({ providerFamilyDomain: "zai" });
      await services.get(serviceDescriptors.ICredentialService).save("ssh:password", "ignored");
      await services
        .get(serviceDescriptors.ICredentialService)
        .save("oauth:active_provider", "zai");

      expect(onProviderProvisioningSourceChanged.mock.calls).toEqual([
        ["personal-config"],
        ["account-settings"],
        // BYOK fork P1b：OAuth 登录删除后，凭据变更不再触发 provisioning "credential" 通知。
      ]);
    } finally {
      disposeServiceResources(services);
    }
  });

  it("keeps the narrow account request auth service private to the host process", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const fetchToken = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      let data: unknown;
      if (url.endsWith("/getCustomerInfo")) {
        data = {
          organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }],
        };
      } else if (url.endsWith("/api_keys")) {
        data = [{ apiKey: "key-id", name: "zcode-api-key" }];
      } else if (url.endsWith("/api_keys/key-id/access_tokens")) {
        data = {
          accessToken: "current-project-token",
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        };
      } else {
        throw new Error(`Unexpected account request: ${url}`);
      }
      return new Response(JSON.stringify({ code: 200, data }), {
        headers: { "content-type": "application/json" },
      });
    });
    const {
      createLocalServices,
      disposeServiceResources,
      getAccountRequestAuthService,
      getOffPeakRequestAuthBuilder,
    } = await import("../src/node.js");
    const { ISettingService } = await import("../src/index.js");
    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: writeZCodeBuiltinProviderConfig(home),
      serviceAuthorityMode: "desktop-attached-remote",
      hostApiNetworkTransport: {
        fetch: fetchToken,
        dispose: vi.fn(),
        disposeAndWait: vi.fn(async () => {}),
      },
    });

    try {
      const accountRequestAuthService = getAccountRequestAuthService(services);
      expect(accountRequestAuthService).toBeDefined();
      expect(getOffPeakRequestAuthBuilder(services)).toBeTypeOf("function");
      const { ProxyChannel } = await import("@zcode/rpc");
      const exposeService = vi.spyOn(ProxyChannel, "fromService");
      const registerChannel = vi.fn();
      services.exposeOnChannelServer({ registerChannel });
      expect(registerChannel).toHaveBeenCalled();
      expect(exposeService).not.toHaveBeenCalledWith(accountRequestAuthService);
      // BYOK fork P1b：OAuth 登录态删除后 loadOAuthTokenSet 恒为 null，基于登录态换 PAT 的
      // resolveCurrent 路径已不存在；以下 OAuth 凭据保存与 PAT 断言属于已删行为，予以移除。
    } finally {
      disposeServiceResources(services);
    }
  });

  it("复用 Host 注入的网络 transport 并由 ServiceCollection 释放", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const transport = {
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ code: 0, msg: "ok", data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
      dispose: vi.fn(),
      disposeAndWait: vi.fn(async () => {}),
    };
    const [{ createLocalServices, disposeServiceResources }, { IClientScenesService }] =
      await Promise.all([import("../src/node.js"), import("../src/index.js")]);
    const services = createLocalServices({
      hostApiNetworkTransport: transport,
      serviceAuthorityMode: "desktop-attached-remote",
      // BYOK fork：P1b 内置 provider 配置改为必须提供 bundled 配置文件，与其他用例一致。
      zcodeBuiltinProviderConfigFilePath: writeZCodeBuiltinProviderConfig(home),
    });

    try {
      await expect(services.get(IClientScenesService).list()).resolves.toMatchObject({
        code: 0,
        data: [],
      });
      expect(transport.fetch).toHaveBeenCalledOnce();
    } finally {
      disposeServiceResources(services);
    }

    expect(transport.dispose).toHaveBeenCalledOnce();
  });

  it("exposes plugin sync through the local RPC server", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const [{ createLocalServices, disposeServiceResources }, { IPluginSyncService }] =
      await Promise.all([import("../src/node.js"), import("../src/index.js")]);
    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: writeZCodeBuiltinProviderConfig(home),
      serviceAuthorityMode: "desktop-attached-remote",
    });
    const [clientProtocol, serverProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "test", 50);
    const client = new ChannelClient(clientProtocol);

    try {
      services.exposeOnChannelServer(server);
      const result = await client
        .getChannel(IPluginSyncService.channelName)
        .call("listLocalUserPluginCandidates", []);

      expect(result.candidates).toEqual([]);
      expect(result.maxArchiveBytes).toBeGreaterThan(0);
    } finally {
      client.dispose();
      server.dispose();
      disposeServiceResources(services);
    }
  });
});
