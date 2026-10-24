// @vitest-environment jsdom
import { act } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientSceneConfig,
  ClientScenesResponse,
  IClientScenesService,
} from "@zcode/services";
import { useAutomationTemplates } from "@/settings/useAutomationTemplates.js";

const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock("@/logger.js", () => ({
  logger: { warn: loggerWarn },
}));

// BYOK fork P1a：off-peak-task 场景不再映射进 catalog，数据源改用 scheduled-task（带合法 cron）。
function offPeakResponse(id: string, title: string): ClientScenesResponse {
  return {
    code: 0,
    msg: "success",
    data: [
      {
        namespace: "zcode",
        scene: "scheduled-task",
        options: {
          prompts: {
            id: "prompts",
            type: "prompts",
            contents: {},
            items: [
              {
                id,
                type: "prompts",
                contents: { en: `${title} prompt` },
                labels: { en: title },
                on_finish: null,
                img: null,
                defaults: { cronExpr: [`${id}-cron`] },
              },
            ],
            refer: "",
            templates: {},
          },
          cronExpr: {
            id: "cron",
            type: "cronExpr",
            contents: {},
            items: [
              {
                id: `${id}-cron`,
                type: "cronExpr",
                contents: { cn: "0 9 * * 1-5", en: "0 9 * * 1-5" },
                labels: {},
                on_finish: null,
                img: null,
              },
            ],
            refer: "",
            templates: {},
          },
        },
        created_at: 0,
        updated_at: 0,
      } as ClientSceneConfig,
    ],
  };
}

function service(list: () => Promise<ClientScenesResponse>): IClientScenesService {
  return { list };
}

beforeEach(() => {
  loggerWarn.mockReset();
});

describe("useAutomationTemplates", () => {
  it("keeps loading true until a successful Client Scenes response settles", async () => {
    let resolveList!: (response: ClientScenesResponse) => void;
    const list = vi.fn(
      () =>
        new Promise<ClientScenesResponse>((resolve) => {
          resolveList = resolve;
        }),
    );
    const clientScenesService = service(list);
    const { result } = renderHook(() => useAutomationTemplates(clientScenesService));

    expect(result.current.loading).toBe(true);
    await act(async () => {
      resolveList(offPeakResponse("item-loaded", "Loaded"));
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    // BYOK fork P1a：offPeak 目录已删除，改用 scheduled 场景验证同一加载语义。
    expect(result.current.scheduled[0]?.id).toBe("item-loaded");
  });

  it("returns an empty remote catalog when Client Scenes fails", async () => {
    const list = vi.fn().mockRejectedValue(new Error("offline"));
    const clientScenesService = service(list);
    const { result } = renderHook(() => useAutomationTemplates(clientScenesService));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scheduled).toEqual([]);
    expect(loggerWarn).toHaveBeenCalledWith(
      "[automation-templates] Client Scenes 请求失败，保留手动创建入口",
      { error: "offline" },
    );
  });

  it("ends loading with an empty remote catalog after a business failure", async () => {
    const list = vi.fn().mockResolvedValue({
      code: 5001,
      msg: "scene unavailable",
      data: [],
    } satisfies ClientScenesResponse);
    const clientScenesService = service(list);
    const { result } = renderHook(() => useAutomationTemplates(clientScenesService));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scheduled).toEqual([]);
  });

  it("ignores a late response from the previous service attachment", async () => {
    let resolveFirst!: (response: ClientScenesResponse) => void;
    const first = service(
      () =>
        new Promise<ClientScenesResponse>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const second = service(async () => offPeakResponse("item-new", "New"));
    const { result, rerender } = renderHook(
      ({ currentService }) => useAutomationTemplates(currentService),
      { initialProps: { currentService: first } },
    );

    rerender({ currentService: second });
    await waitFor(() => expect(result.current.scheduled[0]?.id).toBe("item-new"));
    expect(result.current.loading).toBe(false);
    await act(async () => {
      resolveFirst(offPeakResponse("item-old", "Old"));
      await Promise.resolve();
    });

    expect(result.current.scheduled[0]?.id).toBe("item-new");
    expect(result.current.loading).toBe(false);
  });
});
