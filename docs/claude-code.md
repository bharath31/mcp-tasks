# Run it from Claude Code

[Claude Code](https://code.claude.com/docs/en/mcp#mcp-tasks-that-run-on-the-server) (v2.1.304 or later) is an MCP Tasks host: `request_refund` runs as a task on the server, the footer shows `1 MCP task`, `/tasks` shows the server's status message, and Claude gets the result when the task ends. The quickest way to see it needs no accounts: a local stack with a local identity provider, which also plays the warehouse and the approver. If a step fails, `npm run doctor` says what is missing.

```sh
npm ci
npm run db:up                  # local Postgres in Docker on 127.0.0.1:55432
npm run local -- --owner       # keep it running; writes .local/claude-code.mcp.json
claude --mcp-config .local/claude-code.mcp.json --strict-mcp-config    # in a second terminal
```

Then ask Claude: `Create a test payment of 30000 USD minor units, then request a refund of 15000 of it for order CC-1, reason "Customer returned the item".` Two dialogs follow. The first is a form asking for the exception note the reviewer needs. The second asks to open the approval page: choose **I'm done, continue**, and the stack approves as the owner with a passkey (accepting the dialog approves nothing by itself). The refund then runs once and Claude reports it, including that a person approved it. Without `--owner`, a manager approves instead and Claude asks you nothing beyond the note.

Where Claude Code does and does not run tasks matters for an approval server:

- **Only some sessions declare the tasks extension**: the main conversation of a terminal session, an Agent SDK session, or a `claude -p --input-format stream-json` run with `CLAUDE_AUTO_BACKGROUND_TASKS=1`. Subagents, one-shot `claude -p "<prompt>"`, the VS Code extension and the desktop app do not, and neither did a Claude Code on the web session we tried. There `request_refund` is refused with `-32021`, and the message tells Claude why.
- **Headless runs cancel any task that asks for input.** In `claude -p`, Agent SDK and GitHub Actions runs, pass `exceptionNote` as an argument, and set `OWNER_APPROVAL_PROMPT=status` on Refund Desk (`renderMcp(outcome, { ownerPrompt: "status" })` in the SDK) so the owner gets the approval link in the task's status message instead of a dialog that would be cancelled.
- **Your own deployment:** Policy Desk's `/mcp` does not yet publish OAuth protected-resource metadata, so Claude Code cannot sign in to it with `/mcp`. See [interoperability.md](interoperability.md#claude-code) for exactly what was tested.
