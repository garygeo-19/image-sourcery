import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILT_IN_PROFILES, FILTERS, JUDGES, REGISTRY, getProfile, listProfiles, run, titleAdjacency,
} from "../dist/index.js";

const png = Buffer.from("89504e470d0a1a0a", "hex");
const ctx = { env: {}, options: {}, log: () => {}, corpusOf: () => "archive" };
const stockCtx = { ...ctx, corpusOf: () => "stock" };

const verdict = (query, title, c = ctx) =>
  titleAdjacency.score({ provider: "fixture", title }, { query }, c);

// ── The field report's own worked examples ──────────────────────────────────
// Every case below is a real pick from the 2026-08-19 sourcing run. All of them
// scored WELL on relevance; the title check is what separates them.
test("title-adjacency reproduces every worked example in the field report", () => {
  const rejects = [
    ["Carl Lewis", "Carl Nielsen, Danish composer", "shared first name, different person"],
    ["Oksana Baiul", "Oksana Zabuzhko, writer", "shared first name, different person"],
    ["Al Oerter", "Plate depicting Harun Al-Rashid", "shared fragment, different subject"],
    ["John Shuster", "John Sloan by Will Shuster", "both words present, two different people"],
    ["Elaine Thompson-Herah", "Thompson's gazelle in Nakuru, Kenya", "surname only, different subject"],
  ];
  for (const [query, title, why] of rejects) {
    assert.equal(verdict(query, title).passes, false, `${query} ← ${title} (${why})`);
  }

  const keeps = [
    ["Herb Brooks", "Herb Brooks 1983"],
    ["Hoover Dam Black Canyon", "Hoover Dam, Nevada"],   // partial place name is still the place
  ];
  for (const [query, title] of keeps) {
    assert.equal(verdict(query, title).passes, true, `${query} ← ${title}`);
  }
});

// Splitting on the hyphen is what lets the maiden-name record match. Without it
// "Thompson-Herah" is one token that never matches a bare "Thompson".
test("hyphenated names split, so a maiden-name record still matches", () => {
  assert.equal(verdict("Elaine Thompson-Herah", "Elaine Thompson Beijing 2015").passes, true);
});

// Rule 8: a stock caption describes a scene, so one shared word is coincidence.
// The same one-word test is safe against an archive, whose records name subjects.
test("a one-word subject is confirmable against an archive but never against stock", () => {
  const stock = verdict("Curling", "a stylist curling blonde hair into glamorous curls", stockCtx);
  assert.equal(stock.passes, false);
  assert.match(stock.reason, /stock caption/);

  // Single-word terms are not proper nouns, so identity is not asserted at all.
  const archive = verdict("Strigil", "Bronze strigil, Metropolitan Museum of Art");
  assert.equal(archive.passes, true);
});

// A floor for EVERY multi-word term, named or not. One shared word is a
// coincidence: "Roman mosaic of theatrical masks" matched "Roman Kostrzewski", a
// Polish metal singer, on the single token `roman` — three separate times.
test("one shared word is a coincidence, not a match", () => {
  const thin = verdict("cliff dwelling in a red rock alcove", "sandstone alcove at golden hour");
  assert.equal(thin.passes, false, "sharing only 'alcove' is not a match");
  assert.match(thin.reason, /coincidence/);

  const real = verdict("cliff dwelling in a red rock alcove", "cliff dwelling in a sandstone alcove");
  assert.equal(real.passes, true);
});

// The name inside a descriptive phrase still has to be matched AS a name — a
// whole-string proper-noun test never fires for these.
test("a name embedded in a descriptive phrase is still guarded", () => {
  assert.equal(verdict("Cicero marble portrait bust", "Roman Kostrzewski live in Katowice").passes, false);
  assert.equal(verdict("Cicero marble portrait bust", "Cicero, marble bust, Musei Capitolini").passes, true);
});

