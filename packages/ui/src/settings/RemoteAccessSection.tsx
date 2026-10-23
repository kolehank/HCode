/* BYOK P3/A2：设置页「远程访问」区块。三档鉴权切换、外部基址双模式、token 一次性展示 + QR。
 * 数据源 adapter 化（见 remoteAccessAdapter.ts）：Web 形态走 server HTTP API，
 * 桌面形态走 IPlatformService.webRemoteAccess（main 内嵌 HTTP/WS 入口 + IPC 配置面）；
 * 组件内部状态机不变，只换数据源，桌面额外多一个 desktopEnabled 开关。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { RemoteAccessTokenReveal } from "@/settings/RemoteAccessTokenReveal.js";
import {
  createDesktopRemoteAccessAdapter,
  createWebRemoteAccessAdapter,
  type WebAccessInterfaceItem,
  type WebAccessMode,
} from "@/settings/remoteAccessAdapter.js";

function buildInterfaceUrl(item: WebAccessInterfaceItem, port: number): string {
  const host = item.family === "IPv6" ? `[${item.address}]` : item.address;
  return `http://${host}:${port}`;
}

function formatInterfaceLabel(
  item: WebAccessInterfaceItem,
  port: number,
  formatMessage: (id: string) => string,
): string {
  const suffix = item.isTailscale
    ? ` · Tailscale`
    : item.suggested
      ? ` · ${formatMessage("settings.remoteAccess.interface.suggested")}`
      : "";
  return `${item.name} — ${item.address}${suffix}`;
}

export function RemoteAccessSection({ isDesktop }: { isDesktop: boolean }) {
  const { intl } = useZCodeIntl();
  const formatMessage = useCallback(
    (id: string) => intl.formatMessage({ id }),
    [intl],
  );
  const platform = usePlatform();
  const desktopBridge = isDesktop ? platform.webRemoteAccess : undefined;

  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<WebAccessMode>("open");
  const [cfTeamDomain, setCfTeamDomain] = useState("");
  const [cfAud, setCfAud] = useState("");
  const [cfAllowedEmails, setCfAllowedEmails] = useState("");
  const [tokenPrefix, setTokenPrefix] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [externalBaseUrl, setExternalBaseUrl] = useState("");
  const [interfaces, setInterfaces] = useState<WebAccessInterfaceItem[]>([]);
  const [selectedAddress, setSelectedAddress] = useState("");
  const [port, setPort] = useState(0);
  const [saving, setSaving] = useState(false);
  const [desktopEnabled, setDesktopEnabled] = useState(false);
  const [webStaticConfigured, setWebStaticConfigured] = useState(true);
  const [oneTimeToken, setOneTimeToken] = useState<{ token: string; accessUrl?: string } | null>(
    null,
  );
  // 卸载守卫：save 的 await 回包晚于组件卸载时跳过 setState，与 load 路径的 cancelled 标志同一语义。
  // 用一行 effect 压行数：本文件受 max-lines=400 门禁约束。
  const mountedRef = useRef(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅注册卸载清理，无依赖
  useEffect(() => () => void (mountedRef.current = false), []);

  useEffect(() => {
    // 桌面端旧 preload 未暴露 webRemoteAccess 桥时保留「Web server only」提示。
    if (isDesktop && !desktopBridge) {
      return;
    }
    let cancelled = false;
    const adapter = desktopBridge
      ? createDesktopRemoteAccessAdapter(desktopBridge)
      : createWebRemoteAccessAdapter();
    // 只在打开设置页时各调用一次（本组件挂载即打开状态）。
    void (async () => {
      try {
        const result = await adapter.load();
        if (cancelled) {
          return;
        }
        const config = result.config;
        setMode(config.mode);
        setCfTeamDomain(config.cfTeamDomain);
        setCfAud(config.cfAud);
        setCfAllowedEmails(config.cfAllowedEmails.join(", "));
        setTokenPrefix(config.tokenPrefix);
        setHasToken(config.hasToken);
        setExternalBaseUrl(config.externalBaseUrl);
        setPort(config.port);
        setInterfaces(result.interfaces);
        if (result.desktopEnabled !== undefined) {
          setDesktopEnabled(result.desktopEnabled);
        }
        if (result.webStaticConfigured !== undefined) {
          setWebStaticConfigured(result.webStaticConfigured);
        }
        // 默认选中建议网卡（tailscale / 私网优先，server 侧已标注 suggested）。
        const suggested =
          result.interfaces.find((item) => item.suggested) ?? result.interfaces[0] ?? null;
        setSelectedAddress(suggested?.address ?? "");
        setLoaded(true);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktopBridge, isDesktop]);

  const save = useCallback(
    async (options: { regenerate: boolean }) => {
      if (mode === "cloudflare-access" && (!cfTeamDomain.trim() || !cfAud.trim())) {
        toast(formatMessage("settings.remoteAccess.cf.requiredError"));
        return;
      }
      setSaving(true);
      try {
        const adapter = desktopBridge
          ? createDesktopRemoteAccessAdapter(desktopBridge)
          : createWebRemoteAccessAdapter();
        const result = await adapter.save({
          mode,
          cfTeamDomain: cfTeamDomain.trim(),
          cfAud: cfAud.trim(),
          cfAllowedEmails: cfAllowedEmails
            .split(/[,;\n]/)
            .map((email) => email.trim())
            .filter(Boolean),
          externalBaseUrl: externalBaseUrl.trim(),
          regenerate: options.regenerate,
          ...(desktopBridge ? { desktopEnabled } : {}),
        });
        if (!mountedRef.current) {
          return;
        }
        setTokenPrefix(result.tokenPrefix);
        setHasToken(result.hasToken);
        if (result.token) {
          // 明文只在生成响应里出现一次；组件卸载后 UI 不再持有。
          setOneTimeToken({
            token: result.token,
            ...(result.accessUrl ? { accessUrl: result.accessUrl } : {}),
          });
        }
        // 桌面内嵌入口按新配置即时重建监听；web server 形态仍需重启进程。
        toast(
          formatMessage(
            desktopBridge
              ? "settings.remoteAccess.savedToastDesktop"
              : "settings.remoteAccess.savedToast",
          ),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error("[remoteAccess] 保存远程访问配置失败", { error: detail });
        // 生产构建 renderer 日志 no-op，错误细节必须随 toast 透出，否则保存失败无从定位。
        // 细节经 i18n 占位符 {detail} 插值（修复依据：硬编码全角括号无法本地化）。
        toast(intl.formatMessage({ id: "settings.remoteAccess.saveFailed" }, { detail }));
      } finally {
        if (mountedRef.current) {
          setSaving(false);
        }
      }
    },
    [
      cfAud,
      cfTeamDomain,
      cfAllowedEmails,
      desktopBridge,
      desktopEnabled,
      externalBaseUrl,
      formatMessage,
      intl,
      mode,
    ],
  );

  if (isDesktop && !desktopBridge) {
    return (
      <div className="rounded-lg border border-border bg-surface px-4 py-3 text-ui-base text-foreground-subtle">
        {formatMessage("settings.remoteAccess.webServerOnly")}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-border bg-surface px-4 py-3 text-ui-base text-foreground-subtle">
        {formatMessage("settings.remoteAccess.loadFailed")}（{loadError}）
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-ui-base text-foreground-subtle">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        {formatMessage("settings.remoteAccess.loading")}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <SettingsGroupCard>
          {desktopBridge ? (
            <SettingsRow
              label={formatMessage("settings.remoteAccess.desktop.enable")}
              description={formatMessage("settings.remoteAccess.desktop.enableDescription")}
              control={
                <Switch
                  aria-label={formatMessage("settings.remoteAccess.desktop.enable")}
                  checked={desktopEnabled}
                  onCheckedChange={(checked) => setDesktopEnabled(checked)}
                />
              }
            />
          ) : null}
          {desktopBridge && desktopEnabled && !webStaticConfigured ? (
            <div className="rounded-lg border border-border bg-surface px-4 py-3 text-ui-xs text-foreground-subtle">
              {formatMessage("settings.remoteAccess.desktop.webStaticMissing")}
            </div>
          ) : null}
          <SettingsRow
            label={formatMessage("settings.remoteAccess.mode.label")}
            description={formatMessage("settings.remoteAccess.mode.description")}
            control={
              <Select value={mode} onValueChange={(next) => setMode(next as WebAccessMode)}>
                <SelectTrigger size="lg" className="w-64 min-w-0 justify-between">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">
                    {formatMessage("settings.remoteAccess.mode.open")}
                  </SelectItem>
                  <SelectItem value="cloudflare-access">
                    {formatMessage("settings.remoteAccess.mode.cloudflareAccess")}
                  </SelectItem>
                  <SelectItem value="token">
                    {formatMessage("settings.remoteAccess.mode.token")}
                  </SelectItem>
                </SelectContent>
              </Select>
            }
          />
          {mode === "cloudflare-access" ? (
            <>
              <SettingsRow
                label={formatMessage("settings.remoteAccess.cf.teamDomain")}
                control={
                  <Input
                    className="w-64"
                    value={cfTeamDomain}
                    placeholder="example.cloudflareaccess.com"
                    onChange={(event) => setCfTeamDomain(event.target.value)}
                  />
                }
              />
              <SettingsRow
                label={formatMessage("settings.remoteAccess.cf.aud")}
                control={
                  <Input
                    className="w-64"
                    value={cfAud}
                    onChange={(event) => setCfAud(event.target.value)}
                  />
                }
              />
              <SettingsRow
                label={formatMessage("settings.remoteAccess.cf.emails")}
                description={formatMessage("settings.remoteAccess.cf.emailsDescription")}
                controlLayout="wide"
                control={
                  <Input
                    value={cfAllowedEmails}
                    placeholder="a@example.com, b@example.com"
                    onChange={(event) => setCfAllowedEmails(event.target.value)}
                  />
                }
              />
            </>
          ) : null}
          {mode === "token" ? (
            <SettingsRow
              label={formatMessage("settings.remoteAccess.token.title")}
              description={
                hasToken
                  ? `${formatMessage("settings.remoteAccess.token.prefix")}: ${tokenPrefix || "—"}`
                  : formatMessage("settings.remoteAccess.token.none")
              }
              control={
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  className="min-w-24"
                  disabled={saving}
                  onClick={() => void save({ regenerate: true })}
                >
                  {formatMessage(
                    hasToken
                      ? "settings.remoteAccess.token.regenerate"
                      : "settings.remoteAccess.token.generate",
                  )}
                </Button>
              }
            />
          ) : null}
        </SettingsGroupCard>
      </section>

      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          {formatMessage("settings.remoteAccess.baseUrl.section")}
        </div>
        <SettingsGroupCard>
          <SettingsRow
            label={formatMessage("settings.remoteAccess.interface.label")}
            description={
              port > 0
                ? `${formatMessage("settings.remoteAccess.port")}: ${port}`
                : undefined
            }
            control={
              <Select
                value={selectedAddress}
                onValueChange={(address) => {
                  const item = interfaces.find((candidate) => candidate.address === address);
                  setSelectedAddress(address);
                  if (item && port > 0) {
                    // 建议值回显到下方输入框，保持「可见可编辑」，不静默生效。
                    setExternalBaseUrl(buildInterfaceUrl(item, port));
                  }
                }}
              >
                <SelectTrigger size="lg" className="w-64 min-w-0 justify-between">
                  <SelectValue placeholder={formatMessage("settings.remoteAccess.interface.pick")} />
                </SelectTrigger>
                <SelectContent>
                  {interfaces.length === 0 ? (
                    <SelectItem value="none" disabled>
                      {formatMessage("settings.remoteAccess.interface.empty")}
                    </SelectItem>
                  ) : (
                    interfaces.map((item) => (
                      <SelectItem key={`${item.name}:${item.address}`} value={item.address}>
                        {formatInterfaceLabel(item, port, formatMessage)}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            }
          />
          <SettingsRow
            label={formatMessage("settings.remoteAccess.baseUrl.label")}
            description={formatMessage("settings.remoteAccess.baseUrl.description")}
            controlLayout="wide"
            control={
              <Input
                value={externalBaseUrl}
                placeholder="https://zcode.example.com"
                onChange={(event) => setExternalBaseUrl(event.target.value)}
              />
            }
          />
          <SettingsRow
            label={formatMessage("settings.remoteAccess.save.title")}
            description={formatMessage(
              desktopBridge
                ? "settings.remoteAccess.restartHintDesktop"
                : "settings.remoteAccess.restartHint",
            )}
            control={
              <Button
                type="button"
                size="lg"
                className="min-w-24"
                disabled={saving}
                onClick={() => void save({ regenerate: false })}
              >
                {saving ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                {formatMessage("settings.remoteAccess.save.action")}
              </Button>
            }
          />
        </SettingsGroupCard>
      </section>

      {oneTimeToken ? (
        <section className="space-y-3">
          <div className="text-ui-base font-medium text-foreground-subtle">
            {formatMessage("settings.remoteAccess.oneTime.section")}
          </div>
          <RemoteAccessTokenReveal
            token={oneTimeToken.token}
            {...(oneTimeToken.accessUrl ? { accessUrl: oneTimeToken.accessUrl } : {})}
          />
        </section>
      ) : null}
    </div>
  );
}
