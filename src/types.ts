// ── Core contracts ──────────────────────────────────────────────────────────
// Everything is a Provider — searching a source and generating an image both
// implement the same interface. A user-ranked list of providers is walked top
// to bottom; the Judge decides whether each candidate is good enough, and the
// first one that passes wins (the pipeline stops). Fork the tool by writing a
// new Provider; that's the whole extension surface.

export type ProviderKind = "search" | "generate" | "diagram";

/**
 * What KIND OF CORPUS a provider draws from. This is a different axis from
 * ProviderKind (what the provider *does*) and it changes how much a record's
 * title is worth as evidence:
 *
 *  - "archive"   a catalogue whose records NAME their subject ("Herb Brooks 1983").
 *                A one-word subject can be confirmed against one of these.
 *  - "stock"     a photo library whose captions DESCRIBE a scene ("a stylist
 *                curling blonde hair"). A single shared word is coincidence, so a
 *                one-word subject can never be confirmed here.
 *  - "aggregate" mixed provenance — some records name their subject, some do not.
 *  - "synthetic" generated. Nothing was photographed, so no title is evidence.
 */
export type ProviderCorpus = "archive" | "stock" | "aggregate" | "synthetic";

export interface ImageRequest {
  /** What the image should depict, e.g. "Yarrow's spiny lizard". */
  query: string;
  /** Optional positive constraint the judge must confirm, e.g. "blue-green scaly body". */
  mustShow?: string;
  /** Optional negative constraint, e.g. "must not be a desert spiny lizard". */
  mustNotConfuse?: string;
  /** Minimum judge score (0..1) to accept. Overrides config/judge default. */
  minScore?: number;
  /** How many candidates to consider per provider. */
  count?: number;
  /**
   * What KIND of thing the subject is, when the caller knows. The caller almost
   * always knows more than this library can infer from a query string, so this is
   * declared, never guessed — a library whose value is a reproducible provenance
   * trail must not change behaviour based on a heuristic.
   *
   * "person" is load-bearing: it forbids generation. A generated portrait
   * presented as a real individual is a fabricated likeness — the same falsehood
   * as attaching the wrong photograph, but synthetic and much harder for anyone
   * downstream to catch.
   */
  subjectType?: "person" | "place" | "artifact" | "artwork" | "scene" | "concept";
}

export interface Candidate {
  /** Remote URL OR inline bytes (generators return bytes). One is required. */
  url?: string;
  bytes?: Buffer;
  mime?: string;
  provider: string;
  title?: string;
  license?: string;
  attribution?: string;
  /** Link back to the source record/page, for provenance. */
  sourceUrl?: string;
  /** The provider's OWN id for this image. Once a file is copied elsewhere and
   *  its URL dropped, the link cannot be reconstructed without this. */
  providerId?: string;
  meta?: Record<string, unknown>;
}

/** Per-call context: the user's env (for credentials) + this entry's options. */
export interface Ctx {
  env: NodeJS.ProcessEnv;
  options: Record<string, any>;
  log: (msg: string) => void;
}

export interface Provider {
  name: string;
  kind: ProviderKind;
  /** Which corpus this draws from. Defaults to "aggregate" — the cautious
   *  reading — when a provider does not say. */
  corpus?: ProviderCorpus;
  /** Is this provider usable for THIS user right now? Returns true, or a
   *  human-readable reason it's skipped (e.g. "set UNSPLASH_ACCESS_KEY"). */
  configured(ctx: Ctx): true | string;
  provide(req: ImageRequest, ctx: Ctx): Promise<Candidate[]>;
}

export interface Verdict {
  score: number; // 0..1
  passes: boolean;
  reason: string;
  confusedWith?: string;
  /**
   * Did the judge consider the requested subject a UNIQUE real entity — exactly
   * one of it in the world — rather than a kind of thing? Reported, not acted on:
   * it lets a caller apply a stricter floor to the cases where a near-miss is a
   * falsehood instead of an imprecision.
   */
  subjectIsUnique?: boolean;
}

