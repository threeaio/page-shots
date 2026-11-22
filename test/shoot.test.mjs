// End-to-end tests for scripts/shoot.mjs against local fixture pages (no internet needed).
// They use the Playwright Chromium already installed on the machine.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, shoot, near } from "./helpers.mjs";
import { validateRegionsFile } from "../scripts/regions-contract.mjs";

const BLUE = [0x00, 0x33, 0xcc];
const GREEN = [0x00, 0xaa, 0x44];
const RED = [0xcc, 0x00, 0x00];
const MAGENTA = [0xff, 0x00, 0xff];
const PAPER = [0xf4, 0xf1, 0xea];

let server;
before(async () => (server = await startServer()));
after(() => server.close());

/** Scans the image on a grid and returns the first pixel near `color`, or null. */
function findColor(img, color, step = 4) {
  for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) if (near(img.pixel(x, y), color, 8)) return [x, y];
  return null;
}

test("long page: header, five sections and footer with sensible labels and y-ranges", async () => {
  const { summary, regions, images } = await shoot(`${server.base}/long.html`, ["--views", "desktop"]);
  assert.equal(summary.title, "Long page");
  assert.deepEqual(validateRegionsFile(regions), []);
  const view = regions.views.desktop;
  const img = images.desktop;
  assert.equal(img.width, 1440);
  assert.equal(view.scale, 1);
  assert.deepEqual(
    view.regions.map((r) => [r.kind, r.label]),
    [
      ["head", "Header"],
      ["section", "Intro"],
      ["section", "Features"],
      ["section", "Pricing"],
      ["section", "Section 4"],
      ["section", "Contact"],
      ["foot", "Footer"],
    ],
  );
  assert.equal(view.regions[0].rect[1], 0, "header starts at the top");
  assert.equal(view.regions[6].heading, "Acme Inc.");
  assert.ok(view.regions[2].aliases.includes("features"));
  let lastBottom = 0;
  for (const r of view.regions) {
    const [x, y, w, h] = r.rect;
    assert.ok(x >= 0 && x + w <= img.width, `${r.label} fits horizontally`);
    assert.ok(y >= lastBottom - 1 && y + h <= img.height, `${r.label} lies inside the image, below the previous region`);
    lastBottom = y + h;
  }
  assert.ok(img.height - lastBottom <= 1, "footer ends at the bottom of the image");
});

test("long page with --max-height: cut at the bottom, regions below the cut dropped", async () => {
  const { summary, regions, images } = await shoot(`${server.base}/long.html`, ["--views", "desktop", "--max-height", "1200"]);
  assert.equal(images.desktop.height, 1200);
  assert.equal(summary.images[0].cut, true);
  const view = regions.views.desktop;
  assert.ok(view.regions.every((r) => r.rect[1] < 1200));
  assert.deepEqual(view.regions.map((r) => r.label), ["Header", "Intro", "Features"]);
});

test("unknown consent dialog: no crash, dialog and backdrop hidden, content about cookies kept", async () => {
  const { summary, images } = await shoot(`${server.base}/consent.html`, ["--views", "desktop"]);
  const img = images.desktop;
  assert.equal(findColor(img, MAGENTA), null, "no pixel of the dialog is left");
  assert.ok(near(img.pixel(100, 300), [0x33, 0x66, 0xcc]), "the static article with 'cookie' in its class stays and is not darkened");
  assert.ok(near(img.pixel(100, 1500), PAPER), "no backdrop over the rest of the page");
  assert.ok(img.height >= 2200, "full page captured");
  assert.ok(summary.consent?.hiddenOverlays >= 2, "dialog and backdrop reported as hidden leftovers");
});

test("lazy images: loading=lazy and IntersectionObserver images are in the screenshot", async () => {
  const { images } = await shoot(`${server.base}/lazy.html`, ["--views", "desktop"]);
  const img = images.desktop;
  assert.ok(near(img.pixel(100, 2600), BLUE), `native lazy image loaded, got ${img.pixel(100, 2600)}`);
  assert.ok(near(img.pixel(100, 4600), GREEN), `observer image loaded, got ${img.pixel(100, 4600)}`);
});

