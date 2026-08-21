// ── Built-in profiles ───────────────────────────────────────────────────────
// A profile is a named, savable sourcing strategy: which sources, in what order,
// scored how, and who decides. They are plain data so you can list them, copy
// one into your own config, edit it, and keep the name.
//
// Pick by what the SUBJECT is, not by what you have credentials for:
//   a named person or artifact  → "archive-first" (or "verified" to skip the LLM)
//   a generic scene or activity → "stock"
//   an agent is calling this    → "agent"

import type { Profile } from "./types.js";

/** Archives that name their subjects, in rough order of precision. */
const NAMED_SUBJECT_SOURCES = [
  { provider: "wikipedia" },
  { provider: "wikidata" },
  { provider: "loc" },
  { provider: "wellcome" },
  { provider: "cleveland" },
  { provider: "wikimedia" },
];

const STOCK_SOURCES = [
  { provider: "openverse" },
  { provider: "unsplash", apiKeyEnv: "UNSPLASH_ACCESS_KEY" },
  { provider: "pexels", apiKeyEnv: "PEXELS_API_KEY" },
];

export const BUILT_IN_PROFILES: Record<string, Profile> = {
  /**
   * The recommended default for fact-card style work. Archives first, because a
   * stock library holds no photograph of any named historical figure and asking
   * for one returns a plausible stranger. The deterministic title check runs
   * BEFORE the judge, so a high relevance score cannot rescue a wrong subject.
   */
  "archive-first": {
    name: "archive-first",
    description: "Archives first, deterministic name check, then the judge. Best for named subjects.",
    stages: [
      { gather: NAMED_SUBJECT_SOURCES },
      { score: "title-adjacency" },
      { filter: "passing" },
      { score: "judge" },
      { filter: [{ filter: "min-score" }] },
      { select: "best" },
    ],
  },

  /**
   * No LLM anywhere. Sources that name their subjects, checked against their own
   * titles. Cheap, reproducible, and it was the deterministic title filter — not
   * a judge — that actually caught the wrong-subject picks in the field.
   */
  verified: {
    name: "verified",
    description: "Deterministic only — archives plus a name check, no model calls.",
    judge: { provider: "none" },
    stages: [
      { gather: NAMED_SUBJECT_SOURCES },
      { score: "title-adjacency" },
      { filter: "passing" },
      { select: "best" },
    ],
  },

  /**
   * Agent-in-the-loop. Gather widely, apply the deterministic check, and hand the
   * scored pool back rather than deciding. An agent calling this library holds the
   * surrounding context — the claim the image illustrates, the subject's era, what
   * the card is for — and can view the images, so it is better informed than any
   * judge inside here. The name-check verdicts ride along as evidence.
   */
  agent: {
    name: "agent",
    description: "Gather + deterministic check, then defer the choice to the caller.",
    judge: { provider: "none" },
    stages: [
      { gather: [...NAMED_SUBJECT_SOURCES, ...STOCK_SOURCES] },
      { score: "title-adjacency" },
      { select: "defer" },
    ],
  },

  /**
   * Generic scenes, materials and activities — drafting, a workbench, weather.
   * Deliberately has NO identity check, because there is no identity to check;
   * do not point this at a person's name.
   */
  stock: {
    name: "stock",
    description: "Stock libraries for generic scenes. No identity checking.",
    stages: [
      { gather: STOCK_SOURCES },
      { score: "judge" },
      { filter: "min-score" },
      { select: "first" },
    ],
  },

  /**
   * Fan out across everything at once and let the judge pick comparatively in a
   * single look. Highest recall, most tokens.
   */
  "compare-all": {
    name: "compare-all",
    description: "Gather everything in parallel, one comparative judgement.",
    stages: [
      { gather: [...NAMED_SUBJECT_SOURCES, ...STOCK_SOURCES] },
      { score: "title-adjacency" },
      { filter: "passing" },
      { select: "compare" },
    ],
  },
};

/**
 * Resolve a profile by name. Config-defined profiles win over built-ins of the
 * same name, so a preset can be tuned in place without forking the library.
 */
export function getProfile(
  name: string,
  overrides?: Record<string, Omit<Profile, "name"> & { name?: string }>,
): Profile {
  const custom = overrides?.[name];
  if (custom) return { ...custom, name };
  const built = BUILT_IN_PROFILES[name];
  if (!built) {
    const known = [...new Set([...Object.keys(BUILT_IN_PROFILES), ...Object.keys(overrides ?? {})])];
    throw new Error(`unknown profile "${name}" (have: ${known.join(", ")})`);
  }
  return built;
}

export function listProfiles(
  overrides?: Record<string, Omit<Profile, "name"> & { name?: string }>,
): Profile[] {
  const names = [...new Set([...Object.keys(BUILT_IN_PROFILES), ...Object.keys(overrides ?? {})])];
  return names.sort().map((n) => getProfile(n, overrides));
}
