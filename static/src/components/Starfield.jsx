import React from "react";

// The night sky behind the app, as seen through the dome.
//
// One canvas, fixed behind everything, pointer-inert and aria-hidden. It is decoration and
// must stay cheap and calm: ~30fps (a starfield does not need 60), the loop stops when the
// tab is hidden, and `prefers-reduced-motion` gets a single static frame and no loop at all.
// On a browser with no 2D context it renders nothing rather than throwing.
//
// What is on the sky:
//   - stars, coloured by an approximation of stellar temperature -- mostly near-white to the
//     eye, with the brightest showing a faint amber or blue cast, and denser along a band;
//   - that band: a faint Milky Way haze at a bearing-seeded angle;
//   - two or three distant galaxies as dim elongated smudges;
//   - a slight dimming low in the frame, standing in for atmospheric extinction near the
//     horizon.
// What moves, never more than one "event" at a time:
//   - a subset of stars breathe by a hair; a handful of the brightest throw a faint
//     diffraction cross at the peak of that breath;
//   - once every several seconds exactly one star flares and settles;
//   - once every 20-40s a shooting star crosses -- one in twelve of those a small shower.
// The whole field parallaxes a few pixels against the pointer.
//
// And #3: `bearing` names which part of the sky we are pointed at (the active tab). Changing
// it is a pivot, not a slide -- the outgoing sky pulls back, dims and twists away about the
// centre while the incoming one (seeded by that bearing, the same every visit) pushes in
// from behind and untwists to rest, a reticle rotating with it and reading RECALIBRATING.
// Nothing translates, so there is no direction to read as clunky. Nav order sets which way
// the small twist goes. Under prefers-reduced-motion it is an instant swap with no reticle.

const FRAME_MS = 1000 / 30;
const STAR_COLOR = "226, 231, 242";      // the fallback warm white
const FLARE_COLOR = "150, 194, 255";     // the signal cyan: the spark glow, the meteor tail, the reticle

const MAX_PARALLAX = 14;
const MAX_SPIKE_STARS = 5;
const SHOWER_CHANCE = 0.08;

// ── Seeded randomness ────────────────────────────────────────────────────────
//
// A bearing has to produce the same sky every time the tab is opened, so the field is built
// from a seeded generator rather than Math.random.

