/* =========================================================================
   REPORT THEMES

   A small, fixed catalog of color palettes a school can pick for its
   downloaded PDF reports (School Settings → "Report Theme" →
   SchoolSettings.reportTheme, see ensureSchema.js). Deliberately NOT a
   free-form color picker: every entry here has been checked for enough
   contrast between `primary` and `onPrimary` (the table/section header
   bars are filled with `primary` and their text drawn in `onPrimary`),
   so a school can never accidentally pick a combination that makes a
   report unreadable.

   Consumed by utils/reportExport.js's buildReportPdf — the one shared
   PDF engine every report export (Summary, Subject Results, Grade
   Distribution, Timetable, ...) already goes through (§33/§51), so
   picking a theme here re-themes every one of them at once, never just
   one report type.

   `key` is what's stored on SchoolSettings.reportTheme. Keep this list's
   keys stable — they're a saved value, not just a display label.
========================================================================= */

const THEMES = {
  slate: {
    name: "Slate (default)",
    primary: "#2c3e50",   // section/table header bars
    onPrimary: "#ffffff", // text drawn on top of `primary`
    zebra: "#f4f6f7",     // alternating row fill
    rule: "#cccccc",      // thin divider line under the report header
  },
  navy: {
    name: "Navy",
    primary: "#1B3A6B",
    onPrimary: "#ffffff",
    zebra: "#EEF2F8",
    rule: "#B9C6DA",
  },
  forest: {
    name: "Forest Green",
    primary: "#1F5C3F",
    onPrimary: "#ffffff",
    zebra: "#EEF6F1",
    rule: "#BBD7C7",
  },
  maroon: {
    name: "Maroon",
    primary: "#6E1F2A",
    onPrimary: "#ffffff",
    zebra: "#F7ECEE",
    rule: "#D9BEC2",
  },
  royal: {
    name: "Royal Purple",
    primary: "#3B2F6B",
    onPrimary: "#ffffff",
    zebra: "#F0EEF7",
    rule: "#C6C0DE",
  },
  charcoal: {
    name: "Charcoal",
    primary: "#2B2B2B",
    onPrimary: "#ffffff",
    zebra: "#F2F2F2",
    rule: "#CCCCCC",
  },
  amber: {
    name: "Amber",
    primary: "#8A5A00",
    onPrimary: "#ffffff",
    zebra: "#FBF3E3",
    rule: "#E4C98A",
  },
  teal: {
    name: "Teal",
    primary: "#0F5E5A",
    onPrimary: "#ffffff",
    zebra: "#E9F5F4",
    rule: "#B7DAD7",
  },
  crimson: {
    name: "Crimson",
    primary: "#8B1E2D",
    onPrimary: "#ffffff",
    zebra: "#FBEAEC",
    rule: "#E3B7BD",
  },
  indigo: {
    name: "Indigo",
    primary: "#2F3C7E",
    onPrimary: "#ffffff",
    zebra: "#ECEEF8",
    rule: "#C2C8E8",
  },
  emerald: {
    name: "Emerald",
    primary: "#0B6E4F",
    onPrimary: "#ffffff",
    zebra: "#E8F5EF",
    rule: "#B3DCC9",
  },
  burntOrange: {
    name: "Burnt Orange",
    primary: "#9A3412",
    onPrimary: "#ffffff",
    zebra: "#FBEDE5",
    rule: "#E7BFA9",
  },
  steel: {
    name: "Steel Blue",
    primary: "#33587A",
    onPrimary: "#ffffff",
    zebra: "#EBF1F6",
    rule: "#C1D2E1",
  },
  plum: {
    name: "Plum",
    primary: "#5B2A5E",
    onPrimary: "#ffffff",
    zebra: "#F2EBF3",
    rule: "#D6BFD8",
  },
  graphite: {
    name: "Graphite",
    primary: "#3A3F44",
    onPrimary: "#ffffff",
    zebra: "#EEEFF0",
    rule: "#C9CCCF",
  },
  olive: {
    name: "Olive",
    primary: "#556B2F",
    onPrimary: "#ffffff",
    zebra: "#EFF3E7",
    rule: "#CBD8B4",
  },
  burgundy: {
    name: "Burgundy",
    primary: "#4A0E1E",
    onPrimary: "#ffffff",
    zebra: "#F1E4E7",
    rule: "#D3AEB6",
  },
  skyBlue: {
    name: "Sky Blue",
    primary: "#1D5A8A",
    onPrimary: "#ffffff",
    zebra: "#E9F2FA",
    rule: "#B8D5EA",
  },
};

const DEFAULT_THEME_KEY = "slate";

/* Returns the palette for a stored theme key, falling back to the
   default (slate) for null/blank/unrecognized values — never throws, so
   a report export never fails just because a tenant's saved key becomes
   stale (e.g. this catalog loses an entry in a future release). */
function resolveReportTheme(key) {
  return THEMES[key] || THEMES[DEFAULT_THEME_KEY];
}

// { key, name, primary, onPrimary, zebra, rule } list for the School
// Settings picker — GET /api/school-settings/report-themes. Returns the
// FULL palette (not just key/name/primary) so a frontend consumer can
// fully theme a report with it too — e.g. StudentReport.jsx's on-screen/
// printed report card, which used to stay a fixed maroon regardless of
// the school's chosen reportTheme; it now resolves the same palette
// object this list hands back and applies primary/onPrimary/zebra/rule
// to its header band, section labels, table header and zebra rows.
// None of this is sensitive — it's a static list of color swatches.
function listReportThemes() {
  return Object.entries(THEMES).map(([key, t]) => ({
    key,
    name: t.name,
    primary: t.primary,
    onPrimary: t.onPrimary,
    zebra: t.zebra,
    rule: t.rule,
  }));
}

module.exports = { THEMES, DEFAULT_THEME_KEY, resolveReportTheme, listReportThemes };
