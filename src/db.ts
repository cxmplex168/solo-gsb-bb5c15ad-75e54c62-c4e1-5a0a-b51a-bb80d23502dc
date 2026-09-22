import Database, { Database as DB } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { computeCacheKey, selectVaryHeaders } from './canonical';
import { EntryRow, HeaderMap, InvalidationRecordRow, TokenRow } from './types';
import { generateToken, sha256, stableStringify } from './util';

export interface NewEntry {
  method: string;
  normalizedUrl: string;
  varyNames: string[];
  varySelectors: Array<{ name: string; value: string | null }>;
  cacheKey: string;
  requestHeaders: HeaderMap;
  status: number;
  responseHeaders: HeaderMap;
  body: string | null;
  storedAt: number;
}

export interface RevalidationInput {
  status: number;
  headers: HeaderMap;
  body: string | null;
  originTime: number;
}

export interface ApplyRevalidationResult {
  outcome: 'updated' | 'not_modified_merged' | 'already_consumed';
  idempotentReplay: boolean;
  conflict?: string;
  entry?: EntryRow;
}

/** 条件失效的定位输入（method/URL 已规范化，Vary 选择值由 requestHeaders 决定） */
export interface InvalidationInput {
  requestId: string;
  method: string;
  normalizedUrl: string;
  requestHeaders: HeaderMap;
  expectedEtag: string | null;
  reason: string | null;
  dryRun: boolean;
  now: number;
}

/** 实际/将要被删除的条目 */
export interface InvalidationAffected {
  cacheKey: string;
  method: string;
  normalizedUrl: string;
  etag: string | null;
  vary: string[];
  varySelectors: Array<{ name: string; value: string | null }>;
  disposition: 'deleted' | 'would-delete';
}

/** 同 URL 下未被删除的候选条目及原因 */
export interface InvalidationSkipped {
  cacheKey: string;
  etag: string | null;
  /** etag-mismatch=变体精确命中但 ETag 不符；variant-not-selected=Vary 选择值对应另一个变体 */
  reason: 'etag-mismatch' | 'variant-not-selected';
  detail: string;
}

/** 随失效释放的 pending 回源令牌 */
export interface InvalidationToken {
  token: string;
  etag: string | null;
  disposition: 'released' | 'would-release';
}

export interface InvalidationResult {
  id: number;
  requestId: string;
  dryRun: boolean;
  /** invalidated=实际删除；preview=演练模式有待删项；noop=没有可删项 */
  outcome: 'invalidated' | 'preview' | 'noop';
  affected: InvalidationAffected[];
  skipped: InvalidationSkipped[];
  tokens: InvalidationToken[];
  counts: { deletedEntries: number; releasedTokens: number };
  wallTime: number;
}

export class CacheStore {
  private db: DB;

    constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        cache_key          TEXT PRIMARY KEY,
        method             TEXT NOT NULL,
        normalized_url     TEXT NOT NULL,
        vary_names         TEXT NOT NULL,
        vary_selectors_json TEXT NOT NULL,
        request_headers    TEXT NOT NULL,
        status             INTEGER NOT NULL,
        response_headers   TEXT NOT NULL,
        body               TEXT,
        stored_at          INTEGER NOT NULL,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tokens (
        token          TEXT PRIMARY KEY,
        cache_key      TEXT NOT NULL,
        reason         TEXT NOT NULL,
        issued_at      INTEGER NOT NULL,
        request_id     TEXT NOT NULL,
        status         TEXT NOT NULL CHECK (status IN ('pending','consumed','released')),
        etag           TEXT,
        payload_hash   TEXT,
        consumed_at    INTEGER,
        result_summary TEXT,
        method         TEXT,
        normalized_url TEXT,
        vary_names     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tokens_key_status ON tokens(cache_key, status);

      CREATE TABLE IF NOT EXISTS decision_logs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id     TEXT NOT NULL,
        virtual_time   INTEGER NOT NULL,
        method         TEXT NOT NULL,
        url            TEXT NOT NULL,
        normalized_url TEXT,
        cache_key      TEXT,
        state          TEXT NOT NULL,
        action         TEXT NOT NULL,
        token          TEXT,
        trail_json     TEXT NOT NULL,
        wall_time      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS invalidation_records (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id            TEXT NOT NULL,
        dry_run               INTEGER NOT NULL,
        method                TEXT NOT NULL,
        normalized_url        TEXT NOT NULL,
        request_headers_json  TEXT NOT NULL,
        expected_etag         TEXT,
        reason                TEXT,
        outcome               TEXT NOT NULL,
        affected_json         TEXT NOT NULL,
        skipped_json          TEXT NOT NULL,
        released_tokens_json  TEXT NOT NULL,
        deleted_entries       INTEGER NOT NULL,
        released_token_count  INTEGER NOT NULL,
        wall_time             INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_invalidations_time ON invalidation_records(id DESC);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.db
      .prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)')
      .run('instance_id', randomUUID());
    this.addColumnIfMissing('tokens', 'method', 'TEXT');
    this.addColumnIfMissing('tokens', 'normalized_url', 'TEXT');
    this.addColumnIfMissing('tokens', 'vary_names', 'TEXT');
  }

