# GitHub About section

The repository's About box (description, website and topics) lives in GitHub settings, not in git, so a fresh copy of the repo starts with it empty. This page holds the exact values and one command that applies them.

## Values

**Description** (GitHub allows 350 characters; this is 196):

> Unofficial reference implementation of MCP Tasks with human approvals. An agent's side effects wait until a person approves that exact operation with Auth0, using a passkey for high-value actions.

**Website:** https://mcp-tasks.dev

**Topics** (GitHub allows 20):

`mcp`, `model-context-protocol`, `mcp-tasks`, `mcp-server`, `auth0`, `approvals`, `human-in-the-loop`, `ai-agents`, `agent-security`, `authorization`, `cloudflare-workers`, `passkeys`, `webauthn`, `cel`, `typescript`, `reference-implementation`

## Apply

Needs the [GitHub CLI](https://cli.github.com) signed in with admin rights on the repo. Set `REPO` to the new copy.

```sh
REPO=bharath31/mcp-tasks

gh repo edit "$REPO" \
  --description "Unofficial reference implementation of MCP Tasks with human approvals. An agent's side effects wait until a person approves that exact operation with Auth0, using a passkey for high-value actions." \
  --homepage "https://mcp-tasks.dev"

# Replaces the whole topic list, so it also removes any topic not named here.
gh api -X PUT "repos/$REPO/topics" -H "Accept: application/vnd.github+json" \
  -f "names[]=mcp" -f "names[]=model-context-protocol" -f "names[]=mcp-tasks" \
  -f "names[]=mcp-server" -f "names[]=auth0" -f "names[]=approvals" \
  -f "names[]=human-in-the-loop" -f "names[]=ai-agents" -f "names[]=agent-security" \
  -f "names[]=authorization" -f "names[]=cloudflare-workers" -f "names[]=passkeys" \
  -f "names[]=webauthn" -f "names[]=cel" -f "names[]=typescript" \
  -f "names[]=reference-implementation"
```

Check it:

```sh
gh repo view "$REPO" --json description,homepageUrl,repositoryTopics
```

## Also set by hand

These are in the repo's Settings page and have no `gh repo edit` flag worth scripting:

- In the About box's gear menu, untick **Releases**, **Packages** and **Deployments** (none are published), so the sidebar shows only the description, website and topics.
- Upload a social preview image (Settings, General, Social preview) at 1280 by 640. A PNG export of `docs/assets/banner-light.svg` works.
