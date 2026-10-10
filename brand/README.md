# Maktab brand

## The idea

The mark is a **takhti**, the wooden writing slate on which generations of children in Pakistan
learned to write, with the first stroke of the name on it: the letter **م** (meem), first letter of
**مکتب** (*maktab*, a place of learning). The meem is drawn as one monoline stroke with round ends:
a ring, then a stem that turns into the writing line. The slate silhouette carries the icon at
16 px; the meem carries it at app-icon size.

## Files

| File | Use |
|---|---|
| `maktab-icon.svg` | The mark on its teal tile. Default everywhere (favicon, app icon, light backgrounds) |
| `maktab-icon-dark.svg` | The mark for dark backgrounds (lighter teal tile) |
| `maktab-logo.svg` / `.png` | Mark + wordmark "Maktab" + "مکتب", horizontal, for light backgrounds (PNG is 1200 px wide) |
| `maktab-logo-dark.svg` / `.png` | The same for dark backgrounds |

App icons rendered from `maktab-icon.svg` live in `apps/web/public/icons/` (`icon-192.png`,
`icon-512.png`, `maskable-512.png`, `apple-touch-icon.png`, `favicon.svg`) and
`apps/web/public/favicon.ico` (16/32/48). The maskable and Apple icons are full-bleed teal with the
slate scaled to 78% / 90% so it stays inside the maskable safe zone (a circle of 80% diameter).

The wordmark is drawn as strokes, so it needs no font. **مکتب** in the logo SVGs is live text in
Noto Nastaliq Urdu (OFL); where that font is not installed it falls back to another Arabic-script
font, so use the PNGs in places you do not control (README, slides, social posts).

## Colours

| Role | Hex | Matches |
|---|---|---|
| Brand teal | `#0f766e` | App primary, light theme (`--primary`, Tailwind teal-700); manifest `theme_color` |
| Teal on dark | `#14b8a6` | App primary, dark theme (Tailwind teal-500); tile of the dark icon/logo |
| Urdu name on dark | `#5eead4` | Tailwind teal-300; dark logo only |
| White | `#ffffff` | The slate; the wordmark on dark |

Flat colour only: no gradients, shadows, outlines or effects. The meem is always brand teal on the
white slate (contrast 5.5:1), in both variants.

## Rules

- **Clear space:** keep empty space around the mark of at least 1/4 of its width (128 units of the
  512 viewBox) on every side; around the logo, the same 1/4 of the mark's height.
- **Minimum size:** mark 16 px (favicon); logo 120 px wide on screen, 30 mm in print. Below 120 px,
  use the mark alone.
- Do not redraw, rotate, stretch, recolour, outline or put the mark on a busy photo. Do not replace
  the meem with another letter or the slate with a book or cap.
- On a mid-tone or coloured background, use the mark on its own tile (it carries its background).
