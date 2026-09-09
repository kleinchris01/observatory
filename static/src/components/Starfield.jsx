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
// And #3: `bearing` names which part of the sky we are pointed at (the active tab). When it
// changes the telescope slews -- both fields pan past each other along a bearing-seeded
// direction while a reticle reads RECALIBRATING -- and settles on a fresh, bearing-seeded
// sky. All of the above is off under prefers-reduced-motion, where a bearing change is an
// instant swap.

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

// The direction the sky turns when we slew to this bearing. Seeded so a tab always slews the
// same way, spread around the compass so adjacent tabs do not all pan left.
export function bearingAngle(bearing) {
  return (hashString(bearing) % 3600) / 10 * (Math.PI / 180);
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

  const GAL_TINTS = [[255, 220, 190], [205, 220, 255], [220, 226, 222]];
  const galN = 2 + (rng() < 0.5 ? 1 : 0);
  const galaxies = [];
  for (let i = 0; i < galN; i++) {
    const rx = 34 + rng() * 64;
    galaxies.push({
      x: w * (0.12 + rng() * 0.76),
      y: h * (0.08 + rng() * 0.7),
      rx,
      ry: rx * (0.32 + rng() * 0.35),
      rot: rng() * Math.PI,
      tint: GAL_TINTS[i % GAL_TINTS.length].join(", "),
      alpha: 0.04 + rng() * 0.05,
    });
  }

  return { stars, galaxies, bandAngle };
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

const SLEW_MS = 780;
const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

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
    // Slew: { startAt, from, to, dx, dy } while the telescope is turning to a new bearing.
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
      slew = {
        startAt: now,
        from: field,
        to: fieldFor(nextBearing),
        dx: Math.cos(bearingAngle(nextBearing)),
        dy: Math.sin(bearingAngle(nextBearing)),
      };
      currentBearing = nextBearing;
      flareIdx = -1;
      meteors = [];
      nextMeteorAt = now + 9000 + Math.random() * 12000;
    }

    // One field -- galaxies, band haze, stars -- drawn at a pan offset and global alpha.
    // `effects` gates the twinkle-time-driven bits (flare, diffraction spikes); the slew
    // turns them off so the two panning fields stay quiet.
    function drawField(f, panX, panY, gAlpha, now, effects) {
      if (!f) return;

      for (let i = 0; i < f.galaxies.length; i++) {
        const gx = f.galaxies[i];
        ctx.save();
        ctx.translate(gx.x + panX + ox * 0.15, gx.y + panY + oy * 0.15);
        ctx.rotate(gx.rot);
        ctx.scale(1, gx.ry / gx.rx);
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, gx.rx);
        grad.addColorStop(0, `rgba(${gx.tint}, ${(gx.alpha * gAlpha).toFixed(3)})`);
        grad.addColorStop(0.6, `rgba(${gx.tint}, ${(gx.alpha * gAlpha * 0.4).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${gx.tint}, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, gx.rx, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Milky Way haze: a soft band, brightest along its spine.
      ctx.save();
      ctx.translate(width / 2 + panX + ox * 0.08, height / 2 + panY + oy * 0.08);
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
        const sx = s.x + panX + ox * s.depth;
        const sy = s.y + panY + oy * s.depth;

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
    }

    // The recalibration overlay: a reticle and a label, fading in and out across the slew.
    function drawReticle(p) {
      const vis = p < 0.3 ? p / 0.3 : p > 0.72 ? Math.max(0, (1 - p) / 0.28) : 1;
      if (vis <= 0) return;
      const cx = width / 2;
      const cy = height / 2;
      const R = Math.min(width, height) * 0.16;

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
    }

    function draw(now, force) {
      ctx.clearRect(0, 0, width, height);

      if (!reduced && width > 0 && height > 0) {
        const targetX = -((pointerX / width) * 2 - 1) * MAX_PARALLAX;
        const targetY = -((pointerY / height) * 2 - 1) * MAX_PARALLAX;
        ox += (targetX - ox) * 0.06;
        oy += (targetY - oy) * 0.06;
      }

      // A bearing change: slew if we can, swap instantly if we cannot.
      if (bearingRef.current !== currentBearing && !slew) {
        if (reduced) {
          currentBearing = bearingRef.current;
          field = fieldFor(currentBearing);
        } else {
          beginSlew(bearingRef.current, now);
        }
      }

      if (slew) {
        const p = Math.min(1, (now - slew.startAt) / SLEW_MS);
        const e = easeInOut(p);
        const d = Math.hypot(width, height) * 0.55;
        drawField(slew.from, -slew.dx * d * e, -slew.dy * d * e, Math.max(0, 1 - (p - 0.5) / 0.5), now, false);
        drawField(slew.to, slew.dx * d * (1 - e), slew.dy * d * (1 - e), Math.min(1, p / 0.45), now, false);
        drawReticle(p);
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

      drawField(field, 0, 0, 1, now, true);

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
