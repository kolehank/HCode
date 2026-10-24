import { beforeEach, describe, expect, it } from "vitest";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";

function resetFeedbackStore() {
  useFeedbackStore.setState({
    open: false,
    featureRequestOpen: false,
    tab: "submit",
    submitDraft: null,
    submissionJobId: null,
    selectedTicketId: null,
  });
}

describe("feedback store", () => {
  beforeEach(() => {
    resetFeedbackStore();
  });

  // BYOK fork P1a：feedback 反馈中心（飞书表单厂商通道）已删除，store 动作全部 no-op。
  // 旧「互斥打开 / 打开后台提交 / 按 jobId 打开」交互用例改为断言动作不再改写状态。
  it("keeps all legacy dialog actions as no-ops after the feedback channel removal", () => {
    useFeedbackStore.getState().openFeatureRequest();
    expect(useFeedbackStore.getState()).toMatchObject({
      open: false,
      featureRequestOpen: false,
    });

    useFeedbackStore.getState().openSubmit({ includeLogs: true });
    expect(useFeedbackStore.getState()).toMatchObject({
      open: false,
      submitDraft: null,
    });

    useFeedbackStore.getState().openSubmissionJob("feedback-job-a");
    expect(useFeedbackStore.getState().submissionJobId).toBeNull();
  });
});
