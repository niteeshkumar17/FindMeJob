import { loadFacts, reviewResume } from "./facts.js";
import { plainJobLabel } from "./jobs.js";
import { dryRunDraftHeader, resumePdf, sendMail, sendMode, testRecipient, type MailAuthError, type SendMode } from "./mail.js";
import { alertTo, gmailAddress, maxSendsPerDay, resumeApprovalHash, verbApproved } from "./profile.js";
import {
  companyKey,
  loadState,
  saveState,
  sendsToday,
  todayKey,
  type HeldDraft,
  type HuntState,
  type StateFiles,
} from "./state.js";

export type OutboundDraft = {
  jobId: string;
  company: string;
  role: string;
  url: string;
  targetEmail: string;
  resumeText: string;
};

export function heldDraftFrom(input: OutboundDraft & { postText: string; verbs: string[] }): HeldDraft {
  return {
    at: new Date().toISOString(),
    jobId: input.jobId,
    company: input.company,
    role: input.role,
    url: input.url,
    targetEmail: input.targetEmail,
    postText: input.postText,
    resumeText: input.resumeText,
    resumeHash: resumeApprovalHash(input.resumeText),
    verbs: input.verbs,
  };
}

export async function transmit(
  state: HuntState,
  draft: OutboundDraft,
  mode: SendMode,
): Promise<{ sent: boolean; reason: string }> {
  const key = companyKey(draft.company);
  if (mode === "employer" && sendsToday(state) >= maxSendsPerDay()) {
    return { sent: false, reason: "daily cap reached" };
  }
  if (mode === "employer" && key && state.contactedCompanies.includes(key)) {
    return { sent: false, reason: "company already contacted" };
  }
  const redirected = testRecipient();
  const to = mode === "dry" ? alertTo() : mode === "test" ? redirected ?? alertTo() : draft.targetEmail;
  const company = plainJobLabel(draft.company, 80);
  const role = plainJobLabel(draft.role, 80);
  const subject =
    mode === "dry"
      ? `[dry-run] ${role} at ${company}`
      : mode === "test"
        ? `[test] ${role} at ${company}`
        : `Application for ${role} at ${company}`;
  const body =
    mode === "employer"
      ? [
          "Hello,",
          "",
          `I am applying for the ${role} role at ${company}.`,
          "I am Niteesh Kumar, a Bachelor of Technology student in Computer Science and Engineering at IEC College of Engineering and Technology (2022-2026).",
          "Code: https://github.com/niteeshkumar17",
          "Store: https://kalingastore.shop",
          "Phone: 7217786935",
          `Email: ${gmailAddress()}`,
          "",
          "The resume is attached.",
        ].join("\n")
      : [
          mode === "dry" ? dryRunDraftHeader(draft.targetEmail, draft.url) : "",
          mode === "dry"
            ? "Dry run. This draft was not sent to the employer."
            : `TEST_RECIPIENT is set. This application was not sent to the employer. It was sent to ${to}.`,
          `Company: ${company}`,
          `Role: ${role}`,
          mode === "dry" ? "" : `Address in the post: ${draft.targetEmail}`,
          mode === "dry" ? "" : `Job: ${draft.url}`,
          "The resume PDF is attached.",
          "This send is not in contactedCompanies and it does not increment the daily cap.",
        ]
          .filter((line) => line !== "")
          .join("\n");
  await sendMail({
    to,
    subject,
    body,
    pdf: { name: "Niteesh_Kumar_Resume.pdf", bytes: resumePdf(draft.resumeText) },
  });
  const entry = {
    at: new Date().toISOString(),
    jobId: draft.jobId,
    company: draft.company,
    role: draft.role,
    targetEmail: draft.targetEmail,
  };
  if (mode === "dry") {
    state.previewedJobIds.push(draft.jobId);
    state.dryRunLog.push(entry);
  } else if (mode === "test") {
    state.testSentJobIds.push(draft.jobId);
    state.testSendLog.push(entry);
  } else {
    const day = todayKey();
    state.sendsByDay[day] = (state.sendsByDay[day] ?? 0) + 1;
    state.sentJobIds.push(draft.jobId);
    if (key) {
      state.contactedCompanies.push(key);
    }
  }
  return {
    sent: true,
    reason: mode === "dry" ? "draft logged, not counted" : mode === "test" ? "sent to TEST_RECIPIENT" : "mailed to employer",
  };
}

export async function emailHeldDraft(draft: HeldDraft, note: string): Promise<void> {
  const mode = sendMode();
  const lines = [
    mode === "dry" ? dryRunDraftHeader(draft.targetEmail, draft.url) : "",
    note,
    "This exact resume text is stored in the hunt state.",
    "A later hunt sends this text when DRY_RUN is false and this hash is in VERB_APPROVALS.",
    "TEST_RECIPIENT, while set, receives that send instead of the employer.",
    `Add this hash to VERB_APPROVALS: ${draft.resumeHash}`,
    `Verbs: ${draft.verbs.join(", ")}`,
    `Company: ${plainJobLabel(draft.company, 80)}`,
    `Role: ${plainJobLabel(draft.role, 80)}`,
    mode === "dry" ? "" : `Address in the post: ${draft.targetEmail}`,
    mode === "dry" ? "" : `Job post: ${draft.url}`,
  ];
  await sendMail({
    to: alertTo(),
    subject:
      mode === "dry"
        ? `[review] ${plainJobLabel(draft.role, 60)} at ${plainJobLabel(draft.company, 40)}`
        : `[review] blocked live send ${plainJobLabel(draft.role, 60)} at ${plainJobLabel(draft.company, 40)}`,
    body: lines.filter((line) => line !== "").join("\n"),
    pdf: { name: "Niteesh_Kumar_Resume.pdf", bytes: resumePdf(draft.resumeText) },
  });
}

