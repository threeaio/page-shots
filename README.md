# page-shots

A [Claude Code](https://claude.com/claude-code) skill that takes full-page screenshots of a website and names its regions.

One command gives you:

- `desktop.png` at 1440 px wide and `mobile.png` at 390 px with device scale 2 (780 px wide), full page
- consent banners declined via [@duckduckgo/autoconsent](https://github.com/duckduckgo/autoconsent); unknown banners that float and mention cookie or consent are hidden
- lazy images loaded (the page is scrolled through once, the script waits for pending images)
- bars and chat buttons floating at the bottom hidden, so they do not end up in the middle of the image
- animations and transitions at their end state, videos paused, reduced motion requested (unless `--motion`)
- `regions.json` with the header, sections and footer as rectangles in image pixels

It works on its own and pairs well with [Sideview](https://github.com/threeaio/sideview), which reads `regions.json` next to the images.

## Install

Requires Node.js 20 or newer.

With the installer (copies the skill to `~/.claude/skills/page-shots` and runs `npm install` there):

```bash
git clone <repo-url> page-shots
node page-shots/scripts/install.mjs
# later, without cloning:
npx github:<owner>/page-shots install
```

With a terminal it asks before writing; without one (CI, pipes) it goes ahead. It refuses to write into `~/.claude/skills/page-shots` if that is a symlink.

By hand: copy or symlink this folder to `~/.claude/skills/page-shots`, then run `npm install` inside it.

Playwright needs a Chromium build. The installer checks for one and, if it is missing, prints the command; it never downloads browsers itself. Install it once:

```bash
cd ~/.claude/skills/page-shots && npx playwright install chromium
```

## Usage

Claude Code picks the skill up when you ask for a screenshot of a website. You can also run the script directly:

```bash
node ~/.claude/skills/page-shots/scripts/shoot.mjs <url> <out-dir> [--views desktop,mobile] [--max-height 24000] [--motion]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--views` | `desktop,mobile` | Which views to shoot |
| `--max-height` | `24000` | Cut pages longer than this many CSS pixels (Chrome breaks on very tall captures) |
| `--motion` | off | Keep animations, transitions and videos running; no reduced-motion request |

stdout gets one line of JSON:

```json
{
  "url": "https://example.com",
  "title": "Example Domain",
  "images": [{ "view": "desktop", "path": "/abs/out/desktop.png", "width": 1440, "height": 900, "regions": 1, "cut": false }],
  "consent": null
}
```

`consent` is `{ cmp, result, hiddenOverlays }` when a consent provider was detected or leftovers were hidden. Timings per step go to stderr.

## regions.json

```ts
type RegionsFile = {
  source?: string;      // the URL
  createdAt?: string;   // ISO timestamp
  views: Record<string, { image: string; scale: number; regions: Region[] }>;
};

type Region = {
  kind: "head" | "section" | "foot";
  label: string;            // "Header", "Footer", the section heading, or "Section 3"
  heading: string | null;   // from aria-labelledby, aria-label or the first h1–h3
  aliases: string[];        // English and German: header/top/kopf/oben, footer/bottom/fuß/fuss/unten,
                            // section N/abschnitt N/bereich N plus the section's id and first class
  rect: [x: number, y: number, w: number, h: number]; // image pixels (CSS pixels × scale)
};
```

`image` is the path as written, built from `<out-dir>`; pass an absolute `<out-dir>` if another tool reads the file. Regions that start below a `--max-height` cut are left out. `node scripts/regions-contract.mjs <regions.json>` checks a file against this shape.

## Limitations

- Consent banners that autoconsent does not know are only hidden, not answered, and only if they float (fixed or sticky) and mention cookie or consent in id, class or aria-label.
- Sites with bot protection may return an error page. Check `title`.
- Motion driven by JavaScript or WebGL is not stopped.
- Regions are a heuristic: children of `main` (or `body`), going deeper while there is only one container; sections under 120 px are skipped. News and portal pages often yield only the header.
- Pages behind a login are not supported.
- The browser runs with locale `en-US`; sites that pick their language from the browser serve English.

## Development

```bash
npm install
npm test
```

The tests serve local fixture pages and need no internet, but they do need a Playwright Chromium.

## License

MIT
