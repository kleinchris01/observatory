import React from "react";

// The sky behind the app in Day mode -- Starfield's daytime counterpart, same discipline:
// one canvas, fixed behind everything, pointer-inert and aria-hidden, ~30fps, stops when the
// tab is hidden, a single static frame (no loop) under prefers-reduced-motion.
//
// Unlike Starfield, the weather is NOT seeded off anything stable -- it is genuinely random
// per mount, picked fresh with Math.random() every time Day mode loads, because that
// unpredictability (sometimes bright and sunny, sometimes overcast and raining) is the
// entire point of it. Reloading the same tab can show a different sky; that is correct.
//
// Four weather states, roughly in order of how calm they read:
//   sunny   -- clear gradient, a soft sun with a bloom, one or two slow-drifting light clouds
//   partly  -- more cloud than sunny, sun still visible through gaps
//   cloudy  -- a full overcast layer, dimmer light, no sun
//   rainy   -- the cloudy layer, plus falling rain and an occasional distant lightning flash

const FRAME_MS = 1000 / 30;

const WEATHER_WEIGHTS = [
  ["sunny", 0.35],
  ["partly", 0.25],
  ["cloudy", 0.2],
  ["rainy", 0.2],
];

export function pickWeather(rand = Math.random) {
  const r = rand();
  let acc = 0;
  for (const [name, weight] of WEATHER_WEIGHTS) {
    acc += weight;
    if (r < acc) return name;
  }
  return WEATHER_WEIGHTS[WEATHER_WEIGHTS.length - 1][0];
}

// One cloud: a cluster of overlapping puffs, each drawn as a soft radial gradient rather than
// a flat-filled circle -- a solid circle has a hard edge no real cloud has, and a field of
// them reads as a cartoon speech-bubble cluster instead of a cloud. A wider, flatter puff
// arrangement (dx spread wider than dy) plus a few small puffs riding higher than the rest
// gives the cumulus silhouette real clouds have -- a flat-ish base with billowing top -- rather
// than a uniform round blob.
function makeCloud(w, h, depth) {
  const puffCount = 5 + Math.floor(Math.random() * 5);
  const baseR = (16 + depth * 44) * (0.8 + Math.random() * 0.5);
  const puffs = [];
  for (let i = 0; i < puffCount; i++) {
    const t = puffCount > 1 ? i / (puffCount - 1) : 0.5; // 0..1 across the cloud's width
    // A gentle arch: puffs bow upward toward the middle, flatten toward the ends, so the
    // silhouette has a base to sit on instead of drifting in every direction equally.
    const arch = Math.sin(t * Math.PI);
    puffs.push({
      dx: (t - 0.5) * baseR * 2.4,
      dy: -arch * baseR * 0.7 + (Math.random() - 0.5) * baseR * 0.25,
      r: baseR * (0.5 + arch * 0.35 + Math.random() * 0.35),
    });
  }
  return {
    x: Math.random() * w,
    y: h * (0.05 + Math.random() * 0.3) + depth * h * 0.05,
    depth,
    speed: (3 + depth * 10) / 1000, // px/ms, far clouds drift slower
    puffs,
    spanR: baseR * 1.6,
    alpha: 0.3 + depth * 0.45,
  };
}

function makeRaindrop(w, h) {
  const depth = Math.random();
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    len: 8 + depth * 16,
    speed: 0.4 + depth * 0.9, // px/ms
    depth,
  };
}