// Structured identity beats string overlap: a file placed in a subject's Commons
// category was judged BY A PERSON to be about that subject, and its filename may
// share no word with the term at all.
test("curated identity outranks a weak title overlap", () => {
  const plain = titleAdjacency.score(
    { provider: "fixture", title: "Hercules Stiernhielm portrait" }, { query: "Hercules Stiernhielm" }, ctx);
  const curated = titleAdjacency.score(
    { provider: "fixture", title: "Hercules Stiernhielm portrait", meta: { identityVerifiedBy: "commons-category" } },
    { query: "Hercules Stiernhielm" }, ctx);
  assert.ok(curated.score >= plain.score);
  assert.ok(curated.score >= 0.72);
  assert.match(curated.reason, /identity verified by commons-category/);
});

test("a named subject with no title at all cannot be confirmed", () => {
  const v = titleAdjacency.score({ provider: "unsplash", title: undefined }, { query: "Sonja Henie" }, stockCtx);
  assert.equal(v.passes, false);
  assert.match(v.reason, /supplied no title/);
});

// ── Executor ────────────────────────────────────────────────────────────────

function fixtureProvider(name, candidates, corpus = "archive") {
  REGISTRY[name] = {
    name, corpus, kind: "search",
    configured: () => true,
    provide: async () => candidates.map((c) => ({ provider: name, bytes: png, mime: "image/png", ...c })),
  };
  return { provider: name };
}

test("a chain of gather/select pairs cascades: the precise source wins outright", async () => {
  const first = fixtureProvider("stage-archive", [{ title: "Herb Brooks 1983" }]);
  const second = fixtureProvider("stage-stock", [{ title: "a hockey coach shouting" }], "stock");

  const result = await run({ query: "Herb Brooks" }, {
    judge: { provider: "none" },
    stages: [
      { gather: [first] }, { score: "title-adjacency" }, { filter: "passing" }, { select: "first" },
      { gather: [second] }, { score: "none" }, { select: "first" },
    ],
  }, {});

  assert.equal(result.ok, true);
  assert.equal(result.candidate.provider, "stage-archive");
});

test("...and falls through to the next gather when nothing survives", async () => {
  const first = fixtureProvider("fall-archive", [{ title: "Carl Nielsen, composer" }]);
  const second = fixtureProvider("fall-stock", [{ title: "anything at all" }], "stock");

  const result = await run({ query: "Carl Lewis" }, {
    judge: { provider: "none" },
    stages: [
      { gather: [first] }, { score: "title-adjacency" }, { filter: "passing" }, { select: "first" },
      { gather: [second] }, { score: "none" }, { select: "first" },
    ],
  }, {});

  assert.equal(result.ok, true);
  assert.equal(result.candidate.provider, "fall-stock", "should have fallen through");
  // The wrong-subject drop stays visible in the trace.
  assert.ok(result.attempts.some((a) => /passing: /.test(a.reason)), "the drop must be recorded");
});

test("a dropped candidate is recorded rather than vanishing silently", async () => {
  const p = fixtureProvider("drop-src", [{ title: "Carl Nielsen" }, { title: "Carl Lewis at the 1984 Games" }]);
  const result = await run({ query: "Carl Lewis" }, {
    judge: { provider: "none" },
    stages: [{ gather: [p] }, { score: "title-adjacency" }, { filter: "passing" }, { select: "best" }],
  }, {});

  assert.equal(result.candidate.title, "Carl Lewis at the 1984 Games");
  const dropped = result.attempts.filter((a) => a.reason.startsWith("passing:"));
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /Carl Nielsen/);
});

// The agent-in-the-loop path: the library gathers and checks, the CALLER decides.
test("select defer returns the scored pool instead of choosing", async () => {
  const p = fixtureProvider("defer-src", [{ title: "Sonja Henie 1936" }, { title: "a flock of birds" }]);
  const result = await run({ query: "Sonja Henie" }, {
    judge: { provider: "none" },
    stages: [{ gather: [p] }, { score: "title-adjacency" }, { select: "defer" }],
  }, {});

  assert.equal(result.ok, false, "deferring is not a success — nothing was chosen");
  assert.equal(result.candidate, undefined);
  assert.equal(result.pool.length, 2);
  // The evidence rides along, so the agent reads verdicts rather than guessing from pixels.
  const named = result.pool.find((c) => c.title === "Sonja Henie 1936");
  assert.equal(named.passes, true);
  assert.equal(result.pool.find((c) => c.title === "a flock of birds").passes, false);
});

