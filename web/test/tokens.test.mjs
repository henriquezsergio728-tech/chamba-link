import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CATEGORIES } from "../../api/src/domain.ts";
import { CATEGORY_STYLES, STATUS_LABELS } from "../src/brand/categories.ts";
import { PAIRS, TEXT } from "./pairs.mjs";

const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const schema = readFileSync(new URL("../../api/src/db/schema.ts", import.meta.url), "utf8");

// Custom properties declared as `--name: value;`, resolved through var() references to a hex color.
const decls = new Map([...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

function resolve(name, seen = new Set()) {
  assert.ok(decls.has(name), `${name} is not declared in tokens.css`);
  assert.ok(!seen.has(name), `${name} has a circular var() reference`);
  seen.add(name);
  const value = decls.get(name);
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (ref) return resolve(ref[1], seen);
  assert.match(value, /^#[0-9a-f]{6}$/i, `${name} must resolve to a 6-digit hex color, got ${value}`);
  return value;
}

// WCAG 2.x relative luminance: linearise each sRGB channel, then weight by the eye's sensitivity.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("contrast formula matches known values", () => {
  assert.equal(Math.round(contrast("#000000", "#ffffff") * 100) / 100, 21);
  assert.equal(contrast("#777777", "#777777"), 1);
});

for (const [fg, bg, min] of PAIRS) {
  test(`${fg} on ${bg} >= ${min}:1`, () => {
    const ratio = contrast(resolve(fg), resolve(bg));
    assert.ok(ratio >= min, `${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
  });
}

// tokens.css bars these as text on Arena. A palette change that lifts one to AA fails here, so the rule can be dropped.
for (const fg of ["--cl-olivo", "--cl-cobre"]) {
  test(`${fg} on --cl-arena < ${TEXT}:1, so it is not used as text there`, () => {
    const ratio = contrast(resolve(fg), resolve("--cl-arena"));
    assert.ok(ratio < TEXT, `${fg} on --cl-arena is ${ratio.toFixed(2)}:1, so the rule in tokens.css is no longer needed`);
  });
}

test("every API category has a style whose family has tokens", () => {
  assert.deepEqual(Object.keys(CATEGORY_STYLES).sort(), [...CATEGORIES].sort());
  for (const { family } of Object.values(CATEGORY_STYLES)) {
    for (const part of ["bg", "fg", "tint", "tint-fg"]) resolve(`--cat-${family}-${part}`);
  }
});

test("every booking status in the schema has a label and tokens", () => {
  const m = schema.match(/pgEnum\(\s*['"]booking_status['"]\s*,\s*\[([^\]]*)\]/);
  assert.ok(m, "booking_status enum not found in api/src/db/schema.ts");
  const statuses = [...m[1].matchAll(/['"]([\w-]+)['"]/g)].map((x) => x[1]);
  assert.deepEqual(Object.keys(STATUS_LABELS).sort(), [...statuses].sort());
  for (const s of statuses) {
    resolve(`--status-${s}-bg`);
    resolve(`--status-${s}-fg`);
  }
});
