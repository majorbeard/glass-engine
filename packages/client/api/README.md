# `@glass/client` public API snapshot

`index.d.ts` (the `@glass/client` entry) and `viewer.d.ts` (the
`@glass/client/viewer` entry) are the type declarations the build publishes,
committed so that any change to the SDK's public surface shows up in review.
CI rebuilds the package and fails if they no longer match
(`npm run api:check`).

Private member names are left out, and the export list is one name per
line. Everything else, including doc comments, is exactly what consumers
get. Refactoring internals must not change these files.

When a change to the surface is intended:

```sh
cd packages/client
npm run build
npm run api:update
git diff api/
```

Commit the updated files with the change. Every diff here is a
user-facing change: flag it in the PR description as "glass-engine docs
need an update" (see `CLAUDE.md`), and treat a removed or narrowed
export or signature as breaking for anyone on the published package.
