# Task Authority approval UI (prototype)

React components for the hosted approval page. The page decides nothing itself:
it shows Task Authority's own record of one operation and posts the signed-in
person's decision back, so every client (MCP, REST, CLI) lands on the same
approval.

- `OperationApproval` shows one approval. Reviewers claim it first; the agent's
  owner (policy `self_approval: "owner"`) approves directly. An approval that
  needs a step-up calls your `stepUp` callback (challenge plus login, or PAR),
  and the page offers the final confirmation when the redirect returns.
- `ApprovalQueue` lists the person's eligible pending approvals, as Task
  Authority filters them.
- `approvalClient(authorityUrl, fetchWithAuth)` takes any DPoP-capable fetch,
  such as `useAuth0().createFetcher({ dpopNonceId }).fetchWithAuth`.

Styles are in `styles.css`. Override the `--ta-*` custom properties to brand
it. The refund desk page (`demo/refund-desk/web/review.tsx`) shows the full
wiring with `@auth0/auth0-react`.
