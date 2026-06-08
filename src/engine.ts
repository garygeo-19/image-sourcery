import type {
  Config, ImageRequest, RunResult, Candidate, Verdict, Ctx, Attempt,
  PipelineEntry, PipelineStage,
} from "./types.js";
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
): Promise<Candidate[]> {
  const results = await Promise.all(
    entries.map(async (entry) => {
      let provider;
      try { provider = getProvider(entry.provider); }
      catch (e) { log(`✗ ${entry.provider}: ${(e as Error).message}`); return []; }
      const ctx: Ctx = { env, options: entry, log };
      const ok = provider.configured(ctx);
      if (ok !== true) { log(`– skip ${provider.name} (${ok})`); return []; }
      try {
        const cs = await provider.provide(req, ctx);
        log(`→ ${provider.name}: ${cs.length} candidate(s)`);
        return cs;
      } catch (e) { log(`✗ ${provider.name}: ${(e as Error).message}`); return []; }
    }),
  );
  return results.flat();
}

/**
 * Walk the ranked stages. Single-provider stages run the classic sequential
 * first-pass loop; `{parallel}` stages (and `best`/`pool` modes) gather
 * concurrently and pick the best of the pool COMPARATIVELY — via the judge's
 * `select` if it has one, else by evaluating each and taking the top score.
 * In `first-pass` the first passing stage wins; in `best`/`pool` we judge the
 * whole field and return the global best.
 */
export async function run(
  req: ImageRequest,
  config: Config,
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void = () => {},
): Promise<RunResult> {
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
    const pool = await gatherPool(req, entries, env, log);
    if (!pool.length) continue;

    // Comparative path: a parallel stage (>1 provider), or best/pool mode.
    const comparative = entries.length > 1 || mode === "best" || mode === "pool";

    if (comparative && judge.select) {
      // One look at the whole pool — relative evaluation.
      let pick;
      try { pick = await judge.select(pool, req, judgeCtx); }
      catch (e) { log(`  judge.select error: ${(e as Error).message}`); pick = undefined; }
      if (pick && pick.index >= 0 && pick.index < pool.length) {
        const c = pool[pick.index];
        attempts.push({ provider: c.provider, score: pick.verdict.score, passes: pick.verdict.passes, reason: pick.verdict.reason });
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
      attempts.push({ provider: c.provider, score: v.score, passes: v.passes, reason: v.reason });
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
