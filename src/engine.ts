import type {
  Config, ImageRequest, RunResult, Candidate, Verdict, Ctx, Attempt,
  PipelineEntry, PipelineStage, Profile, Scored,
} from "./types.js";
import type { ScorerCtx } from "./stages.js";
import { corpusOf, getFilter, getScorer, isFilter, isGather, isScore, isSelect } from "./stages.js";
import { getProfile } from "./profiles.js";
import { isParallel } from "./types.js";
import { getProvider } from "./providers.js";
import { getJudge } from "./judges.js";
import { download } from "./util.js";

/** Expand the configured pipeline into a list of stages, each a list of
 *  provider entries. A `{parallel:[...]}` stage keeps its group; a single
 *  `{provider}` entry becomes a one-element stage. In `pool` mode the whole
 *  pipeline collapses into ONE parallel stage. */
function toStages(config: Config): PipelineEntry[][] {
  const entriesOf = (s: PipelineStage): PipelineEntry[] =>
    isParallel(s) ? s.parallel : [s];
  if (config.mode === "pool") return [config.pipeline.flatMap(entriesOf)];
  return config.pipeline.map(entriesOf);
}

/** Gather candidates from a set of provider entries CONCURRENTLY, pooled. */
export async function gatherPool(
  req: ImageRequest,
  entries: PipelineEntry[],
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void = () => {},
  attempts: Attempt[] = [],
): Promise<Candidate[]> {
  const results = await Promise.all(
    entries.map(async (entry) => {
      let provider;
      try { provider = getProvider(entry.provider); }
      catch (e) {
        const reason = `provider unavailable: ${(e as Error).message}`;
        attempts.push({ provider: entry.provider, passes: false, reason });
        log(`✗ ${entry.provider}: ${(e as Error).message}`);
        return [];
      }
      const ctx: Ctx = { env, options: entry, log };
      const ok = provider.configured(ctx);
      if (ok !== true) {
        attempts.push({ provider: provider.name, passes: false, reason: `provider not configured: ${ok}` });
        log(`– skip ${provider.name} (${ok})`);
        return [];
      }
      try {
        const cs = await provider.provide(req, ctx);
        log(`→ ${provider.name}: ${cs.length} candidate(s)`);
        if (!cs.length) attempts.push({ provider: provider.name, passes: false, reason: "provider returned no candidates" });
        return cs;
      } catch (e) {
        const reason = `provider error: ${(e as Error).message}`;
        attempts.push({ provider: provider.name, passes: false, reason });
        log(`✗ ${provider.name}: ${(e as Error).message}`);
        return [];
      }
    }),
  );
  return results.flat();
}

/**
 * Walk the ranked stages. Single-provider stages run the classic sequential
 * loop. In `first-pass` the first candidate to pass an absolute evaluation
 * wins; in `best` every candidate is evaluated absolutely and the global best
 * wins. Explicit `{parallel}` stages and `pool` mode use the judge's
 * COMPARATIVE `select` when available, falling back to absolute evaluations
 * when it is not.
 */