export function hashString(s) {
  let h = 2166136261 >>> 0;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// The tabs, in nav order. A bearing is a point on this line, so slewing between two of them
// is a single horizontal pan whose direction is never in doubt: a later tab is to the right.
// A bearing that is not on the list (or none) sits at 0.
export const BEARING_ORDER = [
  "overview", "fields", "projects", "workflows", "issueTypes", "priorities",
  "people", "assets", "access", "screens", "filters", "dashboards", "boards",
  "automation", "reports", "changes", "scans", "config",
];

export function bearingColumn(bearing) {
  const i = BEARING_ORDER.indexOf(String(bearing));
  return i === -1 ? 0 : i;
}

// ── Star colour ─────────────────────────────────────────────────────────────
//
// A crude blackbody ramp: cool amber through white to hot blue. `u` in [0,1] is the star's
// place on it (biased cool when the field is built, because red and orange dwarfs dominate a
// real sky). `sat` pulls the result back toward white -- dim far stars read white to the
// eye, only the bright near ones show their colour.

const STAR_STOPS = [
  [0.0, [255, 188, 138]],
  [0.35, [255, 224, 199]],
  [0.6, [255, 246, 244]],
  [0.8, [214, 228, 255]],
  [1.0, [170, 199, 255]],
];

export function starRGB(u, sat = 1) {
  const t = Math.max(0, Math.min(1, Number(u) || 0));
  let a = STAR_STOPS[0];
  let b = STAR_STOPS[STAR_STOPS.length - 1];
  for (let i = 0; i < STAR_STOPS.length - 1; i++) {
    if (t >= STAR_STOPS[i][0] && t <= STAR_STOPS[i + 1][0]) {
      a = STAR_STOPS[i];
      b = STAR_STOPS[i + 1];
      break;
    }
  }
  const span = b[0] - a[0] || 1;
  const f = (t - a[0]) / span;
  const s = Math.max(0, Math.min(1, sat));
  return [0, 1, 2].map((i) => {
    const c = a[1][i] + (b[1][i] - a[1][i]) * f;
    return Math.round(c * s + 255 * (1 - s));
  });
}

// Density scales with area but is capped hard -- a 4K display should not get 1,200 stars.
function starCountFor(w, h) {
  return Math.max(60, Math.min(260, Math.round((w * h) / 9000)));
}

// A ~gaussian in [-1.5, 1.5], sd ~0.5, from three uniforms -- for scattering stars around
// the Milky Way band rather than in a hard stripe.
function gauss(rng) {
  return rng() + rng() + rng() - 1.5;
}

// Everything a bearing's sky is made of: the stars, the galaxies, and the angle of the band.
export function makeField(w, h, rng) {
  const bandAngle = rng() * Math.PI;
  const cx = w / 2;
  const cy = h / 2;
  const bandCos = Math.cos(bandAngle);
  const bandSin = Math.sin(bandAngle);
  // Band normal.
  const nx = Math.cos(bandAngle + Math.PI / 2);
  const ny = Math.sin(bandAngle + Math.PI / 2);
  const diag = Math.hypot(w, h);

  const n = starCountFor(w, h);
  const stars = new Array(n);
  let spikes = 0;
  for (let i = 0; i < n; i++) {
    const onBand = rng() < 0.5;
    let x;
    let y;
    if (onBand) {
      const along = (rng() - 0.5) * diag * 1.25;
      const off = gauss(rng) * Math.min(w, h) * 0.16;
      x = cx + bandCos * along + nx * off;
      y = cy + bandSin * along + ny * off;
    } else {
      x = -MAX_PARALLAX + rng() * (w + MAX_PARALLAX * 2);
      y = -MAX_PARALLAX + rng() * (h + MAX_PARALLAX * 2);
    }
    const depth = rng() * rng();
    const tw = depth > 0.35 && rng() < 0.7 ? 0.03 + rng() * 0.09 : 0;
    const spike = tw > 0 && depth > 0.6 && spikes < MAX_SPIKE_STARS && rng() < 0.5;
    if (spike) spikes += 1;
    const u = Math.pow(rng(), 2.2);
    stars[i] = {
      x,
      y,
      depth,
      r: 0.4 + depth * 1.5,
      a: (onBand ? 0.14 : 0.1) + depth * 0.5 + rng() * 0.12,
      tw,
      ts: 0.0006 + rng() * 0.0012,
      tp: rng() * Math.PI * 2,
      spike,
      col: starRGB(u, 0.22 + depth * 0.5).join(", "),
    };
  }

  // Two to four galaxies. The first is a "near" one that may resolve into a spiral; the
  // rest lean far and small, so most of what you see is a faint smudge with a bright core.
  const galN = 2 + ((rng() * 3) | 0);
  const galaxies = [];
  for (let i = 0; i < galN; i++) {
    galaxies.push(makeGalaxy(w, h, rng, i === 0 ? rng() * 0.4 : 0.35 + rng() * 0.65));
  }

  return { stars, galaxies, bandAngle };
}

// One galaxy. `dist` in [0,1] is how far off it reads: near galaxies are large, brighter and
// can resolve into a spiral of individual arm stars; far ones are small, dim, and just a
// bright core in a faint halo -- you cannot make out structure at that distance. Arm points
// are baked in local [-1,1] space so drawing is a translate/scale and a run of tiny dots.
export function makeGalaxy(w, h, rng, dist = rng()) {
  const near = 1 - Math.max(0, Math.min(1, dist));
  // Kept clear of the middle third, where the content and the recalibration reticle sit.
  const left = rng() < 0.5;
  const x = w * (left ? 0.04 + rng() * 0.24 : 0.72 + rng() * 0.24);
  const y = h * (0.06 + rng() * 0.78);
  // 14px at the far end to ~110px near, biased small: most galaxies are far.
  const scale = 14 + near * near * 96;
  const rot = rng() * Math.PI * 2;
  // Never perfectly face-on, so no galaxy reads as a plain circle. Far ones tilt more on
  // average, which also helps sell the distance.
  const incl = 0.28 + rng() * 0.55 + dist * 0.12;
  const bright = 0.45 + near * 0.55;          // multiplies every alpha at draw time
  // Only near galaxies resolve into a spiral; a far one is an unresolved core + halo.
  const spiral = dist < 0.5 && rng() < 0.6;

  if (!spiral) {
    // Warm for an old elliptical, cool for a distant unresolved disk -- pick by chance.
    const warm = rng() < 0.5;
    return {
      spiral: false, x, y, scale, rot, incl, bright,
      core: warm ? "255, 236, 205" : "224, 232, 245",
      halo: warm ? "255, 224, 190" : "206, 218, 240",
    };
  }

  const arms = rng() < 0.72 ? 2 : 3;
  // Fewer dots on a smaller galaxy, so a mid-distance spiral does not look denser than a
  // near one, and the draw cost tracks the size.
  const perArm = Math.round(48 + near * 70);
  const turns = 1.3 + rng() * 1.1;
  const points = [];
  for (let a = 0; a < arms; a++) {
    const base = (a / arms) * Math.PI * 2;
    for (let k = 0; k < perArm; k++) {
      const t = k / perArm;
      const theta = base + t * turns * Math.PI * 2;
      const rad = 0.12 + t * 0.92;
      const ja = (rng() - 0.5) * 0.55 * (0.3 + t);   // arm gets fuzzier outward
      const jr = (rng() - 0.5) * 0.15;
      points.push({
        px: Math.cos(theta + ja) * (rad + jr),
        py: Math.sin(theta + ja) * (rad + jr),
        a: (1 - t * 0.55) * (0.25 + rng() * 0.75),
        s: 0.5 + rng() * 1.0,
      });
    }
  }
  return {
    spiral: true, x, y, scale, rot, incl, bright, points,
    core: "255, 240, 220",
    arm: "205, 222, 255",                     // young blue arm stars
    halo: "210, 220, 255",
  };
}

// ── Shooting star ─────────────────────────────────────────────────────────────

export function makeMeteor(w, h, now, rng = Math.random) {
  const ang = (Math.PI / 180) * (18 + rng() * 24);
  const diag = Math.hypot(w, h);
  const len = diag * (0.34 + rng() * 0.3);
  const speed = 0.9 + rng() * 0.5;
  return {
    x0: rng() * w * 0.9 - w * 0.05,
    y0: rng() * h * 0.35 - h * 0.1,
    dx: Math.cos(ang),
    dy: Math.sin(ang),
    len,
    startAt: now,
    dur: len / speed,
    tail: 90 + rng() * 140,
  };
}

export function makeShowerSibling(lead, now, index, rng = Math.random) {
  const perpX = -lead.dy;
  const perpY = lead.dx;
  const spread = (40 + rng() * 140) * (index % 2 === 0 ? 1 : -1);
  return {
    ...lead,
    x0: lead.x0 + perpX * spread + (rng() * 40 - 20),
    y0: lead.y0 + perpY * spread + (rng() * 40 - 20),
    len: lead.len * (0.8 + rng() * 0.4),
    tail: lead.tail * (0.7 + rng() * 0.5),
    startAt: now + index * (150 + rng() * 250),
    dur: lead.dur * (0.85 + rng() * 0.3),
  };
}

export function meteorPose(m, now) {
  if (!m) return null;
  const t = now - m.startAt;
  if (t < 0 || t >= m.dur) return null;

  const p = t / m.dur;
  const dist = p * m.len;
  const hx = m.x0 + m.dx * dist;
  const hy = m.y0 + m.dy * dist;

  const tailDist = Math.min(dist, m.tail);
  const tx = hx - m.dx * tailDist;
  const ty = hy - m.dy * tailDist;

  let k;
  if (p < 0.12) k = p / 0.12;
  else if (p > 0.55) k = 1 - (p - 0.55) / 0.45;
  else k = 1;

  return { hx, hy, tx, ty, k: Math.max(0, Math.min(1, k)) };
}

const SLEW_MS = 900;
const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const easeIn = (p) => p * p * p;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function Starfield({ active = true, bearing = "default" }) {
  const canvasRef = React.useRef(null);
  const bearingRef = React.useRef(bearing);

  React.useEffect(() => {
    bearingRef.current = bearing;
  }, [bearing]);

  React.useEffect(() => {
    if (!active) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) return undefined;

    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let lastDraw = 0;
    let running = true;

    let currentBearing = bearingRef.current;
    let field = null;
    // Slew: { startAt, from, to, dir } while the telescope is panning to a new bearing. `dir`
    // is +1 when the target tab is further right in the nav (sky scrolls left, new field
    // enters from the right) and -1 the other way -- one axis, direction never in doubt.
    let slew = null;

    let flareIdx = -1;
    let flareStart = 0;
    let flareDur = 0;
    let nextFlareAt = performance.now() + 2500 + Math.random() * 6000;

    let meteors = [];
    let nextMeteorAt = performance.now() + 6000 + Math.random() * 12000;

    let pointerX = window.innerWidth / 2;
    let pointerY = window.innerHeight / 2;
    let ox = 0;
    let oy = 0;

    const fieldFor = (b) => makeField(width, height, mulberry32(hashString(String(b ?? "default"))));

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      slew = null;
      field = fieldFor(currentBearing);
      draw(performance.now(), true);
    }

    function beginSlew(nextBearing, now) {
      // Nav order still sets a direction, but it is the direction of a small twist, not a
      // slide: a later tab settles clockwise, an earlier one counter-clockwise.
      const dir = Math.sign(bearingColumn(nextBearing) - bearingColumn(currentBearing)) || 1;
      slew = {
        startAt: now,
        // Interruptible: a tab change mid-pivot continues from whatever is on screen.
        from: slew ? slew.to : field,
        to: fieldFor(nextBearing),
        dir,
      };
      currentBearing = nextBearing;
      flareIdx = -1;
      meteors = [];
      nextMeteorAt = now + 9000 + Math.random() * 12000;
    }

    // A galaxy: an inclined disk halo, spiral arm stars if it has them, and a bright core on
    // top. The core is what stops it reading as a grey smudge.
    function drawGalaxy(g, gAlpha) {
      gAlpha *= g.bright ?? 1;
      ctx.save();
      ctx.translate(g.x + ox * 0.12, g.y + oy * 0.12);
      ctx.rotate(g.rot);
      ctx.scale(1, 1 - g.incl * 0.72);

      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, g.scale);
      halo.addColorStop(0, `rgba(${g.halo}, ${(0.10 * gAlpha).toFixed(3)})`);
      halo.addColorStop(0.5, `rgba(${g.halo}, ${(0.035 * gAlpha).toFixed(3)})`);
      halo.addColorStop(1, `rgba(${g.halo}, 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(0, 0, g.scale, 0, Math.PI * 2);
      ctx.fill();

      if (g.spiral) {
        for (let k = 0; k < g.points.length; k++) {
          const pt = g.points[k];
          ctx.fillStyle = `rgba(${g.arm}, ${(pt.a * 0.55 * gAlpha).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(pt.px * g.scale, pt.py * g.scale, pt.s, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      const coreR = g.scale * (g.spiral ? 0.24 : 0.44);
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
      core.addColorStop(0, `rgba(${g.core}, ${(0.6 * gAlpha).toFixed(3)})`);
      core.addColorStop(0.4, `rgba(${g.core}, ${(0.24 * gAlpha).toFixed(3)})`);
      core.addColorStop(1, `rgba(${g.core}, 0)`);
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, coreR, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    // One field -- galaxies, band haze, stars. `xf` is an optional { scale, rot, alpha }
    // applied about the viewport centre: the slew uses it to pull the outgoing sky back and
    // twist it out, and push the incoming one in, so the transition reads as the telescope
    // pivoting to a new target rather than a picture sliding sideways. `effects` gates the
    // twinkle-time bits (flare, diffraction spikes), which the slew turns off.
    function drawField(f, xf, now, effects) {
      if (!f) return;
      const gAlpha = xf?.alpha ?? 1;
      const xfActive = xf && ((xf.scale ?? 1) !== 1 || (xf.rot ?? 0) !== 0);
      if (xfActive) {
        ctx.save();
        ctx.translate(width / 2, height / 2);
        ctx.rotate(xf.rot ?? 0);
        ctx.scale(xf.scale ?? 1, xf.scale ?? 1);
        ctx.translate(-width / 2, -height / 2);
      }

      for (let i = 0; i < f.galaxies.length; i++) drawGalaxy(f.galaxies[i], gAlpha);

      // Milky Way haze: a soft band, brightest along its spine.
      ctx.save();
      ctx.translate(width / 2 + ox * 0.08, height / 2 + oy * 0.08);
      ctx.rotate(f.bandAngle);
      const bandW = Math.hypot(width, height) * 1.3;
      const bandH = Math.min(width, height) * 0.55;
      const haze = ctx.createLinearGradient(0, -bandH / 2, 0, bandH / 2);
      haze.addColorStop(0, "rgba(220, 228, 255, 0)");
      haze.addColorStop(0.5, `rgba(220, 228, 255, ${(0.038 * gAlpha).toFixed(3)})`);
      haze.addColorStop(1, "rgba(220, 228, 255, 0)");
      ctx.fillStyle = haze;
      ctx.fillRect(-bandW / 2, -bandH / 2, bandW, bandH);
      ctx.restore();

      for (let i = 0; i < f.stars.length; i++) {
        const s = f.stars[i];
        const sx = s.x + ox * s.depth;
        const sy = s.y + oy * s.depth;

        const osc = effects && !reduced && (s.tw || s.spike) ? Math.sin(now * s.ts + s.tp) : 0;
        let alpha = s.a + (s.tw ? s.tw * osc : 0);
        // Atmospheric extinction: dim stars low in the frame.
        if (sy > height * 0.8) alpha *= Math.max(0.25, 1 - (sy - height * 0.8) / (height * 0.25));
        alpha *= gAlpha;

        if (effects && s.spike && osc > 0) {
          const spk = osc * osc * osc;
          if (spk > 0.12) {
            const reach = s.r * 2.5 + 7 * spk;
            ctx.strokeStyle = `rgba(${s.col}, ${(0.4 * spk * gAlpha).toFixed(3)})`;
            ctx.lineWidth = 0.75;
            ctx.beginPath();
            ctx.moveTo(sx - reach, sy);
            ctx.lineTo(sx + reach, sy);
            ctx.moveTo(sx, sy - reach);
            ctx.lineTo(sx, sy + reach);
            ctx.stroke();
          }
        }

        let radius = s.r;
        if (effects && i === flareIdx) {
          const p = (now - flareStart) / flareDur;
          const env = p < 0.33 ? p / 0.33 : 1 - (p - 0.33) / 0.67;
          const k = Math.max(0, Math.min(1, env));
          alpha = Math.min(1, alpha + 0.85 * k);
          radius = s.r + 0.9 * k;

          const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, 6 + 10 * k);
          g.addColorStop(0, `rgba(${FLARE_COLOR}, ${0.28 * k})`);
          g.addColorStop(1, `rgba(${FLARE_COLOR}, 0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(sx, sy, 6 + 10 * k, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.fillStyle = `rgba(${s.col}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      if (xfActive) ctx.restore();
    }

    // The recalibration overlay: a reticle and a label, fading in and out across the slew and
    // rotating a few degrees with it so the whole transition reads as one pivot.
    function drawReticle(p, dir = 1) {
      const vis = p < 0.3 ? p / 0.3 : p > 0.72 ? Math.max(0, (1 - p) / 0.28) : 1;
      if (vis <= 0) return;
      const cx = width / 2;
      const cy = height / 2;
      const R = Math.min(width, height) * 0.16;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(dir * (p - 0.5) * 0.4);
      ctx.translate(-cx, -cy);

      ctx.strokeStyle = `rgba(${FLARE_COLOR}, ${(0.45 * vis).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.moveTo(cx - R * 1.4, cy);
      ctx.lineTo(cx - R * 0.25, cy);
      ctx.moveTo(cx + R * 0.25, cy);
      ctx.lineTo(cx + R * 1.4, cy);
      ctx.moveTo(cx, cy - R * 1.4);
      ctx.lineTo(cx, cy - R * 0.25);
      ctx.moveTo(cx, cy + R * 0.25);
      ctx.lineTo(cx, cy + R * 1.4);
      ctx.stroke();

      ctx.beginPath();
      for (let a = 0; a < Math.PI * 2 - 0.001; a += Math.PI / 6) {
        const c = Math.cos(a);
        const s = Math.sin(a);
        ctx.moveTo(cx + c * R, cy + s * R);
        ctx.lineTo(cx + c * (R + 6), cy + s * (R + 6));
      }
      ctx.stroke();

      ctx.fillStyle = `rgba(${FLARE_COLOR}, ${(0.55 * vis).toFixed(3)})`;
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.fillText("RECALIBRATING", cx, cy + R + 22);

      ctx.restore();
    }

    function draw(now, force) {
      ctx.clearRect(0, 0, width, height);

      // Parallax eases toward the pointer only while the field is at rest -- during a pan it
      // would be a second, competing motion, which is what made the old slew look messy.
      if (!reduced && !slew && width > 0 && height > 0) {
        const targetX = -((pointerX / width) * 2 - 1) * MAX_PARALLAX;
        const targetY = -((pointerY / height) * 2 - 1) * MAX_PARALLAX;
        ox += (targetX - ox) * 0.06;
        oy += (targetY - oy) * 0.06;
      }

      // A bearing change: pan if we can, swap instantly if we cannot. Not gated on !slew --
      // a change mid-pan retargets from whatever is on screen (see beginSlew).
      if (bearingRef.current !== currentBearing) {
        if (reduced) {
          currentBearing = bearingRef.current;
          field = fieldFor(currentBearing);
        } else {
          beginSlew(bearingRef.current, now);
        }
      }

      if (slew) {
        const p = Math.min(1, (now - slew.startAt) / SLEW_MS);
        // A pivot, not a slide. First half: the old sky pulls back, dims and twists away.
        // Overlapping second half: the new sky pushes in from behind, untwisting to rest.
        // Nothing translates, so there is no "which direction" to read as clunky.
        const R = 0.10; // ~5.7 degrees of twist
        const outP = clamp01(p / 0.55);
        const inP = clamp01((p - 0.4) / 0.6);

        if (outP < 1) {
          drawField(slew.from, {
            scale: 1 - 0.18 * easeIn(outP),
            rot: -slew.dir * R * easeIn(outP),
            alpha: clamp01(1 - 1.3 * outP),
          }, now, false);
        }
        if (inP > 0) {
          drawField(slew.to, {
            scale: 0.82 + 0.18 * easeOut(inP),
            rot: slew.dir * R * (1 - easeOut(inP)),
            alpha: clamp01(1.3 * inP),
          }, now, false);
        }
        drawReticle(p, slew.dir);
        if (p >= 1) {
          field = slew.to;
          slew = null;
          nextFlareAt = now + 3000 + Math.random() * 5000;
        }
        lastDraw = now;
        return;
      }

      if (!reduced) {
        if (flareIdx < 0 && now >= nextFlareAt && field?.stars.length) {
          flareIdx = (Math.random() * field.stars.length) | 0;
          flareStart = now;
          flareDur = 220 + Math.random() * 320;
        } else if (flareIdx >= 0 && now - flareStart >= flareDur) {
          flareIdx = -1;
          nextFlareAt = now + 4000 + Math.random() * 7000;
        }

        if (meteors.length === 0 && now >= nextMeteorAt && width > 0) {
          const lead = makeMeteor(width, height, now);
          meteors.push(lead);
          if (Math.random() < SHOWER_CHANCE) {
            const extra = 1 + ((Math.random() * 2) | 0);
            for (let k = 1; k <= extra; k++) meteors.push(makeShowerSibling(lead, now, k));
          }
        } else if (meteors.length && meteors.every((m) => now - m.startAt >= m.dur)) {
          meteors = [];
          nextMeteorAt = now + 20000 + Math.random() * 22000;
        }
      }

      drawField(field, null, now, true);

      for (let m = 0; m < meteors.length; m++) {
        const mp = meteorPose(meteors[m], now);
        if (!mp || mp.k <= 0) continue;

        const trail = ctx.createLinearGradient(mp.tx, mp.ty, mp.hx, mp.hy);
        trail.addColorStop(0, `rgba(${FLARE_COLOR}, 0)`);
        trail.addColorStop(1, `rgba(${STAR_COLOR}, ${(0.55 * mp.k).toFixed(3)})`);
        ctx.strokeStyle = trail;
        ctx.lineWidth = 1.6;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(mp.tx, mp.ty);
        ctx.lineTo(mp.hx, mp.hy);
        ctx.stroke();

        const head = ctx.createRadialGradient(mp.hx, mp.hy, 0, mp.hx, mp.hy, 7);
        head.addColorStop(0, `rgba(${STAR_COLOR}, ${(0.7 * mp.k).toFixed(3)})`);
        head.addColorStop(1, `rgba(${STAR_COLOR}, 0)`);
        ctx.fillStyle = head;
        ctx.beginPath();
        ctx.arc(mp.hx, mp.hy, 7, 0, Math.PI * 2);
        ctx.fill();
      }

      lastDraw = now;
      if (force) return;
    }

    function loop(now) {
      if (!running) return;
      if (now - lastDraw >= FRAME_MS) draw(now, false);
      raf = window.requestAnimationFrame(loop);
    }

    function onVisibility() {
      if (document.hidden) {
        running = false;
        if (raf) window.cancelAnimationFrame(raf);
        raf = 0;
      } else if (!running) {
        running = true;
        lastDraw = 0;
        raf = window.requestAnimationFrame(loop);
      }
    }

    function onPointerMove(event) {
      pointerX = event.clientX;
      pointerY = event.clientY;
    }

    let resizeTimer = 0;
    function onResize() {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(resize, 150);
    }

    resize();
    if (!reduced) {
      raf = window.requestAnimationFrame(loop);
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pointermove", onPointerMove, { passive: true });
    }
    window.addEventListener("resize", onResize);

    return () => {
      running = false;
      if (raf) window.cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="observatory-starfield" aria-hidden="true" />;
}
