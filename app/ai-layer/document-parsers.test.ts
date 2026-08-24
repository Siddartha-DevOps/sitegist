import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parsePptx } from "./document-parsers.server";

describe("parsePptx", () => {
  it("extracts ordered, decoded slide text only", async () => {
    const archive = zipSync({
      "ppt/slides/slide2.xml": strToU8("<p:sld><a:t>Second &amp; final</a:t></p:sld>"),
      "ppt/slides/slide1.xml": strToU8("<p:sld><a:t>Hello</a:t><a:t>world</a:t></p:sld>"),
      "ppt/embeddings/ignored.bin": strToU8("do not extract"),
    });

    await expect(parsePptx(Buffer.from(archive))).resolves.toBe("Hello world\nSecond & final");
  });
});
