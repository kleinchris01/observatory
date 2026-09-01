import React from "react";

// The night sky behind the app.
//
// One canvas, fixed behind everything, pointer-inert and aria-hidden. It is decoration and
// must behave like it: almost nothing moves. Most stars sit at a fixed faint alpha; a few
// breathe by a hair; and once every several seconds exactly one flares briefly and settles
// again -- the "one flickers time to time". Never two at once, never a drift, never a
// screensaver.
//
// It costs as little as decoration should: ~30fps (a starfield does not need 60), the loop
// stops when the tab is hidden, and `prefers-reduced-motion` gets a single static frame and
// no loop at all. On a browser with no 2D context it renders nothing rather than throwing.

const FRAME_MS = 1000 / 30;
const STAR_COLOR = "226, 231, 242";      // warm white
const FLARE_COLOR = "150, 194, 255";     // the signal cyan, for the spark's glow

// Density scales with area but is capped hard -- a 4K display should not get 1,200 stars.
function starCountFor(w, h) {
  return Math.max(60, Math.min(260, Math.round((w * h) / 9000)));
}

function makeStars(w, h) {
  const n = starCountFor(w, h);
  const stars = new Array(n);
  for (let i = 0; i < n; i++) {
    stars[i] = {
      x: Math.random() * w,
      y: Math.random() * h,
      r: 0.4 + Math.random() * Math.random() * 1.1,   // biased small
      a: 0.12 + Math.random() * 0.55,                  // base alpha
      tw: Math.random() < 0.6 ? 0.03 + Math.random() * 0.09 : 0, // most barely breathe
      ts: 0.0006 + Math.random() * 0.0012,            // twinkle speed (rad/ms)
      tp: Math.random() * Math.PI * 2,                // phase
    };
  }
  return stars;
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
      }

      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        let alpha = s.a;
        if (!reduced && s.tw) alpha += s.tw * Math.sin(now * s.ts + s.tp);

        let radius = s.r;
        if (i === flareIdx) {
          // A quick spark: ease in over the first third, ease out over the rest.
          const p = (now - flareStart) / flareDur;
          const env = p < 0.33 ? p / 0.33 : 1 - (p - 0.33) / 0.67;
          const k = Math.max(0, Math.min(1, env));
          alpha = Math.min(1, alpha + 0.85 * k);
          radius = s.r + 0.9 * k;

          // Soft glow around the spark.
          const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 6 + 10 * k);
          g.addColorStop(0, `rgba(${FLARE_COLOR}, ${0.28 * k})`);
          g.addColorStop(1, `rgba(${FLARE_COLOR}, 0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(s.x, s.y, 6 + 10 * k, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.fillStyle = `rgba(${STAR_COLOR}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
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

    let resizeTimer = 0;
    function onResize() {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(resize, 150);
    }

    resize();
    if (!reduced) {
      raf = window.requestAnimationFrame(loop);
      document.addEventListener("visibilitychange", onVisibility);
    }
    window.addEventListener("resize", onResize);

    return () => {
      running = false;
      if (raf) window.cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="observatory-starfield" aria-hidden="true" />;
}
