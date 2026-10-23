/* eslint-disable max-lines -- 用量账本集中维护 sqlite schema、追加写入与聚合查询，拆散会让口径分散。 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { getUsageLedgerDatabasePath } from "#src/paths.js";

// 修复：本模块被 @zcode/services barrel 顶层 re-export 后，renderer 打包时会把这里的
// 模块级副作用一并带进浏览器 bundle（即使消费代码被摇掉，副作用语句仍被保留）。
// node:sqlite 在浏览器 bundle 中会变成空的 CJS shim，顶层解构必然失败。
// 改为首次真正使用时才解析 node:sqlite，避免模块求值期触碰 node 内置模块。
let cachedDatabase: unknown = null;

interface DatabaseSyncConstructor {
  new (path: string): DatabaseSyncInstance;
}

/** node:sqlite 只能在宿主 Node 运行时使用；惰性解析避免 renderer bundle 顶层求值崩溃。 */
function loadDatabaseSync(): DatabaseSyncConstructor {
  if (!cachedDatabase) {
    // 与既有 Repo 一致：避免构建器把 node:sqlite 改写成不存在的 npm sqlite 包。
    const nodeRequire = createRequire(import.meta.url);
    cachedDatabase = nodeRequire("node:sqlite").DatabaseSync;
  }
  return cachedDatabase as DatabaseSyncConstructor;
}

interface DatabaseSyncInstance {
  close(): void;
  exec(statement: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): void;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

/** 一次已完成模型请求的账本行（usage.delta 事实 → 一行）。 */
export interface UsageLedgerAppendRow {
  /** 请求完成时间（Unix ms）。 */
  ts: number;
  providerId: string;
  model: string;
  sessionId: string;
  workspaceKey: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type UsageLedgerGroupBy = "provider" | "model" | "day";

export interface UsageLedgerSummaryRow {
  /** provider 模式 = providerId；model 模式 = model；day 模式 = host 本地日期 YYYY-MM-DD。 */
  bucket: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UsageLedgerEntry extends UsageLedgerAppendRow {
  id: number;
  /** 恒为 1（一行 = 一次已完成请求）；保留列语义以便未来聚合行复用同一结构。 */
  requestCount: number;
}

interface UsageLedgerTableRow {
  id: number;
  ts: number;
  provider_id: string;
  model: string;
  session_id: string;
  workspace_key: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  request_count: number;
}

interface SummarySqlRow {
  bucket: string;
  request_count: number | bigint;
  input_tokens: number | bigint;
  output_tokens: number | bigint;
  reasoning_tokens: number | bigint;
  cache_read_tokens: number | bigint;
  cache_write_tokens: number | bigint;
}

function toCount(value: number | bigint | null | undefined): number {
  return Number(value ?? 0);
}

function toNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function rowToEntry(row: UsageLedgerTableRow): UsageLedgerEntry {
  return {
    id: Number(row.id),
    ts: Number(row.ts),
    providerId: row.provider_id,
    model: row.model,
    sessionId: row.session_id,
    workspaceKey: row.workspace_key,
    inputTokens: toCount(row.input_tokens),
    outputTokens: toCount(row.output_tokens),
    reasoningTokens: toCount(row.reasoning_tokens),
    cacheReadTokens: toCount(row.cache_read_tokens),
    cacheWriteTokens: toCount(row.cache_write_tokens),
    requestCount: toCount(row.request_count),
  };
}

function summaryRowFromSql(row: SummarySqlRow): UsageLedgerSummaryRow {
  return {
    bucket: row.bucket,
    requestCount: toCount(row.request_count),
    inputTokens: toCount(row.input_tokens),
    outputTokens: toCount(row.output_tokens),
    reasoningTokens: toCount(row.reasoning_tokens),
    cacheReadTokens: toCount(row.cache_read_tokens),
    cacheWriteTokens: toCount(row.cache_write_tokens),
  };
}

/** groupBy → 分桶表达式。都是字面量片段，不拼接任何外部输入。 */
const GROUP_BY_EXPRESSIONS: Record<UsageLedgerGroupBy, string> = {
  provider: "provider_id",
  model: "model",
  // 按 host 进程本地时区切自然日，UI 的「今日」窗口与它同口径。
  day: "strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime')",
};

/**
 * 本地 token 用量账本存储：每次已完成模型请求追加一行，只记 token 数（不做价格/成本）。
 *
 * 独立 `usage-ledger.sqlite`（~/.zcode/v2/），不复用 tasks-index.sqlite——账本是纯追加的
 * 独立事实流，没有任务索引的迁移/清理生命周期，混库会让存储清理语义互相牵连。
 * 懒初始化 + 依赖注入 dbPath 的模式与 AutomationRepo 一致（vitest 并发窗口隔离）。
 */
export class UsageLedgerStore {
  private db: DatabaseSyncInstance | null = null;
  private initializePromise: Promise<void> | null = null;
  private disposed = false;
  private readonly resolvedDbPath: string | null;

