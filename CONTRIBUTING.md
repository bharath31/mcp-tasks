# Contributing

Issues and pull requests are welcome. This is an experimental reference implementation, so the bar is: it must be true, tested and simple.

## Before you open a pull request

```sh
npm ci
npm run db:up      # Postgres in Docker on 127.0.0.1:55432 (or set TEST_PG_ADMIN_URL)
npm run check      # build, lint and every suite CI's main job runs
```

`npm run doctor` explains a failing prerequisite. The browser suites (`npm run test:fullstack`, `npm run test:admin`) need Chromium; CI runs them in a second job.

## Ground rules

- **Approvals are enforced at the API, not in MCP.** Don't add an approval path that only one transport (MCP, REST or CLI) goes through.
- **Fail closed.** No policy means deny. An unknown claim, factor or input is a refusal, not a default.
- **Agents never approve.** Any change near decisions needs a test that an agent token is refused.
- **Every security claim has a test.** If you change behaviour listed in [docs/security-model.md](docs/security-model.md) or [docs/interoperability.md](docs/interoperability.md), update the doc and the test in the same pull request.
- **Don't oversell.** Something tested only against the local identity provider is "local only", not "works with Auth0".
- **Keep the layers apart.** Demo apps use only the SDK; `npm run lint` enforces it.
- **Never commit secrets.** `.env*` and `.dev.vars*` are ignored, and lint scans tracked files.

Where things live: [docs/README.md](docs/README.md). Coding agents: [AGENTS.md](AGENTS.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
