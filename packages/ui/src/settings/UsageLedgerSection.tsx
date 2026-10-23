import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { IServiceAccessor } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";
import { logger } from "@/logger.js";
import type { UsageLedgerSummaryRow } from "@zcode/services";

type UsageLedgerWindow = "today" | "last7Days" | "all";

const USAGE_LEDGER_WINDOW_ITEMS: ReadonlyArray<{
  labelId: string;
  value: UsageLedgerWindow;
}> = [
  { labelId: "settings.usageLedger.window.today", value: "today" },
  { labelId: "settings.usageLedger.window.last7Days", value: "last7Days" },
  { labelId: "settings.usageLedger.window.all", value: "all" },
];

/** host 本地时区的今日零点；聚合的 day 维度也按 host 本地日切，两边口径一致。 */
function startOfLocalDay(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function resolveSinceTs(window: UsageLedgerWindow, now: Date): number | undefined {
  if (window === "today") return startOfLocalDay(now);
  if (window === "last7Days") return now.getTime() - 7 * 24 * 60 * 60 * 1000;
  return undefined;
}

function formatTokenCount(locale: string, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

interface UsageLedgerSectionProps {
  /** 预留：当前仅消费本机全局账本；远程 workspace 不展示该分区数据。 */
  isDesktop: boolean;
}

/**
 * 设置页「本地用量」区块（BYOK P5 usageLedger）。
 *
 * 数据来自本地 token 用量账本（usage-ledger.sqlite，host 侧 usage.delta 旁路 sink 落库）：
 * 只读查询面 getUsageSummary / getRecentUsage；三个时间窗 × provider/model 两个维度。
 * 红线呈现：纯本地记录，不上传（文案必须保留该声明）。
 */
export function UsageLedgerSection({ isDesktop: _isDesktop }: UsageLedgerSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const services = useServices();
  const [window, setWindow] = useState<UsageLedgerWindow>("today");
  const [providerRows, setProviderRows] = useState<UsageLedgerSummaryRow[] | null>(null);
  const [modelRows, setModelRows] = useState<UsageLedgerSummaryRow[] | null>(null);
  const loadVersionRef = useRef(0);

  const load = useCallback(
    async (targetWindow: UsageLedgerWindow, accessor: IServiceAccessor) => {
      const ledgerService = accessor.usageLedgerService;
      if (!ledgerService) {
        setProviderRows([]);
        setModelRows([]);
        return;
      }
      const version = loadVersionRef.current + 1;
      loadVersionRef.current = version;
      const sinceTs = resolveSinceTs(targetWindow, new Date());
      try {
        const [byProvider, byModel] = await Promise.all([
          ledgerService.getUsageSummary({ sinceTs, groupBy: "provider" }),
          ledgerService.getUsageSummary({ sinceTs, groupBy: "model" }),
        ]);
        if (loadVersionRef.current !== version) return;
        setProviderRows(byProvider);
        setModelRows(byModel);
      } catch (error) {
        if (loadVersionRef.current !== version) return;
        logger.warn("[UsageLedgerSection] 读取本地用量账本失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "settings.usageLedger.loadFailed" }));
      }
    },
    [intl],
  );

  useEffect(() => {
    void load(window, services);
  }, [load, services, window]);

  const formatCount = useCallback(
    (value: number) => formatTokenCount(locale, value),
    [locale],
  );

  return (
    <div className="space-y-3">
      <div className="text-ui-base font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "settings.usageLedger.description" })}
      </div>
      <SettingsSegmentedTabs
        items={USAGE_LEDGER_WINDOW_ITEMS.map((item) => ({
          label: intl.formatMessage({ id: item.labelId }),
          value: item.value,
        }))}
        value={window}
        onValueChange={setWindow}
      />
      <UsageSummaryTable
        title={intl.formatMessage({ id: "settings.usageLedger.byProvider" })}
        rows={providerRows}
        emptyMessage={intl.formatMessage({ id: "settings.usageLedger.empty" })}
        bucketTitleId="settings.usageLedger.column.provider"
        unknownBucket={intl.formatMessage({ id: "settings.usageLedger.unknownProvider" })}
        formatCount={formatCount}
        intl={intl}
      />
      <UsageSummaryTable
        title={intl.formatMessage({ id: "settings.usageLedger.byModel" })}
        rows={modelRows}
        emptyMessage={intl.formatMessage({ id: "settings.usageLedger.empty" })}
        bucketTitleId="settings.usageLedger.column.model"
        unknownBucket={intl.formatMessage({ id: "settings.usageLedger.unknownModel" })}
        formatCount={formatCount}
        intl={intl}
      />
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load(window, services)}
          data-testid="usage-ledger-refresh"
        >
          <RotateCcw className="size-4" />
          {intl.formatMessage({ id: "settings.usageLedger.refresh" })}
        </Button>
        <span className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.usageLedger.localOnlyNote" })}
        </span>
      </div>
    </div>
  );
}

function UsageSummaryTable({
  title,
  rows,
  emptyMessage,
  bucketTitleId,
  unknownBucket,
  formatCount,
  intl,
}: {
  title: string;
  rows: UsageLedgerSummaryRow[] | null;
  emptyMessage: string;
  bucketTitleId: string;
  unknownBucket: string;
  formatCount: (value: number) => string;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
}) {
  return (
    <SettingsGroupCard>
      <div className="px-4 pt-3 text-ui-base font-medium text-foreground">{title}</div>
      {rows === null ? (
        <div className="px-4 py-4 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.usageLedger.loading" })}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-4 text-ui-base text-foreground-subtle">{emptyMessage}</div>
      ) : (
        <div className="overflow-x-auto">
          <table
            className="mt-2 w-full text-left text-ui-base font-normal leading-normal tracking-[-0.08px]"
            data-testid="usage-ledger-summary-table"
          >
            <thead className="bg-surface text-foreground-subtle">
              <tr>
                <th className="px-4 py-2 font-normal">
                  {intl.formatMessage({ id: bucketTitleId })}
                </th>
                <th className="px-4 py-2 text-right font-normal">
                  {intl.formatMessage({ id: "settings.usageLedger.column.requests" })}
                </th>
                <th className="px-4 py-2 text-right font-normal">
                  {intl.formatMessage({ id: "settings.usageLedger.column.input" })}
                </th>
                <th className="px-4 py-2 text-right font-normal">
                  {intl.formatMessage({ id: "settings.usageLedger.column.output" })}
                </th>
                <th className="px-4 py-2 text-right font-normal">
                  {intl.formatMessage({ id: "settings.usageLedger.column.reasoning" })}
                </th>
                <th className="px-4 py-2 text-right font-normal">
                  {intl.formatMessage({ id: "settings.usageLedger.column.cacheRead" })}
                </th>
                <th className="px-4 py-2 text-right font-normal">
                  {intl.formatMessage({ id: "settings.usageLedger.column.cacheWrite" })}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.bucket} className="border-t border-border">
                  <td className="max-w-56 truncate px-4 py-2 text-foreground" title={row.bucket}>
                    {row.bucket === "unknown" ? unknownBucket : row.bucket}
                  </td>
                  <td className="px-4 py-2 text-right text-foreground-subtle">
                    {formatCount(row.requestCount)}
                  </td>
                  <td className="px-4 py-2 text-right text-foreground-subtle">
                    {formatCount(row.inputTokens)}
                  </td>
                  <td className="px-4 py-2 text-right text-foreground-subtle">
                    {formatCount(row.outputTokens)}
                  </td>
                  <td className="px-4 py-2 text-right text-foreground-subtle">
                    {formatCount(row.reasoningTokens)}
                  </td>
                  <td className="px-4 py-2 text-right text-foreground-subtle">
                    {formatCount(row.cacheReadTokens)}
                  </td>
                  <td className="px-4 py-2 text-right text-foreground-subtle">
                    {formatCount(row.cacheWriteTokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsGroupCard>
  );
}
