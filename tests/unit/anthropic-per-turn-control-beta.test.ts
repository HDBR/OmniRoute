/**
 * Per-message effort pass-through (#14747, #14746).
 *
 * Claude Code negotiates `per-turn-control-2026-07-01` and, only because of that
 * beta, attaches `output_config` to the `role:"system"` messages it places inside
 * `messages[]` (the mid-conversation-system shape, #10457). Without the beta the
 * client strips `output_config` from those messages itself — the field and the
 * beta travel as a pair.
 *
 * On the Claude OAuth path OmniRoute emits `mid-conversation-system-2026-04-07` for
 * Opus/Fable agent requests and keeps the message-level `output_config` intact (the
 * contract asserted in claude-directive-midconv-passthrough.test.ts). But
 * `per-turn-control-2026-07-01` was not on FORWARDABLE_CLIENT_BETAS, so the merge
 * dropped it and the upstream received the field without the beta that authorizes
 * it:
 *
 *   400 messages.1.output_config: Extra inputs are not permitted
 *
 * Stripping the field (as #14747 suggests) would break the #10457 contract and
 * silently drop the client's per-turn effort. Forwarding the pair intact is the
 * same fix already applied to `dangerous-tool-use-2026-09-03` (#14312) and
 * `afk-mode-2026-01-31` (#14694).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  FORWARDABLE_CLIENT_BETAS,
  mergeClientAnthropicBeta,
} from "../../open-sse/config/anthropicHeaders.ts";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { selectBetaFlags } from "../../open-sse/executors/claudeIdentity.ts";

const PER_TURN_CONTROL_BETA = "per-turn-control-2026-07-01";
const MID_CONVERSATION_SYSTEM_BETA = "mid-conversation-system-2026-04-07";
const CLAUDE_CODE_BETA_HEADER = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "effort-2025-11-24",
  MID_CONVERSATION_SYSTEM_BETA,
  PER_TURN_CONTROL_BETA,
].join(",");

// The request shape that triggers the mid-conversation-system path: an Opus
// agent turn (system + tools) with a system message carrying per-turn effort.
const OPUS_AGENT_BODY = {
  model: "claude-opus-5",
  system: "You are a coding agent.",
  tools: [{ name: "Bash", description: "x", input_schema: { type: "object" } }],
  messages: [
    { role: "user", content: "hello" },
    { role: "system", content: [], output_config: { effort: "high" } },
  ],
};

function betaTokens(headers: Record<string, string>): string[] {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === "anthropic-beta");
  return key ? headers[key].split(",").map((token) => token.trim()) : [];
}

describe("mergeClientAnthropicBeta / per-turn-control beta", () => {
  test("mergeClientAnthropicBeta_ClientNegotiatedPerTurnControl_IsForwarded", () => {
    const merged = mergeClientAnthropicBeta("claude-code-20250219", CLAUDE_CODE_BETA_HEADER);

    assert.ok(
      merged.split(",").includes(PER_TURN_CONTROL_BETA),
      "per-turn-control must reach the upstream alongside message-level output_config"
    );
    assert.ok(FORWARDABLE_CLIENT_BETAS.includes(PER_TURN_CONTROL_BETA));
  });

  test("mergeClientAnthropicBeta_PerTurnControlAlreadyInBase_IsNotDuplicated", () => {
    const merged = mergeClientAnthropicBeta(
      `claude-code-20250219,${PER_TURN_CONTROL_BETA}`,
      CLAUDE_CODE_BETA_HEADER
    );

    assert.equal(merged.split(",").filter((token) => token === PER_TURN_CONTROL_BETA).length, 1);
  });
});

describe("Claude OAuth path / per-turn-control beta", () => {
  test("selectBetaFlagsMerge_OpusAgentWithPerTurnControl_SendsThePairTogether", () => {
    const outbound = mergeClientAnthropicBeta(
      selectBetaFlags(OPUS_AGENT_BODY, null, CLAUDE_CODE_BETA_HEADER),
      CLAUDE_CODE_BETA_HEADER,
      undefined,
      "claude-opus-5"
    ).split(",");

    // The gateway keeps role:"system" + output_config inside messages[] on this
    // path, so both betas have to leave together — the field is only valid when
    // per-turn-control authorizes it.
    assert.equal(
      outbound.filter((token) => token === MID_CONVERSATION_SYSTEM_BETA).length,
      1,
      "mid-conversation-system sent once"
    );
    assert.equal(
      outbound.filter((token) => token === PER_TURN_CONTROL_BETA).length,
      1,
      `per-turn-control sent once: ${outbound.join(",")}`
    );
  });

  test("buildHeaders_ClaudeProviderWithPerTurnControl_KeepsIt", () => {
    const executor = new DefaultExecutor("claude");

    const headers = executor.buildHeaders({ accessToken: "sk-ant-oat-x" }, true, {
      "anthropic-beta": CLAUDE_CODE_BETA_HEADER,
    }) as Record<string, string>;

    const outbound = betaTokens(headers);
    assert.ok(
      outbound.includes(PER_TURN_CONTROL_BETA),
      `outbound beta missing ${PER_TURN_CONTROL_BETA}: ${outbound.join(",")}`
    );
  });

  test("buildHeaders_ClaudeProviderWithoutPerTurnControl_DoesNotInventIt", () => {
    const executor = new DefaultExecutor("claude");

    const headers = executor.buildHeaders({ accessToken: "sk-ant-oat-x" }, true, {
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    }) as Record<string, string>;

    assert.ok(
      !betaTokens(headers).includes(PER_TURN_CONTROL_BETA),
      "per-turn-control must only travel when the client sent it"
    );
  });
});
