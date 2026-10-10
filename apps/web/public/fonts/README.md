# Fonts

`NotoNastaliqUrdu-subset.woff2` — Noto Nastaliq Urdu (variable, SIL OFL 1.1, see `OFL.txt`), subset to
Arabic-script blocks with all OpenType layout features kept (Nastaliq shaping depends on them).
Latin digits are deliberately excluded: numbers render in the system font (PLAN §12, experiment 3).

Regenerate from the upstream `NotoNastaliqUrdu-VF.ttf` (Google Fonts) with fonttools + brotli:

```sh
pyftsubset NotoNastaliqUrdu-VF.ttf \
  --unicodes="U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF,U+200C-200F,U+0020,U+00A0" \
  --layout-features='*' --flavor=woff2 --output-file=NotoNastaliqUrdu-subset.woff2
```

Still to measure on a real phone: load time on 3G (PLAN §12 exp3 "still needs Android").