export async function run(
  req: ImageRequest,
  config: Config,
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void = () => {},
): Promise<RunResult> {
  // A staged pipeline — inline, or a named profile — takes precedence. The
  // `pipeline`/`mode` form below is the original shorthand and stays supported;
  // it is a shim over the same idea and can retire once callers have moved.
  if (config.stages) {
    return runStages(req, { name: "inline", stages: config.stages }, config, env, log);
  }
  if (config.profile) {
    return runStages(req, getProfile(config.profile, config.profiles), config, env, log);
  }

  const judge = getJudge(config.judge.provider);
  const judgeCtx: Ctx = { env, options: config.judge, log };
  const jok = judge.configured(judgeCtx);
  if (jok !== true) throw new Error(`judge "${judge.name}" not configured: ${jok}`);

  const mode = config.mode ?? "first-pass";
  const stages = toStages(config);
  const attempts: Attempt[] = [];
  let best: { c: Candidate; v: Verdict } | null = null;

  const finish = async () => {
    if (!best) return { ok: false, attempts } as RunResult;
    const bytes = best.c.bytes ?? (await download(best.c.url!).then((d) => d.bytes).catch(() => undefined));
    return { ok: best.v.passes, candidate: best.c, verdict: best.v, bytes, attempts };
  };

  for (const entries of stages) {
    const gathered = await gatherPool(req, entries, env, log, attempts);
    // Freeze the exact bytes before judging. Judges consume Candidate.bytes and
    // the returned RunResult reuses those same bytes, so a mutable remote URL
    // cannot yield different judged and saved images.
    const pool: Candidate[] = [];
    for (const candidate of gathered) {
      try {
        if (!candidate.bytes) {
          if (!candidate.url) throw new Error("candidate has neither bytes nor URL");
          candidate.bytes = (await download(candidate.url)).bytes;
        }
        pool.push(candidate);
      } catch (e) {
        const reason = `candidate download failed: ${(e as Error).message}`;
        attempts.push({ provider: candidate.provider, passes: false, reason });
        log(`✗ ${candidate.provider}: ${reason}`);
      }
    }
    if (!pool.length) continue;

    // Only explicitly parallel work is comparative. `best` must retain the
    // absolute acceptance floor by evaluating every candidate individually.
    const comparative = entries.length > 1 || mode === "pool";

    if (comparative && judge.select) {
      // One look at the whole pool — relative evaluation.
      let pick;
      try { pick = await judge.select(pool, req, judgeCtx); }
      catch (e) { log(`  judge.select error: ${(e as Error).message}`); pick = undefined; }
      if (pick && pick.index >= 0 && pick.index < pool.length) {
        const c = pool[pick.index];
        attempts.push({
          provider: c.provider,
          score: pick.verdict.score,
          passes: pick.verdict.passes,
          reason: pick.verdict.reason,
          confusedWith: pick.verdict.confusedWith,
        });
        log(`  ◇ picked [${c.provider}] (${pick.verdict.score.toFixed(2)}) ${pick.verdict.reason}`);
        if (!best || pick.verdict.score > best.v.score) best = { c, v: pick.verdict };
        if (pick.verdict.passes && mode === "first-pass") {
          const bytes = c.bytes ?? (await download(c.url!)).bytes;
          return { ok: true, candidate: c, verdict: pick.verdict, bytes, attempts };
        }
      }
      continue;
    }

    // Fallback: evaluate each candidate; comparative = take the max of this pool,
    // first-pass single-provider = stop at the first that passes.
    for (const c of pool) {
      let v: Verdict;
      try { v = await judge.evaluate(c, req, judgeCtx); }
      catch (e) { log(`  judge error: ${(e as Error).message}`); continue; }
      attempts.push({
        provider: c.provider,
        score: v.score,
        passes: v.passes,
        reason: v.reason,
        confusedWith: v.confusedWith,
      });
      log(`  ${v.passes ? "✓ PASS" : "· fail"} (${v.score.toFixed(2)}) ${v.reason}${v.confusedWith ? ` [looks like: ${v.confusedWith}]` : ""}`);
      if (!best || v.score > best.v.score) best = { c, v };
      if (v.passes && mode === "first-pass" && !comparative) {
        const bytes = c.bytes ?? (await download(c.url!)).bytes;
        return { ok: true, candidate: c, verdict: v, bytes, attempts };
      }
    }
    // A comparative stage that produced a passing best in first-pass mode: stop.
    if (comparative && mode === "first-pass" && best?.v.passes) return finish();
  }

  return finish();
}

// ── Staged execution ────────────────────────────────────────────────────────
// The working set flows through the chain. `gather` ADDS to it, `score` and
// `filter` transform it, and `select` may end the run. A chain with several
// gather/select pairs is therefore a cascade — try the precise source, and only
// fall through to the broad one if nothing was chosen — expressed as data.

/** Download once, so the bytes that were judged are the bytes that get saved. */
async function freeze(
  gathered: Candidate[],
  attempts: Attempt[],
  log: (m: string) => void,
): Promise<Candidate[]> {
  const pool: Candidate[] = [];
  for (const candidate of gathered) {
    try {
      if (!candidate.bytes) {
        if (!candidate.url) throw new Error("candidate has neither bytes nor URL");
        candidate.bytes = (await download(candidate.url)).bytes;
      }
      pool.push(candidate);
    } catch (e) {
      const reason = `candidate download failed: ${(e as Error).message}`;
      attempts.push({ provider: candidate.provider, passes: false, reason });
      log(`✗ ${candidate.provider}: ${reason}`);
    }
  }
  return pool;
}