  /** 老库的轻量列迁移（SQLite 不支持 IF NOT EXISTS 的 ADD COLUMN） */
  private addColumnIfMissing(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  getInstanceId(): string {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('instance_id') as
      | { value: string }
      | undefined;
    return row!.value;
  }

  // —— 条目 ——

  getEntry(cacheKey: string): EntryRow | undefined {
    return this.db.prepare('SELECT * FROM entries WHERE cache_key = ?').get(cacheKey) as
      | EntryRow
      | undefined;
  }

  /** 管理接口：列条目（最近更新在前） */
  listEntries(limit: number): EntryRow[] {
    return this.db
      .prepare('SELECT * FROM entries ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as EntryRow[];
  }

  /** 写入/替换一个预置缓存条目 */
  putEntry(input: NewEntry, now: number): EntryRow {
    const existing = this.getEntry(input.cacheKey);
    const row: EntryRow = {
      cache_key: input.cacheKey,
      method: input.method,
      normalized_url: input.normalizedUrl,
      vary_names: JSON.stringify(input.varyNames),
      vary_selectors_json: JSON.stringify(input.varySelectors),
      request_headers: JSON.stringify(input.requestHeaders),
      status: input.status,
      response_headers: JSON.stringify(input.responseHeaders),
      body: input.body,
      stored_at: input.storedAt,
      created_at: existing ? existing.created_at : now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO entries (
           cache_key, method, normalized_url, vary_names, vary_selectors_json,
           request_headers, status, response_headers, body, stored_at, created_at, updated_at
         ) VALUES (
           @cache_key, @method, @normalized_url, @vary_names, @vary_selectors_json,
           @request_headers, @status, @response_headers, @body, @stored_at, @created_at, @updated_at
         )
         ON CONFLICT(cache_key) DO UPDATE SET
           method=@method, normalized_url=@normalized_url, vary_names=@vary_names,
           vary_selectors_json=@vary_selectors_json, request_headers=@request_headers,
           status=@status, response_headers=@response_headers, body=@body,
           stored_at=@stored_at, updated_at=@updated_at`
      )
      .run(row);
    return this.getEntry(input.cacheKey)!;
  }

  deleteEntry(cacheKey: string): boolean {
    const info = this.db.prepare('DELETE FROM entries WHERE cache_key = ?').run(cacheKey);
    return info.changes > 0;
  }

  // —— 令牌（单飞的核心）——

  /**
   * 原子地为某个缓存键签发回源令牌。
   *
   * 在一个 IMMEDIATE 事务里：
   *   1. 若存在该键的 pending 令牌 => 并发的后来者，返回 leader=false（等待）
   *   2. 否则生成新令牌 => leader=true（负责回源并提交结果）
   *
   * better-sqlite3 为同步驱动，单进程内事务天然串行；
   * IMMEDIATE 起始即拿写锁，杜绝两个连接同时成为 leader。
   */
  issueToken(input: {
    cacheKey: string;
    reason: string;
    requestId: string;
    virtualTime: number;
    etag: string | null;
    method?: string;
    normalizedUrl?: string;
    varyNames?: string[];
  }): { row: TokenRow; leader: boolean } {
    const txn = this.db.transaction(() => {
      const pending = this.db
        .prepare("SELECT * FROM tokens WHERE cache_key = ? AND status = 'pending'")
        .get(input.cacheKey) as TokenRow | undefined;
      if (pending) return { row: pending, leader: false as const };

      const token = generateToken();
      this.db
        .prepare(
          `INSERT INTO tokens
             (token, cache_key, reason, issued_at, request_id, status, etag, method, normalized_url, vary_names)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
        )
        .run(
          token,
          input.cacheKey,
          input.reason,
          input.virtualTime,
          input.requestId,
          input.etag,
          input.method ?? null,
          input.normalizedUrl ?? null,
          input.varyNames ? JSON.stringify(input.varyNames) : null
        );
      const row = this.db.prepare('SELECT * FROM tokens WHERE token = ?').get(token) as TokenRow;
      return { row, leader: true as const };
    });
    return txn.immediate();
  }