test("a scorer that needs the judge fails closed when the judge is unconfigured", async () => {
  const p = fixtureProvider("needs-judge", [{ title: "anything" }]);
  await assert.rejects(
    () => run({ query: "x" }, {
      judge: { provider: "openai" },
      stages: [{ gather: [p] }, { score: "judge" }, { select: "first" }],
    }, {}),
    /not configured/,
  );
});

// ── Profiles ────────────────────────────────────────────────────────────────

test("built-in profiles are well formed", () => {
  for (const [name, profile] of Object.entries(BUILT_IN_PROFILES)) {
    assert.equal(profile.name, name, `${name} must name itself`);
    assert.ok(profile.description, `${name} needs a description`);
    assert.ok(profile.stages.some((s) => Array.isArray(s.gather)), `${name} must gather`);
    assert.ok(profile.stages.some((s) => s.select !== undefined), `${name} must select`);
  }
});

test("archive-first checks identity before it spends a judge call", () => {
  const stages = BUILT_IN_PROFILES["archive-first"].stages;
  const deterministic = stages.findIndex((s) => s.score === "title-adjacency");
  const judged = stages.findIndex((s) => s.score === "judge");
  assert.ok(deterministic >= 0 && judged >= 0);
  assert.ok(deterministic < judged, "a relevance score must not get the chance to rescue a wrong subject");
});

test("a config-defined profile overrides a built-in of the same name", () => {
  const overrides = { verified: { description: "mine", stages: [{ gather: [{ provider: "wikipedia" }] }, { select: "first" }] } };
  assert.equal(getProfile("verified", overrides).description, "mine");
  assert.equal(getProfile("verified").description, BUILT_IN_PROFILES.verified.description);
  assert.ok(listProfiles(overrides).some((p) => p.name === "verified" && p.description === "mine"));
});

test("an unknown profile names the ones that exist", () => {
  assert.throws(() => getProfile("nope"), /unknown profile "nope".*archive-first/s);
});

test("a profile runs end to end via run()", async () => {
  const p = fixtureProvider("profile-src", [{ title: "Herb Brooks 1983" }]);
  const result = await run({ query: "Herb Brooks" }, {
    judge: { provider: "none" },
    profile: "custom",
    profiles: {
      custom: { stages: [{ gather: [p] }, { score: "title-adjacency" }, { filter: "passing" }, { select: "best" }] },
    },
  }, {});
  assert.equal(result.ok, true);
  assert.equal(result.profile, "custom");
});

// ── no-other-name ───────────────────────────────────────────────────────────
// The three-way split. "No name match" is two different things: a title that
// names NOTHING (generic — imprecise but honest, and often the best answer
// available) and a title that names something ELSE (a different subject,
// captioned as such, presented as ours — the falsehood).
const rejectName = (query, title) =>
  FILTERS["no-other-name"].reject({ provider: "fixture", title }, { query }, ctx, {});

test("no-other-name rejects a different named subject but allows a generic one", () => {
  // The real miss: a card about the Stoa Poikile was given the Stoa of Attalos.
  assert.match(
    rejectName("Stoa Poikile Athenian Agora", "Stoa of Attalos, Athens") ?? "",
    /names a different subject/,
  );
  assert.match(
    rejectName("Empire State Building", "the Chrysler Building at dusk") ?? "",
    /names a different subject/,
  );

  // Loosely related is acceptable — a generic example names nothing, so nothing
  // is being asserted falsely. This is what a strict name check wrongly killed.
  assert.equal(rejectName("Stoa Poikile Athenian Agora", "a ruined colonnade at sunset"), null);
  assert.equal(rejectName("Empire State Building", "a Manhattan skyscraper at sunset"), null);

  // And the subject itself obviously passes.
  assert.equal(rejectName("Empire State Building", "Empire State Building from Rockefeller Center"), null);
});

test("no-other-name cannot convict a candidate that has no title", () => {
  assert.equal(rejectName("Empire State Building", undefined), null);
  assert.equal(rejectName("Empire State Building", ""), null);
});
