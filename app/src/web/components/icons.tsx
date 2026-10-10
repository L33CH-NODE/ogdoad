// Stroke icons, drawn inline so they take the text colour.

const PATHS = {
  home: "M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z",
  sophia: "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1",
  money: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3",
  clients: "M15 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 3 18.5V20M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.2a3.5 3.5 0 0 1 0 6.6",
  settings: "M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4M4 12h14",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l1.5 2H4.5zM10 20a2 2 0 0 0 4 0",
  send: "M12 19V5M6 11l6-6 6 6",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  back: "M15 6l-6 6 6 6",
  external: "M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4",
  shield: "M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z",
  file: "M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7zM14 3v4h4",
  power: "M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0",
  bank: "M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18",
  expand: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
  shrink: "M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7",
  lock: "M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  note: "M5 4h10l4 4v12H5zM15 4v4h4M8 12h8M8 16h5",
  check: "M5 12.5l4.5 4.5L19 7.5",
  skip: "M6 6l8 6-8 6zM18 6v12",
  park: "M8 5v14M16 5v14",
  open: "M7 17L17 7M9 7h8v8",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, title }: { name: IconName; size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Mark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" aria-hidden="true">
      <path d="M8.3 3h7.4L21 8.3v7.4L15.7 21H8.3L3 15.7V8.3z" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
