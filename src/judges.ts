import { writeFileSync, mkdirSync } from "node:fs";
import * as readline from "node:readline";
import type { Candidate, Judge } from "./types.js";
import { toDataUrl, download } from "./util.js";

// ── none — accept the first candidate (pure ranked fallback, no judging) ──────
export const none: Judge = {
  name: "none",
  configured: () => true,
  async evaluate() {
    return { score: 1, passes: true, reason: "no judge (accept first candidate)" };
  },
};

/**
 * Ask about UNIQUENESS before asking about relevance.
 *
 * Relevance is the question that failed: every wrong-subject pick in the field
 * report scored well on it. "Is there exactly one of these in the world?" is a
 * different kind of question — a factual one about the subject, not an aesthetic
 * one about the image — and models answer it far more reliably.
 *
 * The judge REPORTS; the pipeline DECIDES. A generic example standing in for a
 * unique subject is honest-but-imprecise, so it scores in the middle rather than
 * at zero, and a profile's min-score decides whether that is good enough. A
 * DIFFERENT named subject is not imprecise, it is false, and scores at the floor.
 */
const UNIQUENESS_RUBRIC =
  ` First decide whether the requested subject is UNIQUE — one particular person, place, building,` +
  ` document or artifact, of which there is exactly one in the world — or a KIND of thing, of which` +
  ` any good example serves, or NEITHER (a theme, a claim, an abstraction).` +
  ` If UNIQUE: an image of that very one is correct. An image of a DIFFERENT specific thing of the` +
  ` same kind is wrong, however similar — the Chrysler Building is not the Empire State Building —` +
  ` and scores at the floor. An image that is merely a generic example of the kind, naming nothing,` +
  ` is honest but imprecise: score it around 0.5 and set isCorrect false.` +
  ` If a KIND: any clear example is correct.` +
  ` If NEITHER: there is no identity to get wrong; judge only whether the image honestly illustrates` +
  ` the idea.`;

// ── openai — vision judge (key: OPENAI_API_KEY) ───────────────────────────────
export const openai: Judge = {
  name: "openai",
  configured: (ctx) => {
    const k = ctx.options.apiKeyEnv ?? "OPENAI_API_KEY";
    return ctx.env[k] ? true : `set ${k}`;
  },
  async evaluate(candidate, req, ctx) {
    const key = ctx.env[ctx.options.apiKeyEnv ?? "OPENAI_API_KEY"]!;
    const dataUrl = await toDataUrl(candidate);
    const minScore = req.minScore ?? ctx.options.minScore ?? 0.7;
    const provenance =
      `\nCandidate metadata — source: ${candidate.provider}` +
      (candidate.title ? `; record title: "${candidate.title}"` : "; record title: (none supplied)") +
      (candidate.meta?.description ? `; described as: "${candidate.meta.description}"` : "") + ".";
    const instruction =
      `Requested subject: "${req.query}".` + provenance +
      UNIQUENESS_RUBRIC +
      ` Weigh the record title as evidence of IDENTITY: an archive title names its subject, whereas a` +
      ` stock caption merely describes a scene, so a single shared word there is coincidence, not a match.` +
      (req.subjectType === "person"
        ? ` The caller has DECLARED this subject a specific real person. Treat it as unique, and reject any` +
          ` image you cannot confirm is that individual — a photograph of someone else, however apt, is a lie` +
          ` the viewer has no way to catch.`
        : "") +
      (req.mustShow ? ` It must show: ${req.mustShow}.` : "") +
      (req.mustNotConfuse ? ` It must NOT be confused with: ${req.mustNotConfuse}.` : "") +
      ` Respond with JSON: {"score":0..1,"isCorrect":boolean,"subjectIsUnique":boolean,` +
      `"reason":"short","confusedWith":"if mismatched, what it actually shows"}.`;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ctx.options.model ?? "gpt-4o-mini",
        response_format: { type: "json_object" },
        max_tokens: 300,
        messages: [
          { role: "system", content: "You verify whether an image correctly depicts a requested subject. Reply ONLY with JSON." },
          { role: "user", content: [
            { type: "text", text: instruction },
            { type: "image_url", image_url: { url: dataUrl } },
          ] },
        ],
      }),
    });
    if (!res.ok) throw new Error(`judge OpenAI ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = (await res.json()) as any;
    const j = JSON.parse(data.choices[0].message.content);
    const score = typeof j.score === "number" ? j.score : 0;
    return {
      score,
      passes: (j.isCorrect ?? score >= minScore) && score >= minScore,
      reason: j.reason ?? "",
      confusedWith: j.confusedWith,
      subjectIsUnique: typeof j.subjectIsUnique === "boolean" ? j.subjectIsUnique : undefined,
    };
  },
  // Comparative: one vision call sees the whole pool and picks the best.
  async select(candidates, req, ctx) {
    const key = ctx.env[ctx.options.apiKeyEnv ?? "OPENAI_API_KEY"]!;
    const minScore = req.minScore ?? ctx.options.minScore ?? 0.7;
    const cap = ctx.options.poolMax ?? 8;
    const byProvider = new Map<string, Candidate[]>();
    for (const c of candidates) {
      if (!byProvider.has(c.provider)) byProvider.set(c.provider, []);
      byProvider.get(c.provider)!.push(c);
    }
    const pool: Candidate[] = [];
    for (let round = 0; pool.length < cap; round++) {
      let added = false;
      for (const list of byProvider.values()) {
        if (round < list.length && pool.length < cap) { pool.push(list[round]); added = true; }
      }
      if (!added) break;
    }
    const urls = await Promise.all(pool.map((c) => toDataUrl(c).catch(() => null)));
    const valid = pool.map((c, i) => ({ i, url: urls[i] })).filter((x) => x.url) as { i: number; url: string }[];
    if (!valid.length) return { index: -1, verdict: { score: 0, passes: false, reason: "no loadable candidates" } };
    const instruction =
      `Requested subject: "${req.query}".` +
      (req.mustShow ? ` It must show: ${req.mustShow}.` : "") +
      (req.mustNotConfuse ? ` It must NOT be confused with: ${req.mustNotConfuse}.` : "") +
      ` You are shown ${valid.length} candidate images, each preceded by the record metadata its` +
      ` provider supplied. Weigh the record title as evidence of IDENTITY: an archive title names its` +
      ` subject, whereas a stock caption merely describes a scene, so a single shared word there is` +
      ` coincidence rather than a match. Where the subject is a named individual and no title names that` +
      ` individual, prefer index -1 over a candidate that merely looks appealing.` +
      UNIQUENESS_RUBRIC +
      ` Pick the ONE index that best and correctly depicts the requested subject.` +
      ` Respond with JSON: {"index":int,"score":0..1,"subjectIsUnique":boolean,"reason":"short"}.` +
      ` If none are acceptable, use index -1.`;
    const content: any[] = [{ type: "text", text: instruction }];
    for (const x of valid) {
      const c = pool[x.i];
      content.push({ type: "text", text:
        `Image ${x.i} — source: ${c.provider}; title: ${c.title ? `"${c.title}"` : "(none supplied)"}` +
        `${c.meta?.description ? `; described as: "${c.meta.description}"` : ""}` });
      content.push({ type: "image_url", image_url: { url: x.url } });
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ctx.options.model ?? "gpt-4o-mini",
        response_format: { type: "json_object" },
        max_tokens: 300,
        messages: [
          { role: "system", content: "You compare candidate images and pick the one that best depicts a requested subject. Reply ONLY with JSON." },
          { role: "user", content },
        ],
      }),
    });
    if (!res.ok) throw new Error(`judge OpenAI ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = (await res.json()) as any;
    const j = JSON.parse(data.choices[0].message.content);
    const index = typeof j.index === "number" ? j.index : -1;
    const score = typeof j.score === "number" ? j.score : 0;
    return {
      index,
      verdict: {
        score, passes: index >= 0 && score >= minScore, reason: j.reason ?? "",
        subjectIsUnique: typeof j.subjectIsUnique === "boolean" ? j.subjectIsUnique : undefined,
      },
    };
  },
};

