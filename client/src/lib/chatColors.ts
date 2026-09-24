// Must stay in sync with PRESET_COLORS in server/lib/workfmColors.ts — the
// server validates any color someone picks against that list, so offering
// anything else here would just get rejected. Not imported from a shared
// module because the client and server packages don't share one.
export const CHAT_NAME_COLORS = [
  "#FF0000",
  "#0000FF",
  "#00FF00",
  "#B22222",
  "#FF7F50",
  "#9ACD32",
  "#FF4500",
  "#2E8B57",
  "#DAA520",
  "#D2691E",
  "#5F9EA0",
  "#1E90FF",
  "#FF69B4",
  "#8A2BE2",
  "#00FF7F",
  "#FF1493",
  "#00BFFF",
  "#F08080",
  "#ADFF2F",
  "#20B2AA",
] as const;
