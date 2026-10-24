import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderConfigService,
  ProviderRegistryService,
  createFailClosedAccountProviderConfigSnapshot,
} from "@zcode/provider";
// BYOK fork P1b：厂商 CDN 远程同步器（ZCodeBuiltinRemoteSynchronizer / EndpointScoped 源）
// 已删除，同步/lease/退避相关用例移除；保留本地 release 解析与缓存物化语义。
import {
  NodeZCodeBuiltinProviderConfigSource,
  decodeZCodeBuiltinRelease,
  encodeZCodeBuiltinRelease,
  resolveZCodeBuiltinCachePaths,
  NodePersonalProviderConfigRepository,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ZCode Built-in Release", () => {
  it("严格解析两层 Release，并拒绝缺字段和旧单层形状", () => {
    const release = decodeZCodeBuiltinRelease(releaseObject(2, "model-b"));

    expect(release.revision).toBe(2);
    expect(release.config.providers.get("builtin")?.builtinModelIds).toEqual(["model-b"]);
    expect(encodeZCodeBuiltinRelease(release)).toEqual(releaseObject(2, "model-b"));
    expect(() =>
      decodeZCodeBuiltinRelease({ schemaVersion: 1, providers: {}, models: [] }),
    ).toThrow();
    expect(() =>
      decodeZCodeBuiltinRelease({
        schemaVersion: 1,
        revision: 1,
        config: { providers: {} },
      }),
    ).toThrow();
  });

  it("拒绝远端或缓存重新发布已退出产品的 ZAPI", () => {
    const release = releaseObject(2, "model-b");

    expect(() =>
      decodeZCodeBuiltinRelease({
        ...release,
        config: {
          ...release.config,
          providerConfigRules: {
            ...release.config.providerConfigRules,
            providerRules: [
              ...release.config.providerConfigRules.providerRules,
              {
                providerId: "builtin:zapi",
                config: {
                  group: "zai-family",
                  access: {
                    type: "zhipu-account",
                    accountType: "zai",
                    mode: "start-plan",
                  },
                  builtinModelIds: ["retired-model"],
                },
              },
            ],
          },
        },
      }),
    ).toThrow("builtin:zapi");
  });

  it("缓存路径按平台、App 版本和规范化 Endpoint 隔离", () => {
    const first = resolveZCodeBuiltinCachePaths({
      environmentConfigRoot: "/environment",
      platform: "darwin-aarch64",
      appVersion: "3.0.0",
      zcodeEndpointOrigin: "https://EXAMPLE.com/",
    });
    const equivalent = resolveZCodeBuiltinCachePaths({
      environmentConfigRoot: "/environment",
      platform: "darwin-aarch64",
      appVersion: "3.0.0",
      zcodeEndpointOrigin: "https://example.com",
    });
    const second = resolveZCodeBuiltinCachePaths({
      environmentConfigRoot: "/environment",
      platform: "darwin-aarch64",
      appVersion: "3.0.0",
      zcodeEndpointOrigin: "https://staging.example.com",
    });
    expect(first).toEqual(equivalent);
    // 路径断言保留全部隔离层级，不能用 POSIX 分隔符让 Windows 正确实现误报。
    expect(dirname(dirname(first.activeFilePath))).toBe(
      join("/environment", "runtime", "provider", "darwin-aarch64", "3.0.0"),
    );
    expect(basename(dirname(first.activeFilePath))).toMatch(/^endpoint-[a-f0-9]{32}$/u);
    expect(basename(first.activeFilePath)).toBe("zcode-builtin.json");
    expect(first.controlFilePath).toBe(
      join(dirname(first.activeFilePath), "zcode-builtin-refresh.json"),
    );
    expect(second.activeFilePath).not.toBe(first.activeFilePath);
    expect(() =>
      resolveZCodeBuiltinCachePaths({
        environmentConfigRoot: "/environment",
        platform: "../other",
        appVersion: "3.0.0",
        zcodeEndpointOrigin: "https://example.com",
      }),
    ).toThrow("platform");
  });

  it("启动选择兼容且 revision 最大的候选，并将它物化为活动文件", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "cache", "active.json");
    await writeRelease(bundledFilePath, 2, "bundled-model");
    await writeRelease(activeFilePath, 3, "active-model");
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath,
      activeFilePath,
      watch: false,
    });

    expect((await source.read()).providers.get("builtin")?.builtinModelIds).toEqual([
      "active-model",
    ]);
    expect(JSON.parse(await readFile(activeFilePath, "utf8"))).toEqual(
      releaseObject(3, "active-model"),
    );
    source.dispose();
  });

  it("损坏、过旧或不兼容 Active 不覆盖 Bundled", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "cache", "active.json");
    await writeRelease(bundledFilePath, 4, "bundled-model");
    await writeRelease(activeFilePath, 3, "old-model");
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath,
      activeFilePath,
      watch: false,
    });

    expect((await source.read()).providers.get("builtin")?.builtinModelIds).toEqual([
      "bundled-model",
    ]);
    expect(JSON.parse(await readFile(activeFilePath, "utf8"))).toEqual(
      releaseObject(4, "bundled-model"),
    );
    source.dispose();
  });

  it("Bundled 与 Active 的相同 revision 冲突时丢弃 Active 并以 Bundled 启动", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "cache", "active.json");
    await writeRelease(bundledFilePath, 4, "bundled-model");
    await writeRelease(activeFilePath, 4, "other-model");
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath,
      activeFilePath,
      watch: false,
    });

    expect((await source.read()).providers.get("builtin")?.builtinModelIds).toEqual([
      "bundled-model",
    ]);
    expect(JSON.parse(await readFile(activeFilePath, "utf8"))).toEqual(
      releaseObject(4, "bundled-model"),
    );
    source.dispose();
  });

  it("Active 缓存无法物化时仍直接使用 Bundled 完成启动", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "cache", "active.json");
    await writeRelease(bundledFilePath, 4, "bundled-model");
    await mkdir(activeFilePath, { recursive: true });
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath,
      activeFilePath,
      watch: false,
    });

    expect((await source.read()).providers.get("builtin")?.builtinModelIds).toEqual([
      "bundled-model",
    ]);
    source.dispose();
  });

  it("远端更高 revision 原子更新；同 revision 同内容去重、不同内容拒绝", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "cache", "active.json");
    await writeRelease(bundledFilePath, 1, "model-a");
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath,
      activeFilePath,
      watch: false,
    });
    const reasons: string[] = [];
    source.onDidChange((reason) => reasons.push(reason));
    await source.read();

    await expect(
      source.applyRemoteRelease(decodeZCodeBuiltinRelease(releaseObject(2, "model-b"))),
    ).resolves.toBe("updated");
    await expect(
      source.applyRemoteRelease(decodeZCodeBuiltinRelease(releaseObject(2, "model-b"))),
    ).resolves.toBe("unchanged");
    await expect(
      source.applyRemoteRelease(decodeZCodeBuiltinRelease(releaseObject(2, "different"))),
    ).rejects.toThrow("相同 revision");
    await expect(
      source.applyRemoteRelease(decodeZCodeBuiltinRelease(releaseObject(1, "old"))),
    ).resolves.toBe("stale");

    expect(reasons).toEqual(["remote-updated"]);
    expect((await source.read()).providers.get("builtin")?.builtinModelIds).toEqual(["model-b"]);
    source.dispose();
  });







  // BYOK fork P1b：远程同步器删除后晚到响应语义不复存在，用例移除。
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-builtin-release-"));
  roots.push(root);
  return root;
}

async function writeRelease(filePath: string, revision: number, modelId: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(releaseObject(revision, modelId)), "utf8");
}

function releaseObject(revision: number, modelId: string) {
  return {
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "builtin",
            config: {
              group: "zai-family",
              access: {
                type: "zhipu-account",
                accountType: "zai",
                mode: "start-plan",
              },
              builtinModelIds: [modelId],
            },
          },
        ],
        templateRules: [],
      },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  };
}
