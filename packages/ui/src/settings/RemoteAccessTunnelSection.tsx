/* BYOK A2：设置页「临时公网通道（Cloudflare Quick Tunnel）」区块。
 * 从 RemoteAccessSection 拆出：状态机（starting/running/error）与安装引导文案
 * 让主组件保持可读，且该区块只在 desktop IPC 形态出现（web 形态无法托管进程）。 */
import { useCallback } from "react";
import { Copy, LoaderCircle, RefreshCw } from "lucide-react";
import type { CloudflaredDetection, QuickTunnelStatus } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import type { WebAccessMode } from "@/settings/remoteAccessAdapter.js";

export interface RemoteAccessTunnelSectionProps {
  enabled: boolean;
  mode: WebAccessMode;
  tunnel: QuickTunnelStatus;
  detection: CloudflaredDetection | null;
  detecting: boolean;
  restarting: boolean;
  onToggle: (enabled: boolean) => void;
  onSwitchToToken: () => void;
  onDetect: () => void;
  onRestart: () => void;
}

export function RemoteAccessTunnelSection({
  enabled,
  mode,
  tunnel,
  detection,
  detecting,
  restarting,
  onToggle,
  onSwitchToToken,
  onDetect,
  onRestart,
}: RemoteAccessTunnelSectionProps) {
  const { intl } = useZCodeIntl();
  const formatMessage = useCallback((id: string) => intl.formatMessage({ id }), [intl]);

  const copyUrl = useCallback(async () => {
    if (!tunnel.publicUrl) {
      return;
    }
    try {
      await navigator.clipboard.writeText(tunnel.publicUrl);
      toast(formatMessage("settings.remoteAccess.copied"));
    } catch {
      toast(formatMessage("settings.remoteAccess.copyFailed"));
    }
  }, [formatMessage, tunnel.publicUrl]);

  const requiresToken = mode !== "token";

  return (
    <section className="space-y-3">
      <div className="text-ui-base font-medium text-foreground-subtle">
        {formatMessage("settings.remoteAccess.tunnel.section")}
      </div>
      <SettingsGroupCard>
        <SettingsRow
          label={formatMessage("settings.remoteAccess.tunnel.enable")}
          description={formatMessage("settings.remoteAccess.tunnel.enableDescription")}
          control={
            <Switch
              aria-label={formatMessage("settings.remoteAccess.tunnel.enable")}
              checked={enabled}
              disabled={requiresToken}
              onCheckedChange={onToggle}
            />
          }
        />
        {requiresToken ? (
          <SettingsRow
            label={formatMessage("settings.remoteAccess.tunnel.requiresToken")}
            control={
              <Button type="button" size="lg" variant="outline" onClick={onSwitchToToken}>
                {formatMessage("settings.remoteAccess.tunnel.switchToToken")}
              </Button>
            }
          />
        ) : null}
        <div className="border-t border-border px-4 py-3 text-ui-xs text-foreground-subtle">
          {formatMessage("settings.remoteAccess.tunnel.warning")}
        </div>

        {enabled ? (
          <div className="flex flex-col gap-3 border-t border-border px-4 py-4">
            <div className="flex items-center gap-2 text-ui-base text-foreground">
              {tunnel.state === "starting" ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  {formatMessage("settings.remoteAccess.tunnel.state.starting")}
                </>
              ) : null}
              {tunnel.state === "running" ? (
                <span>{formatMessage("settings.remoteAccess.tunnel.state.running")}</span>
              ) : null}
              {tunnel.state === "idle" || tunnel.state === "disabled" ? (
                <span>{formatMessage("settings.remoteAccess.tunnel.state.stopped")}</span>
              ) : null}
              {tunnel.state === "error" ? (
                <span>
                  {formatMessage(
                    tunnel.errorCode === "binary-missing"
                      ? "settings.remoteAccess.tunnel.state.binaryMissing"
                      : tunnel.errorCode === "crashed"
                        ? "settings.remoteAccess.tunnel.state.crashed"
                        : "settings.remoteAccess.tunnel.state.startFailed",
                  )}
                </span>
              ) : null}
            </div>

            {tunnel.state === "running" && tunnel.publicUrl ? (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1 break-all rounded-md bg-surface px-3 py-2 font-mono text-ui-xs text-foreground-subtle">
                  {tunnel.publicUrl}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => void copyUrl()}
                >
                  <Copy className="size-4" aria-hidden="true" />
                  {formatMessage("settings.remoteAccess.tunnel.copyUrl")}
                </Button>
              </div>
            ) : null}

            {tunnel.state === "running" && tunnel.reachable === false ? (
              <p className="text-ui-xs text-foreground-subtle">
                {formatMessage("settings.remoteAccess.tunnel.unreachable")}
              </p>
            ) : null}
            {tunnel.state === "running" && tunnel.transport === "http2" ? (
              <p className="text-ui-xs text-foreground-subtle">
                {formatMessage("settings.remoteAccess.tunnel.http2")}
              </p>
            ) : null}

            {tunnel.state === "error" && tunnel.errorDetail ? (
              <div className="break-all rounded-md bg-surface px-3 py-2 text-ui-xs text-foreground-subtle">
                {tunnel.errorDetail}
              </div>
            ) : null}

            {tunnel.state === "error" && tunnel.errorCode === "binary-missing" ? (
              <div className="space-y-1 rounded-md bg-surface px-3 py-2 font-mono text-ui-xs text-foreground-subtle">
                <div>{formatMessage("settings.remoteAccess.tunnel.installWindows")}</div>
                <div>{formatMessage("settings.remoteAccess.tunnel.installMac")}</div>
                <div className="font-sans">
                  {formatMessage("settings.remoteAccess.tunnel.installHint")}
                </div>
                {detection?.path ? <div>{detection.path}</div> : null}
              </div>
            ) : null}

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={detecting}
                onClick={onDetect}
              >
                {detecting ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="size-4" aria-hidden="true" />
                )}
                {formatMessage("settings.remoteAccess.tunnel.redetect")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={restarting}
                onClick={onRestart}
              >
                {restarting ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="size-4" aria-hidden="true" />
                )}
                {formatMessage("settings.remoteAccess.tunnel.restart")}
              </Button>
            </div>
          </div>
        ) : null}
      </SettingsGroupCard>
    </section>
  );
}
