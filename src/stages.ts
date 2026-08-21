// ── Staged pipelines ────────────────────────────────────────────────────────
// A pipeline is a CHAIN OF TYPED STAGES over a candidate set:
//
//     gather → score → filter → select
//
// Every stage is data, so a whole sourcing strategy is a config rather than a
// script. That is the point: two consumers that need different strategies get
// two configs over one executor, instead of two scripts that drift apart and
// have a rule fixed in one and left broken in the other.
//
// The chain is deliberately LINEAR. Cases that look like they want branching —
// "check names against archive titles but not stock captions" — are predicates
// that read a candidate's corpus, not graph topology. Add edges only when a
// profile genuinely cannot be written without them.

import type {
  Candidate, Ctx, ImageRequest, Judge, PipelineEntry, ProviderCorpus, Scored, Stage,
} from "./types.js";
import { getProvider } from "./providers.js";

// ── Scorers: candidates → a 0..1 score, with a reason ────────────────────────

export interface Scorer {
  name: string;
  /** Whether this scorer needs the configured Judge (and therefore credentials). */
  usesJudge?: boolean;
  /** Whether this scorer needs the image BYTES. A metadata-only scorer must not
   *  force a download: checking a title costs nothing, and downloading thirty
   *  candidates to discard twenty-eight of them on that check is both slow and
   *  the surest way to earn a 429 from the archives worth reading. */
  usesBytes?: boolean;
  score(c: Candidate, req: ImageRequest, ctx: ScorerCtx): Promise<Scored> | Scored;
}

export interface ScorerCtx extends Ctx {
  judge: Judge;
  judgeCtx: Ctx;
  corpusOf: (provider: string) => ProviderCorpus;
}

/** Grammar words. Removed from ordinary token overlap. */
const STOP = new Set("a an the of to in and or is with on at for from by".split(" "));

/**
 * Words that never IDENTIFY a subject, so they cannot carry a name match on
 * their own. Deliberately wider than STOP, and deliberately kept separate: fold
 * these into ordinary tokenisation and a term like "Winter Olympics" reduces to
 * nothing at all.
 */
const NAME_STOP = new Set([
  ...STOP, "de", "van", "von", "da", "di",
  "team", "games", "summer", "winter", "olympic", "olympics", "ranking", "centennial",
]);

