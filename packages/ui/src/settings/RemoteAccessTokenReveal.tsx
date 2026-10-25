/* BYOK P3：token 一次性展示卡片（明文 + 复制 + QR + 完整链接），从 RemoteAccessSection 拆出。 */
import { useCallback } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { QrCode } from "@/settings/QrCode.js";

export interface RemoteAccessTokenRevealProps {
  token: string;
  accessUrl?: string;
}

export function RemoteAccessTokenReveal({ token, accessUrl }: RemoteAccessTokenRevealProps) {
  const { intl } = useZCodeIntl();
  const formatMessage = useCallback((id: string) => intl.formatMessage({ id }), [intl]);

  const copyText = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        toast(formatMessage("settings.remoteAccess.copied"));
      } catch {
        toast(formatMessage("settings.remoteAccess.copyFailed"));
      }
    },
    [formatMessage],
  );

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={formatMessage("settings.remoteAccess.oneTime.token")}
        description={formatMessage("settings.remoteAccess.oneTime.hint")}
        controlLayout="wide"
        control={
          <Button type="button" size="lg" variant="outline" onClick={() => void copyText(token)}>
            {formatMessage("settings.remoteAccess.copyToken")}
          </Button>
        }
        detail={
          <div className="w-full break-all rounded-md bg-surface px-3 py-2 font-mono text-ui-base">
            {token}
          </div>
        }
      />
      {accessUrl ? (
        <SettingsRow
          label={formatMessage("settings.remoteAccess.oneTime.qr")}
          controlLayout="wide"
          control={
            <Button
              type="button"
              size="lg"
              variant="outline"
              onClick={() => void copyText(accessUrl)}
            >
              {formatMessage("settings.remoteAccess.copyLink")}
            </Button>
          }
          detail={
            // 上下布局（与 RemoteAccessQuickDialog 同构）：完整链接带 #token 很长，
            // 左右并排会把地址挤塌成逐字符换行（min-w-0 + break-all 在窄容器下的表现）。
            <div className="flex w-full flex-col items-center gap-3">
              <QrCode value={accessUrl} size={168} />
              <div className="w-full break-all rounded-md bg-surface px-3 py-2 text-center font-mono text-ui-xs text-foreground-subtle">
                {accessUrl}
              </div>
            </div>
          }
        />
      ) : null}
    </SettingsGroupCard>
  );
}
