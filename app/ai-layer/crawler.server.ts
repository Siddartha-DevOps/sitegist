import * as cheerio from "cheerio";
import mammoth from "mammoth";
import { getFirecrawl } from "./firecrawl.server";
import { parsePdf as parsePdfUtil } from "~/lib/pdf.server";
import { YoutubeTranscript } from "youtube-transcript";
import { assertSafeOutboundUrl, readTextWithLimit, safeOutboundFetch } from "~/lib/outbound-url.server";

const CRAWLER_UA = "Mozilla/5.0 (compatible; SiteGistBot/1.0; +https://sitegist.ai)";

// Page-size guard: reject responses larger than this so a single huge page can't
// exhaust serverless memory (the old code loaded the entire body into cheerio with
// no ceiling). Extracted text is also capped before chunking.
const MAX_PAGE_BYTES = 8 * 1024 * 1024;       // 8 MB raw HTML
const MAX_CONTENT_CHARS = 500_000;            // ~125k tokens of extracted text
// Below this many non-whitespace chars we treat the fetch as "no readable text"
// — usually a JavaScript-rendered shell that needs a headless renderer (Firecrawl).
const MIN_READABLE_CHARS = 30;
// At or above this many readable chars, static scraping is considered sufficient and
// we skip the (slower, paid) headless fallback — preserves static for normal pages.
const GOOD_STATIC_CHARS = 500;
const FIRECRAWL_TIMEOUT_MS = 45_000;

/**
 * Headless render via Firecrawl (the serverless-friendly stand-in for a bundled
 * browser). Used as an automatic fallback for JS-rendered pages that static
 * scraping can't read. Returns null when Firecrawl isn't configured or fails.
 * Adds an explicit timeout and one retry on top of the SDK.
 */
async function scrapeWithFirecrawl(url: string): Promise<{ title: string; content: string; url: string } | null> {
  await assertSafeOutboundUrl(url);
  const firecrawl = getFirecrawl();
  if (!firecrawl) return null;

  const attempt = async () => {
    let response: any;
    if (typeof (firecrawl as any).scrape === "function") {
      response = await (firecrawl as any).scrape(url, { formats: ["markdown"] });
    } else if (typeof (firecrawl as any).scrapeUrl === "function") {
      response = await (firecrawl as any).scrapeUrl(url, { formats: ["markdown"] });
    }
    if (response && response.success) {
      const doc = response.data || response;
      return {
        title: doc.metadata?.title || doc.title || url,
        content: doc.markdown || doc.content || "",
        url: doc.metadata?.sourceURL || doc.url || url,
      };
    }
    return null;
  };

  for (let i = 0; i < 2; i++) {
    try {
      const result = await Promise.race([
        attempt(),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error("Firecrawl timeout")), FIRECRAWL_TIMEOUT_MS)),
      ]);
      if (result && result.content) return result;
    } catch (e) {
      console.warn(`[Crawler] Firecrawl attempt ${i + 1}/2 failed for ${url}:`, e);
    }
  }
  return null;
}

/** robots.txt is respected by default; set RESPECT_ROBOTS=0 to disable. */
function shouldRespectRobots(): boolean {
  return process.env.RESPECT_ROBOTS?.trim() !== "0";
}

type RobotsRules = { disallow: string[]; allow: string[] };
const robotsCache = new Map<string, RobotsRules>();

