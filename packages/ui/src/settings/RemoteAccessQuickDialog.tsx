/* BYOK A2：侧栏「手机远程」快捷入口的弹窗。
 * 官方中继删除后，手机远控走自托管链路（设置 → 远程访问 / webRemoteAccess）。
 * 本弹窗把「看二维码」从设置页四步缩为一步：
 * - open / cloudflare-access：直接展示 externalBaseUrl 的 QR；
 * - token：一键重新生成并展示新 token 链接（旧 token 立即失效）；
 * - 未启用：引导去设置页。数据面全部复用 remoteAccessAdapter（desktop IPC）。 */
import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, MonitorSmartphone } from "lucide-react";
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
import { logger } from "@/logger.js";
import { QrCode } from "@/settings/QrCode.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { toast } from "@/components/ui/toast.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";

interface QuickAccessState {
  phase: "loading" | "ready" | "error";
  enabled: boolean;
  mode: "open" | "cloudflare-access" | "token";
  externalBaseUrl: string;
  /** token 模式重新生成后的一次性明文链接。 */
  regeneratedUrl: string | null;
  errorDetail: string | null;
}

const INITIAL_STATE: QuickAccessState = {
  phase: "loading",
  enabled: false,
  mode: "open",
  externalBaseUrl: "",
  regeneratedUrl: null,
  errorDetail: null,
};

export function RemoteAccessQuickDialog({
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
          enabled: snapshot.status.enabled,
          mode: snapshot.status.mode,
          externalBaseUrl: snapshot.status.externalBaseUrl,
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
    if (!bridge) return;
    setRegenerating(true);
    try {
      const result = await bridge.saveConfig({
        mode: state.mode,
        // cf*/externalBaseUrl 缺省保留当前配置（controller 的 ?? 语义），
        // 只做 regenerate，避免一键换码时清掉用户已存的 CF/基址设置。
        regenerate: true,
        desktopEnabled: true,
      });
      setState((current) => ({
        ...current,
        regeneratedUrl: result.accessUrl ?? null,
      }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error("[remoteAccessQuick] 重新生成 token 失败", { error: detail });
      toast(intl.formatMessage({ id: "settings.remoteAccess.saveFailed" }, { detail }));
    } finally {
      setRegenerating(false);
    }
  }, [intl, platform, state.mode]);

  const openSettingsRemoteAccess = useCallback(() => {
    onOpenChange(false);
    setPendingSettingsSectionIntent("remoteAccess");
    tabStoreApi.getState().openSettingsTab();
  }, [onOpenChange, tabStoreApi]);

  const renderBody = () => {
    if (state.phase === "loading") {
      return (
        <div className="flex items-center gap-2 px-1 py-6 text-ui-base text-foreground-subtle">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          {formatMessage("settings.remoteAccess.loading")}
        </div>
      );
    }
    if (state.phase === "error") {
      return (
        <div className="space-y-3">
          <p className="text-ui-base text-foreground-subtle">
            {formatMessage("settings.remoteAccess.loadFailed")}
            {state.errorDetail ? `（${state.errorDetail}）` : null}
          </p>
          <Button type="button" variant="outline" onClick={openSettingsRemoteAccess}>
            {formatMessage("settings.remoteAccess.quick.goSettings")}
          </Button>
        </div>
      );
    }
    if (!state.enabled) {
      return (
        <div className="space-y-3">
          <p className="text-ui-base text-foreground-subtle">
            {formatMessage("settings.remoteAccess.quick.disabledHint")}
          </p>
          <Button type="button" onClick={openSettingsRemoteAccess}>
            {formatMessage("settings.remoteAccess.quick.goSettings")}
          </Button>
        </div>
      );
    }
    if (state.mode === "token") {
      return (
        <div className="space-y-3">
          {state.regeneratedUrl ? (
            <div className="flex items-start gap-4">
              <QrCode value={state.regeneratedUrl} size={168} />
              <div className="flex min-w-0 flex-col gap-2">
                <div className="break-all font-mono text-ui-xs text-foreground-subtle">
                  {state.regeneratedUrl}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void navigator.clipboard.writeText(state.regeneratedUrl ?? "")}
                >
                  {formatMessage("settings.remoteAccess.copyLink")}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-ui-base text-foreground-subtle">
              {formatMessage("settings.remoteAccess.quick.tokenHint")}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={regenerating}
            onClick={() => void regenerateTokenUrl()}
          >
            {regenerating ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {formatMessage(
              state.regeneratedUrl
                ? "settings.remoteAccess.token.regenerate"
                : "settings.remoteAccess.token.generate",
            )}
          </Button>
        </div>
      );
    }
    // open / cloudflare-access：链接即入口（CF 的认证在边缘完成）。
    if (!state.externalBaseUrl) {
      return (
        <div className="space-y-3">
          <p className="text-ui-base text-foreground-subtle">
            {formatMessage("settings.remoteAccess.quick.noBaseUrlHint")}
          </p>
          <Button type="button" onClick={openSettingsRemoteAccess}>
            {formatMessage("settings.remoteAccess.quick.goSettings")}
          </Button>
        </div>
      );
    }
    const url = state.externalBaseUrl.replace(/\/+$/, "");
    return (
      <div className="flex items-start gap-4">
        <QrCode value={url} size={168} />
        <div className="flex min-w-0 flex-col gap-2">
          <div className="break-all font-mono text-ui-xs text-foreground-subtle">{url}</div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(url)}
          >
            {formatMessage("settings.remoteAccess.copyLink")}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MonitorSmartphone className="size-4" aria-hidden="true" />
            {formatMessage("settings.remoteAccess.quick.title")}
          </DialogTitle>
          <DialogDescription>
            {formatMessage("settings.remoteAccess.quick.description")}
          </DialogDescription>
        </DialogHeader>
        {renderBody()}
      </DialogContent>
    </Dialog>
  );
}
