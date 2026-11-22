#!/usr/bin/env node
// Full-page screenshots of a website: desktop and mobile, consent banners declined, lazy images loaded,
// regions (header, sections, footer) detected.
//
// Usage: node scripts/shoot.mjs <url> <out-dir> [--views desktop,mobile] [--max-height 24000] [--motion]
// Writes <out-dir>/desktop.png, mobile.png and regions.json, then one line of JSON to stdout:
//   { url, title, images: [{ view, path, width, height, regions, cut }], consent: { cmp, result, hiddenOverlays } | null }
// Timings go to stderr.
//
// regions.json: { source, createdAt, views: { <view>: { image, scale, regions: [{ kind, label, heading,
// aliases, rect: [x, y, w, h] }] } } } – rectangles in pixels of the respective image.
//
// Building blocks: Playwright for browser and capture; @duckduckgo/autoconsent declines consent
// (the same library the DuckDuckGo browsers use); leftover banners and scroll locks are handled by hand.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AUTOCONSENT_DIR = path.dirname(require.resolve("@duckduckgo/autoconsent"));
const AUTOCONSENT_SCRIPT = fs.readFileSync(path.join(AUTOCONSENT_DIR, "autoconsent.playwright.js"), "utf8");
const AUTOCONSENT_RULES = JSON.parse(fs.readFileSync(require.resolve("@duckduckgo/autoconsent/rules/rules.json"), "utf8"));

/** Viewports: a common laptop width and a common phone. */
const VIEWS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const VALUED = new Set(["--views", "--max-height"]);
const [url, outDir] = args.filter((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1]));
if (!url || !outDir) {
  console.error("Usage: node scripts/shoot.mjs <url> <out-dir> [--views desktop,mobile] [--max-height 24000] [--motion]");
  process.exit(1);
}
const views = flag("views", "desktop,mobile").split(",").map((v) => v.trim()).filter((v) => VIEWS[v]);
/** With --motion, motion stays on; otherwise reduced motion, animations at their end state, videos paused. */
const keepMotion = args.includes("--motion");
/** Very long pages are cut at the bottom; Chrome canvases break above roughly 32,000 px. */
const maxHeight = Number(flag("max-height", "24000"));

const t0 = Date.now();
const lap = (what) => console.error(`${((Date.now() - t0) / 1000).toFixed(1)} s  ${what}`);

// ---------- in the page ----------

/** Hide leftover banners and bars floating at the bottom, release scroll locks. */
function hideLeftovers() {
  const selectors = [
    "#onetrust-consent-sdk", "#CybotCookiebotDialog", "#usercentrics-root", "#cmpbox", "#cmpbox2", ".fc-consent-root",
    ".qc-cmp2-container", "[id*='sp_message_container']", "#BorlabsCookieBox", ".cmplz-cookiebanner", "#cookiescript_injected",
    "[id*='cookie' i]", "[class*='cookie' i]", "[id*='consent' i]", "[class*='consent' i]", "[aria-label*='cookie' i]", "[aria-label*='consent' i]",
  ];
  let hidden = 0;
  for (const el of document.querySelectorAll(selectors.join(","))) {
    const st = getComputedStyle(el);
    // Floating elements only: real content about cookies (an article, say) stays.
    if ((st.position === "fixed" || st.position === "sticky") && el.getBoundingClientRect().height > 0) {
      el.style.setProperty("display", "none", "important");
      hidden++;
    }
  }
  // Bars and chat buttons floating at the bottom: the full-page capture would otherwise put them mid-image.
  for (const el of document.querySelectorAll("body *")) {
    const st = getComputedStyle(el);
    if (st.position !== "fixed") continue;
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.top > window.innerHeight * 0.5 && r.height < window.innerHeight * 0.6) {
      el.style.setProperty("display", "none", "important");
      hidden++;
    }
  }
  for (const el of [document.documentElement, document.body]) {
    if (getComputedStyle(el).overflow === "hidden") el.style.setProperty("overflow", "visible", "important");
  }
  return hidden;
}

