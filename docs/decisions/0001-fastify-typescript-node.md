# 0001. Fastify on TypeScript and Node 24

## Context

The API needs an HTTP framework, a language and a runtime.

## Decision

Build the API with Fastify on TypeScript and Node 24, as ES modules compiled with `module` and `moduleResolution` set to `NodeNext`. This is the operator's stack choice.

## Consequences

- `api/package.json` declares `"type": "module"`, and relative imports in `src/` carry the `.js` extension.
- Node is pinned to major 24 in `.nvmrc`, `engines.node` and the `node:24-slim` image base.
- `tsc` compiles `src/` to `dist/`. Development uses `tsx watch`.
- The app is built by a factory, `buildApp()`, so tests call routes with Fastify `inject` without opening a port.
