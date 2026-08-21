# Image Source-cery 🪄

**Ranked image sourcing, with a judge.**

Most image tools hand you *an* image. Image Source-cery hands you a *correct* one — it
walks a **ranked list of providers**, and a pluggable **judge** decides whether each
candidate actually depicts what you asked for. The first one that passes wins; if it
doesn't, the pipeline falls through to the next provider. Searching a source and
generating an image are the **same kind of thing** — both are just providers.

```
your ranked pipeline:   wikimedia → iNaturalist → diagram → generate → unsplash
                              │           │                    │
                          judge?       judge?               judge?      ← first PASS wins, stop
```

The judge is the magic: it's what caught "beets" returning a *strawberry plant* and
"Geronimo" returning the *wrong chief* — the failures every blind image search ships.

## Why

- **Unified providers** — search sources, generators, and diagram-makers all implement
  one tiny interface. Generation is just a provider that draws instead of finds.
- **You rank them** — per use case, set the order. Prefer free/verified sources first,
  fall back to paid search or generation only when needed.
- **A judge gates progression** — an LLM vision judge (default), a human, or none.
- **Bring your own credentials** — the tool ships **zero keys**. Config references your
  credentials by env-var *name*; secrets stay in your environment.
- **License-aware** — every candidate carries its license + attribution for provenance.
- **Fork-friendly** — add a source by writing one `Provider`. That's the whole surface.

## Install

```bash
npm install        # dev deps only (no runtime deps)
npm run build      # → dist/ ; then `npm link` to get the `imgsrcy` command
# or run straight from source:
npx tsx src/cli.ts find "saguaro cactus" --judge none --out ./saguaro.jpg
```

## Quick start

```bash
# keyless, no judge — fastest source wins
imgsrcy find "Sonoran Desert saguaro" --providers wikimedia,inaturalist --judge none --out out.jpg

# verified species, with an LLM judge and a negative constraint
imgsrcy find "Yarrow's spiny lizard" \
  --providers inaturalist,wikimedia,generate \
  --judge openai --min 0.75 \
  --must-not "desert spiny lizard" --out lizard.png

# see what you're configured for (no secrets printed)
imgsrcy doctor

# machine-readable engine compatibility handshake
imgsrcy capabilities
```

The handshake lets wrappers require absolute judging, parallel-doctor support, complete failure and
confusable attempts, and exact judged-to-saved byte binding before exposing provider credentials.

## Demo UI

A zero-dependency web demo lets you watch the providers race for a term — see what
each one returns side by side, reorder/toggle them, then run the judged pipeline and
inspect the winner + decision trace.

```bash
npm run serve          # → http://localhost:5190  (or: npm run build && npm start)
```

- **Search term** → **Run gallery** sources from every enabled provider *in order* and
  shows their candidates with license + attribution.
- **Drag** providers to reorder and toggle them on/off; unconfigured ones (missing key)
  are greyed out — your **own** credentials decide what's available.
- **Credentials panel** — paste a key for any provider or the judge (e.g. `OPENAI_API_KEY`,
  `UNSPLASH_ACCESS_KEY`) and it lights up instantly. Keys are held in the server's memory
  for that session only: never written to disk, never logged, never echoed back, and only
  ever sent to the provider you're calling. A key set once (like `OPENAI_API_KEY`) enables
  both the `generate` provider and the `openai` judge.
- Pick a **judge** + **mode**, then **Run pipeline** to run the real ranked loop and see
  which candidate won and why (the full decision trace).

It calls the same engine the CLI does, over a tiny HTTP API (`GET /api/providers`,
`POST /api/keys`, `POST /api/search`, `POST /api/pipeline`). No keys are bundled; nothing
leaves your machine.

## Configuration

Copy `image-sourcery.config.example.json` → `image-sourcery.config.json` and set your
ranked `pipeline` + `judge`. Credentials are referenced by env-var **name** only:

