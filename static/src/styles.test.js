import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Guards for the theme tokens. The app has three themes (dark, light, day) and grew up on the
// first: tone colours and hover washes were written as dark-mode literals, which left amber
// text at ~2.3:1 on the light themes and every white-on-dark hover invisible there. These
// tests keep the literals from creeping back and hold the text tones to WCAG AA.

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

// Every rule as { selector, body }. Flat walk; the file has no nesting beyond @media, whose
// inner rules this still visits.
function rules() {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push({ selector: m[1].split("*/").pop().trim(), body: m[2] });
  return out;
}

function themeTokens(selector) {
  const rule = rules().find((r) => r.selector === selector);
  if (!rule) throw new Error(`no ${selector} block`);
  const tokens = {};
  for (const decl of rule.body.split(";")) {
    const i = decl.indexOf("--");
    const colon = decl.indexOf(":", i);
    if (i === -1 || colon === -1) continue;
    tokens[decl.slice(i, colon).trim()] = decl.slice(colon + 1).trim();
  }
  return tokens;
}

const base = themeTokens(":root");
const THEMES = {
  // "light" sets no colour tokens of its own: it is the base palette.
  light: base,
  dark: { ...base, ...themeTokens(':root[data-theme="dark"]') },
  day: { ...base, ...themeTokens(':root[data-theme="day"]') },
};

function parseColor(value) {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (rgba) return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: rgba[4] === undefined ? 1 : +rgba[4] };
  throw new Error(`unparseable colour ${value}`);
}

function over(top, bottom) {
  const a = top.a;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}

function luminance({ r, g, b }) {
  const ch = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The surface tone text sits on: the theme's panel, composited over what shows through it.
// Day's panels are frosted over a live sky, so it is judged against the sky's brightest-blue
// end -- the hardest case for dark text, not the easiest.
function panelFor(theme, tokens) {
  const backdrop = theme === "day" ? parseColor("#4fa8f0") : parseColor(tokens["--bg"]);
  return over(parseColor(tokens["--panel"]), backdrop);
}

describe("tone tokens", () => {
  const TEXT = ["--tone-warning-text", "--tone-critical-text", "--tone-success-text", "--tone-grade-b-text", "--tone-grade-d-text"];
  const GRAPHIC = ["--tone-warning", "--tone-critical", "--tone-success"];

  for (const [theme, tokens] of Object.entries(THEMES)) {
    test(`${theme}: text tones meet 4.5:1 on the panel`, () => {
      const panel = panelFor(theme, tokens);
      for (const name of TEXT) {
        expect(contrast(parseColor(tokens[name]), panel), `${name} on ${theme}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    test(`${theme}: graphic tones meet 3:1 on the panel`, () => {
      const panel = panelFor(theme, tokens);
      for (const name of GRAPHIC) {
        expect(contrast(parseColor(tokens[name]), panel), `${name} on ${theme}`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  test("every theme defines every wash step", () => {
    const steps = Object.keys(THEMES.dark).filter((k) => k.startsWith("--wash-"));
    expect(steps.length).toBeGreaterThan(0);
    for (const tokens of Object.values(THEMES)) {
      for (const step of steps) expect(tokens[step]).toBeDefined();
    }
  });
});

describe("no dark-only literals outside theme-scoped rules", () => {
  const open = rules().filter((r) => !r.selector.includes("data-theme") && r.selector !== ":root");

  test("no white-on-dark washes -- use var(--wash-N)", () => {
    const offenders = open
      .filter((r) => /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0?\.(0\d*|1[0-5]?)\s*\)/.test(r.body))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  test("no literal tone colours as text -- use var(--tone-*-text)", () => {
    const literal = /#(d3a24e|e0796d|e07070|c9605a|c9860a|6fae81|4fae7d|8fbf7a|d98f4e)\b/i;
    const offenders = open
      .filter((r) => r.body.split(";").some((d) => /(^|\s)color\s*:/.test(d) && literal.test(d)))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });
});
