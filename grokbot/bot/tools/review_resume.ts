import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { loadFacts, reviewResume } from "../lib/facts.js";

export default defineTool({
  description:
    "Compare a drafted resume with the live GitHub account and kalingastore.shop. Returns flags for any word or number that is not in those sources. Does not send mail.",
  effect: "read",
  inputSchema: z.object({
    resumeText: z.string().min(1),
  }),
  async execute({ resumeText }) {
    const facts = await loadFacts();
    if (!facts.ok) {
      return { ok: false, flags: [`sources unavailable: ${facts.error ?? "unknown"}`] };
    }
    return reviewResume(resumeText, facts.text);
  },
});