```jsonc
{
  "judge":   { "provider": "openai", "model": "gpt-4o-mini", "minScore": 0.7, "apiKeyEnv": "OPENAI_API_KEY" },
  "pipeline": [
    { "provider": "wikimedia" },
    { "provider": "inaturalist", "license": ["cc0", "cc-by"] },
    { "provider": "loc" },
    { "provider": "unsplash", "apiKeyEnv": "UNSPLASH_ACCESS_KEY" },
    { "provider": "pexels", "apiKeyEnv": "PEXELS_API_KEY" },
    { "provider": "generate", "model": "gpt-image-1", "apiKeyEnv": "OPENAI_API_KEY" }
  ]
}
```

Put keys in your shell env or a local `.env` (gitignored). Nothing is bundled.

## Built-in providers

| Provider | Key needed | Best for |
|---|---|---|
| `wikimedia` | none | niche subjects, species, science, historical |
| `inaturalist` | none | **community-verified species photos** (license-filterable) |
| `loc` | none | US historical people, places, events (public domain) |
| `openverse` | none | 800M+ CC-licensed images across many sources |
| `nasa` | none | space & earth science (public domain) |
| `met` | none | public-domain art & artifacts (The Met) |
| `smithsonian` | `SMITHSONIAN_API_KEY` | art, history, natural science (free key) |
| `unsplash` | `UNSPLASH_ACCESS_KEY` | modern stock photography, mood |
| `pexels` | `PEXELS_API_KEY` | modern stock photography & video stills |
| `generate` | `OPENAI_API_KEY` | anything nothing else has (gpt-image-1) |

Judges: `openai` (vision), `human` (interactive), `none` (accept first).

### Profiles — saved paths

A **profile** is a named sourcing strategy: which sources, in what order, scored how,
and who decides. Profiles are plain data, so you can list them, copy one into your
config, edit it, and keep the name.

```bash
imgsrcy profiles                                   # list built-ins + your own
imgsrcy find "Sonja Henie" --profile archive-first
```

| profile | for | shape |
|---|---|---|
| `archive-first` | named people, artifacts, documents | archives → name check → judge |
| `verified` | the same, with no model calls at all | archives → name check |
| `agent` | an agent is calling this | gather → name check → **defer to caller** |
| `stock` | generic scenes, materials, activities | stock → judge |
| `compare-all` | maximum recall | everything → one comparative judgement |

A pipeline is a chain of typed stages over a candidate set — `gather` adds, `score`
and `filter` transform, `select` may end the run. Several gather/select pairs make a
cascade: try the precise source, fall through only if nothing was chosen.

```jsonc
{
  "judge": { "provider": "none" },
  "profiles": {
    "my-pack": {
      "description": "Archives, name-checked, no LLM.",
      "stages": [
        { "gather": [{ "provider": "wikipedia" }, { "provider": "loc" }] },
        { "score": "title-adjacency" },   // deterministic identity check
        { "filter": "passing" },
        { "select": "best" }
      ]
    }
  }
}
```

Scorers: `title-adjacency` (deterministic, metadata-only), `judge` (vision), `none`.
Filters: `min-score`, `passing`, `has-title`, `archive-only`, `no-synthetic`.
Selects: `first`, `best`, `compare`, `defer`.

A profile defined in your config overrides a built-in of the same name, so a preset
can be tuned without forking. Register your own rules with `registerScorer` /
`registerFilter` — the library owns the executor and the generic predicates; rules
about *your* domain stay yours.

**`select: "defer"`** is the agent-in-the-loop path. Nothing is chosen; the scored
pool comes back with each candidate's name-check verdict attached, so an agent that
already holds the surrounding context can decide with the evidence in hand.

`title-adjacency` needs only metadata, so bytes are fetched lazily — candidates are
downloaded once something actually has to look at the picture, not before.

### Tuning

| variable | default | what it does |
|---|---|---|
| `IMGSRCY_RETRY_BUDGET_MS` | `20000` | How long a 429/503 is waited out before giving up. Raise it for unattended batch runs; the modest default keeps an interactive gather from stalling on one throttled source. |
| `IMGSRCY_HOST_GAP_MS` | `120` | Minimum gap between requests to the **same host**. Different hosts stay parallel. `0` disables. |