/** Animations and transitions to their end state, videos paused. Called after scrolling through, so that
 * scroll-triggered reveals have fired and then stand finished instead of halfway. */
function stillMotion() {
  const s = document.createElement("style");
  s.textContent =
    "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; transition-duration: 0s !important; transition-delay: 0s !important; caret-color: transparent !important; }";
  document.head.append(s);
  for (const v of document.querySelectorAll("video")) v.pause();
}

/** Turn off smooth scrolling, otherwise scrollTo arrives too late. */
function forceInstantScroll() {
  const s = document.createElement("style");
  s.textContent = "*, *::before, *::after { scroll-behavior: auto !important; }";
  document.head.append(s);
}

/** Scroll through once so lazy images load; wait for the images; back to the top. */
async function scrollThrough(max) {
  const step = window.innerHeight * 0.9;
  for (let y = 0; y < Math.min(document.documentElement.scrollHeight, max); y += step) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 80));
  }
  const pending = [...document.images].filter((img) => !img.complete);
  await Promise.race([Promise.all(pending.map((img) => new Promise((r) => (img.onload = img.onerror = r)))), new Promise((r) => setTimeout(r, 4000))]);
  window.scrollTo(0, 0);
  await document.fonts?.ready;
}

/** Header, sections, footer of any page. Invisible and tiny elements do not count. */
function readRegions() {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const textOf = (el) => (el ? clean(el.innerText || el.textContent) : "");
  const short = (s) => (s.length > 60 ? s.slice(0, 57).trimEnd() + " …" : s);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.height >= 4 && r.width >= 4 && st.visibility !== "hidden" && st.display !== "none" && el.getAttribute("aria-hidden") !== "true";
  };
  const nameOf = (el) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => textOf(document.getElementById(id))).filter(Boolean).join(" ");
      if (t) return short(t);
    }
    if (el.getAttribute("aria-label")) return short(clean(el.getAttribute("aria-label")));
    const h = textOf(el.querySelector("h1, h2, h3"));
    return h ? short(h) : null;
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return [r.left + window.scrollX, r.top + window.scrollY, r.width, r.height];
  };
  const regions = [];
  const head = [...document.querySelectorAll("header, [role=banner]")].find((el) => visible(el) && el.getBoundingClientRect().top + window.scrollY < 200);
  const foots = [...document.querySelectorAll("footer, [role=contentinfo]")].filter(visible);
  const foot = foots[foots.length - 1];
  if (head) regions.push({ kind: "head", label: "Header", heading: nameOf(head), aliases: ["header", "top"], rect: box(head) });
  // Sections: children of main, otherwise of body. If there is only one container, go one level deeper.
  let container = document.querySelector("main, [role=main]") || document.body;
  const sectionsOf = (c) =>
    [...c.children].filter((el) => el !== head && el !== foot && !el.contains(head) && !el.contains(foot) && visible(el) && el.getBoundingClientRect().height >= 120);
  let sections = sectionsOf(container);
  for (let depth = 0; sections.length === 1 && depth < 4; depth++) {
    container = sections[0];
    sections = sectionsOf(container);
  }
  sections.forEach((el, i) => {
    const heading = nameOf(el);
    regions.push({ kind: "section", label: heading || `Section ${i + 1}`, heading, aliases: [...new Set([el.id, el.classList[0]].filter(Boolean))], rect: box(el) });
  });
  if (foot) regions.push({ kind: "foot", label: "Footer", heading: nameOf(foot), aliases: ["footer", "bottom"], rect: box(foot) });
  return { height: document.documentElement.scrollHeight, title: document.title, regions };
}

// ---------- consent via autoconsent ----------

