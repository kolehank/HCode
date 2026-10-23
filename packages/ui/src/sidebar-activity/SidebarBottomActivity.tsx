import { GlobalNoticeSurface } from "@/global-notice/GlobalNoticeSurface.js";
import type { GlobalNoticeStore } from "@/global-notice/globalNoticeStore.js";

// BYOK fork P1d：MarketingBanner/useMarketingBannerVisible 槽位段随营销族删除，
// 槽位本体（GlobalNoticeSurface 投影）保留。
export function SidebarBottomActivity({
  noticeStore,
}: {
  noticeStore?: GlobalNoticeStore | null;
} = {}) {
  // 未注入时走 GlobalNoticeSurface 默认的 browserGlobalNoticeStore。
  return <GlobalNoticeSurface store={noticeStore ?? undefined} />;
}
