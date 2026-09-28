import React from "react";

// The sky behind the app in Day mode -- Starfield's daytime counterpart: one canvas, fixed
// behind everything, pointer-inert and aria-hidden.
//
// A clear sky and the sun, nothing else. It used to pick random weather on every load, with
// drifting clouds, overcast and rain; the clouds read as grey smudges crossing the content, and
// weather behind a work tool is noise. With nothing moving there is no animation loop: it draws
// once, and again when the window is resized.

// Four stops, not two: real sky colour is not a straight interpolation. It stays a saturated
// blue through most of the zenith, then pales fast in the last quarter toward the horizon
// (atmospheric scattering thickens the more air you are looking through) -- a plain
// top-to-bottom lerp skips that pale band entirely and reads flat.
function drawSky(ctx, width, height) {
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, "#1f6fc4");
  grad.addColorStop(0.45, "#4a9be0");
  grad.addColorStop(0.8, "#a8d8f5");
  grad.addColorStop(1, "#e4f3ff");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
}

// Three layered passes rather than one flat circle: a wide, faint outer corona (the haze real
// sun glare has), a tighter warm-to-white inner glow, then the disc itself slightly desaturated
// at its own edge so it does not read as a flat sticker.
function drawSun(ctx, width, height) {
  const sx = width * 0.78;
  const sy = height * 0.16;
  const r = Math.min(width, height) * 0.075;

  const corona = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 7);
  corona.addColorStop(0, "rgba(255, 250, 224, 0.16)");
  corona.addColorStop(0.4, "rgba(255, 244, 214, 0.08)");
  corona.addColorStop(1, "rgba(255, 244, 214, 0)");
  ctx.fillStyle = corona;
  ctx.beginPath();
  ctx.arc(sx, sy, r * 7, 0, Math.PI * 2);
  ctx.fill();

  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 2.4);
  glow.addColorStop(0, "rgba(255, 252, 235, 0.85)");
  glow.addColorStop(0.55, "rgba(255, 240, 200, 0.35)");
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

export function DaySky({ active = true }) {
  const canvasRef = React.useRef(null);

  React.useEffect(() => {
    if (!active) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) return undefined;

    function paint() {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawSky(ctx, width, height);
      drawSun(ctx, width, height);
    }

    let resizeTimer = 0;
    function onResize() {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(paint, 150);
    }

    paint();
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
    };
  }, [active]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="observatory-daysky" aria-hidden="true" />;
}