/** Minimal robots.txt parser: collects Allow/Disallow for our bot (falling back to *). */
function parseRobots(txt: string): RobotsRules {
  const groups: { agents: Set<string>; disallow: string[]; allow: string[] }[] = [];
  let current: { agents: Set<string>; disallow: string[]; allow: string[] } | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      // Consecutive user-agent lines share the next ruleset.
      if (!current || !lastWasAgent) {
        current = { agents: new Set(), disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.add(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "disallow" && current) {
      current.disallow.push(value);
      lastWasAgent = false;
    } else if (field === "allow" && current) {
      current.allow.push(value);
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const pick = (token: string) => groups.filter(g => g.agents.has(token));
  const applicable = pick("sitegistbot").length ? pick("sitegistbot") : pick("*");
  const disallow: string[] = [];
  const allow: string[] = [];
  for (const g of applicable) { disallow.push(...g.disallow); allow.push(...g.allow); }
  return { disallow, allow };
}

async function getRobots(origin: string): Promise<RobotsRules> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;
  let rules: RobotsRules = { disallow: [], allow: [] };
  try {
    const res = await safeOutboundFetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": CRAWLER_UA },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) rules = parseRobots(await readTextWithLimit(res, 512 * 1024));
  } catch {
    // No robots.txt, unreachable, or oversized → fail open (allow).
  }
  robotsCache.set(origin, rules);
  return rules;
}

/** Robots path matcher with `*` wildcard and `$` end-anchor support. */
function robotsPathMatches(path: string, rule: string): boolean {
  if (rule === "") return false;
  let anchored = false;
  let r = rule;
  if (r.endsWith("$")) { anchored = true; r = r.slice(0, -1); }
  const escaped = r.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  try {
    return new RegExp("^" + escaped + (anchored ? "$" : "")).test(path);
  } catch {
    return false;
  }
}

/** Returns false only when robots.txt explicitly disallows this URL for our bot. */
async function isAllowedByRobots(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    const { disallow, allow } = await getRobots(u.origin);
    const realDisallow = disallow.filter(r => r.length > 0);
    if (realDisallow.length === 0) return true; // empty/absent Disallow = allow all
    const path = u.pathname + u.search;
    const longestMatch = (rules: string[]) =>
      rules.reduce((m, r) => (robotsPathMatches(path, r) ? Math.max(m, r.length) : m), -1);
    const dLen = longestMatch(realDisallow);
    if (dLen === -1) return true;            // no Disallow rule matches
    const aLen = longestMatch(allow);        // more-specific Allow overrides Disallow
    return aLen >= dLen;
  } catch {
    return true; // malformed URL etc. → don't block
  }
}

export async function getYoutubeTranscript(url: string) {
  try {
    const videoIdMatch = url.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([^& \n]+)/);
    const videoId = videoIdMatch ? videoIdMatch[1] : url;
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    return transcript.map(t => t.text).join(" ");
  } catch (error) {
    console.error("YouTube transcript error:", error);
    return "";
  }
}

export type YouTubeUrlType = 'video' | 'playlist' | 'channel';
export type VideoInfo = { id: string; title: string };

export function detectYouTubeUrlType(url: string): YouTubeUrlType {
  if (url.includes('/playlist?list=') || (url.includes('list=') && !url.includes('watch'))) return 'playlist';
  if (url.includes('/@') || url.includes('/c/') || (url.includes('/channel/') && !url.includes('watch'))) return 'channel';
  return 'video';
}

export function extractPlaylistId(url: string): string | null {
  const match = url.match(/[?&]list=([^&]+)/);
  return match?.[1] ?? null;
}

export function extractChannelHandle(url: string): string | null {
  // Handles /@handle, /c/name, /channel/UCxxx
  const atMatch = url.match(/\/@([^/?]+)/);
  if (atMatch) return atMatch[1];
  const cMatch = url.match(/\/c\/([^/?]+)/);
  if (cMatch) return cMatch[1];
  const idMatch = url.match(/\/channel\/(UC[^/?]+)/);
  if (idMatch) return idMatch[1];
  return null;
}

export async function getVideoTitle(videoId: string): Promise<string> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return `YouTube Video (${videoId})`;
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${apiKey}`);
    if (res.ok) {
      const data = await res.json();
      const title = data?.items?.[0]?.snippet?.title;
      if (title) return title;
    }
  } catch (e) {
    console.warn("[YouTube crawler] Failed to fetch video title:", e);
  }
  return `YouTube Video (${videoId})`;
}

export async function getPlaylistVideos(
  playlistId: string,
  maxVideos = 20
): Promise<VideoInfo[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error("YOUTUBE_API_KEY is not set.");

  const videos: VideoInfo[] = [];
  let pageToken: string | undefined;

  const YT_API_BASE = "https://www.googleapis.com/youtube/v3";

  while (videos.length < maxVideos) {
    const params = new URLSearchParams({
      part: "snippet",
      playlistId,
      maxResults: String(Math.min(50, maxVideos - videos.length)),
      key: apiKey,
      ...(pageToken ? { pageToken } : {}),
    });

    const res = await fetch(`${YT_API_BASE}/playlistItems?${params}`);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`YouTube API error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    for (const item of data.items ?? []) {
      const id = item.snippet?.resourceId?.videoId;
      const title = item.snippet?.title || `YouTube Video (${id})`;
      if (id) {
        videos.push({ id, title });
      }
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return videos.slice(0, maxVideos);
}

