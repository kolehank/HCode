/* BYOK A2：侧栏「手机远程」快捷入口的弹窗。
 * 官方中继删除后，手机远控走自托管链路（设置 → 远程访问 / webRemoteAccess）。
 * 本弹窗把「看二维码」从设置页四步缩为一步，视觉形态对齐参考实现
 * （旧 fork WebRemoteControlDialog 的图标头卡 + 分区卡片，见 zCode v3.99.0），
 * 但内容不同：参考版弹 Bot 渠道列表（P1c 已删），这里弹自托管二维码。
 * 数据面复用 remoteAccessAdapter 的 desktop IPC（webRemoteAccess）。 */
import { memo, useCallback, useEffect, useState } from "react";
import { LoaderCircle, MonitorSmartphone, QrCode as QrCodeIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { logger } from "@/logger.js";
import { QrCode } from "@/settings/QrCode.js";
import { toast } from "@/components/ui/toast.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import type { WebRemoteAccessStatus } from "@zcode/shared";

interface QuickAccessState {
  phase: "loading" | "ready" | "error";
  status: WebRemoteAccessStatus | null;
  /** token 模式重新生成后的一次性明文链接。 */
  regeneratedUrl: string | null;
  errorDetail: string | null;
}

const INITIAL_STATE: QuickAccessState = {
  phase: "loading",
  status: null,
  regeneratedUrl: null,
  errorDetail: null,
};

export const RemoteAccessQuickDialog = memo(function RemoteAccessQuickDialogComponent({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const formatMessage = useCallback((id: string) => intl.formatMessage({ id }), [intl]);
  const platform = usePlatform();
  const tabStoreApi = useTabStoreApi();
  const [state, setState] = useState<QuickAccessState>(INITIAL_STATE);
  const [regenerating, setRegenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setState(INITIAL_STATE);
      return;
    }
    let cancelled = false;
    setState({ ...INITIAL_STATE });
    const bridge = platform.webRemoteAccess;
    if (!bridge) {
      setState({
        ...INITIAL_STATE,
        phase: "error",
        errorDetail: "webRemoteAccess bridge unavailable",
      });
      return;
    }
    void (async () => {
      try {
        const snapshot = await bridge.getConfig();
        if (cancelled) return;
        setState({
          phase: "ready",
          status: snapshot.status,
          regeneratedUrl: null,
          errorDetail: null,
        });
      } catch (error) {
        if (cancelled) return;
        const detail = error instanceof Error ? error.message : String(error);
        logger.warn("[remoteAccessQuick] 读取远程访问配置失败", { error: detail });
        setState({ ...INITIAL_STATE, phase: "error", errorDetail: detail });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, platform]);

  const regenerateTokenUrl = useCallback(async () => {
    const bridge = platform.webRemoteAccess;
    const current = state.status;
    if (!bridge || !current) return;
    setRegenerating(true);
    setCopied(false);
    try {
      const result = await bridge.saveConfig({
        mode: current.mode,
        // cf*/externalBaseUrl 缺省保留当前配置（controller 的 ?? 语义），
        // 只做 regenerate，避免一键换码时清掉用户已存的 CF/基址设置。
        regenerate: true,
        desktopEnabled: true,
      });
      setState((prev) => ({
        ...prev,
        regeneratedUrl: result.accessUrl ?? null,
      }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error("[remoteAccessQuick] 重新生成 token 失败", { error: detail });
      toast(intl.formatMessage({ id: "settings.remoteAccess.saveFailed" }, { detail }));
    } finally {
      setRegenerating(false);
    }
  }, [intl, platform, state.status]);

  const copyLink = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        toast(formatMessage("settings.remoteAccess.copied"));
      } catch {
        toast(formatMessage("settings.remoteAccess.copyFailed"));
      }
    },
    [formatMessage],
  );

  const openSettingsRemoteAccess = useCallback(() => {
    onOpenChange(false);
    setPendingSettingsSectionIntent("remoteAccess");
    tabStoreApi.getState().openSettingsTab();
  }, [onOpenChange, tabStoreApi]);

  const status = state.status;
  const accessUrl =
    state.regeneratedUrl ??
    (status?.externalBaseUrl ? status.externalBaseUrl.replace(/\/+$/, "") : "");
  const tokenReady = status?.enabled && status.mode === "token" && state.regeneratedUrl;

  const renderBody = () => {
    if (state.phase === "loading") {
      return (
        <div className="flex items-center gap-2 py-8 text-ui-base text-foreground-subtle">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          {formatMessage("settings.remoteAccess.loading")}
        </div>
      );
    }
    if (state.phase === "error") {
      return (
        <section className="flex min-h-[220px] flex-col justify-center gap-3 rounded-xl border border-border bg-card p-4">
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {formatMessage("settings.remoteAccess.loadFailed")}
            {state.errorDetail ? `（${state.errorDetail}）` : null}
          </p>
          <Button type="button" variant="outline" onClick={openSettingsRemoteAccess}>
            {formatMessage("settings.remoteAccess.quick.goSettings")}
          </Button>
        </section>
      );
    }
    if (!status?.enabled) {
      return (
        <section className="flex min-h-[220px] flex-col justify-center gap-3 rounded-xl border border-border bg-card p-4">
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {formatMessage("settings.remoteAccess.quick.disabledHint")}
          </p>
          <Button type="button" onClick={openSettingsRemoteAccess}>
            {formatMessage("settings.remoteAccess.quick.goSettings")}
          </Button>
        </section>
      );
    }
    if (status.mode === "token" && !tokenReady) {
      return (
        <section className="flex min-h-[220px] flex-col justify-center gap-3 rounded-xl border border-border bg-card p-4">
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {formatMessage("settings.remoteAccess.quick.tokenHint")}
          </p>
          <Button
            type="button"
            disabled={regenerating}
            onClick={() => void regenerateTokenUrl()}
          >
            {regenerating ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <QrCodeIcon className="size-4" aria-hidden="true" />
            )}
            {formatMessage(
              status.hasToken
                ? "settings.remoteAccess.token.regenerate"
                : "settings.remoteAccess.token.generate",
            )}
          </Button>
        </section>
      );
    }
    if (!accessUrl) {
      return (
        <section className="flex min-h-[220px] flex-col justify-center gap-3 rounded-xl border border-border bg-card p-4">
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {formatMessage("settings.remoteAccess.quick.noBaseUrlHint")}
          </p>
          <Button type="button" onClick={openSettingsRemoteAccess}>
            {formatMessage("settings.remoteAccess.quick.goSettings")}
          </Button>
        </section>
      );
    }
    return (
      <section className="flex flex-col items-center gap-4 rounded-xl border border-border bg-card p-5">
        <QrCode value={accessUrl} size={192} />
        <div className="w-full break-all rounded-md bg-surface px-3 py-2 text-center font-mono text-ui-xs text-foreground-subtle">
          {accessUrl}
        </div>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full justify-center"
          onClick={() => void copyLink(accessUrl)}
        >
          {formatMessage("settings.remoteAccess.copyLink")}
        </Button>
        {status.mode === "token" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={regenerating}
            onClick={() => void regenerateTokenUrl()}
          >
            {regenerating ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {formatMessage("settings.remoteAccess.token.regenerate")}
          </Button>
        ) : null}
        {copied ? (
          <span className="text-ui-xs text-foreground-subtle">
            {formatMessage("settings.remoteAccess.copied")}
          </span>
        ) : null}
      </section>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100vh-6rem)] max-w-lg gap-0 overflow-hidden rounded-2xl p-0"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute top-2 right-2 enabled:cursor-pointer [app-region:no-drag]"
          onClick={() => onOpenChange(false)}
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </Button>
        <div className="max-h-[calc(100vh-6rem)] min-h-0 overflow-y-auto p-5">
          <DialogHeader className="space-y-2 pr-8">
            <div className="flex items-center gap-2">
              <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-primary">
                <MonitorSmartphone className="size-5" />
              </div>
              <div className="space-y-1">
                <DialogTitle>
                  {formatMessage("settings.remoteAccess.quick.title")}
                </DialogTitle>
                <DialogDescription>
                  {formatMessage("settings.remoteAccess.quick.description")}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="mt-5">{renderBody()}</div>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-ui-xs text-foreground-subtle">
              {status?.running
                ? formatMessage("settings.remoteAccess.quick.runningHint")
                : formatMessage("settings.remoteAccess.quick.stoppedHint")}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="enabled:cursor-pointer"
              onClick={openSettingsRemoteAccess}
            >
              {formatMessage("settings.remoteAccess.quick.goSettings")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});
