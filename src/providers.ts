import type { Provider, Candidate } from "./types.js";
import { getJSON } from "./util.js";

// ── Wikimedia Commons (no key) ────────────────────────────────────────────────
export const wikimedia: Provider = {
  name: "wikimedia",
  corpus: "archive",
  kind: "search",
  configured: () => true,
  async provide(req) {
    const n = req.count ?? 5;
    const search = await getJSON(
      "https://commons.wikimedia.org/w/api.php?" +
        new URLSearchParams({
          action: "query", format: "json", list: "search",
          srsearch: req.query + " filetype:bitmap", srnamespace: "6",
          srlimit: String(n), origin: "*",
        }),
    );
    const out: Candidate[] = [];
    for (const r of (search.query?.search ?? []).slice(0, n)) {
      const info = await getJSON(
        "https://commons.wikimedia.org/w/api.php?" +
          new URLSearchParams({
            action: "query", format: "json", titles: r.title, prop: "imageinfo",
            iiprop: "url|mime|extmetadata", iiurlwidth: "1080", origin: "*",
          }),
      );
      const page: any = Object.values(info.query?.pages ?? {})[0];
      const ii = page?.imageinfo?.[0];
      if (!ii || !/^image\/(jpeg|png|webp|gif)$/.test(ii.mime ?? "")) continue;
      out.push({
        url: ii.thumburl || ii.url, mime: ii.mime, provider: "wikimedia", title: r.title,
        attribution: (ii.extmetadata?.Artist?.value ?? "").replace(/<[^>]+>/g, "").slice(0, 80) || "Wikimedia Commons",
        license: ii.extmetadata?.LicenseShortName?.value ?? "", sourceUrl: ii.descriptionurl,
      });
    }
    return out;
  },
};

// ── iNaturalist (no key) — research-grade, community-verified species photos ──
export const inaturalist: Provider = {
  name: "inaturalist",
  corpus: "archive",
  kind: "search",
  configured: () => true,
  async provide(req, ctx) {
    const allowed: string[] | undefined = ctx.options.license;
    const data = await getJSON(
      "https://api.inaturalist.org/v1/taxa?" +
        new URLSearchParams({ q: req.query, per_page: String(req.count ?? 5) }),
    );
    const out: Candidate[] = [];
    for (const t of data.results ?? []) {
      const p = t.default_photo;
      if (!p?.medium_url) continue;
      if (allowed && (!p.license_code || !allowed.includes(p.license_code))) continue;
      out.push({
        url: p.medium_url, provider: "inaturalist",
        title: t.preferred_common_name || t.name,
        attribution: p.attribution || "iNaturalist", license: p.license_code || "all-rights-reserved",
        sourceUrl: `https://www.inaturalist.org/taxa/${t.id}`,
        meta: { taxon: t.name, rank: t.rank },
      });
    }
    return out;
  },
};

// ── Library of Congress (no key) — US historical photos/prints/drawings ───────
export const loc: Provider = {
  name: "loc",
  corpus: "archive",
  kind: "search",
  configured: () => true,
  async provide(req) {
    const data = await getJSON(
      "https://www.loc.gov/photos/?" +
        new URLSearchParams({ q: req.query, fo: "json", c: "12" }),
    );
    const sizeOf = (u: string) => {
      const h = /#h=(\d+)/.exec(u); if (h) return +h[1];
      const px = /_(\d+)px\./.exec(u); if (px) return +px[1];
      return /v\.jpe?g/i.test(u) ? 9000 : 100;
    };
    const out: Candidate[] = [];
    for (const r of data.results ?? []) {
      if (!/photo|print|drawing/i.test((r.original_format ?? []).join(" "))) continue;
      const imgs: string[] = r.image_url ?? [];
      if (!imgs.length) continue;
      const best = imgs.reduce((a, b) => (sizeOf(b) > sizeOf(a) ? b : a)).split("#")[0];
      if (!/\.(jpe?g|png|gif)$/i.test(best)) continue;
      out.push({
        url: best, provider: "loc", title: r.title,
        attribution: `Library of Congress · ${(r.title ?? "").slice(0, 60)}`,
        license: "No known restrictions (verify at source)", sourceUrl: r.id,
      });
      if (out.length >= (req.count ?? 5)) break;
    }
    return out;
  },
};

