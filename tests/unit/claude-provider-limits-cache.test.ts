import test from "node:test";
import assert from "node:assert/strict";

import { mergeProviderLimitsCacheEntry } from "../../src/lib/usage/providerLimitsCache.ts";

const oldFetchedAt = "2026-10-12T15:01:00.000Z";
const newFetchedAt = "2026-10-12T16:18:00.000Z";
const resetAt = "2026-10-15T09:00:00.000Z";
const previous = {
  quotas: {
    "weekly (7d)": {
      used: 8,
      total: 100,
      remaining: 92,
      remainingPercentage: 92,
      resetAt,
    },
  },
  plan: null,
  message: null,
  fetchedAt: oldFetchedAt,
  source: "response-headers",
};

test("Claude usage without windows preserves last observed quota and its timestamp", () => {
  const next = {
    quotas: {},
    plan: null,
    message: "Claude connected. Usage API requires admin permissions.",
    fetchedAt: newFetchedAt,
    source: "scheduled",
  };

  const merged = mergeProviderLimitsCacheEntry("claude", next, previous);
  assert.deepEqual(merged.quotas, previous.quotas);
  assert.equal(merged.fetchedAt, oldFetchedAt);
  assert.equal(merged.message, null);
});

test("Claude partial response replaces the cache rather than mixing incompatible window ages", () => {
  const next = {
    quotas: {
      "session (5h)": {
        used: 7,
        total: 100,
        remaining: 93,
        remainingPercentage: 93,
        resetAt: "2026-10-12T20:00:00.000Z",
      },
    },
    plan: null,
    message: null,
    fetchedAt: newFetchedAt,
    source: "scheduled",
  };

  const merged = mergeProviderLimitsCacheEntry("claude", next, previous);
  assert.equal(Object.keys(merged.quotas ?? {}).length, 1);
  assert.equal(merged.quotas?.["session (5h)"], next.quotas["session (5h)"]);
  assert.equal(merged.quotas?.["weekly (7d)"], undefined);
});

test("Claude real reset replaces old quota instead of resurrecting stale data", () => {
  const next = {
    quotas: { "weekly (7d)": { used: 0, total: 100, remainingPercentage: 100, resetAt } },
    plan: null,
    message: null,
    fetchedAt: newFetchedAt,
    source: "manual",
  };
  const merged = mergeProviderLimitsCacheEntry("claude", next, previous);
  assert.equal(merged.quotas?.["weekly (7d)"], next.quotas["weekly (7d)"]);
  assert.equal(merged.fetchedAt, newFetchedAt);
});
