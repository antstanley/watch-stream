---
'watch-tail': patch
---

Give the chart tooltip a background.

layerchart draws its tooltip with colours that come from `--color-surface-*` variables, which only its
framework presets (shadcn-svelte, Skeleton, daisyUI) define. This app imports none of them, so the
tooltip rendered fully transparent with black text - unreadable over a dark chart. It now carries its
own panel styling (dark background, border, light text, elevation shadow), and the browser smoke run
checks the rendered colours so it cannot regress unnoticed.
