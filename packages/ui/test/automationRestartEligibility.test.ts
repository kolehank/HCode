import { describe, expect, it } from "vitest";
// BYOK fork P1a：off-peak/Idle tab 随闲时任务 UI 删除，相关用例移除；
// 保留 Scheduled 单 tab 的现有语义断言。
import {
  canRestartAutomation,
  canToggleAutomation,
  getAutomationActionErrorToastId,
  getAutomationCreateErrorToastId,
  getAutomationRunNowToastId,
  resolveAutomationDetailNavigation,
  resolveAutomationTabNavigation,
  resolveAutomationDetailTarget,
  resolveAutomationTemplateVisibility,
  resolveVisibleAutomationTabs,
} from "@/settings/AutomationsSection.js";

describe("canRestartAutomation", () => {
  it("只允许 failed 定时任务展示重启入口", () => {
    expect(canRestartAutomation({ lifecycleStatus: "failed" })).toBe(true);
    expect(canRestartAutomation({ lifecycleStatus: "completed" })).toBe(false);
    expect(canRestartAutomation({ lifecycleStatus: "active" })).toBe(false);
    expect(canRestartAutomation({ lifecycleStatus: "paused" })).toBe(false);
  });

  it("completed 和 failed 终态不展示暂停或恢复入口", () => {
    expect(canToggleAutomation({ lifecycleStatus: "active" })).toBe(true);
    expect(canToggleAutomation({ lifecycleStatus: "paused" })).toBe(true);
    expect(canToggleAutomation({ lifecycleStatus: "completed" })).toBe(false);
    expect(canToggleAutomation({ lifecycleStatus: "failed" })).toBe(false);
  });

  it("重复立即运行会映射到正在运行提示", () => {
    expect(getAutomationRunNowToastId("queued")).toBe("automations.runNowQueued");
    expect(getAutomationRunNowToastId("duplicate")).toBe("automations.runNowAlreadyRunning");
    expect(getAutomationRunNowToastId("failed")).toBe("automations.runNowFailed");
  });

  it("管理操作失败映射为产品文案，不直接展示 RPC 原文", () => {
    expect(getAutomationActionErrorToastId("create")).toBe("automations.error.create");
    expect(getAutomationActionErrorToastId("update")).toBe("automations.error.update");
    expect(getAutomationActionErrorToastId("toggle")).toBe("automations.error.toggle");
    expect(getAutomationActionErrorToastId("restart")).toBe("automations.error.restart");
    expect(getAutomationActionErrorToastId("delete")).toBe("automations.error.delete");
    expect(
      getAutomationCreateErrorToastId("[AUTOMATION_CREATE_LIMIT_REACHED] automation limit reached"),
    ).toBe("automations.error.createLimit");
    expect(getAutomationCreateErrorToastId("rpc unavailable")).toBe("automations.error.create");
  });

  it("会话创建卡片按 automationId 定位对应详情", () => {
    const target = { automationId: "automation-target" } as never;
    const other = { automationId: "automation-other" } as never;

    expect(resolveAutomationDetailTarget([other, target], " automation-target ")).toBe(target);
    expect(resolveAutomationDetailTarget([other], "automation-target")).toBeNull();
    expect(resolveAutomationDetailTarget([target], undefined)).toBeNull();
  });

  it("详情导航等待列表完成，并在目标不存在时进入可消费的失败终态", () => {
    const target = { automationId: "automation-target" } as never;

    expect(resolveAutomationDetailNavigation([], "automation-target", false)).toEqual({
      status: "pending",
    });
    expect(resolveAutomationDetailNavigation([target], "automation-target", true)).toEqual({
      status: "found",
      target,
    });
    expect(resolveAutomationDetailNavigation([], "automation-target", true)).toEqual({
      status: "missing",
    });
  });

  it("无任务时不展示任何 tab，有任务只展示 Scheduled", () => {
    // BYOK fork P1a：Idle tab 已删除；offPeakVisible 参数不再参与判定。
    expect(resolveVisibleAutomationTabs({ hasAnyTasks: true })).toEqual(["scheduled"]);
    expect(resolveVisibleAutomationTabs({ hasAnyTasks: false })).toEqual([]);
  });

  it("仅在 tabs 数据就绪且 Idle tab 可见时应用 OFFPEAK 导航", () => {
    expect(
      resolveAutomationTabNavigation({
        requestedTab: "idle",
        tabsReady: false,
        visibleTabs: [],
      }),
    ).toEqual({ status: "pending" });
    expect(
      resolveAutomationTabNavigation({
        requestedTab: "idle",
        tabsReady: true,
        visibleTabs: ["scheduled", "idle"],
      }),
    ).toEqual({ status: "settled", tab: "idle" });
    expect(
      resolveAutomationTabNavigation({
        requestedTab: "idle",
        tabsReady: true,
        visibleTabs: ["scheduled"],
      }),
    ).toEqual({ status: "settled", tab: "scheduled" });
  });

  it("无任务时展示 Scheduled 模板，有任务时按 tab 分流", () => {
    // BYOK fork P1a：offPeakCreationEnabled 与 showOffPeakTemplates 已删除，
    // 仅保留 Scheduled 模板可见性语义。
    expect(
      resolveAutomationTemplateVisibility({
        hasAnyTasks: false,
        tab: "scheduled",
      }),
    ).toEqual({
      showScheduledTemplates: true,
    });
    expect(
      resolveAutomationTemplateVisibility({
        hasAnyTasks: true,
        tab: "scheduled",
      }),
    ).toEqual({
      showScheduledTemplates: true,
    });
    expect(
      resolveAutomationTemplateVisibility({
        hasAnyTasks: true,
        tab: "idle" as never,
      }),
    ).toEqual({
      showScheduledTemplates: false,
    });
  });
});