/** Ordinary content words of a string, for overlap scoring. */
export function tokens(s: string): Set<string> {
  return new Set(
    String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/**
 * The longest run of capitalised words inside a term — the NAME within a
 * descriptive phrase. Returns null when there is no run of two or more, because
 * a single leading capital is just sentence case rather than a name.
 */
export function namedRun(term: string): string | null {
  const connective = /^(?:of|the|de|van|von|da|di)$/i;
  // Strip surrounding punctuation before the capital test. Applied to a search
  // TERM this rarely matters, but this also runs over candidate TITLES, where
  // commas are the norm — "Stoa of Attalos, Athens" ends its capitalised run at
  // `Attalos,` and reports no name at all, so a competing subject goes undetected.
  const words = String(term ?? "").trim().split(/\s+/)
    .map((w) => w.replace(/^[^\w'’-]+|[^\w'’-]+$/g, ""))
    .filter(Boolean);
  let best: string[] = [], cur: string[] = [];
  for (const w of words) {
    if (/^[A-Z][\w'’-]*$/.test(w) || (cur.length && connective.test(w))) cur.push(w);
    else { if (cur.length > best.length) best = cur; cur = []; }
  }
  if (cur.length > best.length) best = cur;
  return best.filter((w) => !connective.test(w)).length >= 2 ? best.join(" ") : null;
}

/** The significant, subject-bearing words of a term. Hyphens split too, so
 *  "Thompson-Herah" can match a record that says only "Thompson". */
export function significantParts(term: string): string[] {
  return String(term ?? "")
    .trim()
    .split(/[\s-]+/)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9'’]/g, ""))
    .filter((w) => w.length > 2 && !NAME_STOP.has(w));
}

/** Two or more capitalised words — a specific named subject rather than a described scene. */
export const PROPER_NOUN =
  /^(?:[A-Z0-9][\w'’-]*)(?:\s+(?:of|the|de|van|von|da|di)?\s*[A-Z0-9][\w'’-]*)+$/;

/** Longest run of adjacent parts that appears as a phrase in the title. */
function longestAdjacentRun(parts: string[], title: string): number {
  const flat = ` ${String(title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  let best = 0;
  for (let a = 0; a < parts.length; a++) {
    for (let b = a + 1; b <= parts.length; b++) {
      if (flat.includes(` ${parts.slice(a, b).join(" ")} `)) best = Math.max(best, b - a);
    }
  }
  return best;
}

/**
 * title-adjacency — deterministic identity check on the record's own title.
 *
 * This is the rule an LLM relevance score cannot be trusted with: every
 * wrong-subject pick in the field report scored WELL on relevance, and was caught
 * only by reading what was actually picked. Requiring the name's words to appear
 * NEXT TO EACH OTHER separates "John Shuster" from "John Sloan by Will Shuster",
 * where both words are present and belong to two different people.
 */
export const titleAdjacency: Scorer = {
  name: "title-adjacency",
  score(c, req, ctx) {
    const term = String(req.query ?? "").trim();
    const termTokens = tokens(term);
    if (!termTokens.size) return { score: 0, passes: false, reason: "no significant words in the search term" };

    const title = c.title ?? "";
    const titleTokens = tokens(title);
    const corpus = ctx.corpusOf(c.provider);

    // How much of the term the title actually accounts for. This is the RANKING
    // signal — a hard gate is a yes/no, but a chooser still has to order the
    // survivors, and collapsing everything that passes to 1.0 leaves nothing to
    // sort by but pixel area.
    let hits = 0;
    for (const w of termTokens) if (titleTokens.has(w)) hits++;
    const byTitle = hits / termTokens.size;

    const parts = significantParts(term);

    if (!title) {
      return { score: 0, passes: false, reason: `${c.provider} supplied no title, so identity cannot be confirmed` };
    }

    // Rule 8, and it sits OUTSIDE the named-subject branch below on purpose: that
    // branch needs two tokens to fire at all, so a one-word subject would sail
    // past it. A stock caption is a whole sentence describing a scene, so a
    // single matching word is a coincidence rather than evidence of subject —
    // "Curling" against "a stylist curling blonde hair at a salon". The same
    // one-word test is safe against an archive, whose records name their subject.
    if (parts.length <= 1 && corpus === "stock") {
      return { score: 0, passes: false, reason: "a one-word subject cannot be confirmed by a stock caption" };
    }

    // A term does not have to be ENTIRELY a proper noun to be about a named
    // thing. "Cicero marble portrait bust" is a descriptive phrase with a name
    // inside it, and a whole-string test never fires for it — so it falls
    // through to plain token overlap and matches Roman Kostrzewski, a Polish
    // metal singer. Extract the capitalised run and guard on that instead.
    const named = namedRun(term);

    // Floor for EVERY multi-word term, named or not: one shared word is a
    // coincidence. "Roman mosaic of theatrical masks" matched "Roman
    // Kostrzewski" on the single token `roman`.
    if (parts.length >= 2 && parts.filter((w) => titleTokens.has(w)).length < 2) {
      return {
        score: 0, passes: false,
        reason: `only one word of "${term}" appears in "${title}" — a coincidence, not a match`,
      };
    }

    if (PROPER_NOUN.test(term) || named) {
      // Split on hyphens too, so "Thompson-Herah" can match a record that says
      // only "Thompson" — that is what lets the maiden-name photograph through.
      const nameParts = significantParts(named ?? term);
      const run = longestAdjacentRun(nameParts, title);
      if (run < Math.min(2, nameParts.length)) {
        const shares = nameParts.some((w) => titleTokens.has(w));
        return shares
          // Shares part of the name but not the whole of it, adjacently: almost
          // always a different person who happens to share a first name.
          ? { score: 0, passes: false, reason: `shares part of the name but not the whole of it ("${title}")`, confusedWith: title }
          // Shares none of it. For an unnamed subject a thematic image is honest;
          // for a NAMED one it is not — a generic photo on a person's card reads
          // to the viewer as a picture OF them.
          : { score: 0, passes: false, reason: `title does not name the subject ("${title}")` };
      }
    }

    // Structured identity beats string overlap. A file placed in a subject's
    // Commons category, or hanging off a Wikidata P18 claim, was judged BY A
    // PERSON to be about that subject — and its filename may share no word with
    // the search term at all ("Hercules, Stiernhielm.png").
    const verified = c.meta?.identityVerifiedBy ?? (c as any).viaCategory;
    const score = verified ? Math.max(byTitle, 0.72) : byTitle;
    return {
      score,
      passes: true,
      reason: verified
        ? `identity verified by ${typeof verified === "string" ? verified : "curation"} ("${title}")`
        : `title accounts for ${(byTitle * 100).toFixed(0)}% of the subject ("${title}")`,
    };
  },
};

/** judge — delegate to the configured Judge. The non-deterministic scorer. */
export const judgeScorer: Scorer = {
  name: "judge",
  usesJudge: true,
  usesBytes: true,
  async score(c, req, ctx) {
    const v = await ctx.judge.evaluate(c, req, ctx.judgeCtx);
    return {
      score: v.score, passes: v.passes, reason: v.reason,
      confusedWith: v.confusedWith, subjectIsUnique: v.subjectIsUnique,
    };
  },
};

/** none — accept everything. The pure ranked-fallback path. */
export const noneScorer: Scorer = {
  name: "none",
  score() {
    return { score: 1, passes: true, reason: "no scoring (accept in rank order)" };
  },
};

export const SCORERS: Record<string, Scorer> = {
  "title-adjacency": titleAdjacency,
  judge: judgeScorer,
  none: noneScorer,
};

// ── Filters: drop candidates before anything expensive looks at them ─────────

export interface Filter {
  name: string;
  /** Return null to keep, or a reason to drop. */
  reject(c: Candidate & Partial<Scored>, req: ImageRequest, ctx: ScorerCtx, options: any): string | null;
}

export const FILTERS: Record<string, Filter> = {
  /**
   * min-score, with an optional stricter floor for UNIQUE subjects.
   *
   * `whenUnique` is how a caller acts on the judge's uniqueness call without the
   * library deciding policy for them. For a KIND of thing any good example is
   * correct, so a modest floor is right. For one particular thing — the Empire
   * State Building, the Rosetta Stone — a merely-similar image is honest but
   * imprecise, and whether that clears the bar is the caller's call, not ours.
   */
  "min-score": {
    name: "min-score",
    reject: (c, req, _ctx, options) => {
      const base = options?.min ?? req.minScore ?? 0.7;
      const floor = c.subjectIsUnique && options?.whenUnique !== undefined
        ? options.whenUnique
        : base;
      if ((c.score ?? 0) >= floor) return null;
      return `scored ${(c.score ?? 0).toFixed(2)} < ${floor}` +
        (floor !== base ? " (stricter floor: the subject is unique)" : "");
    },
  },
  passing: {
    name: "passing",
    reject: (c) => (c.passes ? null : c.reason || "did not pass"),
  },
  "has-title": {
    name: "has-title",
    reject: (c) => (c.title ? null : `${c.provider} supplied no title`),
  },
  "archive-only": {
    name: "archive-only",
    reject: (c, _req, ctx) =>
      ctx.corpusOf(c.provider) === "archive" ? null : `${c.provider} is not an archive`,
  },
  /**
   * no-other-name — loosely related is acceptable; wrong identity is not.
   *
   * The three-way split that a plain name check misses. "No name match" is two
   * different things:
   *   · the title names NOTHING specific — a generic colonnade on a Stoa Poikile
   *     card. Imprecise but honest, and often the best available answer.
   *   · the title names something ELSE specific — "Stoa of Attalos, Athens" on
   *     that same card. A different building, captioned as such, presented as the
   *     subject. That is the falsehood.
   *
   * Requiring the caption to MATCH the name is the obvious rule and it is wrong:
   * stock libraries do not caption ancient philosophers, so it rejects the honest
   * generic images too and coverage collapses.
   *
   * So the test is on the CANDIDATE's title alone — does it name a subject of its
   * own, and is that subject not ours? A title that names nothing goes through.
   */
  "no-other-name": {
    name: "no-other-name",
    reject: (c, req) => {
      const title = String(c.title ?? "").trim();
      if (!title) return null;                       // nothing to convict it with
      const theirs = namedRun(title);
      if (!theirs) return null;                      // names nothing — generic, allow
      const theirParts = significantParts(theirs);
      if (!theirParts.length) return null;
      const ours = new Set(significantParts(namedRun(req.query ?? "") ?? req.query ?? ""));
      return theirParts.every((w) => ours.has(w))
        ? null
        : `title names a different subject ("${theirs}")`;
    },
  },
  "no-synthetic": {
    name: "no-synthetic",
    reject: (c, _req, ctx) =>
      ctx.corpusOf(c.provider) === "synthetic" ? "generated images are not allowed here" : null,
  },
};

/** Register a consumer-specific rule. The library owns the executor and the
 *  generic predicates; a consumer owns rules about its own domain. */
export function registerFilter(filter: Filter): void {
  FILTERS[filter.name] = filter;
}
export function registerScorer(scorer: Scorer): void {
  SCORERS[scorer.name] = scorer;
}

export function getScorer(name: string): Scorer {
  const s = SCORERS[name];
  if (!s) throw new Error(`unknown scorer "${name}" (have: ${Object.keys(SCORERS).join(", ")})`);
  return s;
}
export function getFilter(name: string): Filter {
  const f = FILTERS[name];
  if (!f) throw new Error(`unknown filter "${name}" (have: ${Object.keys(FILTERS).join(", ")})`);
  return f;
}

// ── Stage helpers ───────────────────────────────────────────────────────────

export const isGather = (s: Stage): s is Extract<Stage, { gather: PipelineEntry[] }> =>
  Array.isArray((s as any).gather);
export const isScore = (s: Stage): s is Extract<Stage, { score: any }> =>
  (s as any).score !== undefined;
export const isFilter = (s: Stage): s is Extract<Stage, { filter: any }> =>
  (s as any).filter !== undefined;
export const isSelect = (s: Stage): s is Extract<Stage, { select: any }> =>
  (s as any).select !== undefined;

export function corpusOf(provider: string): ProviderCorpus {
  try {
    return getProvider(provider).corpus ?? "aggregate";
  } catch {
    return "aggregate";
  }
}
