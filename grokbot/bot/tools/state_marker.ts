import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { readMarker, writeMarker } from "../lib/state.js";

export default defineTool({
  description: "Write or read the deployment marker used to check that redeploy keeps state. Does not send mail.",
  effect: ({ action }) => (action === "read" ? "read" : "write"),
  inputSchema: z.object({
    action: z.enum(["write", "read"]),
  }),
  async execute({ action }, ctx) {
    if (action === "read") {
      return { action, marker: await readMarker(ctx.host.files) };
    }
    const marker = `grokbot-marker ${new Date().toISOString()}`;
    await writeMarker(ctx.host.files, marker);
    return { action, marker };
  },
});
