export type HraIconAttribute = string | number;
export type HraIconElement = readonly [
  string,
  Readonly<Record<string, HraIconAttribute>>,
];
export type HraIconData = readonly HraIconElement[];

function icon(...elements: HraIconElement[]): HraIconData {
  return Object.freeze(elements);
}

const closeIcon = icon(
  ["line", { key: "a", x1: 6, x2: 18, y1: 6, y2: 18 }],
  ["line", { key: "b", x1: 18, x2: 6, y1: 6, y2: 18 }],
);
const menuIcon = icon(
  ["line", { key: "a", x1: 4, x2: 20, y1: 6, y2: 6 }],
  ["line", { key: "b", x1: 4, x2: 20, y1: 12, y2: 12 }],
  ["line", { key: "c", x1: 4, x2: 20, y1: 18, y2: 18 }],
);
const minusIcon = icon(
  ["line", { key: "a", x1: 5, x2: 19, y1: 12, y2: 12 }],
);
const plusIcon = icon(
  ["line", { key: "a", x1: 5, x2: 19, y1: 12, y2: 12 }],
  ["line", { key: "b", x1: 12, x2: 12, y1: 5, y2: 19 }],
);
const searchIcon = icon(
  ["circle", { cx: 10.5, cy: 10.5, key: "a", r: 5.5 }],
  ["line", { key: "b", x1: 14.5, x2: 20, y1: 14.5, y2: 20 }],
);
const helpIcon = icon(
  ["circle", { cx: 12, cy: 12, key: "a", r: 9 }],
  ["path", { d: "M9.8 9a2.4 2.4 0 1 1 3.4 2.2c-.8.4-1.2 1-1.2 1.8", key: "b" }],
  ["circle", { cx: 12, cy: 17, fill: "currentColor", key: "c", r: 0.7, stroke: "none" }],
);
const playIcon = icon(
  ["path", { d: "M9 7.5 17 12 9 16.5Z", key: "a" }],
);
const stopIcon = icon(
  ["rect", { height: 10, key: "a", rx: 1, width: 10, x: 7, y: 7 }],
);
const sunIcon = icon(
  ["circle", { cx: 12, cy: 12, key: "a", r: 4 }],
  ["path", { d: "M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4", key: "b" }],
);
const moonIcon = icon(
  ["path", { d: "M18.5 15.5A7.5 7.5 0 0 1 8.5 5.5a7.5 7.5 0 1 0 10 10Z", key: "a" }],
);
const computerIcon = icon(
  ["rect", { height: 13, key: "a", rx: 1.5, width: 18, x: 3, y: 4 }],
  ["path", { d: "M9 21h6M12 17v4", key: "b" }],
);
const downloadIcon = icon(
  ["path", { d: "M12 4v11M8 11l4 4 4-4M5 20h14", key: "a" }],
);
const copyIcon = icon(
  ["rect", { height: 11, key: "a", rx: 1.5, width: 11, x: 8, y: 8 }],
  ["path", { d: "M16 8V6.5A1.5 1.5 0 0 0 14.5 5h-8A1.5 1.5 0 0 0 5 6.5v8A1.5 1.5 0 0 0 6.5 16H8", key: "b" }],
);
const moreIcon = icon(
  ["circle", { cx: 5, cy: 12, fill: "currentColor", key: "a", r: 1, stroke: "none" }],
  ["circle", { cx: 12, cy: 12, fill: "currentColor", key: "b", r: 1, stroke: "none" }],
  ["circle", { cx: 19, cy: 12, fill: "currentColor", key: "c", r: 1, stroke: "none" }],
);
const refreshIcon = icon(
  ["path", { d: "M19 8V4l-2 2a8 8 0 1 0 2.2 8", key: "a" }],
);
const genericProfileIcon = icon(
  ["circle", { cx: 12, cy: 12, key: "a", r: 8 }],
  ["circle", { cx: 12, cy: 9.5, key: "b", r: 2.5 }],
  ["path", { d: "M7.5 17c1-2.2 2.5-3.3 4.5-3.3s3.5 1.1 4.5 3.3", key: "c" }],
);

export const Cancel01Icon = closeIcon;
export const Menu01Icon = menuIcon;
export const MinusSignIcon = minusIcon;
export const PlusSignIcon = plusIcon;
export const Search01Icon = searchIcon;
export const HelpCircleIcon = helpIcon;
export const PlayIcon = playIcon;
export const StopIcon = stopIcon;
export const Sun03Icon = sunIcon;
export const Moon02Icon = moonIcon;
export const ComputerIcon = computerIcon;
export const Download01Icon = downloadIcon;
export const CopyLinkIcon = copyIcon;
export const MoreHorizontalIcon = moreIcon;
export const RefreshIcon = refreshIcon;

// The shared UI package imports its finite social catalog from one module even
// when HRA renders only the appearance controls. Product pages use named text
// links, so these neutral marks are a safe compatibility fallback.
export const BlueskyIcon = genericProfileIcon;
export const GithubIcon = genericProfileIcon;
export const InstagramIcon = genericProfileIcon;
export const Linkedin01Icon = genericProfileIcon;
export const NewTwitterIcon = genericProfileIcon;
export const ThreadsIcon = genericProfileIcon;
export const YoutubeIcon = genericProfileIcon;