// ── human — download, show the path, ask y/N on stdin ─────────────────────────
// Also the natural hook for "agent-in-the-loop": an MCP/agent host can swap this
// for a judge that returns the image to the calling model to view.
export const human: Judge = {
  name: "human",
  configured: () => true,
  async evaluate(candidate, req) {
    const bytes = candidate.bytes ?? (await download(candidate.url!)).bytes;
    mkdirSync("/tmp/imgsrcy", { recursive: true });
    const p = `/tmp/imgsrcy/review.${candidate.mime?.includes("png") ? "png" : "jpg"}`;
    writeFileSync(p, bytes);
    console.error(`\n  [${candidate.provider}] saved for review → ${p}`);
    console.error(`  subject: "${req.query}"  ·  license: ${candidate.license ?? "?"}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const ans: string = await new Promise((r) => rl.question("  accept? [y/N] ", (a) => { rl.close(); r(a); }));
    const ok = /^y/i.test(ans.trim());
    return { score: ok ? 1 : 0, passes: ok, reason: ok ? "accepted by human" : "rejected by human" };
  },
  // Comparative: save the whole pool, list it, and pick the best by index.
  // Interactive for a real human; for an agent-in-the-loop, prefer the
  // `imgsrcy gather` command — it saves the pool + manifest and exits so the
  // calling model can view the images and choose.
  async select(candidates, req) {
    mkdirSync("/tmp/imgsrcy/pool", { recursive: true });
    const saved: { i: number; p: string; provider: string; license?: string; url?: string }[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      try {
        const bytes = c.bytes ?? (await download(c.url!)).bytes;
        const p = `/tmp/imgsrcy/pool/${String(i).padStart(2, "0")}.${c.mime?.includes("png") ? "png" : "jpg"}`;
        writeFileSync(p, bytes);
        saved.push({ i, p, provider: c.provider, license: c.license, url: c.url });
      } catch { /* skip unloadable */ }
    }
    console.error(`\n  Pool for "${req.query}" — ${saved.length} candidate(s) in /tmp/imgsrcy/pool/:`);
    for (const s of saved) console.error(`   [${s.i}] ${s.provider} · ${s.license ?? "?"} → ${s.p}`);
    if (!process.stdin.isTTY) {
      return { index: -1, verdict: { score: 0, passes: false, reason: "non-interactive — inspect the pool dir and choose (or use `imgsrcy gather`)" } };
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const ans: string = await new Promise((r) => rl.question("  best index? [N / n=none] ", (a) => { rl.close(); r(a); }));
    const idx = /^n/i.test(ans.trim()) ? -1 : parseInt(ans.trim(), 10);
    const ok = Number.isInteger(idx) && idx >= 0;
    return { index: ok ? idx : -1, verdict: { score: ok ? 1 : 0, passes: ok, reason: ok ? `picked #${idx} by human` : "none chosen" } };
  },
};

export const JUDGES: Record<string, Judge> = { none, openai, human };

export function getJudge(name: string): Judge {
  const j = JUDGES[name];
  if (!j) throw new Error(`unknown judge "${name}" (have: ${Object.keys(JUDGES).join(", ")})`);
  return j;
}