// ── Unsplash (key: UNSPLASH_ACCESS_KEY) ───────────────────────────────────────
export const unsplash: Provider = {
  name: "unsplash",
  corpus: "stock",
  kind: "search",
  configured: (ctx) => {
    const k = ctx.options.apiKeyEnv ?? "UNSPLASH_ACCESS_KEY";
    return ctx.env[k] ? true : `set ${k}`;
  },
  async provide(req, ctx) {
    const key = ctx.env[ctx.options.apiKeyEnv ?? "UNSPLASH_ACCESS_KEY"]!;
    const data = await getJSON(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(req.query)}` +
        `&per_page=${req.count ?? 5}&orientation=landscape&client_id=${key}`,
    );
    return (data.results ?? []).map((r: any) => ({
      url: r.urls.regular, provider: "unsplash",
      attribution: `Unsplash · ${r.user?.name ?? ""}`, license: "Unsplash License",
      sourceUrl: r.links?.html,
    }));
  },
};

// ── Pexels (key: PEXELS_API_KEY) ──────────────────────────────────────────────
export const pexels: Provider = {
  name: "pexels",
  corpus: "stock",
  kind: "search",
  configured: (ctx) => {
    const k = ctx.options.apiKeyEnv ?? "PEXELS_API_KEY";
    return ctx.env[k] ? true : `set ${k}`;
  },
  async provide(req, ctx) {
    const key = ctx.env[ctx.options.apiKeyEnv ?? "PEXELS_API_KEY"]!;
    const data = await getJSON(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(req.query)}` +
        `&per_page=${req.count ?? 5}&orientation=landscape`,
      { Authorization: key },
    );
    return (data.photos ?? []).map((p: any) => ({
      url: p.src?.large ?? p.src?.original, provider: "pexels", title: p.alt || undefined,
      attribution: `Pexels · ${p.photographer ?? ""}`.trim(), license: "Pexels License",
      sourceUrl: p.url,
    }));
  },
};

// ── Generate via OpenAI gpt-image-1 (key: OPENAI_API_KEY) ─────────────────────
// Generation is just another provider. It always "succeeds" at returning bytes;
// the judge still decides whether what it drew is correct.
export const generate: Provider = {
  name: "generate",
  corpus: "synthetic",
  kind: "generate",
  configured: (ctx) => {
    const k = ctx.options.apiKeyEnv ?? "OPENAI_API_KEY";
    return ctx.env[k] ? true : `set ${k}`;
  },
  async provide(req, ctx) {
    // Never fabricate the likeness of a real person. This is a hard refusal, not
    // a scoring penalty: no judge downstream can catch a synthetic portrait the
    // way it can catch a wrong photograph. Generate the equipment, the venue, the
    // artifact or the scene instead — or accept that the card has no image.
    if (req.subjectType === "person") {
      throw new Error(
        "refusing to generate an image of a person (subjectType: \"person\") — " +
        "use an archive provider, or accept no image",
      );
    }
    const key = ctx.env[ctx.options.apiKeyEnv ?? "OPENAI_API_KEY"]!;
    const prompt = ctx.options.promptPrefix
      ? `${ctx.options.promptPrefix} ${req.query}`
      : `Photograph of ${req.query}, photorealistic, natural lighting`;
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ctx.options.model ?? "gpt-image-1",
        prompt, size: ctx.options.size ?? "1024x1024",
        quality: ctx.options.quality ?? "medium", n: 1,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as any;
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error("no image returned");
    return [{
      bytes: Buffer.from(b64, "base64"), mime: "image/png", provider: "generate",
      attribution: `Generated (${ctx.options.model ?? "gpt-image-1"})`, license: "Generated",
      meta: { prompt },
    }];
  },
};

// ── Openverse (no key) — 800M+ CC-licensed images across many sources ─────────
export const openverse: Provider = {
  name: "openverse",
  corpus: "aggregate",
  kind: "search",
  configured: () => true,
  async provide(req) {
    const data = await getJSON(
      "https://api.openverse.org/v1/images/?" +
        new URLSearchParams({ q: req.query, page_size: String(req.count ?? 5) }),
    );
    return (data.results ?? []).map((r: any) => ({
      url: r.url, provider: "openverse", title: r.title,
      attribution: r.creator ? `${r.creator} (Openverse)` : "Openverse",
      license: `${r.license ?? ""} ${r.license_version ?? ""}`.trim(),
      sourceUrl: r.foreign_landing_url,
    }));
  },
};

