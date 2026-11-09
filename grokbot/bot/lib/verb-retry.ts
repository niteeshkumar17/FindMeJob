import { restrictedVerbs, reviewResume } from "./facts.js";

export function rewriteInstruction(verbs: string[]): string {
  return [
    "Rewrite this resume once.",
    `Remove these whole words in any case: ${verbs.join(", ")}.`,
    "The tokens LED and LEDs may stay.",
    "Use only words and numbers from the facts text.",
    "Do not add a skill, a title, or a number.",
    "Call send_application one time with the same jobId and the rewritten resumeText.",
    "Do not call send_application again for this job if that rewrite still fails.",
  ].join(" ");
}

export type LiveVerbDecision =
  | { kind: "pass" }
  | { kind: "rewrite"; instruction: string; verbs: string[] }
  | { kind: "send"; resumeText: string }
  | { kind: "hold"; resumeText: string; verbs: string[]; flags: string[]; retryVerbs: string[]; retryFlags: string[] };

/** Live mode only. The first call asks for one rewrite. The second call sends or holds. */
export function decideLiveVerbRetry(args: {
  pending: boolean;
  originalText: string;
  resumeText: string;
  corpus: string;
}): LiveVerbDecision {
  if (!args.pending) {
    const verbs = restrictedVerbs(args.resumeText);
    if (verbs.length === 0) {
      return { kind: "pass" };
    }
    return { kind: "rewrite", instruction: rewriteInstruction(verbs), verbs };
  }
  const retryVerbs = restrictedVerbs(args.resumeText);
  const retryReview = reviewResume(args.resumeText, args.corpus);
  if (retryVerbs.length === 0 && retryReview.ok) {
    return { kind: "send", resumeText: args.resumeText };
  }
  const originalReview = reviewResume(args.originalText, args.corpus);
  return {
    kind: "hold",
    resumeText: args.originalText,
    verbs: restrictedVerbs(args.originalText),
    flags: originalReview.flags,
    retryVerbs,
    retryFlags: retryReview.flags,
  };
}
