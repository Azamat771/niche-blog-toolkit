# Contributing

Thanks for considering a contribution! This project is deliberately small (single HTML +
zero-dep Node server). The goal is to keep the surface tiny while making it easy for any
blogger to fork and ship their own niche.

## Ground rules

- **No frontend framework, no build step.** Vanilla JS only. If you can't explain why an
  addition needs a bundler, it doesn't.
- **Zero runtime dependencies in `backend/`.** Built-in `http`/`https`/`fs` only.
- **No telemetry, no analytics.** Don't add tracking. Ever.
- **Don't commit secrets.** `.env` files are ignored; double-check before committing.
- **Mobile-first.** Every UI change has to look right at 390 × 844 (iPhone). Test it.
- **One config to rule the niche.** New niche-specific behavior belongs in `niche.json`,
  not hardcoded into the frontend or server.

## Adding a niche example

This is the most welcome kind of contribution — show how the toolkit looks for another niche.

1. `cp -r examples/fitness examples/<your-niche>`
2. Edit `examples/<your-niche>/niche.json` (title, tone, rubrics, palette, packaging defaults).
3. Generate a starter idea bank: `node scripts/seed-ideas.js examples/<your-niche> --count=50`.
4. Manually review `seed-ideas.json` — remove or rewrite weak/duplicate/off-tone ideas.
5. Render and screenshot: `node scripts/apply-niche.js examples/<your-niche>`.
6. Open a PR. Include 1–2 screenshots in `docs/images/<your-niche>-*.png` and add a row to
   the niche table in `README.md`.

## Reporting bugs

Use the **Bug report** issue template. Include:
- What you did (CLI command or UI action)
- What you expected
- What happened (logs, screenshots, network response)
- Niche config you used (or a minimal reproducer)

## Pull requests

- Run `node scripts/apply-niche.js examples/plants` and open `frontend/dist/index.html` to
  smoke-test your change.
- For backend changes: hit `/api/health`, `/api/generate`, and one `/api/agent` action.
- Keep PRs scoped. One concern per PR.

## Code style

- `'use strict';` at the top of every `.js`.
- Plain function declarations over classes when possible.
- Russian-language UI strings live in `niche.json` (`packaging.*`) — not in code.
- English comments in code, English commit messages.

## Versioning

We follow [SemVer](https://semver.org). User-visible behavior changes that require an
in-app data migration must bump `SEED_VERSION` in the frontend template and add a migration
clause in the `migrate()` function — so existing users' favorites and notes survive updates.
