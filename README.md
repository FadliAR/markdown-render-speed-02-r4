# SwiftMark R4 — a fast drop-in Markdown renderer

SPDX-License-Identifier: MIT

`parse.js` is a dependency-free ES module whose `parse(markdown)` returns the
same HTML that marked 18.1.3 produces with its default options (GFM on,
breaks off). `main.ts` is the harness driver: it reads every case from
`/input/cases.json`, renders each one with `parse`, and writes the resulting
HTML strings, in order, to `/output/html.json`.

The renderer is a hand-written, single-pass design:

- a line-oriented block parser (fences, ATX and setext headings, thematic
  breaks, block quotes, lists, HTML blocks, link reference definitions,
  GFM tables, indented code, paragraphs) that collects every link reference
  definition in the document before any inline rendering happens, so forward
  references resolve exactly like the reference implementation;
- an inline parser built on a delimiter stack (emphasis, strong, strikethrough,
  code spans, links, images, autolinks and extended autolinks) with
  CommonMark flanking rules;
- no state is kept between `parse` calls: every call re-lexes its input from
  scratch, so results never depend on earlier cases.

License: MIT (see `LICENSE`).