export async function runStages(
  req: ImageRequest,
  profile: Profile,
  config: Config,
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void = () => {},
): Promise<RunResult> {
  const judgeConfig = profile.judge ?? config.judge;
  const judge = getJudge(judgeConfig.provider);
  const judgeCtx: Ctx = { env, options: judgeConfig, log };

  const needsJudge = profile.stages.some(
    (s) => isScore(s) && getScorer(typeof s.score === "string" ? s.score : s.score.scorer).usesJudge,
  ) || profile.stages.some((s) => isSelect(s) && s.select === "compare");
  if (needsJudge) {
    const ok = judge.configured(judgeCtx);
    if (ok !== true) throw new Error(`judge "${judge.name}" not configured: ${ok}`);
  }

  const scorerCtx: ScorerCtx = { env, options: {}, log, judge, judgeCtx, corpusOf };
  const attempts: Attempt[] = [];
  let working: (Candidate & Partial<Scored>)[] = [];
  let best: (Candidate & Scored) | null = null;

  const record = (c: Candidate & Partial<Scored>) =>
    attempts.push({
      provider: c.provider, score: c.score, passes: c.passes,
      reason: c.reason ?? "", confusedWith: c.confusedWith,
    });

  const answer = async (c: Candidate & Scored, ok: boolean): Promise<RunResult> => ({
    ok,
    candidate: c,
    verdict: { score: c.score, passes: c.passes, reason: c.reason, confusedWith: c.confusedWith },
    bytes: c.bytes ?? (await download(c.url!)).bytes,
    attempts,
    profile: profile.name,
  });

  for (const stage of profile.stages) {
    if (isGather(stage)) {
      // Metadata only. Bytes are fetched lazily, once something actually needs
      // to look at the picture.
      working.push(...(await gatherPool(req, stage.gather, env, log, attempts)));
      log(`  ↳ ${working.length} candidate(s) in play`);
      continue;
    }

    if (isScore(stage)) {
      const spec = typeof stage.score === "string" ? { scorer: stage.score } : stage.score;
      const scorer = getScorer(spec.scorer);
      if (scorer.usesBytes) working = await freeze(working, attempts, log);
      for (const c of working) {
        try {
          Object.assign(c, await scorer.score(c, req, { ...scorerCtx, options: spec }));
        } catch (e) {
          Object.assign(c, { score: 0, passes: false, reason: `scorer error: ${(e as Error).message}` });
        }
        log(`  ${c.passes ? "✓" : "·"} [${c.provider}] ${(c.score ?? 0).toFixed(2)} ${c.reason}`);
        if (c.passes && (!best || (c.score ?? 0) > best.score)) best = c as Candidate & Scored;
      }
      continue;
    }

    if (isFilter(stage)) {
      const specs = (Array.isArray(stage.filter) ? stage.filter : [stage.filter])
        .map((f) => (typeof f === "string" ? { filter: f } : f));
      for (const spec of specs) {
        const filter = getFilter(spec.filter);
        const kept: typeof working = [];
        for (const c of working) {
          const rejected = filter.reject(c, req, scorerCtx, spec);
          if (rejected) {
            // A dropped candidate stays in the trace. Silence here is how a
            // decision trace comes to say nothing about why candidates vanished.
            attempts.push({ provider: c.provider, passes: false, reason: `${filter.name}: ${rejected}` });
            log(`  – dropped [${c.provider}] ${filter.name}: ${rejected}`);
          } else kept.push(c);
        }
        working = kept;
      }
      continue;
    }

    if (isSelect(stage)) {
      if (stage.select === "defer") {
        working.forEach(record);
        return {
          ok: false, attempts, profile: profile.name,
          pool: working.filter((c) => c.score !== undefined) as (Candidate & Scored)[],
        };
      }
      if (!working.length) continue;   // nothing to choose from — fall through

      if (stage.select === "compare" && judge.select) {
        working = await freeze(working, attempts, log);   // the judge must see the images
        let pick;
        try { pick = await judge.select(working, req, judgeCtx); }
        catch (e) { log(`  judge.select error: ${(e as Error).message}`); }
        if (pick && pick.index >= 0 && pick.index < working.length) {
          const chosen = Object.assign(working[pick.index], pick.verdict) as Candidate & Scored;
          record(chosen);
          if (!best || chosen.score > best.score) best = chosen;
          if (chosen.passes) return answer(chosen, true);
        }
        continue;
      }

      const ranked = [...working].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const chosen = stage.select === "best"
        ? ranked[0]
        : working.find((c) => c.passes);
      if (chosen?.passes) {
        record(chosen);
        return answer(chosen as Candidate & Scored, true);
      }
      continue;
    }
  }

  if (best) return answer(best, best.passes);
  return { ok: false, attempts, profile: profile.name };
}
