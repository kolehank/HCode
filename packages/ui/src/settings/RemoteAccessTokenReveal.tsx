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
        // 整行上下布局（与 RemoteAccessQuickDialog 卡片同构）：wide 行的 label|280px
        // 列会把高 QR 塞进右列、左侧留大片空白。
        <div className="flex flex-col items-center gap-3 border-t border-border px-4 py-4">
          <div className="text-ui-base font-medium text-foreground">
            {formatMessage("settings.remoteAccess.oneTime.qr")}
          </div>
          <QrCode value={accessUrl} size={192} />
          <div className="w-full break-all rounded-md bg-surface px-3 py-2 text-center font-mono text-ui-xs text-foreground-subtle">
            {accessUrl}
          </div>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full justify-center"
            onClick={() => void copyText(accessUrl)}
          >
            {formatMessage("settings.remoteAccess.copyLink")}
          </Button>
        </div>
      ) : null}
    </SettingsGroupCard>
  );
}
