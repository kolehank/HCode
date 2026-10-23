// BYOK fork P1a：feedback 反馈中心（飞书表单厂商通道）已删除。
// 保留 store 形状与类型供旧入口（帮助菜单 / 错误横幅等）编译，动作全部 no-op。
import { create } from "zustand";
import type {
  FeedbackTicketModule,
  FeedbackTicketSeverity,
  FeedbackTicketType,
} from "@zcode/shared";

type FeedbackTab = "submit" | "tickets";

export interface FeedbackAttachmentDraft {
  readonly filename: string;
  readonly contentType: string;
  readonly dataBase64: string;
  readonly size: number;
}

export interface FeedbackSubmitDraft {
  readonly title?: string;
  readonly description?: string;
  readonly contact?: string;
  readonly type?: FeedbackTicketType;
  readonly module?: FeedbackTicketModule;
  readonly severity?: FeedbackTicketSeverity;
  readonly screenshots?: readonly FeedbackAttachmentDraft[];
  readonly includeLogs?: boolean;
}

interface FeedbackUiState {
  open: boolean;
  featureRequestOpen: boolean;
  tab: FeedbackTab;
  submitDraft: FeedbackSubmitDraft | null;
  submissionJobId: string | null;
  selectedTicketId: string | null;
  openSubmit: (draft?: FeedbackSubmitDraft) => void;
  openSubmissionJob: (jobId: string) => void;
  openFeatureRequest: () => void;
  openTickets: (ticketId?: string) => void;
  setTab: (tab: FeedbackTab) => void;
  setSelectedTicketId: (ticketId: string | null) => void;
  close: () => void;
}

export const useFeedbackStore = create<FeedbackUiState>()(() => ({
  open: false,
  featureRequestOpen: false,
  tab: "submit",
  submitDraft: null,
  submissionJobId: null,
  selectedTicketId: null,
  openSubmit: () => {},
  openSubmissionJob: () => {},
  openFeatureRequest: () => {},
  openTickets: () => {},
  setTab: () => {},
  setSelectedTicketId: () => {},
  close: () => {},
}));
