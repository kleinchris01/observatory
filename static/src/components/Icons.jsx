import React from "react";
import {
  Stack,
  Pulse,
  Lightning,
  Folder,
  ChartBar,
  Warning,
  WarningCircle,
  Info,
  Scissors,
  CheckCircle,
  Check,
  X,
  Gear,
  ArrowsClockwise,
  Lock,
  Clock,
  Sliders,
} from "@phosphor-icons/react";

export function useLiveDuration(startedAt) {
  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    if (!startedAt) { setElapsed(0); return; }
    const update = () => setElapsed(Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
    update();
    const handle = setInterval(update, 1000);
    return () => clearInterval(handle);
  }, [startedAt]);
  const h = Math.floor(elapsed / 3600), m = Math.floor((elapsed % 3600) / 60), s = elapsed % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// name -> Phosphor icon component. Only names actually referenced anywhere in the
// app are mapped (verified via usage grep before this migration) -- sun/moon/
// chevronDown/chevronUp/externalLink were dead entries in the old hand-rolled
// SVG-path map and were dropped rather than translated.
export const ICON_COMPONENTS = {
  layers: Stack,
  activity: Pulse,
  zap: Lightning,
  folder: Folder,
  barChart: ChartBar,
  alertTriangle: Warning,
  alertCircle: WarningCircle,
  info: Info,
  scissors: Scissors,
  checkCircle: CheckCircle,
  check: Check,
  x: X,
  settings: Gear,
  refreshCw: ArrowsClockwise,
  lock: Lock,
  clock: Clock,
  sliders: Sliders,
};

// Validated categorical palette (dataviz skill's reference instance, references/palette.md) --
// not hand-picked hex values. The old single CHART_PALETTE was literally the dark theme's
// --cool/--warm token values reused as hex constants: correct-looking in dark mode, but an
// early hand-authored replacement for it (tried while building this) FAILED the skill's
// validator on chroma floor and normal-vision separation in both modes -- confirming "looks
// fine" isn't the same as colorblind-safe. These 8 slots pass every check (light: relief-rule
// WARN on 3 slots' raw contrast, mitigated by this app's existing direct-label/legend usage
// on every chart; dark: clean pass). Order is the CVD-safety mechanism -- assign by slot
// index, never re-sorted or cycled.
const DARK_CHART_PALETTE = ["#3987e5", "#008300", "#d55181", "#c98500", "#199e70", "#d95926", "#9085e9", "#e66767"];
const LIGHT_CHART_PALETTE = ["#2a78d6", "#008300", "#e87ba4", "#eda100", "#1baf7a", "#eb6834", "#4a3aa7", "#e34948"];

export function useColorTheme() {
  const [theme, setTheme] = React.useState(() => document.documentElement.dataset.theme || "dark");
  React.useEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver(() => setTheme(target.dataset.theme || "dark"));
    observer.observe(target, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export function useChartPalette() {
  const theme = useColorTheme();
  return theme === "light" ? LIGHT_CHART_PALETTE : DARK_CHART_PALETTE;
}

// Kept for any lingering direct import -- prefer useChartPalette() in new code so
// chart colors actually follow the theme toggle instead of staying dark-mode-only.
export const CHART_PALETTE = DARK_CHART_PALETTE;

export function Icon({ name, size = 16, weight = "regular" }) {
  const Component = ICON_COMPONENTS[name];
  if (!Component) return null;
  return <Component size={size} weight={weight} color="currentColor" aria-hidden="true" />;
}
