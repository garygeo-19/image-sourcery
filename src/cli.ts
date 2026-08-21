#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { loadEnv, download } from "./util.js";
import { loadConfig } from "./config.js";
import { run, gatherPool } from "./engine.js";
import type { PipelineEntry } from "./types.js";
import { REGISTRY, getProvider } from "./providers.js";
import { JUDGES } from "./judges.js";
import { listProfiles, getProfile } from "./profiles.js";
import { SCORERS, FILTERS } from "./stages.js";
import type { Config, Ctx } from "./types.js";

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { name: string; version: string };

const CAPABILITIES = {
  schemaVersion: 1,
  name: packageMetadata.name,
  version: packageMetadata.version,
  capabilities: {
    "best.absoluteEvaluate": true,
    "attempts.confusedWith": true,
    "doctor.parallelStages": true,
    "bytes.judgeSaveBound": true,
    "attempts.providerFailures": true,
    // Staged pipelines: profiles, typed stages, and the deferred (agent) path.
    "pipeline.stages": true,
    "pipeline.profiles": true,
    "select.defer": true,
    "scorer.titleAdjacency": true,
    "provider.corpus": true,
    // A declared person is refused by the generator, not merely scored down.
    "generate.refusesPerson": true,
    // A rejected candidate leaves a sidecar but no image at --out.
    "out.failClosed": true,
    // 429/503 are waited out; requests to one host are paced.
    "http.retryAfter": true,
    "http.hostPacing": true,
  },
};

function parseFlags(args: string[]): { _: string[]; flags: Record<string, string> } {
  const _: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      flags[key] = val;
    } else _.push(a);
  }
  return { _, flags };
}