  getToken(token: string): TokenRow | undefined {
    return this.db.prepare('SELECT * FROM tokens WHERE token = ?').get(token) as
      | TokenRow
      | undefined;
  }

  getPendingToken(cacheKey: string): TokenRow | undefined {
    return this.db
      .prepare("SELECT * FROM tokens WHERE cache_key = ? AND status = 'pending'")
      .get(cacheKey) as TokenRow | undefined;
  }

  listTokens(includeClosed: boolean, limit: number): TokenRow[] {
    const sql = includeClosed
      ? 'SELECT * FROM tokens ORDER BY issued_at DESC LIMIT ?'
      : "SELECT * FROM tokens WHERE status = 'pending' ORDER BY issued_at DESC LIMIT ?";
    return this.db.prepare(sql).all(limit) as TokenRow[];
  }

  /** 释放（放弃）pending 令牌，之后同键可重新签发。幂等。 */
  releaseToken(token: string, now: number): 'released' | 'not_pending' | 'not_found' {
    const info = this.db
      .prepare(
        `UPDATE tokens SET status='released', consumed_at=?, result_summary='abandoned by client'
         WHERE token=? AND status='pending'`
      )
      .run(now, token);
    if (info.changes > 0) return 'released';
    const existing = this.getToken(token);
    return existing ? 'not_pending' : 'not_found';
  }

  /**
   * 提交回源结果。要求：
   * - 令牌必须存在且仍 pending（404 / 409）
   * - 相同 payloadHash 重复提交 => 幂等成功（idempotentReplay=true）
   * - 不同 payloadHash => 409，不修改任何数据
   * - status=304 时与缓存中的旧响应合并
   *
   * 整个过程在一个事务中完成：令牌置 consumed 与条目更新原子发生。
   */
  applyRevalidation(
    token: string,
    input: RevalidationInput,
    now: number
  ): ApplyRevalidationResult {
    const payloadHash = sha256(
      stableStringify({ status: input.status, headers: input.headers, body: input.body })
    );

    const txn = this.db.transaction((): ApplyRevalidationResult => {
      const tokenRow = this.getToken(token);
      if (!tokenRow) {
        return {
          outcome: 'already_consumed',
          idempotentReplay: false,
          conflict: '令牌不存在',
        };
      }
      if (tokenRow.status !== 'pending') {
        if (tokenRow.payload_hash === payloadHash) {
          return {
            outcome: 'already_consumed',
            idempotentReplay: true,
            entry: this.getEntry(tokenRow.cache_key),
          };
        }
        return {
          outcome: 'already_consumed',
          idempotentReplay: false,
          conflict: `令牌已 ${tokenRow.status}，且提交内容与首次提交不一致`,
        };
      }

      const oldEntry = this.getEntry(tokenRow.cache_key);
      let entry: EntryRow;
      let outcome: 'updated' | 'not_modified_merged';

      if (input.status === 304) {
        if (!oldEntry) {
          throw new RevalidationConflictError('源站返回 304，但缓存中没有可合并的旧响应');
        }
        entry = this.mergeNotModified(oldEntry, input, now);
        outcome = 'not_modified_merged';
      } else {
        if (input.status < 200 || input.status >= 600) {
          throw new RevalidationConflictError(`非法的响应状态码: ${input.status}`);
        }
        entry = this.replaceFromOrigin(tokenRow, input, now);
        outcome = 'updated';
      }

      this.db
        .prepare(
          `UPDATE tokens
             SET status='consumed', consumed_at=?, payload_hash=?,
                 result_summary=?
           WHERE token=?`
        )
        .run(now, payloadHash, `${input.status} ${outcome}`, token);
      return { outcome, idempotentReplay: false, entry };
    });

    return txn.immediate();
  }

