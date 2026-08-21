import assert from "node:assert/strict";
import test from "node:test";

import { JUDGES } from "../dist/index.js";

const ctx = (options = {}) => ({ env: { OPENAI_API_KEY: "sk-test" }, options, log: () => {} });
const png = Buffer.from("89504e470d0a1a0a", "hex");
const candidate = (provider, title, extra = {}) => ({
  provider, title, bytes: png, mime: "image/png", ...extra,
});

/** Stub the OpenAI endpoint and hand back whatever body the judge sent. */
async function captureJudgeRequest(reply, body) {
  const real = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (_input, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try { await body(); } finally { globalThis.fetch = real; }
  return sent;
}

/** Every text fragment the judge sent, flattened. */
const promptText = (sent) =>
  sent.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]))
    .filter((p) => p.type === "text").map((p) => p.text).join("\n");

// An archive record names its subject; a stock caption only describes a scene.
// That distinction is the whole basis of the filename test, and it is invisible
// to a judge that only ever receives pixels.
test("evaluate sends the candidate's record title to the judge", async () => {
  const sent = await captureJudgeRequest(
    { score: 0.9, isCorrect: true, reason: "ok" },
    () => JUDGES.openai.evaluate(
      candidate("wikipedia", "Herb Brooks", { meta: { description: "American ice hockey coach" } }),
      { query: "Herb Brooks" },
      ctx(),
    ),
  );
  const text = promptText(sent);
  assert.match(text, /Herb Brooks/);
  assert.match(text, /record title/);
  assert.match(text, /American ice hockey coach/);
  assert.match(text, /wikipedia/);
});

test("evaluate says so explicitly when a provider supplied no title", async () => {
  const sent = await captureJudgeRequest(
    { score: 0.5, isCorrect: false, reason: "unclear" },
    () => JUDGES.openai.evaluate(candidate("unsplash", undefined), { query: "Sonja Henie" }, ctx()),
  );
  // Silence would read as "no objection". Absence has to be stated.
  assert.match(promptText(sent), /record title: \(none supplied\)/);
});

test("select labels every image with its own provider and title", async () => {
  const sent = await captureJudgeRequest(
    { index: 0, score: 0.9, reason: "ok" },
    () => JUDGES.openai.select(
      [candidate("wikipedia", "Carl Lewis"), candidate("pexels", "a man running on a track at sunset")],
      { query: "Carl Lewis" },
      ctx(),
    ),
  );
  const text = promptText(sent);
  assert.match(text, /Image 0 — source: wikipedia; title: "Carl Lewis"/);
  assert.match(text, /Image 1 — source: pexels; title: "a man running on a track at sunset"/);
});

// gatherPool preserves provider order, so slicing the pool truncated by provider:
// with three providers at count 5 and poolMax 8, the third was never judged.
test("select's pool cap keeps every provider represented", async () => {
  const many = [
    ...Array.from({ length: 5 }, (_, i) => candidate("openverse", `openverse ${i}`)),
    ...Array.from({ length: 5 }, (_, i) => candidate("unsplash", `unsplash ${i}`)),
    ...Array.from({ length: 5 }, (_, i) => candidate("pexels", `pexels ${i}`)),
  ];
  const sent = await captureJudgeRequest(
    { index: 0, score: 0.9, reason: "ok" },
    () => JUDGES.openai.select(many, { query: "anything" }, ctx({ poolMax: 8 })),
  );
  const text = promptText(sent);
  for (const provider of ["openverse", "unsplash", "pexels"]) {
    assert.match(text, new RegExp(`source: ${provider};`), `${provider} was starved by the pool cap`);
  }
  assert.equal((text.match(/^Image \d+ — source:/gm) ?? []).length, 8, "cap must still be respected");
});

test("select still returns the index the judge chose", async () => {
  let verdict;
  await captureJudgeRequest(
    { index: 1, score: 0.82, reason: "second one is the right person" },
    async () => {
      verdict = await JUDGES.openai.select(
        [candidate("pexels", "a skater"), candidate("wikipedia", "Sonja Henie")],
        { query: "Sonja Henie" },
        ctx(),
      );
    },
  );
  assert.equal(verdict.index, 1);
  assert.equal(verdict.verdict.passes, true);
});
