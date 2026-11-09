import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { loadFacts } from "../lib/facts.js";
import { findJobs } from "../lib/jobs.js";
import { sendMode } from "../lib/mail.js";
import { DAILY_CAP_DEFAULT, maxSendsPerDay } from "../lib/profile.js";
import { loadState, rememberPosts, sendsToday } from "../lib/state.js";

export default defineTool({
  description:
    "Read public tech jobs that publish an apply-by-email address, store each post, and return the live GitHub and store text the resume may use. Does not send mail and does not return an email address.",
  effect: "write",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const state = await loadState(ctx.host.files);
    const mode = sendMode();
    const facts = await loadFacts();
    const jobs = facts.ok ? await findJobs(state, mode) : [];
    if (jobs.length > 0) {
      await rememberPosts(ctx.host.files, jobs);
    }
    return {
      dryRun: mode === "dry",
      testRecipient: mode === "test",
      sendsToday: sendsToday(state),
      maxSendsPerDay: maxSendsPerDay(),
      dailyCapDefault: DAILY_CAP_DEFAULT,
      factsOk: facts.ok,
      factsError: facts.error ?? "",
      facts: facts.ok && jobs.length > 0 ? facts.text : "",
      jobs: jobs.map((job) => ({
        jobId: job.jobId,
        company: job.company,
        role: job.role,
        url: job.url,
        description: job.description,
      })),
    };
  },
});
