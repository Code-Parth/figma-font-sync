import { describe, expect, test } from "bun:test";
import { externalReferences } from "../../scripts/build";

describe("externalReferences", () => {
  test("a fully inlined page has none", () => {
    const html = `<!doctype html><html><head><style>body{background:url(data:image/png;base64,AA==)}</style></head>
<body><div id="root"></div><script type="module">var a=1;</script></body></html>`;
    expect(externalReferences(html)).toEqual([]);
  });

  test("finds script src, stylesheet href and image src in any quoting", () => {
    const html = `<link rel="stylesheet" href="./styles.css"><script type="module" src='./main.js'></script>
<img src=logo.png><img srcset="a.png 1x, b.png 2x">`;
    expect(externalReferences(html)).toEqual(["./styles.css", "./main.js", "logo.png", "a.png 1x, b.png 2x"]);
  });

  test("finds remote URLs", () => {
    expect(externalReferences(`<script src="https://cdn.example/x.js"></script>`)).toEqual(["https://cdn.example/x.js"]);
  });

  test("allows data: URLs and fragment links", () => {
    expect(externalReferences(`<img src="data:image/svg+xml,%3Csvg%3E"><a href="#top">top</a>`)).toEqual([]);
  });

  test("ignores src= and href= inside inline script and style bodies", () => {
    const html = `<script type="module">el.innerHTML='<a href="https://x.example">x</a><img src="y.png">'</script>
<style>a[href="https://x.example"]{color:red}</style>`;
    expect(externalReferences(html)).toEqual([]);
  });
});
