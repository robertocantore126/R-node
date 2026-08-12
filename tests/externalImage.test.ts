import { describe, expect, it, vi } from "vitest";
import { fetchImageAsFile, firstImageFile, firstUriFromList } from "../src/editor/externalImage";

describe("firstImageFile", () => {
  it("returns the first image/* entry and skips non-image files", () => {
    const files = [
      new File(["a"], "notes.txt", { type: "text/plain" }),
      new File(["b"], "pic.png", { type: "image/png" }),
      new File(["c"], "photo.jpg", { type: "image/jpeg" }),
    ];
    expect(firstImageFile(files)?.name).toBe("pic.png");
  });

  it("returns null when no image is present", () => {
    expect(firstImageFile([new File(["a"], "doc.pdf", { type: "application/pdf" })])).toBeNull();
    expect(firstImageFile([])).toBeNull();
  });
});

describe("firstUriFromList", () => {
  it("skips comment lines and returns the first URL", () => {
    const list = "# dropped from https://example.com/page\nhttps://example.com/img/cat.png\nhttps://example.com/page";
    expect(firstUriFromList(list)).toBe("https://example.com/img/cat.png");
  });

  it("handles a bare single-URL payload and empty input", () => {
    expect(firstUriFromList("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(firstUriFromList("")).toBeNull();
    expect(firstUriFromList("# only a comment\n")).toBeNull();
  });
});

describe("fetchImageAsFile", () => {
  function okResponse(type: string, body: string, headers: Record<string, string> = {}): Response {
    return new Response(new Blob([body], { type }), { status: 200, headers });
  }

  it("downloads an image URL into a File named after the URL", async () => {
    const fetcher = vi.fn(async () => okResponse("image/png", "png-bytes"));
    const file = await fetchImageAsFile("https://example.com/img/cat.png?x=1", fetcher);
    expect(fetcher).toHaveBeenCalledWith("https://example.com/img/cat.png?x=1");
    expect(file).not.toBeNull();
    expect(file!.name).toBe("cat.png");
    expect(file!.type).toBe("image/png");
    expect(await file!.text()).toBe("png-bytes");
  });

  it("returns null for a non-image response, an HTTP error, or a network failure", async () => {
    expect(await fetchImageAsFile("https://example.com/a.txt", vi.fn(async () => okResponse("text/plain", "x")))).toBeNull();
    expect(await fetchImageAsFile("https://example.com/404.png", vi.fn(async () => new Response(null, { status: 404 })))).toBeNull();
    expect(await fetchImageAsFile("https://example.com/down.png", vi.fn(async () => { throw new Error("net"); }))).toBeNull();
  });

  it("rejects downloads that are too large (content-length or actual size)", async () => {
    const big = "x".repeat(30 * 1024 * 1024);
    const announced = vi.fn(async () => okResponse("image/png", "small", { "content-length": String(30 * 1024 * 1024) }));
    expect(await fetchImageAsFile("https://example.com/big.png", announced)).toBeNull();

    const actual = vi.fn(async () => okResponse("image/png", big));
    expect(await fetchImageAsFile("https://example.com/big.png", actual)).toBeNull();
  });
});
