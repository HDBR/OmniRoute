import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachAntigravity429Diagnostic,
  buildAntigravity429Diagnostic,
  getAntigravity429Diagnostic,
} from "../../open-sse/executors/antigravity429Diagnostics.ts";

const secret = "unique-secret-never-record";

test("structured 429 keeps only bounded classification and request shape", () => {
  const diagnostic = buildAntigravity429Diagnostic({
    status: 429,
    provider: "agy",
    upstreamBody: {
      error: { status: "RESOURCE_EXHAUSTED", reason: "RATE_LIMIT_EXCEEDED", message: secret },
      upstream_details: { token: secret },
    },
    requestHeaders: { Authorization: `Bearer ${secret}`, "x-goog-user-project": secret,
      "User-Agent": secret, "Content-Type": "application/json" },
    responseHeaders: { "retry-after": "30", "set-cookie": secret, "x-cloud-trace-context": secret },
    envelope: { project: secret, model: secret, request: { contents: secret }, requestId: secret },
  });
  assert.equal(diagnostic?.httpStatus, 429);
  assert.equal(diagnostic?.upstreamStatus, "RESOURCE_EXHAUSTED");
  assert.equal(diagnostic?.reason, "RATE_LIMIT_EXCEEDED");
  assert.deepEqual(diagnostic?.requestHeaderNames, ["content-type", "user-agent", "x-goog-user-project"]);
  assert.deepEqual(diagnostic?.responseHeaderNames, ["retry-after"]);
  assert.deepEqual(diagnostic?.envelopeNames, ["model", "project", "request", "requestId"]);
  assert.match(diagnostic?.shapeHash ?? "", /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(diagnostic), /unique-secret-never-record|authorization|cookie|contents|message/i);
});

test("unstructured 429 has no free-text fields or unknown keys", () => {
  const diagnostic = buildAntigravity429Diagnostic({
    status: 429, provider: "antigravity", upstreamBody: { _rawText: secret, error: { reason: secret } },
    requestHeaders: { [secret]: secret }, responseHeaders: { [secret]: secret },
    envelope: { [secret]: secret },
  });
  assert.deepEqual(diagnostic?.requestHeaderNames, []);
  assert.deepEqual(diagnostic?.responseHeaderNames, []);
  assert.deepEqual(diagnostic?.envelopeNames, []);
  assert.equal(diagnostic?.reason, null);
  assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(secret));
  assert.equal(buildAntigravity429Diagnostic({
    status: 429, provider: "agy",
    upstreamBody: { error: { message: "generic" }, upstream_details: {
      error: { status: "RESOURCE_EXHAUSTED", reason: "QUOTA_EXCEEDED" },
    } },
  })?.reason, "QUOTA_EXCEEDED");
  assert.equal(buildAntigravity429Diagnostic({
    status: 429, provider: "agy",
    upstreamBody: { error: { status: "UNKNOWN_STATUS", reason: "UNKNOWN_REASON" } },
  })?.upstreamStatus, null);
  assert.equal(buildAntigravity429Diagnostic({
    status: 429, provider: "agy",
    upstreamBody: { error: { details: [{ reason: "RATE_LIMIT_EXCEEDED", message: secret }] } },
  })?.reason, "RATE_LIMIT_EXCEEDED");
  assert.equal(buildAntigravity429Diagnostic({ status: 200, provider: "agy" }), null);
  assert.equal(buildAntigravity429Diagnostic({ status: 429, provider: "other" }), null);
});

test("final executor response and existing call-log artifact carry the diagnostic", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const attempt = fs.readFileSync(path.join(root, "open-sse/executors/antigravity/executeAttempt.ts"), "utf8");
  const core = fs.readFileSync(path.join(root, "open-sse/handlers/chatCore.ts"), "utf8");
  const logs = fs.readFileSync(path.join(root, "open-sse/handlers/chatCore/attemptLogging.ts"), "utf8");
  assert.match(attempt, /attachAntigravity429Diagnostic\(\s*new Response/);
  assert.match(attempt, /attachAntigravity429Diagnostic\(\s*modifiedResponse/);
  assert.match(core, /diagnostic: getAntigravity429Diagnostic\(providerResponse\)/);
  assert.match(logs, /antigravity429Diagnostic: diagnostic/);
});

test("diagnostic stays on the in-process response without changing its wire body", async () => {
  const response = new Response("plain error", { status: 429 });
  const diagnostic = buildAntigravity429Diagnostic({ status: 429, provider: "agy" });
  assert.equal(attachAntigravity429Diagnostic(response, diagnostic), response);
  assert.equal(getAntigravity429Diagnostic(response), diagnostic);
  assert.equal(await response.text(), "plain error");
  assert.equal(getAntigravity429Diagnostic(new Response("plain error", { status: 429 })), null);
});