// ── NASA Images (no key) — space & earth science, public domain ───────────────
export const nasa: Provider = {
  name: "nasa",
  corpus: "archive",
  kind: "search",
  configured: () => true,
  async provide(req) {
    const data = await getJSON(
      "https://images-api.nasa.gov/search?" +
        new URLSearchParams({ q: req.query, media_type: "image" }),
    );
    const items = data.collection?.items ?? [];
    return items.slice(0, req.count ?? 5).map((x: any) => {
      const meta = x.data?.[0] ?? {};
      const href = (x.links?.[0]?.href ?? "").replace(/~thumb\.jpg$/i, "~medium.jpg");
      return {
        url: href, provider: "nasa", title: meta.title,
        attribution: meta.center ? `NASA / ${meta.center}` : "NASA",
        license: "Public Domain (NASA — verify usage)",
        sourceUrl: meta.nasa_id ? `https://images.nasa.gov/details/${meta.nasa_id}` : undefined,
      };
    }).filter((c: Candidate) => !!c.url);
  },
};

// ── The Met (no key) — public-domain art & artifacts (two-step search) ────────
export const met: Provider = {
  name: "met",
  corpus: "archive",
  kind: "search",
  configured: () => true,
  async provide(req) {
    const s = await getJSON(
      "https://collectionapi.metmuseum.org/public/collection/v1/search?" +
        new URLSearchParams({ q: req.query, hasImages: "true" }),
    );
    const ids: number[] = (s.objectIDs ?? []).slice(0, req.count ?? 5);
    const out: Candidate[] = [];
    for (const id of ids) {
      try {
        const o = await getJSON(
          `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`,
        );
        const img = o.primaryImage || o.primaryImageSmall;
        if (!img) continue;
        out.push({
          url: img, provider: "met", title: o.title,
          attribution: o.artistDisplayName || "The Metropolitan Museum of Art",
          license: o.isPublicDomain ? "Public Domain (CC0)" : "The Met (verify)",
          sourceUrl: o.objectURL,
        });
      } catch { /* skip unfetchable object */ }
    }
    return out;
  },
};

// ── Smithsonian Open Access (key: SMITHSONIAN_API_KEY, free at api.data.gov) ───
export const smithsonian: Provider = {
  name: "smithsonian",
  corpus: "archive",
  kind: "search",
  configured: (ctx) => {
    const k = ctx.options.apiKeyEnv ?? "SMITHSONIAN_API_KEY";
    return ctx.env[k] ? true : `set ${k} (free key at api.data.gov)`;
  },
  async provide(req, ctx) {
    const key = ctx.env[ctx.options.apiKeyEnv ?? "SMITHSONIAN_API_KEY"]!;
    const data = await getJSON(
      "https://api.si.edu/openaccess/api/v1.0/search?" +
        new URLSearchParams({ q: req.query, rows: String(req.count ?? 5), api_key: key }),
    );
    const out: Candidate[] = [];
    for (const r of data.response?.rows ?? []) {
      const media = r.content?.descriptiveNonRepeating?.online_media?.media ?? [];
      const m = media.find((x: any) => x.type === "Images") || media[0];
      const img = m?.content || m?.thumbnail;
      if (!img) continue;
      out.push({
        url: img, provider: "smithsonian", title: r.title,
        attribution: "Smithsonian Open Access", license: "CC0 (verify)",
        sourceUrl: r.content?.descriptiveNonRepeating?.record_link,
      });
    }
    return out;
  },
};

