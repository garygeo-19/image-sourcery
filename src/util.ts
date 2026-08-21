import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";

const UA = "image-sourcery/0.2 (+https://github.com/garygeo-19/image-sourcery)";

/**
 * How long to keep waiting out a 429 before giving up, in ms.
 *
 * Rule 11 of CHOOSING-PACK-IMAGES: a throttle recorded as a failure is
 * indistinguishable from a subject that genuinely has no photograph, and that
 * mistake silently removed a dozen well-documented athletes from a pack. Wait,
 * then resume.
 *
 * The default is deliberately modest. "Several minutes if it persists" is right
 * for an unattended BATCH run and wrong for an interactive one — and because a
 * gather stage fans out across providers, a long budget is paid per provider,
 * so one throttled archive can stall a whole stage. Batch callers should raise
 * it: `IMGSRCY_RETRY_BUDGET_MS=300000`.
 */
const RETRY_BUDGET_MS = Number(process.env.IMGSRCY_RETRY_BUDGET_MS ?? 20_000);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(() => r(), ms));

/**
 * Minimum gap between requests to the SAME host, in ms.
 *
 * Politeness is a per-host property, not a per-provider one: `wikipedia`,
 * `wikidata` and `wikimedia` are three providers over one organisation's
 * infrastructure, and a single gather can otherwise fire five downloads at
 * upload.wikimedia.org simultaneously. That burst is self-inflicted — it is what
 * earned the 429s that then read downstream as "this subject has no photograph".
 *
 * Different hosts stay fully parallel, so the cost to a run that spans many
 * sources is close to nothing. Set IMGSRCY_HOST_GAP_MS=0 to disable.
 */
const HOST_GAP_MS = Number(process.env.IMGSRCY_HOST_GAP_MS ?? 120);

/** Per-host tail of scheduled request times. */
const hostClear = new Map<string, Promise<void>>();

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** Queue behind any in-flight request to the same host, then wait out the gap. */
function paced<T>(url: string, work: () => Promise<T>): Promise<T> {
  if (!HOST_GAP_MS) return work();
  const host = hostOf(url);
  const prior = hostClear.get(host) ?? Promise.resolve();
  const turn = prior.then(() => sleep(HOST_GAP_MS));
  hostClear.set(host, turn.catch(() => {}));
  return turn.then(work);
}

/**
 * Fetch that treats 429 (and 503) as a PAUSE, not a failure. Honours Retry-After
 * when the server sends it, otherwise backs off exponentially, until the budget
 * is spent. Every other status is returned to the caller untouched.
 */
async function politeFetch(url: string, headers: Record<string, string>): Promise<Response> {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const res = await paced(url, () => fetch(url, { headers }));
    if (res.status !== 429 && res.status !== 503) return res;

    const header = Number(res.headers.get("retry-after"));
    const delay = Number.isFinite(header) && header > 0
      ? Math.min(header * 1000, RETRY_BUDGET_MS - waited)
      : Math.min(500 * 2 ** attempt, 15_000);
    if (waited + delay > RETRY_BUDGET_MS) return res; // budget spent — let the caller see the 429
    await sleep(delay);
    waited += delay;
  }
}

/**
 * Load credentials WITHOUT bundling any. Reads process.env first, then a local
 * `.env` in the working directory (gitignored), then any extra files passed.
 * Config references creds by env-var NAME — secrets never live in this repo.
 */
export function loadEnv(extraFiles: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const files = [path.resolve(process.cwd(), ".env"), ...extraFiles];
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

export async function getJSON(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await politeFetch(url, { "User-Agent": UA, ...headers });
  if (res.status === 429) throw new Error("rate limited (429) after backoff");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function download(url: string): Promise<{ bytes: Buffer; mime: string }> {
  const res = await politeFetch(url, { "User-Agent": UA });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const mime = res.headers.get("content-type") || "image/jpeg";
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!/^image\//.test(mime) && !bytes.slice(0, 3).toString("hex").match(/^(ffd8ff|89504e|474946)/)) {
    throw new Error(`not an image (${mime})`);
  }
  return { bytes, mime };
}

/** Resolve a candidate to base64 data-URL form for vision models. */
export async function toDataUrl(c: { url?: string; bytes?: Buffer; mime?: string }): Promise<string> {
  if (c.bytes) return `data:${c.mime ?? "image/png"};base64,${c.bytes.toString("base64")}`;
  const d = await download(c.url!);
  return `data:${d.mime};base64,${d.bytes.toString("base64")}`;
}
