#!/usr/bin/env node
// Installs the page-shots skill for Claude Code:
//   1. copies the skill to $HOME/.claude/skills/page-shots
//   2. runs npm install there
//   3. checks whether Playwright can launch Chromium; if not, prints the command to install it.
// It never downloads browsers itself.
//
// Usage: node scripts/install.mjs            (from a clone)
//        npx github:<owner>/page-shots install
// With a terminal it asks before writing; without one (CI, pipes) it goes ahead without asking.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.HOME || os.homedir();
const TARGET = path.join(HOME, ".claude", "skills", "page-shots");
const FILES = ["SKILL.md", "README.md", "LICENSE", "package.json", "package-lock.json", "scripts/shoot.mjs", "scripts/regions-contract.mjs", "scripts/install.mjs"];

const args = process.argv.slice(2).filter((a) => a !== "install");
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node scripts/install.mjs\nCopies the skill to ~/.claude/skills/page-shots and runs npm install there.");
  process.exit(0);
}

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const same = fs.existsSync(TARGET) && fs.realpathSync(TARGET) === fs.realpathSync(SOURCE);
if (!same && fs.lstatSync(TARGET, { throwIfNoEntry: false })?.isSymbolicLink()) {
  fail(`${TARGET} is a symlink to ${fs.readlinkSync(TARGET)}. Not touching it; remove the link first to install a copy.`);
}

if (!same && process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const verb = fs.existsSync(TARGET) ? "Update" : "Install";
  const answer = await rl.question(`${verb} page-shots in ${TARGET}? [y/N] `).catch(() => ""); // Ctrl+C/Ctrl+D = no
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) fail("Cancelled. Nothing written.");
}

if (!same) {
  for (const file of FILES) {
    const from = path.join(SOURCE, file);
    if (!fs.existsSync(from)) {
      if (file === "package-lock.json") continue; // not part of the package when run through npx
      fail(`Missing ${from}. Run the installer from a complete copy of page-shots.`);
    }
    const to = path.join(TARGET, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  console.log(`Copied the skill to ${TARGET}`);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const install = spawnSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: TARGET, stdio: ["ignore", "inherit", "inherit"], shell: process.platform === "win32" });
if (install.status !== 0) fail(`npm install failed in ${TARGET}`);

let browserReady = false;
try {
  const { chromium } = createRequire(path.join(TARGET, "package.json"))("playwright");
  const browser = await chromium.launch();
  await browser.close();
  browserReady = true;
} catch {
  // missing or broken browser; reported below
}

if (browserReady) {
  console.log("Playwright Chromium: found.");
} else {
  console.log(
    [
      "Playwright Chromium: not found. Install it once:",
      `  cd "${TARGET}" && npx playwright install chromium`,
    ].join("\n"),
  );
}
console.log(`Done. Try: node "${path.join(TARGET, "scripts", "shoot.mjs")}" https://example.com /tmp/page-shots-test`);
