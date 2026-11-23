#!/usr/bin/env node
// Checks a regions.json against the contract that readers such as Sideview rely on:
//   { source?: string, views: Record<string, { image: string, scale: number, regions: Region[] }> }
//   Region = { label: string, kind: "head" | "section" | "foot", heading: string | null,
//              aliases: string[], rect: [x, y, w, h] }   (rect in image pixels)
// Extra fields (such as createdAt) are allowed.
//
// As a module: validateRegionsFile(data) returns a list of problems (empty when valid).
// As a CLI:    node scripts/regions-contract.mjs <regions.json>   exits 1 and prints the problems if invalid.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

const KINDS = new Set(["head", "section", "foot"]);
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

/** @returns {string[]} problems, empty when the data matches the contract */
export function validateRegionsFile(data) {
  const problems = [];
  if (!isObject(data)) return ["root is not an object"];
  if ("source" in data && typeof data.source !== "string") problems.push("source is not a string");
  if (!isObject(data.views)) return [...problems, "views is not an object"];
  for (const [name, view] of Object.entries(data.views)) {
    const at = `views.${name}`;
    if (!isObject(view)) {
      problems.push(`${at} is not an object`);
      continue;
    }
    if (typeof view.image !== "string" || !view.image) problems.push(`${at}.image is not a non-empty string`);
    if (!isNumber(view.scale) || view.scale <= 0) problems.push(`${at}.scale is not a positive number`);
    if (!Array.isArray(view.regions)) {
      problems.push(`${at}.regions is not an array`);
      continue;
    }
    view.regions.forEach((r, i) => {
      const rat = `${at}.regions[${i}]`;
      if (!isObject(r)) return problems.push(`${rat} is not an object`);
      if (typeof r.label !== "string" || !r.label) problems.push(`${rat}.label is not a non-empty string`);
      if (!KINDS.has(r.kind)) problems.push(`${rat}.kind is not head, section or foot`);
      if (r.heading !== null && typeof r.heading !== "string") problems.push(`${rat}.heading is not a string or null`);
      if (!Array.isArray(r.aliases) || !r.aliases.every((a) => typeof a === "string")) problems.push(`${rat}.aliases is not an array of strings`);
      if (!Array.isArray(r.rect) || r.rect.length !== 4 || !r.rect.every(isNumber)) problems.push(`${rat}.rect is not [x, y, w, h]`);
      else if (r.rect[2] < 0 || r.rect[3] < 0) problems.push(`${rat}.rect has a negative size`);
    });
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scripts/regions-contract.mjs <regions.json>");
    process.exit(1);
  }
  const problems = validateRegionsFile(JSON.parse(fs.readFileSync(file, "utf8")));
  for (const p of problems) console.error(p);
  if (problems.length) process.exit(1);
  console.log("ok");
}
