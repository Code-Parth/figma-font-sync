import { describe, expect, it } from "bun:test";
import { openCommand, openUrl } from "../../src/open-url";

const URL_WITH_QUERY = "https://accounts.google.com/o/oauth2/v2/auth?client_id=a&scope=b c";

describe("openUrl", () => {
  it("builds a shell-free command per platform", () => {
    expect(openCommand("darwin", "http://localhost:47321/pair")).toEqual(["open", "http://localhost:47321/pair"]);
    expect(openCommand("win32", "http://localhost:47321/pair")).toEqual([
      "rundll32",
      "url.dll,FileProtocolHandler",
      "http://localhost:47321/pair",
    ]);
    expect(openCommand("linux", "http://localhost:47321/pair")).toEqual(["xdg-open", "http://localhost:47321/pair"]);
  });

  it("passes the URL as one argument", async () => {
    const launched: string[][] = [];
    await openUrl(URL_WITH_QUERY, "linux", async (argv) => {
      launched.push(argv);
      return 0;
    });
    expect(launched).toEqual([["xdg-open", "https://accounts.google.com/o/oauth2/v2/auth?client_id=a&scope=b%20c"]]);
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "not a url", "smb://host/share"])(
    "refuses %s without launching anything",
    async (url) => {
      let launched = false;
      const attempt = openUrl(url, "darwin", async () => {
        launched = true;
        return 0;
      });
      await expect(attempt).rejects.toThrow();
      expect(launched).toBe(false);
    },
  );

  it("rejects with a clear message when the opener fails", async () => {
    await expect(openUrl("http://localhost:47321/pair", "linux", async () => 3)).rejects.toThrow(
      "xdg-open exited with code 3",
    );
    await expect(
      openUrl("http://localhost:47321/pair", "linux", async () => {
        throw new Error("ENOENT");
      }),
    ).rejects.toThrow("Could not run xdg-open to open a browser: ENOENT");
  });

  it("treats an opener that is still running as success", async () => {
    await openUrl("http://localhost:47321/pair", "linux", async () => null);
  });
});
