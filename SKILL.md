---
name: page-shots
description: Full-page screenshots of a website with a ready-made script instead of hand-written Playwright code – desktop (1440 px) and mobile (390 px at 2x), consent banners declined, lazy images loaded, bars floating at the bottom hidden, animations stopped, and the page's regions (header, sections, footer) written to regions.json. Use when a public website is needed as an image – to discuss it, compare pages, review a design or use it as a reference. Not for screenshots of your own app under test (use the project's test tooling) and not for pages behind a login.
---

# Full-page screenshots

Do not build this yourself. The script handles what ad-hoc versions usually get wrong: consent banners, lazy images, bars floating at the bottom, smooth scrolling, pages over 20,000 px, motion. Without `--motion` it tells the page to reduce motion, sets CSS animations and transitions to their end state and pauses videos. It does not stop motion driven by JavaScript or WebGL.

```bash
node ~/.claude/skills/page-shots/scripts/shoot.mjs <url> <out-dir> [--views desktop,mobile] [--max-height 24000] [--motion]
```

Pass an absolute `<out-dir>`; the image paths in the output are built from it.

## Output

- `<out-dir>/desktop.png` (1440 px wide) and `mobile.png` (780 px: 390 at device scale 2), full page, cut at the bottom after `--max-height` CSS pixels.
- `<out-dir>/regions.json`: per view `image`, `scale`, `regions` with `kind` (head, section, foot), `label`, `heading`, `aliases`, `rect` [x, y, w, h] in image pixels.
- stdout, one line of JSON: `url`, `title`, `images` (each `view`, `path`, `width`, `height`, `regions`, `cut`), `consent` (detected provider and result, or null).
- stderr: timings per step. Typically 5 to 30 s for both views.

## With the Canvas app

Works on its own. It pairs well with the Canvas app: hand both image paths to Canvas; it reads `regions.json` next to the images, so regions like "the header" can be addressed by name on any website.

## Limits

- Consent is declined by autoconsent (opt-out, the library the DuckDuckGo browsers use). What it does not know, the script hides if it floats and its id, class or label mentions cookie or consent.
- Sites with bot protection return an error page. Check `title` in the output; if it looks like an error, take the screenshot in a regular browser instead.
- Regions are a heuristic (children of `main`, otherwise of `body`). On news sites it often finds only the header.