export interface Judge {
  name: string;
  configured(ctx: Ctx): true | string;
  /** Absolute, per-candidate verdict (sequential / first-pass path). */
  evaluate(candidate: Candidate, req: ImageRequest, ctx: Ctx): Promise<Verdict>;
  /**
   * Optional COMPARATIVE selector: given a *pool* of candidates gathered in
   * parallel, pick the single best one and say why. This is the relative
   * ("which of these is best?") evaluation — one look at the whole set instead
   * of N independent yes/no calls. When absent, the engine falls back to
   * evaluating each candidate and taking the highest score. Return index -1 if
   * none are acceptable.
   */
  select?(
    candidates: Candidate[],
    req: ImageRequest,
    ctx: Ctx,
  ): Promise<{ index: number; verdict: Verdict }>;
}

/** A candidate plus the verdict a scorer reached about it. */
export interface Scored {
  score: number;
  passes: boolean;
  reason: string;
  confusedWith?: string;
  /** Carried through from the judge — see Verdict.subjectIsUnique. */
  subjectIsUnique?: boolean;
}

export type FilterSpec = string | { filter: string; [option: string]: any };

/**
 * How the surviving candidates become an answer.
 *  - "first"   the first that passes, in rank order — cheapest
 *  - "best"    the highest scorer across the whole set
 *  - "compare" one relative look at the pool via the judge's `select`
 *  - "defer"   DO NOT decide. Return the scored pool so the CALLER judges —
 *              this is the agent-in-the-loop path: an agent invoking this
 *              library already holds the surrounding context and can read the
 *              images, so it is better informed than any judge inside here.
 */
export type SelectMode = "first" | "best" | "compare" | "defer";

/** One link in a staged pipeline. See src/stages.ts. */
export type Stage =
  | { gather: PipelineEntry[]; [option: string]: any }
  | { score: string | { scorer: string; [option: string]: any } }
  | { filter: FilterSpec | FilterSpec[] }
  | { select: SelectMode };

/** A named, savable sourcing strategy. */
export interface Profile {
  name: string;
  description?: string;
  judge?: JudgeConfig;
  stages: Stage[];
}

export interface PipelineEntry {
  provider: string;
  [option: string]: any;
}

/**
 * A parallel stage: gather candidates from these providers CONCURRENTLY, pool
 * them, and judge them comparatively (best-of-pool) rather than first-pass. This
 * is the "fan out, then pick the best" configuration — an alternative to the
 * pure sequential cascade, usable for one stage while other stages stay
 * sequential.
 */
export interface ParallelStage {
  parallel: PipelineEntry[];
  [option: string]: any;
}

export type PipelineStage = PipelineEntry | ParallelStage;

export function isParallel(s: PipelineStage): s is ParallelStage {
  return Array.isArray((s as ParallelStage).parallel);
}
export interface JudgeConfig {
  provider: string;
  [option: string]: any;
}
export interface Config {
  judge: JudgeConfig;
  /** Name of a built-in or config-defined profile to run. */
  profile?: string;
  /** Extra profiles, saved alongside your config. These override built-ins of
   *  the same name, so a preset can be tuned without forking the library. */
  profiles?: Record<string, Omit<Profile, "name"> & { name?: string }>;
  /** An explicit staged pipeline. Takes precedence over `profile`. */
  stages?: Stage[];
  /**
   * Ranked list of STAGES, tried in order. A stage is either one provider
   * (sequential) or a `{ parallel: [...] }` group (gathered concurrently and
   * judged comparatively). Plain `{ provider }` entries keep the classic
   * sequential cascade; wrap some in `parallel` to fan out at that stage.
   */
  pipeline: PipelineStage[];
  /**
   * "first-pass" (default): stop at the first candidate that passes — cheapest.
   * "best": judge every candidate from every provider and return the highest
   * scorer — more thorough (and more API calls), fixes "the 1st result was bad".
   * "pool": gather the ENTIRE pipeline in parallel into one pool and pick the
   * best comparatively — maximum recall + relative evaluation in a single shot.
   */
  mode?: "first-pass" | "best" | "pool";
}

export interface Attempt {
  provider: string;
  score?: number;
  passes?: boolean;
  reason: string;
  confusedWith?: string;
}
export interface RunResult {
  ok: boolean;
  candidate?: Candidate;
  verdict?: Verdict;
  bytes?: Buffer;
  attempts: Attempt[];
  /** Set when the pipeline ended in `select: "defer"`: the scored pool, handed
   *  back for the caller to judge. `ok` is false because nothing was chosen. */
  pool?: (Candidate & Scored)[];
  /** Which profile ran, when one was named. */
  profile?: string;
}
