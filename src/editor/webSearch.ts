/**
 * Web search for pictures with facts attached: album covers, film posters,
 * book covers and Wikipedia pages. Results are dragged from the Web search
 * panel onto the map — into a chart box, a gallery, a topic or empty canvas.
 *
 * Only keyless public APIs that answer a browser directly (CORS), so the web
 * build needs no server of its own: iTunes Search (albums), Open Library
 * (books) and the Wikipedia REST API (pages, and films via their infobox).
 * Deezer refuses cross-origin calls and MusicBrainz rate-limits hard, which
 * is why neither is here. The
 * desktop build fetches through `resolveFetcher` (tauri-plugin-http), the
 * same door dropped image URLs already use.
 */
import { resolveFetcher, type FetchFn } from "./externalImage";

export type WebSource = "albums" | "films" | "books" | "wikipedia";
export const WEB_SOURCES: { id: WebSource; label: string }[] = [
  { id: "albums", label: "Albums" },
  { id: "films", label: "Films" },
  { id: "books", label: "Books" },
  { id: "wikipedia", label: "Wikipedia" },
];

export type WebLang = "it" | "en";

/** One search result, as dragged onto the map. Plain JSON: it travels in a
 *  DataTransfer payload (WEB_ITEM_DRAG_TYPE). */
export interface WebItem {
  source: WebSource;
  /** What the result IS, as listed in the panel. */
  title: string;
  /** What lands on the map — the box caption, the topic title — when it
   *  should say more than `title`: an album is "Artist - Album". */
  caption?: string;
  /** Second line in the results list (artist, author, description). */
  subtitle?: string;
  /** Small picture for the results list. */
  thumbUrl?: string;
  /** The picture imported on drop. Absent = a result with no picture. */
  imageUrl?: string;
  /** The facts: a box's note, a topic's notes. */
  details?: string;
  /** Page the facts came from. */
  url?: string;
  /** Wikipedia only: the page to fetch the summary of on drop. */
  wiki?: { lang: WebLang; key: string };
  /** Last.fm only: the album to fetch tags, tracks and summary of on drop. */
  lastfm?: { artist: string; album: string };
}

/** What a result is called on the map. */
export const webCaption = (item: WebItem): string => item.caption ?? item.title;

/**
 * The user's own Last.fm API key (free at last.fm/api/account/create).
 * Last.fm answers browsers directly but refuses every call without a key,
 * and a key cannot ship in a public web app, so each user brings theirs. It
 * stays in this browser's storage. Without one, albums come from iTunes.
 */
const LASTFM_KEY = "rnode.lastfmKey";
export function getLastfmKey(): string {
  try { return localStorage.getItem(LASTFM_KEY)?.trim() ?? ""; } catch { return ""; }
}
export function setLastfmKey(key: string): void {
  try {
    if (key.trim()) localStorage.setItem(LASTFM_KEY, key.trim());
    else localStorage.removeItem(LASTFM_KEY);
  } catch { /* private mode: not remembered */ }
}

/** Last.fm's grey star, served for albums it has no cover for. */
const LASTFM_NO_COVER = "2a96cbd8b46e442fc41c2b86b821562f";
/** Last.fm serves any square size from the same path. */
const lastfmArt = (url: string | undefined, px: number): string | undefined =>
  url && !url.includes(LASTFM_NO_COVER) ? url.replace(/\/i\/u\/[^/]+\//, `/i/u/${px}x${px}/`) : undefined;

/** One Last.fm API call; its errors come back as JSON with a message. */
async function lastfmCall(params: Record<string, string>, key: string, fetcher: FetchFn): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ ...params, api_key: key, format: "json" });
  const res = await fetcher(`https://ws.audioscrobbler.com/2.0/?${qs}`);
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || j.error) {
    throw new Error(j.error === 10 || j.error === 26 ? "Last.fm refused the API key — check it in the panel" : `Last.fm: ${String(j.message ?? `HTTP ${res.status}`)}`);
  }
  return j;
}

interface LastfmAlbum {
  name?: string;
  artist?: string;
  url?: string;
  image?: { "#text"?: string; size?: string }[];
}

const largestImage = (images?: { "#text"?: string }[]): string | undefined => {
  for (let i = (images?.length ?? 0) - 1; i >= 0; i--) if (images![i]["#text"]) return images![i]["#text"];
  return undefined;
};

/** DataTransfer type of a dragged WebItem (JSON). */
export const WEB_ITEM_DRAG_TYPE = "application/x-rnode-web-item";

