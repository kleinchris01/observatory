import React from "react";

// The night sky behind the app.
//
// One canvas, fixed behind everything, pointer-inert and aria-hidden. It is decoration and
// must stay cheap and calm: ~30fps (a starfield does not need 60), the loop stops when the
// tab is hidden, and `prefers-reduced-motion` gets a single static frame and no loop at all.
// On a browser with no 2D context it renders nothing rather than throwing.
//
// A few things move, and never more than one "event" at a time:
//   - most stars sit still; a subset breathe by a hair (depth-weighted, near stars more);
//   - a handful of the brightest near stars throw a faint diffraction cross at the peak of
//     that breath;
//   - once every several seconds exactly one star flares briefly and settles;
//   - once every 20-40s a shooting star crosses part of the sky and fades -- and roughly one
//     time in twelve that is a little shower of two or three on parallel tracks.
// The whole field also parallaxes a few pixels against the pointer -- near stars further
// than far ones -- which is what makes it read as sky rather than wallpaper. All of that is
// off under prefers-reduced-motion.

const FRAME_MS = 1000 / 30;
const STAR_COLOR = "226, 231, 242";      // warm white
const FLARE_COLOR = "150, 194, 255";     // the signal cyan, for the spark's glow and the meteor tail

// How far the field slides at the extremes of pointer travel. Small on purpose -- this is
// depth, not motion. Stars are generated across a viewport padded by this much on every side
// so the slide never exposes a bare edge.
const MAX_PARALLAX = 14;

// At most this many stars carry a diffraction cross, regardless of screen size -- it is a
// grace note, not a texture.
const MAX_SPIKE_STARS = 5;

// Chance a lone meteor is instead a small shower, and how many streaks it then carries.
const SHOWER_CHANCE = 0.08;

// Density scales with area but is capped hard -- a 4K display should not get 1,200 stars.
function starCountFor(w, h) {
  return Math.max(60, Math.min(260, Math.round((w * h) / 9000)));
}

// Each star gets a depth in [0,1): 0 is far (tiny, dim, still), 1 is near (larger, brighter,
// more likely to breathe, parallaxes most). The distribution is biased toward far so the
// field still reads as "mostly faint dust, a few bright ones".
function makeStars(w, h) {
  const n = starCountFor(w, h);
  const stars = new Array(n);
  let spikes = 0;
  for (let i = 0; i < n; i++) {
    const depth = Math.random() * Math.random();       // biased toward 0 / far
    // Near stars breathe; far stars almost never do.
    const tw = depth > 0.35 && Math.random() < 0.7 ? 0.03 + Math.random() * 0.09 : 0;
    // A capped handful of the closest breathing stars also get a diffraction cross.
    const spike = tw > 0 && depth > 0.6 && spikes < MAX_SPIKE_STARS && Math.random() < 0.5;
    if (spike) spikes += 1;
    stars[i] = {
      x: -MAX_PARALLAX + Math.random() * (w + MAX_PARALLAX * 2),
      y: -MAX_PARALLAX + Math.random() * (h + MAX_PARALLAX * 2),
      depth,
      r: 0.4 + depth * 1.5,                             // ~0.4 far -> ~1.9 near
      a: 0.1 + depth * 0.5 + Math.random() * 0.12,      // far dim, near bright, slight jitter
      tw,
      ts: 0.0006 + Math.random() * 0.0012,             // twinkle speed (rad/ms)
      tp: Math.random() * Math.PI * 2,                 // phase
      spike,
    };
  }
  return stars;
}

// ── Shooting star ─────────────────────────────────────────────────────────────
//
// A meteor's whole trajectory is decided once at spawn, so the draw loop only has to ask
// "where is it now". Both of these are pure and exported for testing -- the scheduling that
// calls them lives in the component.

// A fresh meteor: enters high, travels down and to the right on a shallow angle.
export function makeMeteor(w, h, now, rng = Math.random) {
  const ang = (Math.PI / 180) * (18 + rng() * 24);    // 18deg - 42deg below horizontal
  const diag = Math.hypot(w, h);
  const len = diag * (0.34 + rng() * 0.3);            // distance travelled across the sky
  const speed = 0.9 + rng() * 0.5;                    // px per ms
  return {
    x0: rng() * w * 0.9 - w * 0.05,                   // somewhere across the top
    y0: rng() * h * 0.35 - h * 0.1,
    dx: Math.cos(ang),
    dy: Math.sin(ang),
    len,
    startAt: now,
    dur: len / speed,
    tail: 90 + rng() * 140,                           // tail length in px
  };
}

// A sibling streak for a meteor shower: same heading as the lead, shifted sideways along the
// perpendicular and started a beat later, with its length and duration jittered a little so
// the group does not read as a rake. `index` is 1-based (the lead is index 0, unchanged).
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