export async function holdDraft(state: HuntState, draft: HeldDraft, note?: string): Promise<void> {
  const known = state.verbHeldHashes.includes(draft.resumeHash);
  if (note && !known) {
    await emailHeldDraft(draft, note);
    state.verbHeldHashes.push(draft.resumeHash);
    state.verbReviewLog.push({
      at: draft.at,
      jobId: draft.jobId,
      company: draft.company,
      role: draft.role,
      targetEmail: draft.targetEmail,
      resumeHash: draft.resumeHash,
    });
  }
  const exists = state.heldDrafts.some((item) => item.jobId === draft.jobId && item.resumeHash === draft.resumeHash);
  if (!exists) {
    state.heldDrafts.push(draft);
  }
}

/** Fold unfinished retries into held drafts, then send approved texts on a live hunt. */
export async function settleHeldDrafts(files: StateFiles): Promise<void> {
  const state = await loadState(files);
  const mode = sendMode();
  const stillPending: HeldDraft[] = [];
  for (const pending of state.pendingVerbRetries) {
    try {
      const approved = verbApproved(pending.resumeHash);
      await holdDraft(
        state,
        pending,
        approved
          ? undefined
          : mode === "dry"
            ? "Dry run routed this draft to you because it contains a restricted verb. The employer was not emailed."
            : "The rewrite did not arrive. This draft is held. The employer was not emailed.",
      );
    } catch {
      stillPending.push(pending);
    }
  }
  state.pendingVerbRetries = stillPending;
  await saveState(files, state);
  await dropExpiredHeldDrafts(files);
  if (mode === "dry") {
    return;
  }
  const facts = await loadFacts();
  if (!facts.ok) {
    return;
  }
  const current = await loadState(files);
  const remain: HeldDraft[] = [];
  for (const draft of current.heldDrafts) {
    if (!verbApproved(draft.resumeHash) || !draft.postText.includes(draft.targetEmail)) {
      remain.push(draft);
      continue;
    }
    const review = reviewResume(draft.resumeText, facts.text);
    if (!review.ok) {
      if (!draft.factHoldNotified) {
        await sendMail({
          to: alertTo(),
          subject: `[grokbot] approved draft still blocked for ${draft.company}`,
          body: [
            "The hash is approved. The source check still failed, so this exact text was not sent.",
            ...review.flags,
          ].join("\n"),
        });
        draft.factHoldNotified = true;
      }
      remain.push(draft);
      continue;
    }
    const key = companyKey(draft.company);
    if (mode === "employer" && key && current.contactedCompanies.includes(key)) {
      continue;
    }
    if (mode === "employer" && sendsToday(current) >= maxSendsPerDay()) {
      remain.push(draft);
      continue;
    }
    const result = await transmit(current, draft, mode);
    if (!result.sent) {
      remain.push(draft);
    }
  }
  current.heldDrafts = remain;
  await saveState(files, current);
}

export const HELD_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function heldDraftExpired(draft: HeldDraft, now = Date.now()): boolean {
  const at = Date.parse(draft.at);
  return Number.isFinite(at) && now - at >= HELD_DRAFT_TTL_MS;
}

export function settleErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/\s+/g, " ").trim().slice(0, 500);
  return message.length > 0 ? message : "Unknown settle error";
}

export function shouldMailSettleError(alreadyMailed: readonly string[], message: string): boolean {
  return !alreadyMailed.includes(message);
}

export async function dropExpiredHeldDrafts(files: StateFiles, now = Date.now()): Promise<void> {
  const state = await loadState(files);
  const expired = state.heldDrafts.filter((draft) => heldDraftExpired(draft, now));
  if (expired.length === 0) {
    return;
  }
  await sendMail({
    to: alertTo(),
    subject: "[review] held draft expired",
    body: [
      "These held drafts are more than 7 days old. They were dropped and will not be sent.",
      ...expired.map((draft) =>
        [`Company: ${draft.company}`, `Role: ${draft.role}`, `Hash: ${draft.resumeHash}`, `Held at: ${draft.at}`].join("\n"),
      ),
    ].join("\n\n"),
  });
  const current = await loadState(files);
  current.heldDrafts = current.heldDrafts.filter((draft) => !heldDraftExpired(draft, now));
  await saveState(files, current);
}

export async function recordSettleError(files: StateFiles, error: unknown): Promise<void> {
  const message = settleErrorMessage(error);
  const state = await loadState(files);
  const mail = shouldMailSettleError(state.settleErrorsMailed, message);
  state.lastSettleError = message;
  await saveState(files, state);
  if (!mail) {
    return;
  }
  try {
    await sendMail({
      to: alertTo(),
      subject: "[grokbot] settle failed",
      body: ["The hunt could not settle held drafts.", message].join("\n"),
    });
  } catch {
    return;
  }
  const fresh = await loadState(files);
  fresh.lastSettleError = message;
  if (!fresh.settleErrorsMailed.includes(message)) {
    fresh.settleErrorsMailed.push(message);
  }
  await saveState(files, fresh);
}

export async function clearSettleError(files: StateFiles): Promise<void> {
  const state = await loadState(files);
  if (state.lastSettleError === "") {
    return;
  }
  state.lastSettleError = "";
  await saveState(files, state);
}

export async function recordLastMailError(files: StateFiles, error: MailAuthError, now = new Date()): Promise<void> {
  const state = await loadState(files);
  state.lastMailError = {
    at: now.toISOString(),
    message: error.message.replace(/\s+/g, " ").trim().slice(0, 500),
  };
  await saveState(files, state);
}
