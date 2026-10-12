import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-claude-panel-"));
process.env.DATA_DIR = dataDir;

const { observeClaudeUnifiedHeaders } =
  await import("../../open-sse/services/usage/claudeHeaderQuota.ts");
const { getQuotaCache } = await import("../../src/domain/quotaCache.ts");
const { getLatestQuotaSnapshotsForConnection } =
  await import("../../src/lib/db/quotaSnapshots.ts");
const { getProviderLimitsCache } = await import("../../src/lib/db/providerLimits.ts");
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
const { GET } = await import("../../src/app/api/usage/[connectionId]/route.ts");
const originalFetch = globalThis.fetch;
const { getSanitizedCachedProviderLimitsMap } =
  await import("../../src/lib/usage/providerLimits.ts");
const { parseQuotaData } =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaParsing.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

const headers = new Headers({
  "anthropic-ratelimit-unified-5h-utilization": "0.08",
  "anthropic-ratelimit-unified-5h-reset": "1791838200",
  "anthropic-ratelimit-unified-7d-utilization": "0.08",
  "anthropic-ratelimit-unified-7d-reset": "1791997200",
});

test.after(() => {
  globalThis.fetch = originalFetch;
  resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("Claude headers survive a page reload via the persisted limits cache", async () => {
  const connectionId = "claude-panel-header-test";
  assert.equal(observeClaudeUnifiedHeaders("claude", connectionId, headers), true);
  assert.equal(getQuotaCache(connectionId)?.quotas["weekly (7d)"].remainingPercentage, 92);
  assert.equal(getLatestQuotaSnapshotsForConnection(connectionId).length, 2);

  const persisted = getProviderLimitsCache(connectionId);
  assert.equal(persisted?.source, "response-headers");
  assert.equal(persisted?.quotas?.["weekly (7d)"]?.remainingPercentage, 92);

  const cacheFromPage = (await getSanitizedCachedProviderLimitsMap())[connectionId];
  const weekly = parseQuotaData("claude", cacheFromPage).find(
    (quota) => quota.name === "weekly (7d)"
  );
  assert.equal(weekly?.remainingPercentage, 92);
});

test("Claude usage error does not erase header quotas on a forced refresh", async () => {
  const connection = await createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "Header-only panel account",
    email: "header-only@example.test",
    accessToken: "header-only-test-token",
    isActive: true,
    expiresAt: "2099-01-01T00:00:00Z",
  });
  const connectionId = connection.id as string;
  assert.equal(observeClaudeUnifiedHeaders("claude", connectionId, headers), true);
  const observed = getProviderLimitsCache(connectionId);
  assert.equal(observed?.quotas?.["weekly (7d)"]?.remainingPercentage, 92);

  globalThis.fetch = async () => new Response(null, { status: 403 });
  const response = await GET(new Request("http://localhost/api/usage/test"), {
    params: Promise.resolve({ connectionId }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(parseQuotaData("claude", body).find((q) => q.name === "weekly (7d)")?.used, 8);
  assert.equal(getProviderLimitsCache(connectionId)?.fetchedAt, observed?.fetchedAt);
  assert.equal(getProviderLimitsCache(connectionId)?.source, "response-headers");
});