const HELP = `image-sourcery (imgsrcy) — ranked image sourcing, with a judge

Usage:
  imgsrcy find "<subject>" [--out file] [options]
  imgsrcy gather "<subject>" [--out dir] [options]   fan out, save the whole pool
  imgsrcy profiles                                list saved + built-in profiles
  imgsrcy doctor [--config file]
  imgsrcy capabilities                            machine-readable compatibility report
  imgsrcy providers

Options for find:
  --out <path>            save the chosen image here
  --profile <name>        run a named profile (see 'imgsrcy profiles')
  --providers a,b,c       override the ranked pipeline (e.g. wikimedia,inaturalist,generate)
  --judge none|openai|human   override the judge
  --best                  judge ALL candidates and keep the highest scorer
  --parallel              gather the whole pipeline AT ONCE (pool) and pick the best
                          comparatively — fan-out instead of sequential cascade
  --min <0..1>            minimum judge score to accept
  --write-on-fail         also save the best REJECTED candidate (default: sidecar only)

'gather' fans out all providers in parallel, downloads every candidate to a dir
(default /tmp/imgsrcy/pool) + writes pool.json, and exits — for human/agent
comparative judging (view the pool, pick the best). Same flags as find.
  --must-show "<text>"    positive constraint the judge must confirm
  --must-not "<text>"     negative constraint (must not be confused with)
  --count <n>             candidates considered per provider (default 5)
  --config <file>         config file (default ./image-sourcery.config.json)

Credentials are read from your env / a local .env, referenced by NAME in config.
The tool ships no keys. Run 'imgsrcy doctor' to see what you're set up for.`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { _, flags } = parseFlags(rest);

  if (cmd === "capabilities") {
    console.log(JSON.stringify(CAPABILITIES, null, 2));
    return;
  }

  const env = loadEnv();
  const config: Config = loadConfig(flags.config);

  if (!cmd || cmd === "help" || flags.help) { console.log(HELP); return; }

  if (cmd === "profiles") {
    for (const p of listProfiles(config.profiles)) {
      const custom = config.profiles?.[p.name] ? " (from your config)" : "";
      console.log(`\n  ${p.name}${custom}`);
      if (p.description) console.log(`    ${p.description}`);
      console.log(`    ${p.stages.map((st) => Object.keys(st)[0]).join(" → ")}`);
    }
    console.log(`\nScorers: ${Object.keys(SCORERS).join(", ")}`);
    console.log(`Filters: ${Object.keys(FILTERS).join(", ")}`);
    console.log(`\nRun one:  imgsrcy find "<subject>" --profile <name>`);
    return;
  }

  if (cmd === "providers") {
    console.log("Providers:");
    for (const [name, p] of Object.entries(REGISTRY)) console.log(`  ${name.padEnd(12)} ${p.kind}`);
    console.log("Judges:");
    for (const name of Object.keys(JUDGES)) console.log(`  ${name}`);
    return;
  }

  if (cmd === "doctor") {
    console.log(`Judge: ${config.judge.provider}`);
    const jctx: Ctx = { env, options: config.judge, log: () => {} };
    const j = JUDGES[config.judge.provider];
    console.log(`  ${j ? (j.configured(jctx) === true ? "✓ ready" : "✗ " + j.configured(jctx)) : "✗ unknown judge"}`);
    console.log(`Pipeline (ranked):`);
    for (const entry of config.pipeline.flatMap((s: any) => ("parallel" in s ? s.parallel : [s]))) {
      let status = "✗ unknown provider";
      try {
        const p = getProvider(entry.provider);
        const ctx: Ctx = { env, options: entry, log: () => {} };
        const ok = p.configured(ctx);
        status = ok === true ? "✓ ready" : "– skipped: " + ok;
      } catch { /* unknown */ }
      console.log(`  ${entry.provider.padEnd(12)} ${status}`);
    }
    return;
  }

  if (cmd === "find") {
    const query = _[0];
    if (!query) { console.error('find needs a subject, e.g. imgsrcy find "saguaro cactus"'); process.exit(1); }
    if (flags.providers) config.pipeline = flags.providers.split(",").map((p) => ({ provider: p.trim() }));
    if (flags.judge) config.judge = { ...config.judge, provider: flags.judge };
    if (flags.profile) { config.profile = flags.profile; delete config.stages; }
    if (flags.best) config.mode = "best";
    if (flags.parallel) config.mode = "pool";

    const req = {
      query,
      mustShow: flags["must-show"],
      mustNotConfuse: flags["must-not"],
      minScore: flags.min ? Number(flags.min) : undefined,
      count: flags.count ? Number(flags.count) : 5,
    };

    const result = await run(req, config, env, (m) => console.error(m));

    const provenance = {
      query, ok: result.ok,
      provider: result.candidate?.provider,
      title: result.candidate?.title,
      license: result.candidate?.license,
      attribution: result.candidate?.attribution,
      sourceUrl: result.candidate?.sourceUrl,
      score: result.verdict?.score,
      reason: result.verdict?.reason,
      confusedWith: result.verdict?.confusedWith,
      profile: result.profile,
      pool: result.pool?.map((c) => ({
        provider: c.provider, title: c.title, score: c.score, passes: c.passes,
        reason: c.reason, license: c.license, sourceUrl: c.sourceUrl, url: c.url,
      })),
      out: flags.out ?? null,
      generatedAt: new Date().toISOString(),
      attempts: result.attempts,
    };
    if (flags.out) {
      mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
      // The sidecar is the decision trace and is written either way — a failed run
      // needs a record too. The IMAGE is only written when the run actually passed:
      // a rejected candidate left at the requested path looks identical to a good
      // one to anything downstream that checks whether the file exists.
      if (result.bytes && (result.ok || flags["write-on-fail"])) {
        writeFileSync(flags.out, result.bytes);
      }
      writeFileSync(flags.out + ".json", JSON.stringify(provenance, null, 2));
    }
    console.log(JSON.stringify(provenance, null, 2));
    process.exit(result.ok ? 0 : 2);
  }

  if (cmd === "gather") {
    const query = _[0];
    if (!query) { console.error('gather needs a subject, e.g. imgsrcy gather "saguaro cactus"'); process.exit(1); }
    const entries: PipelineEntry[] = flags.providers
      ? flags.providers.split(",").map((p) => ({ provider: p.trim() }))
      : config.pipeline.flatMap((s) => ("parallel" in s ? s.parallel : [s]));
    const req = {
      query,
      mustShow: flags["must-show"],
      mustNotConfuse: flags["must-not"],
      count: flags.count ? Number(flags.count) : 5,
    };
    const pool = await gatherPool(req, entries, env, (m) => console.error(m));
    const dir = flags.out ?? "/tmp/imgsrcy/pool";
    mkdirSync(dir, { recursive: true });
    const manifest: any[] = [];
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      const base = { index: i, provider: c.provider, title: c.title, license: c.license, attribution: c.attribution, sourceUrl: c.sourceUrl, url: c.url };
      try {
        const d = c.bytes ? { bytes: c.bytes, mime: c.mime ?? "image/jpeg" } : await download(c.url!);
        const file = path.join(dir, `${String(i).padStart(2, "0")}.${d.mime.includes("png") ? "png" : "jpg"}`);
        writeFileSync(file, d.bytes);
        manifest.push({ ...base, file });
      } catch (e) { manifest.push({ ...base, error: String((e as Error).message) }); }
    }
    writeFileSync(path.join(dir, "pool.json"), JSON.stringify({ query, count: manifest.length, candidates: manifest }, null, 2));
    console.log(JSON.stringify({ query, dir, count: manifest.length, candidates: manifest }, null, 2));
    return;
  }

  console.error(`unknown command "${cmd}"\n`);
  console.log(HELP);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