export async function getChannelVideos(
  handleOrId: string,
  maxVideos = 20
): Promise<VideoInfo[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error("YOUTUBE_API_KEY is not set.");

  // Determine whether it's a UC... channel ID or a handle
  const isChannelId = handleOrId.startsWith("UC");
  const params = new URLSearchParams({
    part: "contentDetails",
    key: apiKey,
    ...(isChannelId ? { id: handleOrId } : { forHandle: handleOrId }),
  });

  const YT_API_BASE = "https://www.googleapis.com/youtube/v3";
  const res = await fetch(`${YT_API_BASE}/channels?${params}`);
  if (!res.ok) {
    throw new Error(`YouTube channels API error: ${res.status}`);
  }

  const data = await res.json();
  const uploadsPlaylistId: string | undefined =
    data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

  if (!uploadsPlaylistId) {
    throw new Error("Could not find uploads playlist for this channel. Custom handles might require entering the full UC... channel ID.");
  }

  return getPlaylistVideos(uploadsPlaylistId, maxVideos);
}

export async function parsePdf(buffer: Buffer) {
  try {
    return await parsePdfUtil(buffer).then(data => data.text);
  } catch (error) {
    console.error("PDF parse error:", error);
    return "";
  }
}

export async function parseDocx(buffer: Buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch (error) {
    console.error("Docx parse error:", error);
    return "";
  }
}

