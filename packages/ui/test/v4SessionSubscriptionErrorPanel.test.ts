// @vitest-environment jsdom

import type { IPlatformService } from "@zcode/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SessionSubscriptionErrorPanel } from "@/v4/SessionSubscriptionErrorPanel.js";

const screenshot = {
  filename: "session-subscription-error.png",
  contentType: "image/png",
  dataBase64: "c2NyZWVuc2hvdA==",
  size: 10,
};
const captureWindowScreenshot = vi.fn(async () => screenshot);
const platform = {
  captureWindowScreenshot,
} as unknown as IPlatformService;

function renderPanel() {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        PlatformProvider,
        { platform },
        createElement(SessionSubscriptionErrorPanel, {
          error: "EPERM: operation not permitted",
          sessionId: "session-1",
          workspacePath: "F:\\ZCode_data",
          onReconnect: vi.fn(),
        }),
      ),
    ),
  );
}

beforeEach(() => {
  useFeedbackStore.setState({
    open: false,
    featureRequestOpen: false,
    tab: "submit",
    submitDraft: null,
    submissionJobId: null,
    selectedTicketId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SessionSubscriptionErrorPanel", () => {
  it("shows the subscription error with report and reconnect actions", () => {
    renderPanel();

    expect(screen.getByText("EPERM: operation not permitted")).toBeTruthy();
    expect(screen.getByRole("button", { name: "反馈问题" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新连接" })).toBeTruthy();
  });

  it("反馈入口点击后不再写 feedback 草稿（厂商通道已删，仅保留入口）", async () => {
    // BYOK fork P1a：feedback 厂商通道删除，openSubmit 为 no-op，不再写入 submitDraft。
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "反馈问题" }));

    await waitFor(() => expect(captureWindowScreenshot).not.toHaveBeenCalled());
    expect(useFeedbackStore.getState().open).toBe(false);
    expect(useFeedbackStore.getState().submitDraft).toBeNull();
  });
});
