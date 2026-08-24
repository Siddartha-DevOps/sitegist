import Papa from "papaparse";
import { unzipSync } from "fflate";

// CSV → readable sentences. Each row becomes "Col1: val1; Col2: val2; ..."
// so the embedding model sees structured, queryable context instead of raw commas.
export function parseCsv(buffer: Buffer): string {
  const text = buffer.toString("utf-8");
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  const headers = result.meta.fields ?? [];
  if (headers.length === 0) {
    // No header row detected — fall back to raw text
    return text;
  }

  const lines: string[] = [];
  for (const row of result.data) {
    const parts = headers
      .map((h) => {
        const val = (row[h] ?? "").toString().trim();
        return val ? `${h}: ${val}` : null;
      })
      .filter(Boolean);
    if (parts.length > 0) lines.push(parts.join("; "));
  }

  return lines.join("\n");
}

function decodeXmlText(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

// PPTX → extract text runs from slide XML without executing embedded content.
export async function parsePptx(buffer: Buffer): Promise<string> {
  try {
    if (buffer.length > 25 * 1024 * 1024) throw new Error("PPTX exceeds 25 MB");
    const files = unzipSync(new Uint8Array(buffer), {
      filter: ({ name }) => /^ppt\/slides\/slide\d+\.xml$/.test(name),
    });
    const slides = Object.entries(files)
      .sort(([a], [b]) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]))
      .map(([, xml]) => {
        if (xml.byteLength > 5 * 1024 * 1024) throw new Error("PPTX slide exceeds 5 MB");
        const source = new TextDecoder().decode(xml);
        return [...source.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
          .map((match) => decodeXmlText(match[1]))
          .join(" ");
      });
    return slides.join("\n").trim();
  } catch (error) {
    console.error("PPTX parse error:", error);
    return "";
  }
}

// Markdown → strip syntax to plain text.
export function parseMarkdown(buffer: Buffer): string {
  let text = buffer.toString("utf-8");

  text = text
    .replace(/```[\s\S]*?```/g, " ")            // fenced code blocks
    .replace(/`([^`]+)`/g, "$1")                 // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")    // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")     // links → link text
    .replace(/^#{1,6}\s+/gm, "")                 // headings
    .replace(/^[>\-*+]\s+/gm, "")                // blockquotes & bullets
    .replace(/(\*\*|__)(.*?)\1/g, "$2")          // bold
    .replace(/(\*|_)(.*?)\1/g, "$2")             // italic
    .replace(/^\s*\|.*\|\s*$/gm, (line) =>       // table rows → spaced cells
      line.replace(/\|/g, " ").trim()
    )
    .replace(/^[-=]{3,}\s*$/gm, "")              // horizontal rules / setext underlines
    .replace(/\n{3,}/g, "\n\n")                  // collapse blank lines
    .trim();

  return text;
}