// ── Wikipedia (no key) — article LEAD IMAGE for a named subject ───────────────
// The highest-precision source for anything with an encyclopedia article. An
// article IS an identity assertion: the record key is the subject's own name,
// so the title passes the naming test by construction, and `description` gives a
// machine-readable entity type ("American track and field athlete (born 1961)")
// that lets a caller reject on KIND, not just on string overlap. Verified against
// the wrong-subject cases in CHOOSING-PACK-IMAGES: Carl Lewis, Sonja Henie,
// Oksana Baiul and Franz Klammer all return the correct person.
export const wikipedia: Provider = {
  name: "wikipedia",
  corpus: "archive",
  kind: "search",
  configured: () => true,
  async provide(req, ctx) {
    const lang = ctx.options.lang ?? "en";
    const data = await getJSON(
      `https://${lang}.wikipedia.org/w/api.php?` +
        new URLSearchParams({
          action: "query", format: "json", generator: "search",
          gsrsearch: req.query, gsrlimit: String(req.count ?? 5),
          prop: "pageimages|info|description", piprop: "original|name", inprop: "url",
        }),
    );
    // `query.pages` is an object keyed by pageid and its key order is NOT search
    // rank — only the per-page `index` carries that. Sorting is load-bearing, not
    // tidiness: without it "Carl Lewis" resolves to Donovan Bailey, which is the
    // exact wrong-athlete failure this provider exists to prevent.
    const pages: any[] = Object.values(data.query?.pages ?? {})
      .sort((a: any, b: any) => (a.index ?? 1e9) - (b.index ?? 1e9));
    const picked: { page: any; file: string }[] = [];
    for (const page of pages) {
      const src: string | undefined = page.original?.source;
      if (!src) continue;
      // A /wikipedia/<lang>/ path is a locally-hosted NON-FREE fair-use file;
      // only /wikipedia/commons/ is freely licensed.
      if (!src.includes("/wikipedia/commons/")) continue;
      // Pictograms, icons, flags and coats of arms are not photographs of a subject.
      if (/\.svg($|\?)/i.test(src)) continue;
      if (/pictogram|icon|logo|flag|coat[_ ]of[_ ]arms|\bmap\b/i.test(page.pageimage ?? "")) continue;
      picked.push({ page, file: `File:${page.pageimage}` });
    }
    if (!picked.length) return [];

    // One batched call for licence + attribution across every file we kept.
    let meta: Record<string, any> = {};
    try {
      const info = await getJSON(
        "https://commons.wikimedia.org/w/api.php?" +
          new URLSearchParams({
            action: "query", format: "json", titles: picked.map((p) => p.file).join("|"),
            prop: "imageinfo", iiprop: "url|mime|extmetadata", iiurlwidth: "1200",
          }),
      );
      for (const p of Object.values<any>(info.query?.pages ?? {})) meta[p.title] = p.imageinfo?.[0];
    } catch { /* licence lookup is best-effort; the image is still usable */ }

    return picked.map(({ page, file }) => {
      const ii = meta[file];
      return {
        url: ii?.thumburl || page.original.source.split("?")[0],
        mime: ii?.mime,
        provider: "wikipedia",
        // The ARTICLE title — i.e. the subject's name — not the filename.
        title: page.title,
        attribution: (ii?.extmetadata?.Artist?.value ?? "").replace(/<[^>]+>/g, "").slice(0, 80)
          || `Wikipedia — ${page.title}`,
        license: ii?.extmetadata?.LicenseShortName?.value ?? "See Wikimedia Commons",
        sourceUrl: page.fullurl,
        providerId: page.pageimage,
        meta: {
          description: page.description,      // entity type, for a kind check
          file: page.pageimage,
          identityVerifiedBy: "wikipedia-article",
        },
      } as Candidate;
    });
  },
};

// ── Wikidata (no key) — entity → P18 "image" claim ───────────────────────────
// Complements `wikipedia`: covers subjects whose article carries no lead image
// (e.g. "Strigil"), and surfaces AMBIGUITY instead of silently resolving it —
// the search results carry a label + description per candidate entity.
export const wikidata: Provider = {
  name: "wikidata",
  corpus: "archive",
  kind: "search",
  configured: () => true,
  async provide(req) {
    const found = await getJSON(
      "https://www.wikidata.org/w/api.php?" +
        new URLSearchParams({
          action: "wbsearchentities", format: "json", language: "en",
          type: "item", limit: String(Math.max(5, req.count ?? 5)), search: req.query,
        }),
    );
    const ids: string[] = (found.search ?? []).map((s: any) => s.id).slice(0, 8);
    if (!ids.length) return [];

    const ents = await getJSON(
      "https://www.wikidata.org/w/api.php?" +
        new URLSearchParams({
          action: "wbgetentities", format: "json", ids: ids.join("|"),
          props: "claims|labels|descriptions", languages: "en",
        }),
    );

    const out: Candidate[] = [];
    // Walk in relevance order but SKIP entities with no image: for "Geronimo" the
    // top hit is the given name (no P18) and the Apache leader is second. Taking
    // search[0] blindly returns nothing and reads as "no photograph exists".
    for (const id of ids) {
      const e = ents.entities?.[id];
      const file = e?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (!file) continue;
      const label = e.labels?.en?.value;
      const description = e.descriptions?.en?.value;
      out.push({
        url: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=1024`,
        provider: "wikidata",
        // The entity LABEL, not the filename — a Commons filename frequently
        // names the event rather than the subject.
        title: label ?? description ?? req.query,
        attribution: `Wikimedia Commons — ${file}`,
        license: "See Wikimedia Commons (per-file)",
        sourceUrl: `https://www.wikidata.org/wiki/${id}`,
        providerId: id,
        meta: { description, file, qid: id, identityVerifiedBy: "wikidata-P18" },
      });
      if (out.length >= (req.count ?? 5)) break;
    }
    return out;
  },
};

