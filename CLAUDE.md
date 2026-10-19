# ChambaLink: working agreements

- Never commit, stage, push, or create, switch or delete branches. Leave changes in the working tree; the maintainer reviews, commits and pushes.
- Never read or print .env files. Never SSH to the production VM unless the session explicitly asks for it.
- Stay inside the task's scope. Report bugs and inconsistencies instead of fixing them unasked.
- main is protected: changes land through pull requests that pass the test and image checks.
- Commit messages follow Conventional Commits, as in git log (feat(deploy): ..., ci: ..., docs: ...).
- README.md and docs/ describe the repository as it is: no roadmap or future-phase language, and every claim traceable to code, config or a documented operator fact.
- The repo is public: no IP addresses, OCIDs, key names or personal paths in any file.
- Toolchain: Node from .nvmrc, pnpm via corepack (pinned in package.json). Verify with `docker compose up -d --wait db && pnpm typecheck && pnpm test`.