  /**
   * RFC 9110 4.3.4：304 只携带更新后的元数据（头），body 与状态码沿用旧响应。
   * 逐头替换：新响应里出现的头覆盖旧头；304 中禁止出现的表示元数据不会被删除
   * （演练场景按逐头合并实现并记录）。stored_at 更新为本次源站时间。
   */
  private mergeNotModified(old: EntryRow, input: RevalidationInput, now: number): EntryRow {
    const oldHeaders = JSON.parse(old.response_headers) as HeaderMap;
    // 304 响应中出现的头逐头覆盖旧响应头；body 与状态码沿用旧响应
    const merged: HeaderMap = { ...oldHeaders, ...input.headers };
    const oldVary = JSON.parse(old.vary_names) as string[];
    const varyNames =
      input.headers['vary'] !== undefined ? parseVaryNames(input.headers['vary']) : oldVary;

    return this.putEntry(
      {
        cacheKey: old.cache_key,
        method: old.method,
        normalizedUrl: old.normalized_url,
        varyNames,
        varySelectors: JSON.parse(old.vary_selectors_json),
        requestHeaders: JSON.parse(old.request_headers),
        status: old.status,
        responseHeaders: merged,
        body: old.body,
        storedAt: input.originTime,
      },
      now
    );
  }

  private replaceFromOrigin(
    tokenRow: TokenRow,
    input: RevalidationInput,
    now: number
  ): EntryRow {
    // 替换响应后 Vary 字段集合可能改变：缓存键也随之改变。
    // 演练语义中要求变体结构稳定；若回源响应带来不同的 Vary 集合则报冲突。
    const oldEntry = this.getEntry(tokenRow.cache_key);
    const newVary = parseVaryNames(input.headers['vary']);
    const oldVary: string[] = oldEntry
      ? (JSON.parse(oldEntry.vary_names) as string[])
      : tokenRow.vary_names
        ? (JSON.parse(tokenRow.vary_names) as string[])
        : [];
    if (
      JSON.stringify([...newVary].sort()) !== JSON.stringify([...oldVary].sort())
    ) {
      throw new RevalidationConflictError(
        `回源响应的 Vary (${newVary.join(',') || '-'}) 与缓存键中的 Vary (${oldVary.join(',') || '-'}) 不一致；` +
          '演练服务要求变体结构保持稳定，请通过管理接口重新预置'
      );
    }

    const method = oldEntry?.method ?? tokenRow.method ?? 'GET';
    const normalizedUrl = oldEntry?.normalized_url ?? tokenRow.normalized_url ?? '';

    return this.putEntry(
      {
        cacheKey: tokenRow.cache_key,
        method,
        normalizedUrl,
        varyNames: newVary,
        varySelectors: oldEntry ? JSON.parse(oldEntry.vary_selectors_json) : [],
        requestHeaders: oldEntry ? JSON.parse(oldEntry.request_headers) : {},
        status: input.status,
        responseHeaders: input.headers,
        body: input.body,
        storedAt: input.originTime,
      },
      now
    );
  }

  // —— 判定日志 ——