Politeness is per-host rather than per-provider on purpose: `wikipedia`, `wikidata` and
`wikimedia` are three providers over one organisation's infrastructure, and a single
gather can otherwise fire five downloads at one CDN at once. That burst is self-inflicted,
and the 429 it earns reads downstream as *"this subject has no photograph."*

### Modes

- **first-pass** (default) — sequential cascade: stop at the first candidate that
  passes. Cheapest.
- **best** (`--best` or `"mode": "best"`) — judge *every* candidate from every
  provider and keep the highest scorer. More thorough (and more API calls); fixes
  "the first result was bad."
- **pool** (`--parallel` or `"mode": "pool"`) — **fan out**: gather the whole
  pipeline *at once, in parallel*, into one candidate pool, then judge them
  **comparatively** ("which of these is best?") in a single look. Maximum recall +
  relative evaluation. This is the parallel alternative to the sequential cascade.

### Parallel stages

A pipeline stage can be a `{ parallel: [...] }` group — those providers are
gathered concurrently and judged comparatively, while the rest of the pipeline
stays a sequential cascade. Fan out only where you need to:

```jsonc
"pipeline": [
  { "provider": "wikimedia" },                 // try the precise source first
  { "parallel": [                              // …then fan out and pick the best
      { "provider": "openverse" },
      { "provider": "unsplash", "apiKeyEnv": "UNSPLASH_ACCESS_KEY" },
      { "provider": "pexels", "apiKeyEnv": "PEXELS_API_KEY" }
  ]},
  { "provider": "generate", "model": "gpt-image-1", "apiKeyEnv": "OPENAI_API_KEY" }
]
```

### Comparative judging

Parallel/pool stages use the judge's optional **`select`** — one relative look at
the whole pool instead of N independent yes/no calls:
- `openai` — a single vision call sees every candidate and returns the best index.
- `human` — saves the pool and asks for the best index (interactive), or for an
  **agent-in-the-loop**, use `imgsrcy gather`.

### `gather` — fan out for external judging

```bash
imgsrcy gather "Golf Mk2 GTI, factory stock" --providers wikimedia,openverse,pexels --out ./pool
```

Fans out all providers in parallel, downloads **every** candidate to a dir + a
`pool.json` manifest (provider, license, attribution, source), and exits. A human
or an agent (Claude Code, Cursor) then views the pool and picks the best — the
relative evaluation step, done outside the tool. The long-term path runs the same
comparison as an automated `openai` `select` call.

Every `--out` also writes a **provenance sidecar** (`<out>.json`): the source, license,
attribution, query, judge score + reason, and the full decision trace.

## Add a provider (the whole extension surface)

```ts
import type { Provider } from "image-sourcery";

export const flickr: Provider = {
  name: "flickr",
  kind: "search",
  configured: (ctx) => ctx.env[ctx.options.apiKeyEnv ?? "FLICKR_API_KEY"] ? true : "set FLICKR_API_KEY",
  async provide(req, ctx) {
    // ...return Candidate[] with { url, license, attribution, sourceUrl }
  },
};
```

Register it, drop it into your ranked `pipeline`, done.

## Roadmap

- ✅ Providers: Wikimedia, iNaturalist, LoC, Openverse, NASA, The Met, Smithsonian, Unsplash, Pexels, generate
- ✅ Multi-candidate `--best` mode; provenance sidecar manifests
- ✅ Demo web UI (`npm run serve`) — gallery + judged pipeline over a tiny HTTP API
- More providers: Europeana, Flickr Commons, GBIF, Pixabay
- More judges/generators: Anthropic & Gemini vision; Imagen, Flux, local Stable Diffusion
- **MCP server** so any agent (Claude Code, Cursor) can call it as tools
- Cost ledger + budgets, response/image caching
- Diagram lane: author SVGs as code (with no-answer-giveaway rules)

## License

MIT