export async function crawlUrl(url: string, recursive = false) {
  await assertSafeOutboundUrl(url);
  // Respect robots.txt before any fetch (both Firecrawl and the basic path).
  if (shouldRespectRobots() && !(await isAllowedByRobots(url))) {
    throw new Error(
      "Blocked by robots.txt — this URL is disallowed for crawling. Remove it, " +
      "use a page the site permits, or set RESPECT_ROBOTS=0 if you own the site."
    );
  }

  // Static-first: try plain HTTP + cheerio (fast, free, preserves normal HTML pages).
  // JS-rendered pages produce little/no readable text here and fall back to the
  // headless renderer (Firecrawl) further below.
  let response: { data: string };
  try {
    const fetched = await safeOutboundFetch(url, {
      headers: {
        "User-Agent": CRAWLER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!fetched.ok) throw new Error(`HTTP ${fetched.status}`);
    response = { data: await readTextWithLimit(fetched, MAX_PAGE_BYTES) };
  } catch (error: any) {
    const msg = String(error?.message || "");
    if (error?.code === "ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED" || /maxContentLength|maxBodyLength/i.test(msg)) {
      throw new Error(`Page is too large to crawl (over ${Math.round(MAX_PAGE_BYTES / (1024 * 1024))} MB). Add the key content as Text or a File instead.`);
    }
    console.error(`Error crawling ${url}:`, error);
    return null;
  }

  let title = url;
  let finalContent = "";
  try {
    const $ = cheerio.load(response.data);

    // Clean up unnecessary, non-content tags
    $("script, style, nav, footer, header, iframe, noscript, svg, .cookie-banner, #cookie-consent, .pop-up, .menu, .sidebar, [aria-hidden='true']").remove();

    title = $("title").text().trim() || $("h1").first().text().trim() || url;

    // Advanced HTML-to-Markdown parser built directly on cheerio
    let markdown = "";
    
    // Help helper function to traverse and extract markdown
    function extractNode(element: any) {
      $(element).children().each((_, el) => {
        const tagName = el.tagName ? el.tagName.toLowerCase() : "";
        
        switch (tagName) {
          case "h1":
            markdown += `\n\n# ${$(el).text().trim().replace(/\s+/g, " ")}\n\n`;
            break;
          case "h2":
            markdown += `\n\n## ${$(el).text().trim().replace(/\s+/g, " ")}\n\n`;
            break;
          case "h3":
            markdown += `\n\n### ${$(el).text().trim().replace(/\s+/g, " ")}\n\n`;
            break;
          case "h4":
          case "h5":
          case "h6":
            markdown += `\n\n#### ${$(el).text().trim().replace(/\s+/g, " ")}\n\n`;
            break;
          case "p": {
            const text = $(el).text().trim().replace(/\s+/g, " ");
            if (text) markdown += `\n\n${text}\n\n`;
            break;
          }
          case "li": {
            const text = $(el).text().trim().replace(/\s+/g, " ");
            if (text) markdown += `\n- ${text}`;
            break;
          }
          case "ul":
          case "ol":
            markdown += "\n";
            extractNode(el);
            markdown += "\n";
            break;
          case "pre":
          case "code": {
            const codeText = $(el).text().trim();
            if (codeText) markdown += `\n\`\`\`\n${codeText}\n\`\`\`\n`;
            break;
          }
          case "table": {
            markdown += "\n\n";
            const rows: string[][] = [];
            $(el).find("tr").each((_, tr) => {
              const row: string[] = [];
              $(tr).find("th, td").each((_, td) => {
                row.push($(td).text().trim().replace(/\s+/g, " ").replace(/\|/g, "\\|"));
              });
              if (row.length > 0) rows.push(row);
            });
            
            if (rows.length > 0) {
              // Add header
              markdown += `| ${rows[0].join(" | ")} |\n`;
              markdown += `| ${rows[0].map(() => "---").join(" | ")} |\n`;
              // Add body
              for (let i = 1; i < rows.length; i++) {
                markdown += `| ${rows[i].join(" | ")} |\n`;
              }
            }
            markdown += "\n";
            break;
          }
          case "blockquote": {
            const quote = $(el).text().trim().replace(/\s+/g, " ");
            if (quote) markdown += `\n\n> ${quote}\n\n`;
            break;
          }
          case "div":
          case "section":
          case "article":
          case "main": {
            // Traverse child elements
            extractNode(el);
            break;
          }
          default: {
            // For simple inline text or text nodes
            const text = $(el).text().trim().replace(/\s+/g, " ");
            if (text && $(el).children().length === 0) {
              markdown += ` ${text} `;
            } else {
              extractNode(el);
            }
          }
        }
      });
    }

    const bodyElement = $("body");
    if (bodyElement.length > 0) {
      extractNode(bodyElement);
    } else {
      markdown = $.text();
    }

    // Clean up excessive formatting artifacts
    const cleanedContent = markdown
      .replace(/\n{3,}/g, "\n\n")
      .replace(/ +/g, " ")
      .trim();

    finalContent = cleanedContent || $.text().replace(/\s+/g, " ").trim();
  } catch (error) {
    console.error(`Error parsing ${url}:`, error);
    return null;
  }

  const capContent = (c: string) => (c.length > MAX_CONTENT_CHARS ? c.slice(0, MAX_CONTENT_CHARS) : c);
  finalContent = capContent(finalContent);
  const staticReadable = finalContent.replace(/\s+/g, "").length;

  // Rich static content → use it directly. Preserves fast/free static scraping for
  // normal HTML pages and avoids paying for a headless render.
  if (staticReadable >= GOOD_STATIC_CHARS) {
    return { title, content: finalContent, url };
  }

  // Thin/empty static content usually means a JS-rendered page. Automatically fall
  // back to the headless renderer (Firecrawl) and keep whichever result is richer.
  if (!recursive) {
    const fc = await scrapeWithFirecrawl(url);
    if (fc?.content) {
      const fcReadable = fc.content.replace(/\s+/g, "").length;
      if (fcReadable > staticReadable) {
        return { title: fc.title || title, content: capContent(fc.content), url: fc.url || url };
      }
    }
  }

  // Some (thin) static text and no better headless result — use what we have.
  if (staticReadable >= MIN_READABLE_CHARS) {
    return { title, content: finalContent, url };
  }

  // Truly empty: fail loudly with an actionable message instead of indexing nothing.
  const rawHtml = typeof response.data === "string" ? response.data : "";
  const looksSpa = /enable JavaScript|id=["'](root|app|__next|___gatsby)["']/i.test(rawHtml);
  throw new Error(
    getFirecrawl()
      ? "This page returned no readable text and the headless render also failed — retry shortly, or add the content as Text/File."
      : looksSpa
        ? "This page rendered no readable text — it looks like a JavaScript app. Set FIRECRAWL_API_KEY to crawl JS-rendered sites, or paste the content via Text/File."
        : "No readable text found on this page. If it needs JavaScript to render, set FIRECRAWL_API_KEY; otherwise add the content as Text/File."
  );
}

export async function crawlRecursive(url: string, limit = 10) {
  await assertSafeOutboundUrl(url);
  const firecrawl = getFirecrawl();
  if (firecrawl) {
    try {
      let response: any;
      if (typeof (firecrawl as any).crawl === "function") {
        response = await (firecrawl as any).crawl(url, {
          limit,
          scrapeOptions: { formats: ["markdown"] }
        });
      } else if (typeof (firecrawl as any).crawlUrl === "function") {
        response = await (firecrawl as any).crawlUrl(url, {
          limit,
          scrapeOptions: { formats: ["markdown"] }
        });
      }

      if (response && response.success) {
        const pages = response.data || response.pages || [];
        // Return array of results
        return pages.map((page: any) => ({
          title: page.metadata?.title || page.url,
          content: page.markdown || page.html,
          url: page.url
        }));
      }
    } catch (e) {
      console.error("Recursive crawl failed:", e);
    }
  }
  return [];
}

export async function getSitemapUrls(url: string) {
  try {
    const response = await safeOutboundFetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return [];
    const xml = await readTextWithLimit(response, 8 * 1024 * 1024);
    return Array.from(xml.matchAll(/<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi))
      .map((match) => match[1].trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"))
      .filter(Boolean);
  } catch (error) {
    console.error("Sitemap error:", error);
    return [];
  }
}

export type DocsSiteType = "gitbook" | "zendesk" | "web";

export function resolveDocsSitemapUrl(input: string): { sitemapUrl: string; type: DocsSiteType } {
  const base = input.trim().replace(/\/+$/, ""); // strip trailing slashes

  // Gitbook: hosted on gitbook.io or custom domain with gitbook pattern
  if (base.includes(".gitbook.io")) {
    return { sitemapUrl: `${base}/sitemap.xml`, type: "gitbook" };
  }

  // Zendesk Help Center: subdomain.zendesk.com/hc or custom domain with /hc path
  if (base.includes(".zendesk.com") || base.match(/\/hc($|\/)/)) {
    // Sitemap lives at /hc/sitemap.xml — strip anything after /hc
    const hcIndex = base.indexOf("/hc");
    const hcBase = hcIndex !== -1 ? base.substring(0, hcIndex + 3) : base;
    return { sitemapUrl: `${hcBase}/sitemap.xml`, type: "zendesk" };
  }

  // Generic docs site — try /sitemap.xml as the standard location
  return { sitemapUrl: `${base}/sitemap.xml`, type: "web" };
}

// ---- GitHub connector --------------------------------------------------------

/** Parse a GitHub repo from a URL (https://github.com/owner/repo) or "owner/repo". */
export function parseGithubRepo(input: string): { owner: string; repo: string } | null {
  if (!input) return null;
  const s = input.trim();
  const m = s.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/i, "") };
  const m2 = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (m2) return { owner: m2[1], repo: m2[2].replace(/\.git$/i, "") };
  return null;
}

const GITHUB_DOC_EXT = /\.(md|mdx|markdown|rst|txt)$/i;

/**
 * Discover documentation/text files in a GitHub repo via the GitHub API (one or
 * two calls: repo info for the default branch + the recursive git tree). Raw file
 * contents are fetched later, per file, during ingestion, so a big repo drains a
 * few files at a time. Set GITHUB_TOKEN to lift rate limits / read private repos.
 */
export async function getGithubDocFiles(
  owner: string,
  repo: string,
  branch?: string
): Promise<{ branch: string; files: { path: string; rawUrl: string }[] }> {
  const headers: Record<string, string> = {
    "User-Agent": "SiteGist",
    Accept: "application/vnd.github+json",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  let resolvedBranch = branch?.trim();
  if (!resolvedBranch) {
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (repoRes.status === 404) throw new Error(`Repo ${owner}/${repo} not found (private repos need a GITHUB_TOKEN).`);
    if (repoRes.status === 403) throw new Error("GitHub API rate limit reached — try again later or set GITHUB_TOKEN.");
    if (!repoRes.ok) throw new Error(`GitHub error (HTTP ${repoRes.status}).`);
    const info: any = await repoRes.json();
    resolvedBranch = info.default_branch || "main";
  }

  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(resolvedBranch!)}?recursive=1`,
    { headers }
  );
  if (treeRes.status === 403) throw new Error("GitHub API rate limit reached — try again later or set GITHUB_TOKEN.");
  if (!treeRes.ok) throw new Error(`Could not read repo tree (HTTP ${treeRes.status}).`);
  const tree: any = await treeRes.json();
  const items: any[] = Array.isArray(tree.tree) ? tree.tree : [];

  const files = items
    .filter((it) => it.type === "blob" && typeof it.path === "string" && GITHUB_DOC_EXT.test(it.path))
    .map((it) => ({
      path: it.path as string,
      rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${resolvedBranch}/${(it.path as string)
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    }));

  return { branch: resolvedBranch!, files };
}

export function chunkText(text: string, size = 1200, overlap = 200): string[] {
  if (!text || !text.trim()) return [];

  // Helper to split a long sentence at the nearest word boundary
  function splitLongSentence(sentence: string, maxSize: number): string[] {
    const parts: string[] = [];
    let remaining = sentence;
    while (remaining.length > maxSize) {
      let splitIdx = remaining.lastIndexOf(" ", maxSize);
      if (splitIdx === -1 || splitIdx === 0) {
        splitIdx = maxSize;
      }
      parts.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx);
    }
    if (remaining.trim()) {
      parts.push(remaining);
    }
    return parts;
  }

  // Phase 1: Sentence splitting without using lookbehind regex for maximum compatibility.
  // Split on sentence endings preserving the punctuation/separator.
  const rawParts = text.split(/([.!?]+(?:\s+|\n+)|\n{2,})/g);
  const sentences: string[] = [];
  let currentSentence = "";

  for (let i = 0; i < rawParts.length; i++) {
    const part = rawParts[i];
    if (!part) continue;
    if (/^[.!?\s\n]+$/.test(part)) {
      currentSentence += part;
      if (currentSentence.trim()) {
        sentences.push(currentSentence);
      }
      currentSentence = "";
    } else {
      if (currentSentence.trim()) {
        sentences.push(currentSentence);
      }
      currentSentence = part;
    }
  }
  if (currentSentence.trim()) {
    sentences.push(currentSentence);
  }

  // Handle single sentences longer than size
  const processedSentences: string[] = [];
  for (const s of sentences) {
    if (s.length > size) {
      processedSentences.push(...splitLongSentence(s, size));
    } else {
      processedSentences.push(s);
    }
  }

  // Phase 2: Accumulating sentences into chunks respecting size and carrying overlap
  const chunks: string[] = [];
  let currentBuffer = "";

  for (let i = 0; i < processedSentences.length; i++) {
    const s = processedSentences[i];
    const sTrimmed = s.trim();
    if (!sTrimmed) continue;

    if (!currentBuffer) {
      currentBuffer = s;
    } else {
      if (currentBuffer.length + s.length > size) {
        chunks.push(currentBuffer.trim());

        // Seed with tail of previous buffer matching the overlap length
        let seed = "";
        if (overlap > 0 && currentBuffer.length > overlap) {
          const rawTail = currentBuffer.slice(-overlap);
          const firstSpaceIdx = rawTail.indexOf(" ");
          if (firstSpaceIdx !== -1 && firstSpaceIdx < rawTail.length - 1) {
            seed = rawTail.slice(firstSpaceIdx).trim() + " ";
          } else {
            seed = rawTail.trim() + " ";
          }
        }
        currentBuffer = seed + s;
      } else {
        currentBuffer += (currentBuffer.endsWith(" ") ? "" : " ") + s;
      }
    }
  }

  if (currentBuffer.trim()) {
    chunks.push(currentBuffer.trim());
  }

  return chunks;
}
