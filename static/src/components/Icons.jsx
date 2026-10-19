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
  Copy,
  MagnifyingGlass,
  Users,
  Database,
  ShieldCheck,
  Bell,
  Flag,
  CaretLeft,
  CaretRight,
  CaretUp,
  CaretDown,
  Tag,
  Browser,
  SquaresFour,
  Kanban,
  ClipboardText,
  Wrench,
  ListChecks,
} from "@phosphor-icons/react";

export function useLiveDuration(startedAt) {
  const elapsed = Math.floor(useLiveElapsedMs(startedAt) / 1000);
  const h = Math.floor(elapsed / 3600),
    m = Math.floor((elapsed % 3600) / 60),
    s = elapsed % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// The same 1s tick as useLiveDuration, but the raw milliseconds. For progress estimates
// that do arithmetic against an expected duration rather than just printing a clock.
export function useLiveElapsedMs(startedAt) {
  const [ms, setMs] = React.useState(0);
  React.useEffect(() => {
    if (!startedAt) {
      setMs(0);
      return;
    }
    const base = new Date(startedAt).getTime();
    const update = () => setMs(Math.max(0, Date.now() - base));
    update();
    const handle = setInterval(update, 1000);
    return () => clearInterval(handle);
  }, [startedAt]);
  return ms;
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
  // Added for the shared SortFilterBar. An unmapped name renders as nothing at all, so a
  // search box would have shipped with an invisible affordance.
  search: MagnifyingGlass,
  checkCircle: CheckCircle,
  check: Check,
  x: X,
  settings: Gear,
  refreshCw: ArrowsClockwise,
  lock: Lock,
  clock: Clock,
  sliders: Sliders,
  copy: Copy,
  user: Users,
  database: Database,
  shield: ShieldCheck,
  bell: Bell,
  flag: Flag,
  caretLeft: CaretLeft,
  caretRight: CaretRight,
  // Live call sites, not dead weight: Panel's own collapse toggle (ui.jsx) and
  // ProjectsTab's disclosure both name these and have rendered no icon at all since the
  // Phosphor migration dropped them as "verified dead" -- the grep that verified it evidently
  // missed a dynamic `open ? "chevronUp" : "chevronDown"` ternary.
  chevronUp: CaretUp,
  chevronDown: CaretDown,
  // Added so the top-level admin nav can give every tab a genuinely distinct icon -- three
  // tabs shared "barChart", two shared "layers", two shared "activity", which cost nothing
  // while the collapsed sidebar always showed the label alongside it but made several tabs
  // indistinguishable from each other the moment the rail collapsed to icons only.
  tag: Tag,
  browser: Browser,
  grid: SquaresFour,
  kanban: Kanban,
  clipboardText: ClipboardText,
  wrench: Wrench,
  listChecks: ListChecks,
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
