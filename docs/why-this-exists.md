# When an agent action needs more than confirmation

An agent that can issue refunds needs more than an authenticated API connection. A support engineer may be allowed to delegate refund requests without being allowed to approve a $1,500 exception. The finance reviewer may be someone else, using a different device, minutes later.

This repo implements that case: **a backend checks who approved which exact action, then checks permission again before execution.** MCP Tasks gives the agent a way to follow work that is still waiting. Auth0 supplies identity and authentication evidence; FGA supplies current relationships and permissions.

## A concrete failure to design for

1. A support agent requests a $1,500 refund for a specific payment.
2. Policy requires human review. The app persists the task and operation rather than keeping a chat request open.
3. A reviewer signs in and approves that payment and amount with the required authentication strength.
4. Before execution, the worker checks the operation digest, approval and current authorization. If the request changed or the reviewer lost the required access, it cannot use the old approval to execute.
5. An atomic claim coordinates workers. The app sends the provider a stable idempotency key and reconciles uncertain results rather than blindly retrying.

The approval record is tied to canonical arguments and business-state version, not a boolean an agent can supply. Read the [sequence and code map](architecture.md) and the [limits of these checks](security-model.md).

## What existing tools already solve

These are complementary mechanisms, not claims that the alternatives are insecure. You can implement the same application checks around other protocols or workflow engines.

| Mechanism                                                                                                              | What its documentation provides                                                                | What this repo demonstrates around it                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MCP tool confirmations](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#user-interaction-model) | Human oversight and the ability to deny tool invocations; hosts choose the interaction model.  | A server-side policy shared with REST and CLI callers, with identity-verified reviewers and exact-operation records.                                                                                                      |
| [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)                                     | Persisted pause/resume, review of tool calls and editable state.                               | Reviewer eligibility, approval binding and claim-time rechecks. A workflow engine can own the wait while an approval layer owns these checks.                                                                             |
| [Auth0 asynchronous authorization](https://auth0.com/ai/docs/intro/asynchronous-authorization)                         | CIBA-based out-of-band user consent, with optional RAR transaction details and token issuance. | Application-level policy, a separate reviewer queue, FGA eligibility, execution claims and audit records connected to MCP Tasks. This repo's CIBA path is **local-fixture-tested only**, not a verified live integration. |

Human-in-the-loop approval itself is not new. Auth0 already offers asynchronous authorization. This repo's value is the inspectable integration and its tests, including what happens after approval, across transports, revocation and worker retries. It is not a new identity provider or a replacement for a workflow engine.

## A good fit

- You own a backend that exposes state-changing tools to agents and other clients.
- The person requesting an operation is not always the person allowed to approve it.
- You need approval evidence tied to the operation, and authorization checks after a potentially long wait.
- You want to study or adapt an implementation using TypeScript, Auth0, FGA and Postgres, and can evaluate its security limits yourself.

Refunds have the fullest implementation. Production deployments and data exports have policy templates; they are not equally complete end-to-end demos.

## Choose something smaller when

- **The user only needs to confirm a local tool call.** Start with your host's confirmation UI.
- **You already authenticate and authorize reviewers in a durable workflow.** A pause/resume primitive may be sufficient. Compare the missing checks before adding another service.
- **You only need decoupled consent from an identified user.** Evaluate Auth0's official asynchronous authorization offering first.
- **You need a supported production approval product today.** This repo has no support contract, external security review or production-hardening evidence.
- **Your executor is untrusted but holds provider credentials.** This architecture cannot prevent it from calling the provider directly.

## Help establish whether this is useful

The implementation shows that the pattern can be built. It does not establish developer demand, production reliability or a reduction in implementation time.

If this resembles something you are building, [describe one real action](https://github.com/bharath31/mcp-tasks/issues/new?template=use_case.yml): who requests it, who approves it, how long it waits, and what your current workflow cannot enforce. If an existing tool already meets your needs, that is useful feedback too.

To evaluate the policy first, run `npm run playground`. To inspect an actual approval flow, use the [hosted demo](https://mcp-tasks.dev) or [local MCP walkthrough](claude-code.md).
