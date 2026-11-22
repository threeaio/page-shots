// End-to-end test of scripts/install.mjs with a fake HOME: install, update, then shoot a fixture page
// with the installed copy. npm runs offline against the real npm cache, so nothing is downloaded.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ROOT, startServer, shoot, tempDir } from "./helpers.mjs";
import { validateRegionsFile } from "../scripts/regions-contract.mjs";

const INSTALL = path.join(ROOT, "scripts", "install.mjs");
const realCache = execFileSync("npm", ["config", "get", "cache"], { encoding: "utf8" }).trim();
const realBrowsers = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), "Library", "Caches", "ms-playwright");

let server;
before(async () => (server = await startServer()));
after(() => server.close());

/** Runs the installer without a terminal (stdin closed), as in CI or a pipe. */
function install(home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, npm_config_cache: realCache, npm_config_offline: "true", ...extraEnv };
  if (!("PLAYWRIGHT_BROWSERS_PATH" in extraEnv)) delete env.PLAYWRIGHT_BROWSERS_PATH;
  const r = spawnSync(process.execPath, [INSTALL, "install"], { env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 120_000 });
  return { status: r.status, out: r.stdout + r.stderr, env };
}

test("installer refuses to write through a symlinked skill folder", () => {
  const home = tempDir("page-shots-home-");
  const elsewhere = tempDir("page-shots-elsewhere-");
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(home, ".claude", "skills", "page-shots"));
  const { status, out } = install(home);
  assert.equal(status, 1);
  assert.match(out, /symlink/);
  assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing written into the link target");
});

test("installer: fresh install, update, then the installed skill shoots a page", async () => {
  const home = tempDir("page-shots-home-");
  const target = path.join(home, ".claude", "skills", "page-shots");

  // Fresh install; the fake HOME has no Playwright browsers, so the installer only prints the command.
  const first = install(home);
  assert.equal(first.status, 0, first.out);
  for (const f of ["SKILL.md", "README.md", "LICENSE", "package.json", "scripts/shoot.mjs", "scripts/regions-contract.mjs"]) {
    assert.ok(fs.existsSync(path.join(target, f)), `${f} copied`);
  }
  assert.ok(!fs.existsSync(path.join(target, "test")), "tests are not copied");
  assert.ok(fs.existsSync(path.join(target, "node_modules", "playwright")), "dependencies installed");
  assert.ok(fs.existsSync(path.join(target, "node_modules", "@duckduckgo", "autoconsent")), "dependencies installed");
  assert.match(first.out, /not found/);
  assert.match(first.out, /npx playwright install chromium/);

  // Update with browsers available.
  const second = install(home, { PLAYWRIGHT_BROWSERS_PATH: realBrowsers });
  assert.equal(second.status, 0, second.out);
  assert.match(second.out, /Playwright Chromium: found/);

  // The installed copy works on its own.
  const { regions, images } = await shoot(`${server.base}/long.html`, ["--views", "desktop"], {
    script: path.join(target, "scripts", "shoot.mjs"),
    env: second.env,
  });
  assert.deepEqual(validateRegionsFile(regions), []);
  assert.equal(images.desktop.width, 1440);
  assert.equal(regions.views.desktop.regions.length, 7);
});