/** Declines consent (optOut). Reports the result once autoconsent is done. */
async function withAutoconsent(context) {
  const state = { cmp: null, result: null, done: false };
  const config = {
    enabled: true,
    autoAction: "optOut",
    disabledCmps: [],
    enablePrehide: true,
    enableCosmeticRules: true,
    enableGeneratedRules: true,
    detectRetries: 20,
    isMainWorld: false,
    prehideTimeout: 2000,
    enableHeuristicDetection: true,
    heuristicMode: "tier2",
    logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: false, messages: false, waits: false },
  };
  const reply = (frame, msg) => frame.evaluate((m) => window.autoconsentReceiveMessage?.(m), msg).catch(() => {});
  await context.exposeBinding("autoconsentSendMessage", async ({ frame }, msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "init") return reply(frame, { type: "initResp", config, rules: AUTOCONSENT_RULES });
    if (msg.type === "eval") {
      const result = await frame.evaluate(msg.code).catch(() => false);
      return reply(frame, { type: "evalResp", id: msg.id, result });
    }
    if (msg.type === "cmpDetected" || msg.type === "popupFound") state.cmp = msg.cmp;
    if (msg.type === "optOutResult") state.result = msg.result ? "declined" : "failed";
    if (msg.type === "autoconsentDone") state.done = true;
  });
  await context.addInitScript(AUTOCONSENT_SCRIPT);
  return state;
}

// ---------- run ----------

fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
// Some sites lock out the user agent of a headless browser ("HeadlessChrome"), so use that of a regular Chrome.
const major = browser.version().split(".")[0];
const AGENT = {
  desktop: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
  mobile: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
};
const result = { source: url, createdAt: new Date().toISOString(), views: {} };
const images = [];
let title = "";
let consent = null;
try {
  for (const view of views) {
    const options = VIEWS[view];
    const context = await browser.newContext({ ...options, locale: "en-US", userAgent: AGENT[view], reducedMotion: keepMotion ? "no-preference" : "reduce" });
    const state = await withAutoconsent(context);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    lap(`${view}: loaded`);
    // Autoconsent works on its own; wait at most three seconds for it to finish.
    for (let i = 0; i < 30 && state.cmp && !state.done; i++) await page.waitForTimeout(100);
    const leftovers = await page.evaluate(hideLeftovers).catch(() => 0);
    if (state.cmp || leftovers) consent = { cmp: state.cmp, result: state.result, hiddenOverlays: leftovers };
    lap(`${view}: consent ${state.cmp ? `${state.cmp} ${state.result ?? ""}` : "none detected"}${leftovers ? `, ${leftovers} leftovers hidden` : ""}`);
    await page.evaluate(forceInstantScroll);
    await page.evaluate(scrollThrough, maxHeight);
    if (!keepMotion) await page.evaluate(stillMotion);
    await page.waitForTimeout(800);
    lap(`${view}: scrolled through${keepMotion ? "" : ", motion stopped"}`);
    const data = await page.evaluate(readRegions);
    title ||= data.title;
    const scale = options.deviceScaleFactor ?? 1;
    const height = Math.min(data.height, maxHeight);
    const image = path.join(outDir, `${view}.png`);
    // Full page; pages that are too long are cut at the bottom (clip needs fullPage, otherwise only the viewport).
    await page.screenshot({ path: image, fullPage: true, animations: keepMotion ? "allow" : "disabled", clip: height < data.height ? { x: 0, y: 0, width: options.viewport.width, height } : undefined });
    lap(`${view}: screenshot`);
    const regions = data.regions.filter((r) => r.rect[1] < height).map((r) => ({ ...r, rect: r.rect.map((v) => Math.round(v * scale)) }));
    result.views[view] = { image, scale, regions };
    images.push({ view, path: image, width: options.viewport.width * scale, height: Math.round(height * scale), regions: regions.length, cut: height < data.height });
    await context.close();
  }
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(outDir, "regions.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ url, title, images, consent }));
