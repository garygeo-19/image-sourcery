import { writeFileSync, mkdirSync } from "node:fs";
import * as readline from "node:readline";
import type { Judge } from "./types.js";
import { toDataUrl, download } from "./util.js";

// ── none — accept the first candidate (pure ranked fallback, no judging) ──────
export const none: Judge = {
  name: "none",
  configured: () => true,
  async evaluate() {
    return { score: 1, passes: true, reason: "no judge (accept first candidate)" };
  },
};

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
    const instruction =
      `Requested subject: "${req.query}".` +
      (req.mustShow ? ` It must show: ${req.mustShow}.` : "") +
      (req.mustNotConfuse ? ` It must NOT be confused with: ${req.mustNotConfuse}.` : "") +
      ` Judge how well the image depicts the requested subject. Be strict about species/identity.` +
      ` Respond with JSON: {"score":0..1,"isCorrect":boolean,"reason":"short","confusedWith":"if mismatched, what it actually shows"}.`;
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
    };
  },
  // Comparative: one vision call sees the whole pool and picks the best.
  async select(candidates, req, ctx) {
    const key = ctx.env[ctx.options.apiKeyEnv ?? "OPENAI_API_KEY"]!;
    const minScore = req.minScore ?? ctx.options.minScore ?? 0.7;
    const pool = candidates.slice(0, ctx.options.poolMax ?? 8);
    const urls = await Promise.all(pool.map((c) => toDataUrl(c).catch(() => null)));
    const valid = pool.map((c, i) => ({ i, url: urls[i] })).filter((x) => x.url) as { i: number; url: string }[];
    if (!valid.length) return { index: -1, verdict: { score: 0, passes: false, reason: "no loadable candidates" } };
    const instruction =
      `Requested subject: "${req.query}".` +
      (req.mustShow ? ` It must show: ${req.mustShow}.` : "") +
      (req.mustNotConfuse ? ` It must NOT be confused with: ${req.mustNotConfuse}.` : "") +
      ` You are shown ${valid.length} candidate images, each preceded by its label "Image N".` +
      ` Pick the ONE index that best and correctly depicts the requested subject; be strict about identity/species.` +
      ` Respond with JSON: {"index":int,"score":0..1,"reason":"short"}. If none are acceptable, use index -1.`;
    const content: any[] = [{ type: "text", text: instruction }];
    for (const x of valid) {
      content.push({ type: "text", text: `Image ${x.i}:` });
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
    return { index, verdict: { score, passes: index >= 0 && score >= minScore, reason: j.reason ?? "" } };
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
