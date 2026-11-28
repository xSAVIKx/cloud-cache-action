# CLAUDE.md

Cloud Cache Action is a GitHub Action. Its documentation site is a VitePress site in `docs/`.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the build, the tests and the commit rules.

## Design identity

This site uses the shared identity from xSAVIKx/xSAVIKx.github.io/identity.
- Do not edit the vendored `ys-*.css` file. To update it, copy the new file from the hub.
- Keep this project's own brand colours, logo and illustrations.
- Use system fonts only. Do not add a web font or serif headings.
- New text colours must meet 4.5:1 contrast in light and dark.

The vendored file is `docs/.vitepress/theme/ys-vitepress.css`. `biome.json` excludes it, so
`npm run format` does not change it.