export function DaySky({ active = true }) {
  const canvasRef = React.useRef(null);
  // Picked once per mount (per load), not per render -- React.useState's initializer runs
  // exactly once, which is what "fresh weather every time this loads" means here.
  const [weather] = React.useState(() => pickWeather());

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

    const cloudy = weather === "partly" || weather === "cloudy" || weather === "rainy";
    const raining = weather === "rainy";

    let clouds = [];
    let raindrops = [];
    let nextFlashAt = performance.now() + 8000 + Math.random() * 20000;
    let flashUntil = 0;

    function seedClouds() {
      const count = weather === "sunny" ? 2 : weather === "partly" ? 5 : 9;
      clouds = Array.from({ length: count }, () => makeCloud(width, height, Math.random()));
    }

    function seedRain() {
      const count = raining ? Math.max(80, Math.min(320, Math.round((width * height) / 6000))) : 0;
      raindrops = Array.from({ length: count }, () => makeRaindrop(width, height));
    }

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seedClouds();
      seedRain();
      draw(performance.now());
    }

    // Four stops, not two: real sky colour is not a straight interpolation. It stays a
    // saturated blue through most of the zenith, then pales fast in the last quarter toward
    // the horizon (atmospheric scattering thickens the more air you are looking through) --
    // a plain top-to-bottom lerp skips that pale band entirely and reads flat.
    function drawSky(now) {
      const flashK = now < flashUntil ? 1 - (flashUntil - now) / 260 : 0;
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      if (weather === "sunny") {
        grad.addColorStop(0, "#1f6fc4");
        grad.addColorStop(0.45, "#4a9be0");
        grad.addColorStop(0.8, "#a8d8f5");
        grad.addColorStop(1, "#e4f3ff");
      } else if (weather === "partly") {
        grad.addColorStop(0, "#3f76a8");
        grad.addColorStop(0.5, "#6b9cc2");
        grad.addColorStop(0.82, "#aebfc9");
        grad.addColorStop(1, "#d3dde1");
      } else if (weather === "cloudy") {
        grad.addColorStop(0, "#6b7683");
        grad.addColorStop(0.55, "#8a95a0");
        grad.addColorStop(1, "#b7bfc7");
      } else {
        const L = flashK * 55;
        grad.addColorStop(0, `rgb(${45 + L}, ${49 + L}, ${56 + L})`);
        grad.addColorStop(0.6, `rgb(${64 + L}, ${69 + L}, ${77 + L})`);
        grad.addColorStop(1, `rgb(${88 + L}, ${93 + L}, ${99 + L})`);
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
    }

    // Three layered passes rather than one flat circle: a wide, faint outer corona (the haze
    // real sun glare has), a tighter warm-to-white inner glow, then the disc itself slightly
    // desaturated at its own edge so it does not read as a flat sticker.
    function drawSun() {
      if (weather !== "sunny" && weather !== "partly") return;
      const sx = width * 0.78;
      const sy = height * 0.16;
      const r = Math.min(width, height) * (weather === "sunny" ? 0.075 : 0.05);
      const k = weather === "sunny" ? 1 : 0.55;

      const corona = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 7);
      corona.addColorStop(0, `rgba(255, 250, 224, ${0.16 * k})`);
      corona.addColorStop(0.4, `rgba(255, 244, 214, ${0.08 * k})`);
      corona.addColorStop(1, "rgba(255, 244, 214, 0)");
      ctx.fillStyle = corona;
      ctx.beginPath();
      ctx.arc(sx, sy, r * 7, 0, Math.PI * 2);
      ctx.fill();

      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 2.4);
      glow.addColorStop(0, `rgba(255, 252, 235, ${0.85 * k})`);
      glow.addColorStop(0.55, `rgba(255, 240, 200, ${0.35 * k})`);
      glow.addColorStop(1, "rgba(255, 240, 200, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(sx, sy, r * 2.4, 0, Math.PI * 2);
      ctx.fill();

      const disc = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
      disc.addColorStop(0, "rgba(255, 255, 250, 0.98)");
      disc.addColorStop(0.7, "rgba(255, 249, 224, 0.96)");
      disc.addColorStop(1, "rgba(255, 233, 173, 0.9)");
      ctx.fillStyle = disc;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Two passes per puff: a soft, downward-offset shadow wash first (so the cluster reads as
    // lit from above, giving it volume instead of looking like a flat grey smear), then the
    // lit body on top, each as a radial gradient -- never a flat-filled circle, which is what
    // read as a cartoon. A light blur on the whole layer (where the canvas supports filters;
    // harmless no-op where it does not) melts the puff outlines into each other the way real
    // cloud edges never resolve to a hard line.
    function drawClouds(dt) {
      if (!cloudy) return;
      const dark = weather === "rainy" || weather === "cloudy";
      const lit = dark ? "158, 165, 176" : "255, 255, 255";
      const shade = dark ? "94, 101, 113" : "196, 209, 224";
      const shadow = dark ? "60, 66, 76" : "140, 156, 178";

      ctx.save();
      if (typeof ctx.filter === "string") ctx.filter = "blur(7px)";
      for (const c of clouds) {
        c.x += c.speed * dt;
        if (c.x - c.spanR > width) c.x = -c.spanR;

        for (const p of c.puffs) {
          const sy = c.y + p.dy + p.r * 0.4;
          const g = ctx.createRadialGradient(c.x + p.dx, sy, 0, c.x + p.dx, sy, p.r * 1.05);
          g.addColorStop(0, `rgba(${shadow}, ${c.alpha * 0.4})`);
          g.addColorStop(1, `rgba(${shadow}, 0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(c.x + p.dx, sy, p.r * 1.05, 0, Math.PI * 2);
          ctx.fill();
        }
        for (const p of c.puffs) {
          const g = ctx.createRadialGradient(
            c.x + p.dx, c.y + p.dy - p.r * 0.2, p.r * 0.05,
            c.x + p.dx, c.y + p.dy, p.r
          );
          g.addColorStop(0, `rgba(${lit}, ${c.alpha})`);
          g.addColorStop(0.75, `rgba(${lit}, ${c.alpha * 0.9})`);
          g.addColorStop(1, `rgba(${shade}, ${c.alpha * 0.55})`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(c.x + p.dx, c.y + p.dy, p.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    function drawRain(dt) {
      if (!raining) return;
      ctx.strokeStyle = "rgba(214, 228, 240, 0.4)";
      ctx.lineWidth = 1;
      ctx.lineCap = "round";
      for (const d of raindrops) {
        d.y += d.speed * dt;
        d.x -= d.speed * dt * 0.22; // a slight slant
        if (d.y > height) { d.y = -d.len; d.x = Math.random() * width; }
        ctx.globalAlpha = 0.25 + d.depth * 0.45;
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - d.len * 0.22, d.y + d.len);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    function maybeFlash(now) {
      if (!raining || reduced) return;
      if (now >= nextFlashAt && flashUntil < now) {
        flashUntil = now + 260;
        nextFlashAt = now + 10000 + Math.random() * 24000;
      }
    }

    function draw(now) {
      const dt = lastDraw ? now - lastDraw : FRAME_MS;
      maybeFlash(now);
      drawSky(now);
      drawSun();
      drawClouds(reduced ? 0 : dt);
      drawRain(reduced ? 0 : dt);
      lastDraw = now;
    }

    function loop(now) {
      if (!running) return;
      if (now - lastDraw >= FRAME_MS) draw(now);
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
  }, [active, weather]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="observatory-daysky" data-weather={weather} aria-hidden="true" />;
}
