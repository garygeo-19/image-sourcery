import assert from "node:assert/strict";
import test from "node:test";

import { REGISTRY } from "../dist/index.js";

const ctx = (options = {}, env = {}) => ({ env, options, log: () => {} });
const json = (value) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

/** Swap in a fetch stub for one test and always put the real one back. */
async function withFetch(handler, body) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => handler(String(input));
  try {
    return await body();
  } finally {
    globalThis.fetch = real;
  }
}

// MediaWiki returns `query.pages` as an OBJECT keyed by page id, and JavaScript
// orders integer-like keys numerically — not by search rank. Only the per-page
// `index` carries rank. Here the correct subject has the HIGHER page id, so
// Object.values() alone yields the wrong athlete: this is the exact shape that
// made "Carl Lewis" resolve to Donovan Bailey.
test("wikipedia ranks by search index, not by page-id key order", async () => {
  const pages = {
    100: {
      index: 2, title: "Donovan Bailey", pageimage: "Donovan_Bailey.jpg",
      description: "Canadian sprinter", fullurl: "https://en.wikipedia.org/wiki/Donovan_Bailey",
      original: { source: "https://upload.wikimedia.org/wikipedia/commons/a/Donovan_Bailey.jpg" },
    },
    999: {
      index: 1, title: "Carl Lewis", pageimage: "Carl_Lewis.jpg",
      description: "American track and field athlete (born 1961)",
      fullurl: "https://en.wikipedia.org/wiki/Carl_Lewis",
      original: { source: "https://upload.wikimedia.org/wikipedia/commons/b/Carl_Lewis.jpg" },
    },
  };
  assert.equal(Object.values(pages)[0].title, "Donovan Bailey", "fixture must reproduce the bad key order");

  const candidates = await withFetch(
    (url) => (url.includes("generator=search") ? json({ query: { pages } }) : json({ query: { pages: {} } })),
    () => REGISTRY.wikipedia.provide({ query: "Carl Lewis", count: 5 }, ctx()),
  );

  assert.equal(candidates[0].title, "Carl Lewis");
  assert.equal(candidates[0].meta.description, "American track and field athlete (born 1961)");
});

// A /wikipedia/<lang>/ path is a locally hosted NON-FREE fair-use file, and an
// SVG pictogram is an icon rather than a photograph of the subject. Neither may
// be handed to a caller that is going to publish the result.
test("wikipedia drops non-free fair-use files and pictograms", async () => {
  const pages = {
    1: {
      index: 1, title: "Some Film", pageimage: "Poster.jpg", fullurl: "https://en.wikipedia.org/wiki/Some_Film",
      original: { source: "https://upload.wikimedia.org/wikipedia/en/0/Poster.jpg" }, // fair use
    },
    2: {
      index: 2, title: "Ice hockey", pageimage: "Ice_hockey_pictogram.svg",
      fullurl: "https://en.wikipedia.org/wiki/Ice_hockey",
      original: { source: "https://upload.wikimedia.org/wikipedia/commons/1/Ice_hockey_pictogram.svg" },
    },
    3: {
      index: 3, title: "Herb Brooks", pageimage: "Herb_Brooks_1983.JPG",
      fullurl: "https://en.wikipedia.org/wiki/Herb_Brooks",
      original: { source: "https://upload.wikimedia.org/wikipedia/commons/2/Herb_Brooks_1983.JPG" },
    },
  };
  const candidates = await withFetch(
    (url) => (url.includes("generator=search") ? json({ query: { pages } }) : json({ query: { pages: {} } })),
    () => REGISTRY.wikipedia.provide({ query: "Herb Brooks", count: 5 }, ctx()),
  );

  assert.deepEqual(candidates.map((c) => c.title), ["Herb Brooks"]);
});

// Taking search[0] blindly returns the entity with no image and reads downstream
// as "no photograph of this subject exists". For "Geronimo" the top hit is the
// given name; the Apache leader is second.
test("wikidata skips entities with no P18 rather than reporting nothing", async () => {
  const candidates = await withFetch((url) => {
    if (url.includes("wbsearchentities")) {
      return json({ search: [{ id: "Q20002168" }, { id: "Q2791" }] });
    }
    return json({
      entities: {
        Q20002168: { labels: { en: { value: "Geronimo" } }, descriptions: { en: { value: "male given name" } }, claims: {} },
        Q2791: {
          labels: { en: { value: "Gerónimo" } },
          descriptions: { en: { value: "Apache leader" } },
          claims: { P18: [{ mainsnak: { datavalue: { value: "Geronimo_1887.jpg" } } }] },
        },
      },
    });
  }, () => REGISTRY.wikidata.provide({ query: "Geronimo", count: 5 }, ctx()));

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].title, "Gerónimo");
  assert.equal(candidates[0].providerId, "Q2791");
  // The label, not the filename — a Commons filename often names the event, not the subject.
  assert.match(candidates[0].url, /Special:FilePath\/Geronimo_1887\.jpg/);
});

// Rule 3: a generated portrait presented as a real individual is a fabricated
// likeness — the same falsehood as the wrong photograph, but synthetic and much
// harder to catch downstream. This must be a refusal, not a scoring penalty.
test("generate refuses a declared person before making any API call", async () => {
  let called = false;
  await withFetch(
    () => { called = true; return json({}); },
    async () => {
      await assert.rejects(
        () => REGISTRY.generate.provide(
          { query: "Sonja Henie", subjectType: "person" },
          ctx({}, { OPENAI_API_KEY: "sk-test" }),
        ),
        /refusing to generate an image of a person/,
      );
    },
  );
  assert.equal(called, false, "must refuse before spending an API call");
});

test("generate proceeds for a non-person subject", async () => {
  const candidates = await withFetch(
    () => json({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }),
    () => REGISTRY.generate.provide(
      { query: "cars running nose-to-tail", subjectType: "scene" },
      ctx({}, { OPENAI_API_KEY: "sk-test" }),
    ),
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].provider, "generate");
});

// /search/ returns exhibition landing pages and unrelated books; /photos/ returns
// photographs. Same parsing, different corpus.
test("loc queries the photographs endpoint", async () => {
  let requested = "";
  await withFetch(
    (url) => { requested = url; return json({ results: [] }); },
    () => REGISTRY.loc.provide({ query: "Rosa Parks", count: 5 }, ctx()),
  );
  assert.match(requested, /loc\.gov\/photos\//);
  assert.doesNotMatch(requested, /loc\.gov\/search\//);
});
