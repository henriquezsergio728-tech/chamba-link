# web

Brand assets and design tokens for the ChambaLink frontend. This directory holds no application code and is not part of the pnpm workspace (`pnpm-workspace.yaml` lists only `api`), so `pnpm -r test` and the CI `test` job do not run its tests.

| Path | Contents |
| --- | --- |
| `src/styles/tokens.css` | CSS custom properties in three layers: palette (`--cl-*`), semantic (`--color-*`), and domain (`--cat-*` category families, `--status-*` booking statuses). Light scheme only. |
| `src/brand/categories.ts` | Maps each value of `CATEGORIES` (`api/src/domain.ts`) to a family, a Spanish label and a Tabler Icons name; maps each `booking_status` value (`api/src/db/schema.ts`) to a label. |
| `src/brand/mark.svg` | Logo mark, olive and copper links, for light backgrounds. |
| `src/brand/mark-reversed.svg` | Logo mark, cream and maize links, for the Monte and Añil backgrounds. |
| `src/brand/icon.svg` | App icon and favicon source: the reversed mark on an Añil rounded square. |
| `test/tokens.test.mjs` | Checks every pair in `test/pairs.mjs` against its WCAG 2.x contrast minimum, that Olivo and Cobre on Arena stay below 4.5:1, the reason `tokens.css` bars them as text there, and that every API category and booking status has a label and tokens. |

The fonts named in `tokens.css`, Archivo and Atkinson Hyperlegible, are not included; until they are, the font stacks fall back to system fonts.

## Test

The tests use the Node test runner and import `.ts` files through Node's type stripping, so they need no dependencies.

```sh
node --test web/test/*.test.mjs
```
