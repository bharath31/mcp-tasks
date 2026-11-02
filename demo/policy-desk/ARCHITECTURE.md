# Policy Desk architecture

## Components

```mermaid
flowchart LR
  subgraph Browser
    UI["Policy Desk UI<br/>(web/dist, Auth0 SPA + DPoP)"]
  end

  subgraph CF["Cloudflare Worker: mcp-tasks-policy-desk"]
    HOST["/sandbox/*<br/>host API: reset, scenario, policy"]
    APP["/v1/refunds*<br/>refund app (authority.protect)"]
    TA["/v1/*<br/>Task Authority service<br/>(auth0/service, imported)"]
    SIM["Payment simulator"]
    CRON["Hourly cleanup cron"]
  end

  subgraph Auth0["Auth0 tenant"]
    UL["Universal Login<br/>org policy-desk, MFA, WebAuthn"]
    ACT["Login Actions<br/>approval + assurance claims"]
    M2M["M2M clients<br/>api, executor, auditor, admin, agent"]
    ALEX["Alex (real user)<br/>refresh token via Agent Owner client"]
  end

  FGA["Auth0 FGA<br/>organization relations"]
  PG[("Supabase Postgres via Hyperdrive<br/>schemas: authority, policy_desk")]

  UI -- "login, step-up" --> UL
  UL --> ACT
  UI -- "DPoP-bound token" --> HOST
  UI --> APP
  UI --> TA
  HOST -- "seed tuples" --> FGA
  HOST -- "refresh Alex's token,<br/>create delegation" --> ALEX
  APP -- "protect(): register op,<br/>request approval" --> TA
  APP --> SIM
  TA -- "check: may X do Y now?" --> FGA
  TA -- "verify JWT (JWKS), amr, auth_time" --> Auth0
  HOST -- "client credentials" --> M2M
  TA --> PG
  APP --> PG
  CRON --> PG
```

## One refund that needs approval

```mermaid
sequenceDiagram
  autonumber
  actor V as Visitor (reviewer)
  participant UI as UI
  participant W as Worker host + refund app
  participant TA as Task Authority
  participant A0 as Auth0
  participant F as FGA
  participant DB as Postgres

  V->>UI: Sign in
  UI->>A0: Authorization code + PKCE, DPoP
  A0-->>UI: Access token (org member)
  UI->>W: POST /sandbox/reset
  W->>F: Write tuples: visitor, Alex, agent, backends
  W->>A0: Exchange Alex's refresh token
  W->>TA: Create Alex-owned delegation to the agent
  UI->>W: Run scenario: agent asks for a refund
  W->>TA: protect(): register operation (agent token)
  TA->>F: agent registered_agent? Alex refund_request?
  TA->>TA: Evaluate approval policy (amount tier)
  TA->>DB: Store operation + pending approval
  TA-->>W: approval_required
  V->>UI: Review the request
  UI->>A0: Step-up (MFA, or WebAuthn for high value)
  A0-->>UI: Token with amr + auth_time
  UI->>TA: Approve (DPoP)
  TA->>F: visitor refund_approve?
  TA->>TA: Check: not owner/initiator, factor strength, freshness
  TA->>DB: Record decision + audit
  W->>TA: Executor claims operation
  W->>W: Simulated payment
  W->>TA: Report outcome
```

## Why FGA

Tokens prove who the caller is and how they signed in. They don't prove the caller may still do this action right
now: a delegation or an approval can wait for hours, and a person's role can change in the meantime. The service
asks FGA at every decision point (create delegation, register operation, approve, claim). It never caches the answer
and fails closed when FGA is unreachable. Revoking a relation in FGA therefore stops in-flight work immediately.

The relations live in `auth0/service/fga/model.fga`. The call sites are `fgaCheck` in
`auth0/service/src/{delegations,operations,claims,context}.ts`.
