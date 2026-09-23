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

// One cloud: a cluster of overlapping soft circles so it reads as a cloud shape rather than a
// single blob, drifting left to right at its own depth-scaled speed.
function makeCloud(w, h, depth) {
  const puffCount = 4 + Math.floor(Math.random() * 4);
  const baseR = (18 + depth * 46) * (0.8 + Math.random() * 0.5);
  const puffs = [];
  for (let i = 0; i < puffCount; i++) {
    puffs.push({
      dx: (i - puffCount / 2) * baseR * 0.62 + (Math.random() - 0.5) * baseR * 0.3,
      dy: (Math.random() - 0.5) * baseR * 0.5,
      r: baseR * (0.55 + Math.random() * 0.55),
    });
  }
  return {
    x: Math.random() * w,
    y: h * (0.06 + Math.random() * 0.32) + depth * h * 0.05,
    depth,
    speed: (3 + depth * 10) / 1000, // px/ms, far clouds drift slower
    puffs,
    alpha: 0.35 + depth * 0.4,
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

    function drawSky(now) {
      const flashK = now < flashUntil ? 1 - (flashUntil - now) / 260 : 0;
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      if (weather === "sunny") {
        grad.addColorStop(0, "#4fa8f0");
        grad.addColorStop(1, "#bfe3ff");
      } else if (weather === "partly") {
        grad.addColorStop(0, "#6fa3c9");
        grad.addColorStop(1, "#cdd9df");
      } else if (weather === "cloudy") {
        grad.addColorStop(0, "#8a97a3");
        grad.addColorStop(1, "#c3cad0");
      } else {
        grad.addColorStop(0, `rgb(${68 + flashK * 90}, ${74 + flashK * 90}, ${82 + flashK * 90})`);
        grad.addColorStop(1, `rgb(${101 + flashK * 70}, ${107 + flashK * 70}, ${112 + flashK * 70})`);
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
    }

    function drawSun() {
      if (weather !== "sunny" && weather !== "partly") return;
      const sx = width * 0.78;
      const sy = height * 0.16;
      const r = Math.min(width, height) * (weather === "sunny" ? 0.09 : 0.06);
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 4);
      const bloom = weather === "sunny" ? 0.55 : 0.3;
      glow.addColorStop(0, `rgba(255, 244, 214, ${bloom})`);
      glow.addColorStop(1, "rgba(255, 244, 214, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(sx, sy, r * 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(255, 250, 235, 0.95)";
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    function drawClouds(now, dt) {
      if (!cloudy) return;
      for (const c of clouds) {
        c.x += c.speed * dt;
        if (c.x - 120 > width) c.x = -120;
        ctx.fillStyle = weather === "rainy" || weather === "cloudy"
          ? `rgba(120, 128, 138, ${c.alpha})`
          : `rgba(255, 255, 255, ${c.alpha})`;
        for (const p of c.puffs) {
          ctx.beginPath();
          ctx.arc(c.x + p.dx, c.y + p.dy, p.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    function drawRain(dt) {
      if (!raining) return;
      ctx.strokeStyle = "rgba(210, 226, 240, 0.55)";
      ctx.lineWidth = 1;
      for (const d of raindrops) {
        d.y += d.speed * dt;
        d.x -= d.speed * dt * 0.25; // a slight slant
        if (d.y > height) { d.y = -d.len; d.x = Math.random() * width; }
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - d.len * 0.25, d.y + d.len);
        ctx.stroke();
      }
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
      drawClouds(now, reduced ? 0 : dt);
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
