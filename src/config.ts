import { readFileSync, existsSync } from "node:fs";
import type { Config } from "./types.js";

/** Sensible keyless default: try free sources, no judge (accept first). */
export const DEFAULT_CONFIG: Config = {
  judge: { provider: "none" },
  pipeline: [
    { provider: "wikimedia" },
    { provider: "inaturalist" },
    { provider: "loc" },
    { provider: "unsplash", apiKeyEnv: "UNSPLASH_ACCESS_KEY" },
    { provider: "pexels", apiKeyEnv: "PEXELS_API_KEY" },
  ],
};

export function loadConfig(file?: string): Config {
  if (file && !existsSync(file)) {
    throw new Error(`config file does not exist: ${file}`);
  }
  const candidates = [file, "image-sourcery.config.json"].filter(Boolean) as string[];
  for (const p of candidates) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as Config;
  }
  return DEFAULT_CONFIG;
}
