import assert from "node:assert/strict";
import test from "node:test";

// The budget must be set before the module is imported — it is read at load time.
process.env.IMGSRCY_RETRY_BUDGET_MS = "1200";
process.env.IMGSRCY_HOST_GAP_MS = "100";
const { getJSON } = await import("../dist/util.js");

const json = (value) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

async function withFetch(handler, body) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => handler(String(input));
  try { return await body(); } finally { globalThis.fetch = real; }
}

// Rule 11: a throttle recorded as a failure looks exactly like a missing image.
// Fourteen images appeared permanently unfetchable until a wait was added, after
// which every one succeeded.
test("a 429 is waited out and the call then succeeds", async () => {
  let calls = 0;
  const data = await withFetch(
    () => {
      calls += 1;
      if (calls === 1) return new Response("slow down", { status: 429 });
      return json({ ok: true });
    },
    () => getJSON("https://fixtures.invalid/thing"),
  );
  assert.equal(calls, 2, "must retry rather than surface the 429");
  assert.deepEqual(data, { ok: true });
});

test("Retry-After is honoured rather than ignored", async () => {
  let calls = 0;
  const started = Date.now();
  await withFetch(
    () => {
      calls += 1;
      if (calls === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
      }
      return json({ ok: true });
    },
    () => getJSON("https://fixtures.invalid/thing"),
  );
  // Retry-After: 1 means one second; the default first backoff is only 500ms, so a
  // wait of at least ~900ms proves the header drove the delay and not the fallback.
  assert.ok(Date.now() - started >= 900, "should have waited the advertised second");
});

test("a persistent 429 gives up once the budget is spent", async () => {
  let calls = 0;
  await withFetch(
    () => { calls += 1; return new Response("nope", { status: 429 }); },
    async () => {
      await assert.rejects(() => getJSON("https://fixtures.invalid/thing"), /rate limited \(429\) after backoff/);
    },
  );
  assert.ok(calls > 1, "should have retried before giving up");
});

test("a non-throttle error is surfaced immediately, not retried", async () => {
  let calls = 0;
  await withFetch(
    () => { calls += 1; return new Response("gone", { status: 404 }); },
    async () => { await assert.rejects(() => getJSON("https://fixtures.invalid/thing"), /HTTP 404/); },
  );
  assert.equal(calls, 1);
});

// Politeness is a per-HOST property. Three providers over one organisation's
// infrastructure, or five parallel downloads from one CDN, is a self-inflicted
// burst — and the 429 it earns reads downstream as "no photograph exists".
test("requests to the same host are spaced out", async () => {
  const seen = [];
  await withFetch(
    (url) => { seen.push([url, Date.now()]); return json({ ok: true }); },
    async () => {
      await Promise.all([
        getJSON("https://same.invalid/a"),
        getJSON("https://same.invalid/b"),
        getJSON("https://same.invalid/c"),
      ]);
    },
  );
  assert.equal(seen.length, 3);
  const stamps = seen.map(([, t]) => t).sort((a, b) => a - b);
  assert.ok(stamps[2] - stamps[0] >= 180, `three same-host requests should be paced, saw ${stamps[2] - stamps[0]}ms`);
});

test("requests to different hosts still run in parallel", async () => {
  const started = Date.now();
  await withFetch(
    () => json({ ok: true }),
    async () => {
      await Promise.all([
        getJSON("https://one.invalid/x"),
        getJSON("https://two.invalid/x"),
        getJSON("https://three.invalid/x"),
      ]);
    },
  );
  // Each host waits its own single gap; they must not queue behind each other.
  assert.ok(Date.now() - started < 260, "different hosts must not serialise");
});
