# Poem Typesetter

A small in-browser app for typesetting poetry and exporting it as high-resolution images
(sharper than screenshots).

Open `index.html` in a browser. No install, build step, or server needed.

## Features

- Type or paste directly onto the page; every piece of text can have its own font, size,
  color, bold/italic (⌘B / ⌘I), and each line its own alignment.
- Text flows across pages automatically and flows back when it shrinks; "+ Add page" forces
  a page break. Selections can span pages.
- Adjustable wrap width, hanging indent for wrapped lines, line height, margins, and where
  text flows to the next page. Optionally keep stanzas together.
- Page size presets or custom sizes, background color (or transparent PNG), page numbers.
- Export PNG or JPEG at 1–4× scale; multiple pages download as a ZIP.
- Work is saved in the browser automatically; undo/redo with ⌘Z / ⌘⇧Z.

## Fonts

Most fonts load from Google Fonts. [Libron](https://github.com/nicoverbruggen/libron) is
bundled in `fonts/libron/` under the SIL Open Font License (see `fonts/libron/LICENSE.txt`).
