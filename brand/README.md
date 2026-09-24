# Brand

| File | What it is |
|---|---|
| `wordmark.svg` | The logo: **ssh** solid, **manager** outlined. Supplied, not derived. |
| `icon.svg` | The app icon — the mark on its tile. Everything else is generated from this. |
| `mark.svg` | The mark alone, no tile, `currentColor` for the white parts. |

## The icon

`>_` and the mark of what types into it. The four-pointed sparks come from
[icons8](https://icons8.com), which is where the shape of "AI" is currently
agreed.

**The chevron carries the accent, not the sparks.** The product is an SSH
manager first — that is what the wordmark says — and an icon that argues with
its own logo is an icon nobody trusts. The sparks are white: present, not
shouting.

**Stroke 34.** Thinner reads better at 512px and starts to vanish at 16, and a
favicon that resolves to a dot is one shape short of a mark. This is the
thinnest weight that survives a browser tab.

**The sparks sit above the baseline.** The rising diagonal from chevron to spark
is what gives the mark its movement; level with the prompt, a spark reads as
another character in it rather than as something it produced.

**Centred as a whole, measured rather than estimated.** The drawing is 392×192
inside 512, with 60px left and right and 160px top and bottom. A round stroke
cap and a curved star both extend past the coordinates they are drawn from — the
mark sat 95px from one edge and 3px from the other until somebody measured it in
a canvas.

## Regenerating

```bash
qlmanage -t -s 1024 -o /tmp brand/icon.svg          # → PNG for electron-builder
cp /tmp/icon.svg.png desktop/electron/resources/icon.png
```

The favicon in `ui/index.html` is the same SVG inlined as a data URI: the
browser asks for `/favicon.ico` without the control plane's token and would be
refused, so there is no request to make.
