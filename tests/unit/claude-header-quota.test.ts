import test from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/services/usage/claudeHeaderQuota.ts");

// Real header set captured from a setup-token connection on 2026-10-12 (values only).
const real = new Headers({
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.07",
  "anthropic-ratelimit-unified-5h-reset": "1791810000",
  "anthropic-ratelimit-unified-7d-utilization": "0.08",
  "anthropic-ratelimit-unified-7d-reset": "1791997200",
});

test("unified headers become the legacy /api/oauth/usage shape (percent used, ISO reset)", () => {
  const usage = mod.claudeUsageFromUnifiedHeaders(real, 1000);
  assert.deepEqual(usage, {
    five_hour: { utilization: 7, resets_at: new Date(1791810000 * 1000).toISOString() },
    seven_day: { utilization: 8, resets_at: new Date(1791997200 * 1000).toISOString() },
    status: "allowed",
    observedAt: 1000,
  });
});

test("plain header records work and a lone window is kept", () => {
  const usage = mod.claudeUsageFromUnifiedHeaders(
    { "anthropic-ratelimit-unified-7d-utilization": "1.0" },
    5
  );
  assert.deepEqual(usage, { seven_day: { utilization: 100, resets_at: null }, observedAt: 5 });
});

test("responses without utilization, or with garbage, give null", () => {
  assert.equal(mod.claudeUsageFromUnifiedHeaders(new Headers({ "content-type": "x" })), null);
  assert.equal(mod.claudeUsageFromUnifiedHeaders(null), null);
  assert.equal(
    mod.claudeUsageFromUnifiedHeaders({ "anthropic-ratelimit-unified-5h-utilization": "abc" }),
    null
  );
  assert.equal(
    mod.claudeUsageFromUnifiedHeaders({ "anthropic-ratelimit-unified-5h-utilization": "-1" }),
    null
  );
});

test("observe feeds the sink once per 30 s per connection, only for Claude", () => {
  mod._resetClaudeHeaderUsage();
  const seen: Array<[string, number | undefined]> = [];
  mod.setClaudeHeaderUsageSink((id, usage) => seen.push([id, usage.seven_day?.utilization]));
  assert.equal(mod.observeClaudeUnifiedHeaders("claude", "conn-a", real, 0), true);
  assert.equal(mod.observeClaudeUnifiedHeaders("claude", "conn-a", real, 29_999), false);
  assert.equal(mod.observeClaudeUnifiedHeaders("cc", "conn-a", real, 30_000), true);
  assert.equal(mod.observeClaudeUnifiedHeaders("openai", "conn-b", real, 0), false);
  assert.equal(mod.observeClaudeUnifiedHeaders("claude", undefined, real, 0), false);
  assert.equal(mod.observeClaudeUnifiedHeaders("claude", "conn-c", new Headers(), 0), false);
  assert.deepEqual(seen, [
    ["conn-a", 8],
    ["conn-a", 8],
  ]);
  assert.equal(mod.getClaudeHeaderUsage("conn-a", 60_000, 40_000)?.seven_day?.utilization, 8);
  assert.equal(mod.getClaudeHeaderUsage("conn-a", 60_000, 200_000), null);
});

test("a throwing sink never breaks the request path", () => {
  mod._resetClaudeHeaderUsage();
  mod.setClaudeHeaderUsageSink(() => {
    throw new Error("db down");
  });
  assert.equal(mod.observeClaudeUnifiedHeaders("claude", "conn-x", real, 0), false);
  mod._resetClaudeHeaderUsage();
});