// ── Wellcome Collection (no key) — medicine, science, and portraiture ─────────
// Titles are exemplary for the naming test — "Marie Curie. Photograph.",
// "Joseph Lister, Baron Lister. Photograph." — and licence is filterable in the
// request itself. Strong for named figures in medicine and science and for
// pre-photographic portraits; returns nothing for modern sport, which is the
// honest answer rather than a plausible stranger.
export const wellcome: Provider = {
  name: "wellcome",
  corpus: "archive",
  kind: "search",
  configured: () => true,
  async provide(req, ctx) {
    const licenses = ctx.options.license ?? "pdm,cc-by,cc-0";
    const data = await getJSON(
      "https://api.wellcomecollection.org/catalogue/v2/images?" +
        new URLSearchParams({
          query: req.query,
          pageSize: String(req.count ?? 5),
          "locations.license": Array.isArray(licenses) ? licenses.join(",") : licenses,
        }),
    );
    const out: Candidate[] = [];
    for (const r of data.results ?? []) {
      const loc = r.locations?.[0];
      if (!loc?.url) continue;
      // The location is an IIIF info.json; derive a rendered JPEG from it.
      const base = String(loc.url).replace(/\/info\.json$/, "");
      out.push({
        url: `${base}/full/1000,/0/default.jpg`,
        provider: "wellcome",
        title: r.source?.title,
        attribution: `Wellcome Collection${loc.license?.label ? ` · ${loc.license.label}` : ""}`,
        license: loc.license?.id ?? "see Wellcome Collection",
        sourceUrl: r.source?.id ? `https://wellcomecollection.org/works/${r.source.id}` : undefined,
        providerId: r.id,
        meta: { identityVerifiedBy: "wellcome-catalogue" },
      });
    }
    return out;
  },
};

// ── Cleveland Museum of Art (no key) — CC0 artifacts and artworks ─────────────
// Direct CDN JPEGs, no IIIF assembly, CC0 flagged per record. Notable for
// FAILING CLEANLY: an out-of-scope subject returns zero results rather than a
// plausible near-match, which is what makes it safe in a first-pass cascade.
export const cleveland: Provider = {
  name: "cleveland",
  corpus: "archive",
  kind: "search",
  configured: () => true,
  async provide(req, ctx) {
    const params = new URLSearchParams({
      q: req.query, limit: String(req.count ?? 5), has_image: "1",
    });
    if (ctx.options.cc0 !== false) params.set("cc0", "1");
    const data = await getJSON(
      `https://openaccess-api.clevelandart.org/api/artworks/?${params}`,
    );
    const out: Candidate[] = [];
    for (const r of data.data ?? []) {
      const url = r.images?.web?.url ?? r.images?.print?.url;
      if (!url) continue;
      out.push({
        url, provider: "cleveland", title: r.title,
        attribution: r.creators?.[0]?.description
          ? `${r.creators[0].description} · Cleveland Museum of Art`
          : "Cleveland Museum of Art",
        license: r.share_license_status ?? "verify at source",
        sourceUrl: r.url,
        providerId: r.accession_number ? String(r.accession_number) : undefined,
        meta: { identityVerifiedBy: "cleveland-collection" },
      });
    }
    return out;
  },
};

export const REGISTRY: Record<string, Provider> = {
  wikipedia, wikidata, wikimedia, inaturalist, loc, wellcome, cleveland,
  unsplash, pexels, openverse, nasa, met, smithsonian, generate,
};

export function getProvider(name: string): Provider {
  const p = REGISTRY[name];
  if (!p) throw new Error(`unknown provider "${name}" (have: ${Object.keys(REGISTRY).join(", ")})`);
  return p;
}
