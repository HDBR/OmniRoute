import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-agy-chatcore-429-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const { getCallLogs, getCallLogById, waitForCallLogSaves } =
  await import("../../src/lib/usage/callLogs.ts");
const { getExecutor } = await import("../../open-sse/executors/index.ts");
const { buildFinalAntigravityResult } =
  await import("../../open-sse/executors/antigravity/executeAttempt.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { closeSharedLoggerResource } = await import("../../src/shared/utils/loggerResource.ts");

const secret = "agy-429-private-fixture";

after(async () => {
  await waitForCallLogSaves(5000);
  core.resetDbInstance();
  await closeSharedLoggerResource();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("handleChatCore persists the executor's 429 diagnostic in the call-log artifact", async (t) => {
  await core.ensureDbInitialized();
  const executor = await getExecutor("agy");
  let calls = 0;
  t.mock.method(executor, "execute", async () => {
    calls++;
    return buildFinalAntigravityResult(
      false,
      new Response(
        JSON.stringify({
          error: { status: "RESOURCE_EXHAUSTED", reason: "RATE_LIMIT_EXCEEDED" },
        }),
        { status: 429, headers: { "set-cookie": secret } }
      ),
      "https://example.invalid",
      { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      { project: secret, model: "gemini-2.5-flash", request: { contents: secret } },
      "test-account",
      null,
      () => {}
    );
  });

  const body = {
    model: "agy/gemini-2.5-flash",
    stream: false,
    messages: [{ role: "user", content: "fixture" }],
  };
  const result = await handleChatCore({
    body,
    modelInfo: { provider: "agy", model: "gemini-2.5-flash", extendedContext: false },
    credentials: {
      accessToken: "test-placeholder",
      providerSpecificData: { projectId: "test-project" },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body,
      headers: new Headers({ accept: "application/json" }),
    },
    skipResourcePressureGuard: true,
    skipUpstreamRetry: true,
  });
  assert.equal(result.status, 429);
  assert.ok(calls > 0, "handler must use the mocked agy executor");
  assert.equal(await waitForCallLogSaves(5000), true);
  const rows = await getCallLogs({ limit: 5 });
  const row = await getCallLogById(rows[0].id);
  assert.equal(row?.detailState, "ready");
  const diagnostic = (
    row?.responseBody as {
      _omniroute?: {
        antigravity429Diagnostic?: {
          httpStatus: number;
          upstreamStatus: string;
          reason: string;
          requestHeaderNames: string[];
          responseHeaderNames: string[];
          envelopeNames: string[];
          shapeHash: string;
        };
      };
    }
  )?._omniroute?.antigravity429Diagnostic;
  assert.equal(diagnostic?.httpStatus, 429);
  assert.equal(diagnostic?.upstreamStatus, "RESOURCE_EXHAUSTED");
  assert.equal(diagnostic?.reason, "RATE_LIMIT_EXCEEDED");
  assert.deepEqual(diagnostic?.requestHeaderNames, ["content-type"]);
  assert.deepEqual(diagnostic?.responseHeaderNames, ["content-type"]);
  assert.deepEqual(diagnostic?.envelopeNames, ["model", "project", "request"]);
  assert.match(diagnostic?.shapeHash ?? "", /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(row?.responseBody), new RegExp(secret));
});
