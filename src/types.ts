// ── Core contracts ──────────────────────────────────────────────────────────
// Everything is a Provider — searching a source and generating an image both
// implement the same interface. A user-ranked list of providers is walked top
// to bottom; the Judge decides whether each candidate is good enough, and the
// first one that passes wins (the pipeline stops). Fork the tool by writing a
// new Provider; that's the whole extension surface.

export type ProviderKind = "search" | "generate" | "diagram";

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
}
export interface RunResult {
  ok: boolean;
  candidate?: Candidate;
  verdict?: Verdict;
  bytes?: Buffer;
  attempts: Attempt[];
}
