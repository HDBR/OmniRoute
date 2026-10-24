/**
 * Claude subscription quota read from the `anthropic-ratelimit-unified-*` headers that every
 * upstream /v1/messages response already carries — no extra request.
 *
 * Why: a connection created from `claude setup-token` holds an inference-only token
 * (`user:inference`), so /api/oauth/usage answers 403 and the 5h/weekly bars stay empty
 * (docs/providers/CLAUDE_CODE_SETUP_TOKEN.md, issue #10115). Without a quota snapshot the
 * router only learns that such an account is full from a 429. The unified headers carry the
 * same numbers the usage API returns, as a 0..1 fraction plus an epoch-seconds reset.
 *
 * This module stays dependency-free on purpose: the executor (open-sse) records here and the
 * quota cache (src/domain) registers the sink, so open-sse never imports the domain layer
 * (see the import-cycle note in services/quotaPreflight.ts).
 */

type HeaderSource =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

export interface ClaudeHeaderWindow {
  /** Percentage USED (0..100), the unit /api/oauth/usage reports. */
  utilization: number;
  resets_at: string | null;
}

/** Same shape as the legacy /api/oauth/usage payload, so normalizeClaudeUsageQuotas reads it. */
export interface ClaudeHeaderUsage {
  five_hour?: ClaudeHeaderWindow;
  seven_day?: ClaudeHeaderWindow;
  status?: string;
  observedAt: number;
}

export type ClaudeHeaderUsageSink = (connectionId: string, usage: ClaudeHeaderUsage) => void;

const PREFIX = "anthropic-ratelimit-unified-";
const CLAUDE_PROVIDERS = new Set(["claude", "cc"]);
export const CLAUDE_HEADER_QUOTA_MIN_INTERVAL_MS = 30_000;
const MAX_ENTRIES = 512;

const latest = new Map<string, ClaudeHeaderUsage>();
let sink: ClaudeHeaderUsageSink | null = null;

function readHeader(headers: HeaderSource, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(name: string): string | null }).get(name);
    return value ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const value = record[name] ?? record[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function fraction(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  // Utilization can pass 1.0 slightly while overage is in use; anything wilder is noise.
  if (!Number.isFinite(value) || value < 0 || value > 10) return undefined;
  return value;
}

function resetIso(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function window(headers: HeaderSource, key: "5h" | "7d"): ClaudeHeaderWindow | undefined {
  const used = fraction(readHeader(headers, `${PREFIX}${key}-utilization`));
  if (used === undefined) return undefined;
  return {
    utilization: Math.round(used * 10_000) / 100,
    resets_at: resetIso(readHeader(headers, `${PREFIX}${key}-reset`)),
  };
}

/** Parse the unified headers; null when the response carries no utilization at all. */
export function claudeUsageFromUnifiedHeaders(
  headers: HeaderSource,
  now: number = Date.now()
): ClaudeHeaderUsage | null {
  const fiveHour = window(headers, "5h");
  const sevenDay = window(headers, "7d");
  if (!fiveHour && !sevenDay) return null;
  const status = readHeader(headers, `${PREFIX}status`);
  return {
    ...(fiveHour ? { five_hour: fiveHour } : {}),
    ...(sevenDay ? { seven_day: sevenDay } : {}),
    ...(status ? { status } : {}),
    observedAt: now,
  };
}

/** Registered once by the quota cache; the executor never imports it directly. */
export function setClaudeHeaderUsageSink(next: ClaudeHeaderUsageSink | null): void {
  sink = next;
}

/**
 * Record the quota carried by one upstream Claude response. At most one observation per
 * connection every 30 s; never throws (it runs inside the request path).
 */
export function observeClaudeUnifiedHeaders(
  provider: string | undefined,
  connectionId: string | undefined,
  headers: HeaderSource,
  now: number = Date.now()
): boolean {
  try {
    if (!provider || !CLAUDE_PROVIDERS.has(provider) || !connectionId) return false;
    const previous = latest.get(connectionId);
    if (previous && now - previous.observedAt < CLAUDE_HEADER_QUOTA_MIN_INTERVAL_MS) return false;
    const usage = claudeUsageFromUnifiedHeaders(headers, now);
    if (!usage) return false;
    latest.delete(connectionId);
    latest.set(connectionId, usage);
    if (latest.size > MAX_ENTRIES) latest.delete(latest.keys().next().value as string);
    sink?.(connectionId, usage);
    return true;
  } catch {
    return false;
  }
}

/** Latest header observation for a connection, if younger than maxAgeMs (default 6 h). */
export function getClaudeHeaderUsage(
  connectionId: string,
  maxAgeMs: number = 6 * 60 * 60 * 1000,
  now: number = Date.now()
): ClaudeHeaderUsage | null {
  const usage = latest.get(connectionId);
  if (!usage || now - usage.observedAt > maxAgeMs) return null;
  return usage;
}

/** Test-only. */
export function _resetClaudeHeaderUsage(): void {
  latest.clear();
  sink = null;
}
