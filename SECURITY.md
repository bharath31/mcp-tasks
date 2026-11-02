# Security policy

This is an experimental reference implementation, not a supported product. There is no SLA, no bug bounty and no external audit. Read [docs/security-model.md](docs/security-model.md) for what the design claims, what it does not, and which test backs each claim.

## Reporting a vulnerability

Report it privately through GitHub: **Security** tab, then **Report a vulnerability** (<https://github.com/bharath31/mcp-tasks/security/advisories/new>). Please do not open a public issue or pull request for a vulnerability.

Include what you did, what you expected, what happened, and the commit you tested. A failing test is the most useful form.

In scope:

- Anything that lets an agent, or anyone other than an eligible reviewer, approve an operation.
- Running an operation twice, running one that was not approved, or running one with arguments other than those approved.
- Crossing a tenant, organization or sandbox boundary.
- Leaking a secret, token or another user's data.
- The hosted demo at <https://mcp-tasks.bharath.sh>, as long as you only use your own sandbox. Do not load-test it, and do not touch other people's sandboxes.

Out of scope: the limits listed in [docs/security-model.md](docs/security-model.md) (for example, a compromised worker that holds provider credentials), simulated payments, and rate limits on the demo.

## Supported versions

Only `main`. There are no releases.