// Head position, tail position and brightness at `now`, or null when the meteor is done (or
// not yet started). Brightness ramps fast, holds, then fades over the back half.
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

export function Starfield({ active = true }) {
  const canvasRef = React.useRef(null);

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
    let stars = [];
    let raf = 0;
    let lastDraw = 0;
    let running = true;

    // Flare state: one at a time, scheduled well apart.
    let flareIdx = -1;
    let flareStart = 0;
    let flareDur = 0;
    let nextFlareAt = performance.now() + 2500 + Math.random() * 6000;

    // Meteor state: a burst of one (usually) or a few (a shower), then a long wait. The
    // "one event at a time" rule holds -- a shower is one event that happens to have several
    // streaks in it, and nothing else fires until the last of them has faded.
    let meteors = [];
    let nextMeteorAt = performance.now() + 6000 + Math.random() * 12000;

    // Pointer parallax: store raw pointer coords, ease the field toward the implied offset
    // every frame. Starts centred so there is no opening jump.
    let pointerX = window.innerWidth / 2;
    let pointerY = window.innerHeight / 2;
    let ox = 0;
    let oy = 0;

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = makeStars(width, height);
      draw(performance.now(), true);
    }

    function draw(now, force) {
      ctx.clearRect(0, 0, width, height);

      // Ease the parallax offset toward where the pointer implies it should be. A no-op
      // under reduced motion (target stays 0,0) and when the pointer never moves.
      if (!reduced && width > 0 && height > 0) {
        const targetX = -((pointerX / width) * 2 - 1) * MAX_PARALLAX;
        const targetY = -((pointerY / height) * 2 - 1) * MAX_PARALLAX;
        ox += (targetX - ox) * 0.06;
        oy += (targetY - oy) * 0.06;
      }

      // Schedule / advance the flare.
      if (!reduced) {
        if (flareIdx < 0 && now >= nextFlareAt && stars.length) {
          flareIdx = (Math.random() * stars.length) | 0;
          flareStart = now;
          flareDur = 220 + Math.random() * 320;
        } else if (flareIdx >= 0 && now - flareStart >= flareDur) {
          flareIdx = -1;
          nextFlareAt = now + 4000 + Math.random() * 7000;
        }

        // Schedule / retire the meteor(s).
        if (meteors.length === 0 && now >= nextMeteorAt && width > 0) {
          const lead = makeMeteor(width, height, now);
          meteors.push(lead);
          if (Math.random() < SHOWER_CHANCE) {
            const extra = 1 + ((Math.random() * 2) | 0); // one or two more, so 2-3 total
            for (let k = 1; k <= extra; k++) meteors.push(makeShowerSibling(lead, now, k));
          }
        } else if (meteors.length && meteors.every((m) => now - m.startAt >= m.dur)) {
          meteors = [];
          nextMeteorAt = now + 20000 + Math.random() * 22000;
        }
      }

      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        const sx = s.x + ox * s.depth;
        const sy = s.y + oy * s.depth;

        const osc = !reduced && (s.tw || s.spike) ? Math.sin(now * s.ts + s.tp) : 0;
        let alpha = s.a + (s.tw ? s.tw * osc : 0);

        // A faint four-point diffraction cross, only in the top of the breath so it reads as
        // an occasional glint rather than a permanent fixture.
        if (s.spike && osc > 0) {
          const spk = osc * osc * osc;
          if (spk > 0.12) {
            const reach = s.r * 2.5 + 7 * spk;
            ctx.strokeStyle = `rgba(${STAR_COLOR}, ${(0.4 * spk).toFixed(3)})`;
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
        if (i === flareIdx) {
          // A quick spark: ease in over the first third, ease out over the rest.
          const p = (now - flareStart) / flareDur;
          const env = p < 0.33 ? p / 0.33 : 1 - (p - 0.33) / 0.67;
          const k = Math.max(0, Math.min(1, env));
          alpha = Math.min(1, alpha + 0.85 * k);
          radius = s.r + 0.9 * k;

          // Soft glow around the spark.
          const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, 6 + 10 * k);
          g.addColorStop(0, `rgba(${FLARE_COLOR}, ${0.28 * k})`);
          g.addColorStop(1, `rgba(${FLARE_COLOR}, 0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(sx, sy, 6 + 10 * k, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.fillStyle = `rgba(${STAR_COLOR}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      // The shooting star(s), drawn last so they pass in front of the field. No parallax --
      // a meteor is a foreground event and the offset would be imperceptible on a moving
      // streak. meteorPose returns null for a sibling whose staggered start is still in the
      // future, so the same loop handles the shower's fan-in for free.
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
