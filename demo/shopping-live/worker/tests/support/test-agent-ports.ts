import {
  fakeBrowserLauncher,
  scriptedModel,
} from "../../../../shopping-agent/tests/fakes.js";
import type { RunPortsFactory } from "../../../../shopping-agent-orchestration/src/types.js";

export const harnessAgentPorts: RunPortsFactory = () => ({
  model: scriptedModel([
    {
      content: null,
      toolCalls: [
        {
          id: "1",
          name: "view_catalog",
          arguments: "{}",
        },
        {
          id: "2",
          name: "add_to_cart",
          arguments: JSON.stringify({ productId: "tray" }),
        },
        {
          id: "3",
          name: "finish_session",
          arguments: JSON.stringify({
            summary: "Added tray; stopped before checkout.",
          }),
        },
      ],
    },
  ]),
  launchBrowser: fakeBrowserLauncher(),
});