  constructor(
    dbPath?: string,
    private readonly busyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  private resolveDbPath(): string {
    return this.resolvedDbPath ?? getUsageLedgerDatabasePath();
  }

  async ensureReady(): Promise<void> {
    if (this.disposed) {
      throw new Error("UsageLedgerStore already disposed");
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(this.resolveDbPath()).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  /** dispose 链的同步收口；dispose 后再到的写入按丢弃处理（不能让账本拖住 host 退出）。 */
  close(): void {
    this.disposed = true;
    try {
      this.db?.close();
    } catch {
      // ignore：close 失败不影响 dispose 链上的其他资源。
    }
    this.db = null;
    this.initializePromise = null;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const DatabaseSync = loadDatabaseSync();
    const db = new DatabaseSync(path);
    this.db = db;
    db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    // 独立库的最小迁移：只建表和索引；后续列变更在这里追加 ALTER 分支。
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        session_id TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        request_count INTEGER NOT NULL DEFAULT 1
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_usage_ledger_ts ON usage_ledger(ts)");
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_usage_ledger_provider_ts ON usage_ledger(provider_id, ts)",
    );
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("UsageLedgerStore 未初始化：请先 await ensureReady()");
    }
    return this.db;
  }

  async append(row: UsageLedgerAppendRow): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `INSERT INTO usage_ledger
          (ts, provider_id, model, session_id, workspace_key,
           input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
           request_count)
        VALUES
          (@ts, @provider_id, @model, @session_id, @workspace_key,
           @input_tokens, @output_tokens, @reasoning_tokens, @cache_read_tokens,
           @cache_write_tokens, 1)`,
      )
      .run({
        ts: row.ts,
        provider_id: row.providerId,
        model: row.model,
        session_id: row.sessionId,
        workspace_key: row.workspaceKey,
        input_tokens: toNonNegativeInt(row.inputTokens),
        output_tokens: toNonNegativeInt(row.outputTokens),
        reasoning_tokens: toNonNegativeInt(row.reasoningTokens),
        cache_read_tokens: toNonNegativeInt(row.cacheReadTokens),
        cache_write_tokens: toNonNegativeInt(row.cacheWriteTokens),
      });
  }

  async getUsageSummary(params: {
    sinceTs?: number;
    groupBy: UsageLedgerGroupBy;
  }): Promise<UsageLedgerSummaryRow[]> {
    await this.ensureReady();
    const groupExpression = GROUP_BY_EXPRESSIONS[params.groupBy];
    const rows = this.getDatabase()
      .prepare(
        `SELECT ${groupExpression} AS bucket,
          COUNT(*) AS request_count,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(reasoning_tokens) AS reasoning_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens,
          SUM(cache_write_tokens) AS cache_write_tokens
        FROM usage_ledger
        WHERE (@since IS NULL OR ts >= @since)
        GROUP BY bucket
        ORDER BY request_count DESC, bucket ASC`,
      )
      .all({ since: params.sinceTs ?? null }) as unknown as SummarySqlRow[];
    return rows.map(summaryRowFromSql);
  }

  async getRecentUsage(limit: number): Promise<UsageLedgerEntry[]> {
    await this.ensureReady();
    const cappedLimit = Math.min(Math.max(Math.floor(limit) || 0, 1), 500);
    const rows = this.getDatabase()
      .prepare(
        `SELECT id, ts, provider_id, model, session_id, workspace_key,
          input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
          request_count
        FROM usage_ledger
        ORDER BY ts DESC, id DESC
        LIMIT @limit`,
      )
      .all({ limit: cappedLimit }) as unknown as UsageLedgerTableRow[];
    return rows.map(rowToEntry);
  }
}
