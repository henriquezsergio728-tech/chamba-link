// Foreground/background token pairs the UI is allowed to use, with the WCAG 2.x minimum each must meet.
// 4.5 is AA for normal text; 3 is AA for large text (>= 24px, or >= 19px bold) and for graphics (WCAG 1.4.11).
export const TEXT = 4.5;
export const GRAPHIC = 3;

export const PAIRS = [
  ["--color-text", "--color-bg", TEXT],
  ["--color-text", "--color-surface", TEXT],
  ["--color-text", "--color-surface-subtle", TEXT],
  ["--color-text-muted", "--color-bg", TEXT],
  ["--color-text-muted", "--color-surface", TEXT],
  ["--color-text-muted", "--color-surface-subtle", TEXT],
  ["--color-on-primary", "--color-primary", TEXT],
  ["--color-on-accent", "--color-accent", TEXT],
  ["--color-on-highlight", "--color-highlight", TEXT],
  ["--color-on-danger", "--color-danger", TEXT],
  ["--color-danger", "--color-danger-bg", TEXT],
  ["--color-danger", "--color-bg", TEXT],
  ["--color-primary", "--color-bg", TEXT],
  ["--color-accent", "--color-bg", TEXT],
  ["--color-focus", "--color-bg", GRAPHIC],
  ["--color-focus", "--color-surface", GRAPHIC],
  ["--color-border-strong", "--color-bg", GRAPHIC],

  // Text field boundaries: the Ceniza border on both backgrounds, and the error border.
  ["--color-input-border", "--color-surface", GRAPHIC],
  ["--color-input-border", "--color-bg", GRAPHIC],
  ["--color-danger", "--color-surface", GRAPHIC],

  ...["instalaciones", "hogar", "obra", "personas", "otros"].flatMap((f) => [
    [`--cat-${f}-fg`, `--cat-${f}-bg`, TEXT],
    [`--cat-${f}-tint-fg`, `--cat-${f}-tint`, TEXT],
  ]),

  ...["pending", "confirmed", "completed", "declined", "cancelled", "expired"].map((s) => [
    `--status-${s}-fg`,
    `--status-${s}-bg`,
    TEXT,
  ]),

  // Logo mark strokes against the backgrounds they are approved for.
  ["--cl-olivo", "--cl-crema", GRAPHIC],
  ["--cl-cobre", "--cl-crema", GRAPHIC],
  ["--cl-crema", "--cl-anil", GRAPHIC],
  ["--cl-maiz", "--cl-anil", GRAPHIC],
  ["--cl-crema", "--cl-monte", GRAPHIC],
  ["--cl-maiz", "--cl-monte", GRAPHIC],
];
