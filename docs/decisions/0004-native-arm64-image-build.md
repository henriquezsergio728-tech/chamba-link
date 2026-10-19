# 0004. Native arm64 image build in CI

## Context

The production VM is arm64. The API image must run there, and a broken image must not reach the registry.

## Decision

Build the image in CI on the native arm64 runner `ubuntu-24.04-arm`, smoke-test it by requesting `/healthz` from a running container, and push it to GHCR only on pushes to `main`, tagged with the full commit SHA and `latest`.

## Consequences

- The build needs no emulation or cross-compilation.
- The published image is `linux/arm64` only.
- Pull requests build and smoke-test the image without pushing it.
- Each SHA tag identifies one build. `latest` moves on every push to `main`.
- Production selects an image by SHA through `API_TAG`.
