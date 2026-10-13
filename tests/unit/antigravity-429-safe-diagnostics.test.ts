import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  attachAntigravity429Diagnostic,
  buildAntigravity429Diagnostic,
  getAntigravity429Diagnostic,
} from "../../open-sse/executors/antigravity429Diagnostics.ts";

const secret = "unique-secret-never-record";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-agy-429-test-"));
process.env.DATA_DIR = dataDir;

const { buildFinalAntigravityResult, tryEmbedLongRetryAfter } =
  await import("../../open-sse/executors/antigravity/executeAttempt.ts");
const { normalizeExecutorResult } =
  await import("../../open-sse/handlers/chatCore/upstreamTimeouts.ts");
const { persistAttemptLogs } = await import("../../open-sse/handlers/chatCore/attemptLogging.ts");
const coreDb = await import("../../src/lib/db/core.ts");
const { getCallLogById, waitForCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");

before(async () => {
  await coreDb.ensureDbInitialized();
});

after(async () => {
  await waitForCallLogSaves(5000);
  coreDb.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("structured 429 keeps only bounded classification and request shape", () => {
  const diagnostic = buildAntigravity429Diagnostic({
    status: 429,
    provider: "agy",
    upstreamBody: {
      error: { status: "RESOURCE_EXHAUSTED", reason: "RATE_LIMIT_EXCEEDED", message: secret },
      upstream_details: { token: secret },
    },
    requestHeaders: {
      Authorization: `Bearer ${secret}`,
      "x-goog-user-project": secret,
      "User-Agent": secret,
      "Content-Type": "application/json",
    },
    responseHeaders: { "retry-after": "30", "set-cookie": secret, "x-cloud-trace-context": secret },
    envelope: { project: secret, model: secret, request: { contents: secret }, requestId: secret },
  });
  assert.equal(diagnostic?.httpStatus, 429);
  assert.equal(diagnostic?.upstreamStatus, "RESOURCE_EXHAUSTED");
  assert.equal(diagnostic?.reason, "RATE_LIMIT_EXCEEDED");
  assert.deepEqual(diagnostic?.requestHeaderNames, [
    "content-type",
    "user-agent",
    "x-goog-user-project",
  ]);
  assert.deepEqual(diagnostic?.responseHeaderNames, ["retry-after"]);
  assert.deepEqual(diagnostic?.envelopeNames, ["model", "project", "request", "requestId"]);
  assert.match(diagnostic?.shapeHash ?? "", /^[a-f0-9]{16}$/);
  assert.doesNotMatch(
    JSON.stringify(diagnostic),
    /unique-secret-never-record|authorization|cookie|contents|message/i
  );
});

test("unstructured 429 has no free-text fields or unknown keys", () => {
  const diagnostic = buildAntigravity429Diagnostic({
    status: 429,
    provider: "antigravity",
    upstreamBody: { _rawText: secret, error: { reason: secret } },
    requestHeaders: { [secret]: secret },
    responseHeaders: { [secret]: secret },
    envelope: { [secret]: secret },
  });
  assert.deepEqual(diagnostic?.requestHeaderNames, []);
  assert.deepEqual(diagnostic?.responseHeaderNames, []);
  assert.deepEqual(diagnostic?.envelopeNames, []);
  assert.equal(diagnostic?.reason, null);
  assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(secret));
  assert.equal(
    buildAntigravity429Diagnostic({
      status: 429,
      provider: "agy",
      upstreamBody: {
        error: { message: "generic" },
        upstream_details: {
          error: { status: "RESOURCE_EXHAUSTED", reason: "QUOTA_EXCEEDED" },
        },
      },
    })?.reason,
    "QUOTA_EXCEEDED"
  );
  assert.equal(
    buildAntigravity429Diagnostic({
      status: 429,
      provider: "agy",
      upstreamBody: { error: { status: "UNKNOWN_STATUS", reason: "UNKNOWN_REASON" } },
    })?.upstreamStatus,
    null
  );
  assert.equal(
    buildAntigravity429Diagnostic({
      status: 429,
      provider: "agy",
      upstreamBody: { error: { details: [{ reason: "RATE_LIMIT_EXCEEDED", message: secret }] } },
    })?.reason,
    "RATE_LIMIT_EXCEEDED"
  );
  assert.equal(buildAntigravity429Diagnostic({ status: 200, provider: "agy" }), null);
  assert.equal(buildAntigravity429Diagnostic({ status: 429, provider: "other" }), null);
});

function logContext(id: string): Parameters<typeof persistAttemptLogs>[1] {
  return {
    traceId: id,
    provider: "antigravity",
    connectionId: "test-connection",
    model: "test-model",
    skillRequestId: id,
    detailedLoggingEnabled: false,
    reqLogger: null,
    pendingRequestId: id,
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    requestedModel: "test-model",
    credentials: { connectionId: "test-connection" },
    startTime: Date.now(),
    body: { messages: [{ role: "user", content: "fixture" }] },
    sourceFormat: "openai",
    targetFormat: "openai",
    comboName: null,
    comboStepId: null,
    comboExecutionKey: null,
    tokensCompressed: 0,
    apiKeyInfo: null,
    noLogEnabled: false,
  } as Parameters<typeof persistAttemptLogs>[1];
}

for (const stream of [false, true]) {
  test(`executor → normalized failed response → call-log artifact (${stream ? "stream" : "json"})`, async () => {
    const id = `agy-429-${stream ? "stream" : "json"}`;
    const upstream = new Response(
      JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", reason: "QUOTA_EXCEEDED" } }),
      { status: 429, headers: { "retry-after": "30", "set-cookie": secret } }
    );
    const result = await buildFinalAntigravityResult(
      stream,
      upstream,
      "https://example.invalid",
      { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      { model: "test-model", request: { contents: secret } },
      "test-account",
      null,
      () => {}
    );
    const normalized = normalizeExecutorResult(result);
    assert.equal(
      normalized.response,
      result.response,
      "normalization must preserve WeakMap identity"
    );
    const diagnostic = getAntigravity429Diagnostic(normalized.response);
    assert.equal(diagnostic?.reason, "QUOTA_EXCEEDED");
    persistAttemptLogs(
      {
        status: 429,
        error: "upstream error",
        upstreamResponse: normalized.response,
        clientResponse: { error: "upstream error" },
      },
      logContext(id)
    );
    assert.equal(await waitForCallLogSaves(5000), true);
    const row = await getCallLogById(id);
    assert.equal(row?.detailState, "ready");
    assert.deepEqual(
      (row?.responseBody as { _omniroute?: { antigravity429Diagnostic?: unknown } })?._omniroute
        ?.antigravity429Diagnostic,
      diagnostic
    );
    assert.doesNotMatch(JSON.stringify(row?.responseBody), new RegExp(secret));
    assert.equal(getAntigravity429Diagnostic(new Response("recreated", { status: 429 })), null);
  });
}

test("oversized 429 body skips structured diagnostic parsing", async () => {
  const oversizedBody = JSON.stringify({
    error: { status: "RESOURCE_EXHAUSTED", reason: "QUOTA_EXCEEDED" },
    padding: "x".repeat(64 * 1024),
  });
  const result = await buildFinalAntigravityResult(
    false,
    new Response(oversizedBody, { status: 429 }),
    "https://example.invalid",
    {},
    {},
    "test-account",
    null,
    () => {}
  );
  const diagnostic = getAntigravity429Diagnostic(result.response);
  assert.equal(diagnostic?.httpStatus, 429);
  assert.equal(diagnostic?.reason, null);
  assert.equal(diagnostic?.upstreamStatus, null);
});

test("long-retry response replacement retains the diagnostic", async () => {
  const upstream = new Response(JSON.stringify({ error: { reason: "RATE_LIMIT_EXCEEDED" } }), {
    status: 429,
  });
  const result = await tryEmbedLongRetryAfter(
    upstream,
    120_000,
    "https://example.invalid",
    {},
    { model: "test-model" },
    null
  );
  assert.equal(getAntigravity429Diagnostic(result!.response)?.reason, "RATE_LIMIT_EXCEEDED");
});

test("diagnostic stays on the in-process response without changing its wire body", async () => {
  const response = new Response("plain error", { status: 429 });
  const diagnostic = buildAntigravity429Diagnostic({ status: 429, provider: "agy" });
  assert.equal(attachAntigravity429Diagnostic(response, diagnostic), response);
  assert.equal(getAntigravity429Diagnostic(response), diagnostic);
  assert.equal(await response.text(), "plain error");
  assert.equal(getAntigravity429Diagnostic(new Response("plain error", { status: 429 })), null);
});
