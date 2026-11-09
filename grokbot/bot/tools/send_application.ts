import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { heldDraftFrom, holdDraft, transmit } from "../lib/deliver.js";
import { loadFacts, restrictedVerbs, reviewResume } from "../lib/facts.js";
import { addressInPost } from "../lib/jobs.js";
import { dryRunEnabled, sendMail, sendMode } from "../lib/mail.js";
import { alertTo, resumeApprovalHash, verbApproved } from "../lib/profile.js";
import { loadPost, loadState, saveState, withHuntLock } from "../lib/state.js";
import { decideLiveVerbRetry } from "../lib/verb-retry.js";

function toolResult(args: {
  sent: boolean;
  blocked: boolean;
  dryRun: boolean;
  flags: string[];
  verbs: string[];
  reason: string;
  instruction?: string;
}) {
  return {
    sent: args.sent,
    blocked: args.blocked,
    dryRun: args.dryRun,
    flags: args.flags,
    verbs: args.verbs,
    reason: args.reason,
    instruction: args.instruction ?? "",
  };
}

export default defineTool({
  description:
    "Fact-check a resume and send it for a jobId saved by search_jobs. The recipient is taken from that stored post. Do not pass an email address.",
  effect: "write",
  inputSchema: z.object({
    jobId: z.string().min(1),
    resumeText: z.string().min(40).max(6000),
  }),
  async execute(input, ctx) {
    return withHuntLock(() => sendApplication(input, ctx));
  },
});

async function sendApplication(
  input: { jobId: string; resumeText: string },
  ctx: { session: { purpose?: string }; host: { files: Parameters<typeof loadState>[0] } },
) {
    if (ctx.session.purpose === "eval") {
      return toolResult({ sent: false, blocked: false, dryRun: true, flags: [], verbs: [], reason: "eval" });
    }
    const post = await loadPost(ctx.host.files, input.jobId);
    if (!post) {
      return toolResult({
        sent: false,
        blocked: true,
        dryRun: dryRunEnabled(),
        flags: [],
        verbs: [],
        reason: "job post is not on file",
      });
    }
    const targetEmail = addressInPost(post.postText);
    if (!targetEmail || !post.postText.includes(targetEmail)) {
      return toolResult({
        sent: false,
        blocked: true,
        dryRun: dryRunEnabled(),
        flags: [],
        verbs: [],
        reason: "no address appears verbatim in the stored post",
      });
    }
    const facts = await loadFacts();
    if (!facts.ok) {
      return toolResult({
        sent: false,
        blocked: true,
        dryRun: dryRunEnabled(),
        flags: [`sources unavailable: ${facts.error ?? "unknown"}`],
        verbs: [],
        reason: "sources unavailable",
      });
    }
    const state = await loadState(ctx.host.files);
    const mode = sendMode();
    const outbound = {
      jobId: input.jobId,
      company: post.company,
      role: post.role,
      url: post.url,
      targetEmail,
      postText: post.postText,
    };
    const pending = state.pendingVerbRetries.find((item) => item.jobId === input.jobId);
    if (mode !== "dry" && pending) {
      const decision = decideLiveVerbRetry({
        pending: true,
        originalText: pending.resumeText,
        resumeText: input.resumeText,
        corpus: facts.text,
      });
      state.pendingVerbRetries = state.pendingVerbRetries.filter((item) => item.jobId !== input.jobId);
      if (decision.kind === "send") {
        const result = await transmit(state, { ...outbound, resumeText: decision.resumeText }, mode);
        await saveState(ctx.host.files, state);
        return toolResult({
          sent: result.sent,
          blocked: false,
          dryRun: false,
          flags: [],
          verbs: [],
          reason: result.reason,
        });
      }
      if (decision.kind === "hold") {
        const retryNote = [
          "The rewrite did not pass the verb check and the source check. The employer was not emailed.",
          decision.retryVerbs.length > 0 ? `Retry verbs: ${decision.retryVerbs.join(", ")}` : "",
          decision.retryFlags.length > 0 ? `Retry fact-check flags:\n${decision.retryFlags.join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        await holdDraft(state, pending, retryNote);
        await saveState(ctx.host.files, state);
        return toolResult({
          sent: false,
          blocked: true,
          dryRun: false,
          flags: [],
          verbs: decision.verbs,
          reason: "blocked pending verb approval",
        });
      }
    }
    const verbs = restrictedVerbs(input.resumeText);
    if (verbs.length > 0 && !verbApproved(resumeApprovalHash(input.resumeText))) {
      const draft = heldDraftFrom({ ...outbound, resumeText: input.resumeText, verbs });
      if (mode === "dry") {
        await holdDraft(
          state,
          draft,
          "Dry run routed this draft to you because it contains a restricted verb. The employer was not emailed.",
        );
        await saveState(ctx.host.files, state);
        return toolResult({
          sent: false,
          blocked: false,
          dryRun: true,
          flags: reviewResume(input.resumeText, facts.text).flags,
          verbs,
          reason: "routed for verb review",
        });
      }
      const decision = decideLiveVerbRetry({
        pending: false,
        originalText: input.resumeText,
        resumeText: input.resumeText,
        corpus: facts.text,
      });
      if (decision.kind === "rewrite") {
        state.pendingVerbRetries = state.pendingVerbRetries.filter((item) => item.jobId !== input.jobId);
        state.pendingVerbRetries.push(draft);
        await saveState(ctx.host.files, state);
        return toolResult({
          sent: false,
          blocked: false,
          dryRun: false,
          flags: [],
          verbs: decision.verbs,
          reason: "rewrite",
          instruction: decision.instruction,
        });
      }
    }
    const review = reviewResume(input.resumeText, facts.text);
    if (!review.ok) {
      if (!state.blockedJobIds.includes(input.jobId)) {
        await sendMail({
          to: alertTo(),
          subject: `[grokbot] blocked resume for ${post.company}`,
          body: [
            `The resume for ${post.role} at ${post.company} was not sent.`,
            `Address in the post: ${targetEmail}`,
            "Flags:",
            ...review.flags,
          ].join("\n"),
        });
        state.blockedJobIds.push(input.jobId);
        await saveState(ctx.host.files, state);
      }
      return toolResult({
        sent: false,
        blocked: true,
        dryRun: mode === "dry",
        flags: review.flags,
        verbs,
        reason: "fact check failed",
      });
    }
    const result = await transmit(state, { ...outbound, resumeText: input.resumeText }, mode);
    await saveState(ctx.host.files, state);
    return toolResult({
      sent: result.sent,
      blocked: false,
      dryRun: mode === "dry",
      flags: [],
      verbs,
      reason: result.reason,
    });
}