  insertDecisionLog(row: {
    requestId: string;
    virtualTime: number;
    method: string;
    url: string;
    normalizedUrl: string | null;
    cacheKey: string | null;
    state: string;
    action: string;
    token: string | null;
    trail: unknown;
    now: number;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO decision_logs
           (request_id, virtual_time, method, url, normalized_url, cache_key, state, action, token, trail_json, wall_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.requestId,
        row.virtualTime,
        row.method,
        row.url,
        row.normalizedUrl,
        row.cacheKey,
        row.state,
        row.action,
        row.token,
        JSON.stringify(row.trail),
        row.now
      );
    return Number(info.lastInsertRowid);
  }

  listDecisionLogs(limit: number): unknown[] {
    const rows = this.db
      .prepare('SELECT * FROM decision_logs ORDER BY id DESC LIMIT ?')
      .all(limit) as any[];
    return rows.map((r) => ({
      ...r,
      trail: JSON.parse(r.trail_json),
    }));
  }

  // —— 条件失效 ——

  /**
   * 按「方法 + 规范化 URL」找候选条目，用每个候选自身的 Vary 集合结合请求头
   * 精确解析目标变体（与 lookupEntry 相同的「响应头决定键」语义），随后：
   *
   * - 变体命中且 ETag 与 expectedEtag 相符（或未提供 expectedEtag）=> 删除条目；
   * - 变体命中但 ETag 不符 => 跳过（etag-mismatch），绝不动其他变体；
   * - 同 URL 的其他 Vary 变体 => 跳过（variant-not-selected）；
   * - 删除的键上若有 pending 回源令牌 => 一并释放（status='released'），
   *   否则同键无法签发新令牌。
   *
   * 整个过程在单个 IMMEDIATE 事务内完成；dryRun 只做同样的解析与判定，
   * 不删条目、不动令牌，但同样写入一条审计记录（dry_run=1）便于追溯。
   */
  invalidate(input: InvalidationInput): InvalidationResult {
    const txn = this.db.transaction((): InvalidationResult => {
      const candidates = this.db
        .prepare(
          `SELECT * FROM entries
           WHERE method = ? AND normalized_url = ?
           ORDER BY updated_at DESC`
        )
        .all(input.method, input.normalizedUrl) as EntryRow[];

      const affected: InvalidationAffected[] = [];
      const skipped: InvalidationSkipped[] = [];
      let matchedEntry: EntryRow | undefined;

      for (const candidate of candidates) {
        const varyNames = JSON.parse(candidate.vary_names) as string[];
        const varySelectors = selectVaryHeaders(varyNames, input.requestHeaders);
        const keyDetails = computeCacheKey({
          method: input.method,
          normalizedUrl: input.normalizedUrl,
          varyNames,
          varySelectors,
        });

        if (keyDetails.cacheKey !== candidate.cache_key) {
          skipped.push({
            cacheKey: candidate.cache_key,
            etag: readEtag(candidate),
            reason: 'variant-not-selected',
            detail: `该条目的 Vary(${varyNames.join(',') || '∅'}) 选择值对应另一个变体，本次请求头解析出的键不指向它`,
          });
          continue;
        }

        // 键哈希具有唯一性，最多只有一个候选能成为目标变体
        matchedEntry = candidate;
        const etag = readEtag(candidate);
        if (input.expectedEtag !== null && etag !== input.expectedEtag) {
          skipped.push({
            cacheKey: candidate.cache_key,
            etag,
            reason: 'etag-mismatch',
            detail:
              etag === null
                ? `条目无 ETag，条件失效要求 expectedEtag=${input.expectedEtag}`
                : `条目 ETag ${etag} 与 expectedEtag ${input.expectedEtag} 不符，拒绝删除`,
          });
          matchedEntry = undefined;
        }
      }

      let tokens: InvalidationToken[] = [];
      if (matchedEntry) {
        const target = matchedEntry;
        affected.push({
          cacheKey: target.cache_key,
          method: target.method,
          normalizedUrl: target.normalized_url,
          etag: readEtag(target),
          vary: JSON.parse(target.vary_names),
          varySelectors: JSON.parse(target.vary_selectors_json),
          disposition: input.dryRun ? 'would-delete' : 'deleted',
        });

        // 先读出该键的 pending 令牌（dryRun 需要完整令牌值用于预览）
        const pendingTokens = this.db
          .prepare("SELECT * FROM tokens WHERE cache_key = ? AND status = 'pending'")
          .all(target.cache_key) as TokenRow[];

        if (!input.dryRun) {
          this.db.prepare('DELETE FROM entries WHERE cache_key = ?').run(target.cache_key);
          this.db
            .prepare(
              `UPDATE tokens
                 SET status='released', consumed_at=?, result_summary='released by conditional invalidation'
               WHERE cache_key=? AND status='pending'`
            )
            .run(input.now, target.cache_key);
        }

        tokens = pendingTokens.map((t) => ({
          token: t.token,
          etag: t.etag,
          disposition: input.dryRun ? 'would-release' : 'released',
        }));
      }

      const outcome: InvalidationResult['outcome'] = affected.length === 0
        ? 'noop'
        : input.dryRun
          ? 'preview'
          : 'invalidated';

      const id = this.insertInvalidationRecord(input, {
        outcome,
        affected,
        skipped,
        tokens,
      });

      return {
        id,
        requestId: input.requestId,
        dryRun: input.dryRun,
        outcome,
        affected,
        skipped,
        tokens,
        counts: {
          deletedEntries: input.dryRun ? 0 : affected.length,
          releasedTokens: input.dryRun ? 0 : tokens.length,
        },
        wallTime: input.now,
      };
    });
    return txn.immediate();
  }

  private insertInvalidationRecord(
    input: InvalidationInput,
    p: {
      outcome: InvalidationResult['outcome'];
      affected: InvalidationAffected[];
      skipped: InvalidationSkipped[];
      tokens: InvalidationToken[];
    }
  ): number {
    const info = this.db
      .prepare(
        `INSERT INTO invalidation_records
           (request_id, dry_run, method, normalized_url, request_headers_json,
            expected_etag, reason, outcome, affected_json, skipped_json,
            released_tokens_json, deleted_entries, released_token_count, wall_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.requestId,
        input.dryRun ? 1 : 0,
        input.method,
        input.normalizedUrl,
        JSON.stringify(input.requestHeaders),
        input.expectedEtag,
        input.reason,
        p.outcome,
        JSON.stringify(p.affected),
        JSON.stringify(p.skipped),
        JSON.stringify(p.tokens.map((t) => t.token)),
        input.dryRun ? 0 : p.affected.length,
        input.dryRun ? 0 : p.tokens.length,
        input.now
      );
    return Number(info.lastInsertRowid);
  }

  /** 条件失效审计记录（最近在前） */
  listInvalidationRecords(limit: number): unknown[] {
    const rows = this.db
      .prepare('SELECT * FROM invalidation_records ORDER BY id DESC LIMIT ?')
      .all(limit) as InvalidationRecordRow[];
    return rows.map((r) => ({
      id: r.id,
      requestId: r.request_id,
      dryRun: r.dry_run === 1,
      method: r.method,
      normalizedUrl: r.normalized_url,
      requestHeaders: JSON.parse(r.request_headers_json),
      expectedEtag: r.expected_etag,
      reason: r.reason,
      outcome: r.outcome,
      affected: JSON.parse(r.affected_json),
      skipped: JSON.parse(r.skipped_json),
      releasedTokens: JSON.parse(r.released_tokens_json),
      deletedEntries: r.deleted_entries,
      releasedTokenCount: r.released_token_count,
      wallTime: r.wall_time,
    }));
  }

  // —— 重置 / 统计 ——

  reset(): void {
    this.db.transaction(() => {
      this.db.exec(
        'DELETE FROM entries; DELETE FROM tokens; DELETE FROM decision_logs; DELETE FROM invalidation_records;'
      );
      this.db
        .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
        .run('instance_id', randomUUID());
    })();
  }

  stats(): { entries: number; pendingTokens: number; decisions: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      entries: one('SELECT COUNT(*) AS n FROM entries'),
      pendingTokens: one("SELECT COUNT(*) AS n FROM tokens WHERE status='pending'"),
      decisions: one('SELECT COUNT(*) AS n FROM decision_logs'),
    };
  }
}

function parseVaryNames(value: string | undefined): string[] {
  if (!value) return [];
  const tokens = value
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.includes('*')) return [];
  return [...new Set(tokens)];
}

/** 从条目响应头中读出 ETag（无 etag 头为 null） */
function readEtag(entry: EntryRow): string | null {
  const headers = JSON.parse(entry.response_headers) as HeaderMap;
  return headers['etag'] !== undefined ? headers['etag'] : null;
}

export class RevalidationConflictError extends Error {
  statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'RevalidationConflictError';
  }
}