/** Longest `details` kept — a note is a topic, not an article. */
export const WEB_DETAILS_MAX = 600;

/** Cut `text` to at most `max` characters, at a sentence end when there is
 *  one in the second half, else at a word, with an ellipsis. */
export function clipDetails(text: string, max = WEB_DETAILS_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (stop > max / 2) return head.slice(0, stop + 1);
  const space = head.lastIndexOf(" ");
  return `${head.slice(0, space > 0 ? space : max).trimEnd()}…`;
}

const year = (date?: string): string | undefined => (date && /^\d{4}/.test(date) ? date.slice(0, 4) : undefined);
const joinLine = (parts: (string | number | undefined)[]): string => parts.filter((p) => p !== undefined && p !== "").join(" · ");
/** iTunes serves any square size from the same path. */
const itunesArt = (url: string | undefined, px: number): string | undefined => url?.replace(/\/\d+x\d+bb\./, `/${px}x${px}bb.`);
/** Wikipedia thumbnails are protocol-relative in search results. */
const absolute = (url: string | undefined): string | undefined => (url?.startsWith("//") ? `https:${url}` : url);

async function getJson(url: string, fetcher: FetchFn): Promise<unknown> {
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
  return res.json();
}

interface ItunesHit {
  collectionName?: string;
  trackName?: string;
  artistName?: string;
  artworkUrl100?: string;
  releaseDate?: string;
  primaryGenreName?: string;
  trackCount?: number;
  longDescription?: string;
  collectionViewUrl?: string;
  trackViewUrl?: string;
}

interface OpenLibraryDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  subject?: string[];
}

interface WikiPage {
  key: string;
  title: string;
  description?: string | null;
  thumbnail?: { url?: string } | null;
}

/** Wikipedia full-text search (the REST endpoint takes CirrusSearch
 *  keywords such as `hastemplate:`). */
async function wikiSearch(source: WebSource, q: string, lang: WebLang, fetcher: FetchFn): Promise<WebItem[]> {
  const j = (await getJson(`https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=24`, fetcher)) as { pages?: WikiPage[] };
  return (j.pages ?? []).map((p) => ({
    source,
    title: p.title,
    subtitle: p.description ?? undefined,
    thumbUrl: absolute(p.thumbnail?.url ?? undefined),
    // The real picture and the text come from the page summary on drop
    // (resolveWebItem): a search answers with a 60px thumbnail only.
    imageUrl: absolute(p.thumbnail?.url ?? undefined),
    details: p.description ?? undefined,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.key)}`,
    wiki: { lang, key: p.key },
  }));
}

/** Search one source. Throws on a network or HTTP failure; an empty list
 *  means the source answered with nothing. */
export async function searchWeb(source: WebSource, query: string, lang: WebLang = "it", fetcher: FetchFn = resolveFetcher(), lastfmKey = getLastfmKey()): Promise<WebItem[]> {
  const q = query.trim();
  if (q === "") return [];
  const enc = encodeURIComponent(q);
  const country = lang === "it" ? "IT" : "US";
  switch (source) {
    case "albums": {
      if (lastfmKey) {
        const j = await lastfmCall({ method: "album.search", album: q, limit: "24" }, lastfmKey, fetcher);
        const found = ((j.results as { albummatches?: { album?: LastfmAlbum[] | LastfmAlbum } } | undefined)?.albummatches?.album) ?? [];
        return (Array.isArray(found) ? found : [found]).filter((a) => a.name && a.artist).map((a) => {
          const art = largestImage(a.image);
          return {
            source,
            title: a.name!,
            caption: `${a.artist} - ${a.name}`,
            subtitle: a.artist,
            thumbUrl: lastfmArt(art, 174),
            imageUrl: lastfmArt(art, 600),
            details: a.artist,
            url: a.url,
            lastfm: { artist: a.artist!, album: a.name! },
          };
        });
      }
      const j = (await getJson(`https://itunes.apple.com/search?term=${enc}&entity=album&limit=24&country=${country}`, fetcher)) as { results?: ItunesHit[] };
      return (j.results ?? []).filter((r) => r.collectionName).map((r) => ({
        source,
        title: r.collectionName!,
        caption: r.artistName ? `${r.artistName} - ${r.collectionName}` : undefined,
        subtitle: r.artistName,
        thumbUrl: itunesArt(r.artworkUrl100, 200),
        imageUrl: itunesArt(r.artworkUrl100, 600),
        details: [r.artistName, joinLine([year(r.releaseDate), r.primaryGenreName, r.trackCount ? `${r.trackCount} tracks` : undefined])].filter(Boolean).join("\n"),
        url: r.collectionViewUrl,
      }));
    }
    case "films": {
      // iTunes stopped answering movie searches (0 results even for "The
      // Matrix"), and every film database worth having wants an API key.
      // Wikipedia pages carrying the film infobox are a keyless stand-in,
      // with the poster where the wiki hosts one (Italian usually does).
      const infobox = lang === "it" ? "Film" : "Infobox film";
      return wikiSearch(source, `${q} hastemplate:"${infobox}"`, lang, fetcher);
    }
    case "books": {
      const j = (await getJson(`https://openlibrary.org/search.json?q=${enc}&limit=24&fields=key,title,author_name,first_publish_year,cover_i,subject`, fetcher)) as { docs?: OpenLibraryDoc[] };
      return (j.docs ?? []).filter((d) => d.title).map((d) => ({
        source,
        title: d.title!,
        subtitle: joinLine([d.author_name?.slice(0, 2).join(", "), d.first_publish_year]),
        thumbUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : undefined,
        imageUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : undefined,
        details: [d.author_name?.join(", "), joinLine([d.first_publish_year, d.subject?.slice(0, 3).join(", ")])].filter(Boolean).join("\n"),
        url: d.key ? `https://openlibrary.org${d.key}` : undefined,
      }));
    }
    case "wikipedia":
      return wikiSearch(source, q, lang, fetcher);
  }
}