test("fixed bottom bar and chat button hidden, fixed top bar kept", async () => {
  const { images } = await shoot(`${server.base}/fixed.html`, ["--views", "desktop"]);
  const img = images.desktop;
  assert.equal(findColor(img, MAGENTA), null, "no bottom bar or chat button anywhere");
  assert.ok(near(img.pixel(10, 10), [0x22, 0x66, 0x44]), "top bar kept");
});

test("animations: end state without --motion, the same on every run", async () => {
  const boxes = { reveal: 100, blink: 320, fade: 540, reduced: 760 };
  const sample = (img) => Object.fromEntries(Object.entries(boxes).map(([k, x]) => [k, img.pixel(x, 100)]));
  const [a, b] = await Promise.all([1, 2].map(() => shoot(`${server.base}/anim.html`, ["--views", "desktop"])));
  const first = sample(a.images.desktop);
  assert.ok(near(first.reveal, GREEN), `animation at its end state, got ${first.reveal}`);
  assert.ok(near(first.blink, [0x88, 0x66, 0x00]), `infinite animation stopped at its base style, got ${first.blink}`);
  assert.ok(near(first.fade, GREEN), `transition at its end state, got ${first.fade}`);
  assert.ok(near(first.reduced, GREEN), "page is told to reduce motion");
  assert.deepEqual(sample(b.images.desktop), first, "deterministic across runs");
});

test("animations: --motion keeps motion on", async () => {
  const { images } = await shoot(`${server.base}/anim.html`, ["--views", "desktop", "--motion"]);
  const img = images.desktop;
  assert.ok(!near(img.pixel(100, 100), GREEN), "60 s animation still under way");
  assert.ok(near(img.pixel(760, 100), RED), "no reduced-motion preference");
});

test("mobile view: 390 wide at 2x gives a 780 px image and scaled regions", async () => {
  const { summary, regions, images } = await shoot(`${server.base}/long.html`, ["--views", "mobile"]);
  assert.deepEqual(Object.keys(regions.views), ["mobile"]);
  assert.equal(images.mobile.width, 780);
  assert.equal(summary.images[0].width, 780);
  assert.equal(summary.images[0].height, images.mobile.height);
  const view = regions.views.mobile;
  assert.equal(view.scale, 2);
  assert.equal(view.regions[0].rect[2], 780, "header spans the full image width");
  assert.equal(view.regions[0].rect[3], 200, "100 CSS px header is 200 image px");
  assert.deepEqual(validateRegionsFile(regions), []);
});

test("default views: desktop and mobile in one regions.json that matches the contract", async () => {
  const { regions, summary } = await shoot(`${server.base}/long.html`);
  assert.deepEqual(validateRegionsFile(regions), []);
  assert.deepEqual(Object.keys(regions.views), ["desktop", "mobile"]);
  assert.equal(regions.source, `${server.base}/long.html`);
  for (const img of summary.images) assert.equal(regions.views[img.view].image, img.path);
});

test("contract validator rejects broken files", () => {
  const region = { label: "Header", kind: "head", heading: null, aliases: [], rect: [0, 0, 10, 10] };
  const ok = { source: "x", views: { desktop: { image: "/a.png", scale: 1, regions: [region] } } };
  assert.deepEqual(validateRegionsFile(ok), []);
  assert.deepEqual(validateRegionsFile({ views: {} }), [], "source is optional");
  const broken = (patch) => validateRegionsFile({ views: { desktop: { ...ok.views.desktop, regions: [{ ...region, ...patch }] } } });
  assert.ok(broken({ kind: "nav" }).length);
  assert.ok(broken({ rect: [0, 0, 10] }).length);
  assert.ok(broken({ heading: 3 }).length);
  assert.ok(broken({ aliases: "header" }).length);
  assert.ok(validateRegionsFile({ views: { desktop: { image: "", scale: 0, regions: [] } } }).length === 2);
  assert.ok(validateRegionsFile([]).length);
});
