import React from "react";

// Icon geometry follows Tabler Icons visual conventions (MIT licensed): https://github.com/tabler/tabler-icons

export type UiIconName =
  | "arrow-down" | "arrow-left" | "arrow-right" | "arrow-up" | "check"
  | "check-circle" | "chevron-down" | "chevron-left" | "chevron-right"
  | "circle-x" | "code" | "copy" | "eye" | "external-link" | "globe"
  | "git-branch" | "image" | "layers" | "lock" | "loader" | "moon"
  | "monitor" | "paperclip" | "refresh" | "sparkles" | "square" | "sun"
  | "thumbs-down" | "thumbs-up" | "tool" | "x"
  | "film"
  // Image Editor extensions:
  | "crop" | "brush" | "highlighter" | "arrow" | "mosaic" | "type"
  | "sliders" | "download" | "undo" | "redo" | "rotate-cw"
  | "flip-horizontal" | "flip-vertical" | "circle" | "maximize"
  | "zoom-in" | "zoom-out" | "trash" | "shield-check" | "clipboard"
  | "user" | "clock" | "cloud" | "logout";

const paths: Record<UiIconName, React.ReactNode> = {
  "arrow-down": <path d="m6 9 6 6 6-6" />,
  "arrow-left": <path d="m15 6-6 6 6 6" />,
  "arrow-right": <path d="m9 6 6 6-6 6" />,
  "arrow-up": <path d="m6 15 6-6 6 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  "check-circle": <><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></>,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-left": <path d="m14 6-6 6 6 6" />,
  "chevron-right": <path d="m10 6 6 6-6 6" />,
  "circle-x": <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></>,
  code: <><path d="m8 9-3 3 3 3m8-6 3 3-3 3" /><path d="m14 5-4 14" /></>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  clipboard: <><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="m9 14 2 2 4-4" /></>,
  eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>,
  "external-link": <><path d="M14 5h5v5M19 5l-8 8" /><path d="M19 14v3a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  "git-branch": <><path d="M6 3v12a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V9" /><circle cx="6" cy="3" r="2" /><circle cx="18" cy="7" r="2" /><circle cx="12" cy="18" r="2" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-4-4L5 20" /></>,
  layers: <path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 4 9 5 9-5" />,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  loader: <><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1" /></>,
  moon: <path d="M20 15.5A8 8 0 0 1 8.5 4 8 8 0 1 0 20 15.5Z" />,
  monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
  paperclip: <path d="m20 11-7.5 7.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-7.5 7.5a2 2 0 0 1-3-3L14 7" />,
  refresh: <><path d="M20 11a8 8 0 0 0-14.5-4L3 10m0-5v5h5M4 13a8 8 0 0 0 14.5 4L21 14m0 5v-5h-5" /></>,
  sparkles: <><path d="m12 3-1.2 4.8L6 9l4.8 1.2L12 15l1.2-4.8L18 9l-4.8-1.2L12 3Z" /><path d="m19 15-.6 2.4L16 18l2.4.6L19 21l.6-2.4L22 18l-2.4-.6L19 15Z" /></>,
  square: <rect x="5" y="5" width="14" height="14" rx="2" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4" /></>,
  "thumbs-down": <path d="M7 10v10H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h2Zm0 0 3-7a2 2 0 0 1 2 2v3h6a2 2 0 0 1 2 2l-1 7a2 2 0 0 1-2 2h-7l-3-3" />,
  "thumbs-up": <path d="M7 14V4a2 2 0 0 1 2-2h2l1 6h6a2 2 0 0 1 2 2l-1 7a2 2 0 0 1-2 2H9l-2-3H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h2" />,
  tool: <><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.2 2.2-2.7-.7-.7-2.7 2.2-2.2Z" /></>,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  film: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 5v14m10 -14v14" /><path d="M3 10h4m10 0h4M3 14h4m10 0h4" /></>,

  // Image editing tools:
  crop: <><path d="M8 5v10a1 1 0 0 0 1 1h10" /><path d="M5 8h10a1 1 0 0 1 1 1v10" /></>,
  brush: <><path d="M3 21v-3.5a4 4 0 0 1 4-4h2.5l7-7a2.121 2.121 0 0 1 3 3l-7 7V19a4 4 0 0 1-4 4H3Z" /><path d="M14.5 5.5 18 9" /></>,
  highlighter: <><path d="m9 11-6 6v3h3l6-6" /><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" /></>,
  arrow: <><path d="M5 19 19 5" /><path d="M9 5h10v10" /></>,
  mosaic: <><rect x="3" y="3" width="6" height="6" /><rect x="9" y="9" width="6" height="6" /><rect x="15" y="15" width="6" height="6" /><rect x="15" y="3" width="6" height="6" /><rect x="3" y="15" width="6" height="6" /></>,
  type: <><path d="M4 7V4h16v3" /><path d="M12 4v16" /><path d="M9 20h6" /></>,
  sliders: <><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></>,
  download: <><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /><path d="m7 11 5 5 5-5" /><line x1="12" y1="4" x2="12" y2="16" /></>,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" /></>,
  redo: <><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13" /></>,
  "rotate-cw": <><path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4" /><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" /></>,
  "flip-horizontal": <><path d="m3 7 5 5-5 5V7Z" /><path d="m21 7-5 5 5 5V7Z" /><line x1="12" y1="3" x2="12" y2="21" strokeDasharray="2 2" /></>,
  "flip-vertical": <><path d="m7 3 5 5 5-5H7Z" /><path d="m7 21 5-5 5-5H7Z" /><line x1="3" y1="12" x2="21" y2="12" strokeDasharray="2 2" /></>,
  circle: <circle cx="12" cy="12" r="9" />,
  maximize: <><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></>,
  "zoom-in": <><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" /></>,
  "zoom-out": <><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" /></>,
  trash: <><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></>,
  "shield-check": <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><polyline points="12 6 12 12 16 14" /></>,
  cloud: <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>,
};

export interface UiIconProps extends React.SVGProps<SVGSVGElement> {
  name: UiIconName;
  size?: number | string;
  strokeWidth?: number;
}

export const UiIcon = React.forwardRef<SVGSVGElement, UiIconProps>(
  ({ name, size = 20, strokeWidth = 1.8, ...props }, ref) => (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={props["aria-label"] ? undefined : true}
      {...props}
    >
      {paths[name] ?? paths.tool}
    </svg>
  )
);

UiIcon.displayName = "UiIcon";

export const icon = (name: UiIconName) => (props: Omit<UiIconProps, "name">) => (
  <UiIcon name={name} {...props} />
);

export const Crop = icon("crop");
export const Brush = icon("brush");
export const Highlighter = icon("highlighter");
export const Arrow = icon("arrow");
export const Mosaic = icon("mosaic");
export const Type = icon("type");
export const Sliders = icon("sliders");
export const Download = icon("download");
export const Undo = icon("undo");
export const Redo = icon("redo");
export const RotateCw = icon("rotate-cw");
export const FlipH = icon("flip-horizontal");
export const FlipV = icon("flip-vertical");
export const Sparkles = icon("sparkles");
export const Check = icon("check");
export const X = icon("x");
export const Copy = icon("copy");
export const Clipboard = icon("clipboard");
export const Eye = icon("eye");
export const ZoomIn = icon("zoom-in");
export const ZoomOut = icon("zoom-out");
export const Maximize = icon("maximize");
export const Trash = icon("trash");
export const ShieldCheck = icon("shield-check");
export const Loader2 = icon("loader");
export const Square = icon("square");
export const Circle = icon("circle");
