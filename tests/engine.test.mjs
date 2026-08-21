import assert from "node:assert/strict";
import test from "node:test";

import { JUDGES, REGISTRY, run } from "../dist/index.js";

test("best mode evaluates every candidate absolutely and preserves confusedWith", async () => {
  const providerA = "test-best-a";
  const providerB = "test-best-b";
  const judgeName = "test-best-judge";
  let evaluateCalls = 0;
  let selectCalls = 0;

  REGISTRY[providerA] = {
    name: providerA,
    kind: "search",
    configured: () => true,
    provide: async () => [
      { provider: providerA, bytes: Buffer.from("a1"), mime: "image/png", meta: { id: "a1" } },
      { provider: providerA, bytes: Buffer.from("a2"), mime: "image/png", meta: { id: "a2" } },
    ],
  };
  REGISTRY[providerB] = {
    name: providerB,
    kind: "search",
    configured: () => true,
    provide: async () => [
      { provider: providerB, bytes: Buffer.from("b1"), mime: "image/png", meta: { id: "b1" } },
    ],
  };
  const verdicts = {
    a1: { score: 0.3, passes: false, reason: "wrong subject", confusedWith: "lookalike a" },
    a2: { score: 0.8, passes: true, reason: "correct but weaker" },
    b1: { score: 0.9, passes: true, reason: "best correct image" },
  };
  JUDGES[judgeName] = {
    name: judgeName,
    configured: () => true,
    evaluate: async (candidate) => {
      evaluateCalls += 1;
      return verdicts[candidate.meta.id];
    },
    select: async () => {
      selectCalls += 1;
      return { index: 0, verdict: { score: 1, passes: true, reason: "must not run" } };
    },
  };

  try {
    const result = await run(
      { query: "specific subject" },
      {
        judge: { provider: judgeName },
        mode: "best",
        pipeline: [{ provider: providerA }, { provider: providerB }],
      },
      {},
    );

    assert.equal(evaluateCalls, 3);
    assert.equal(selectCalls, 0);
    assert.equal(result.ok, true);
    assert.equal(result.candidate.provider, providerB);
    assert.equal(result.attempts.length, 3);
    assert.equal(result.attempts[0].confusedWith, "lookalike a");
  } finally {
    delete REGISTRY[providerA];
    delete REGISTRY[providerB];
    delete JUDGES[judgeName];
  }
});

test("explicit parallel stages remain comparative", async () => {
  const providerA = "test-parallel-a";
  const providerB = "test-parallel-b";
  const judgeName = "test-parallel-judge";
  let evaluateCalls = 0;
  let selectCalls = 0;

  for (const name of [providerA, providerB]) {
    REGISTRY[name] = {
      name,
      kind: "search",
      configured: () => true,
      provide: async () => [{ provider: name, bytes: Buffer.from(name), mime: "image/png" }],
    };
  }
  JUDGES[judgeName] = {
    name: judgeName,
    configured: () => true,
    evaluate: async () => {
      evaluateCalls += 1;
      return { score: 0, passes: false, reason: "must not run" };
    },
    select: async () => {
      selectCalls += 1;
      return { index: 1, verdict: { score: 0.9, passes: true, reason: "comparative winner" } };
    },
  };

  try {
    const result = await run(
      { query: "parallel subject" },
      {
        judge: { provider: judgeName },
        pipeline: [{ parallel: [{ provider: providerA }, { provider: providerB }] }],
      },
      {},
    );

    assert.equal(evaluateCalls, 0);
    assert.equal(selectCalls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.candidate.provider, providerB);
  } finally {
    delete REGISTRY[providerA];
    delete REGISTRY[providerB];
    delete JUDGES[judgeName];
  }
});

test("judged remote bytes are frozen once and provider failures remain attempts", async () => {
  const changingProvider = "test-changing-bytes";
  const brokenProvider = "test-broken-provider";
  const judgeName = "test-frozen-bytes-judge";
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  REGISTRY[brokenProvider] = {
    name: brokenProvider,
    kind: "search",
    configured: () => true,
    provide: async () => { throw new Error("offline fixture failure"); },
  };
  REGISTRY[changingProvider] = {
    name: changingProvider,
    kind: "search",
    configured: () => true,
    provide: async () => [{ provider: changingProvider, url: "https://fixture.invalid/image", mime: "image/png" }],
  };
  JUDGES[judgeName] = {
    name: judgeName,
    configured: () => true,
    evaluate: async (candidate) => {
      assert.deepEqual(candidate.bytes, Buffer.from("judged-bytes"));
      return { score: 0.9, passes: true, reason: "exact frozen bytes" };
    },
  };
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(fetchCalls === 1 ? Buffer.from("judged-bytes") : Buffer.from("different-bytes"), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  };

  try {
    const result = await run(
      { query: "frozen subject" },
      {
        judge: { provider: judgeName },
        mode: "best",
        pipeline: [{ provider: brokenProvider }, { provider: changingProvider }],
      },
      {},
    );
    assert.equal(fetchCalls, 1);
    assert.deepEqual(result.bytes, Buffer.from("judged-bytes"));
    assert.match(result.attempts[0].reason, /provider error: offline fixture failure/);
    assert.equal(result.attempts.at(-1).passes, true);
  } finally {
    globalThis.fetch = originalFetch;
    delete REGISTRY[brokenProvider];
    delete REGISTRY[changingProvider];
    delete JUDGES[judgeName];
  }
});