/**
 * Fill in what a search result leaves out: for Wikipedia, the page summary
 * (the text) and a picture large enough to use. Other sources are complete.
 * A failed summary keeps the item as it was rather than losing the drop.
 */
export async function resolveWebItem(item: WebItem, fetcher: FetchFn = resolveFetcher(), lastfmKey = getLastfmKey()): Promise<WebItem> {
  if (item.lastfm) return lastfmDetails(item, fetcher, lastfmKey);
  if (!item.wiki) return item;
  try {
    const s = (await getJson(`https://${item.wiki.lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(item.wiki.key)}`, fetcher)) as {
      extract?: string;
      description?: string;
      thumbnail?: { source?: string; width?: number };
      originalimage?: { source?: string; width?: number };
    };
    // The original can be a 40 MB scan; past 1600px a resized thumbnail
    // (same path, another width) is plenty for a map. Wikimedia only renders
    // its standard widths — 1200px answers HTTP 400, 1280px works.
    const orig = s.originalimage;
    const thumb = s.thumbnail?.source;
    const imageUrl = orig?.source && (orig.width ?? 0) <= 1600 ? orig.source : thumb ? thumb.replace(/\/\d+px-/, "/1280px-") : item.imageUrl;
    const text = s.extract ? clipDetails(s.extract) : s.description;
    return { ...item, imageUrl, details: text ?? item.details };
  } catch {
    return item;
  }
}

/** Last.fm's search carries no facts: tags, track count and the album's
 *  wiki summary come from album.getInfo, on drop. */
async function lastfmDetails(item: WebItem, fetcher: FetchFn, key: string): Promise<WebItem> {
  if (!item.lastfm || !key) return item;
  try {
    const j = await lastfmCall({ method: "album.getinfo", artist: item.lastfm.artist, album: item.lastfm.album, autocorrect: "1" }, key, fetcher);
    const a = j.album as {
      tags?: { tag?: { name?: string }[] | { name?: string } };
      tracks?: { track?: unknown[] | unknown };
      wiki?: { published?: string; summary?: string };
      image?: { "#text"?: string }[];
    } | undefined;
    if (!a) return item;
    const tags = a.tags?.tag ? (Array.isArray(a.tags.tag) ? a.tags.tag : [a.tags.tag]).map((t) => t.name).filter(Boolean).slice(0, 3).join(", ") : undefined;
    const tracks = a.tracks?.track ? (Array.isArray(a.tracks.track) ? a.tracks.track.length : 1) : undefined;
    // The summary ends in an HTML "Read more on Last.fm" link.
    const summary = a.wiki?.summary?.replace(/<a [^>]*>.*?<\/a>\.?/g, "").replace(/<[^>]+>/g, "").trim();
    const art = lastfmArt(largestImage(a.image), 600);
    return {
      ...item,
      imageUrl: item.imageUrl ?? art,
      details: [item.lastfm.artist, joinLine([tags, tracks ? `${tracks} tracks` : undefined]), summary ? clipDetails(summary, 400) : undefined].filter(Boolean).join("\n"),
    };
  } catch {
    return item;
  }
}
