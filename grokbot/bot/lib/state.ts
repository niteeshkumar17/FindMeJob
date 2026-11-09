import { MARKER_FILE, POSTS_FILE, STATE_FILE } from "./profile.js";

export type StateFiles = {
  read(path: string, options?: { scope?: { kind: "deployment" } }): Promise<string | undefined>;
  write(path: string, data: string, options?: { scope?: { kind: "deployment" } }): Promise<void>;
};

const SCOPE = { kind: "deployment" } as const;

export type DraftLogEntry = {
  at: string;
  jobId: string;
  company: string;
  role: string;
  targetEmail: string;
  resumeHash?: string;
};

export type HeldDraft = {
  at: string;
  jobId: string;
  company: string;
  role: string;
  url: string;
  targetEmail: string;
  postText: string;
  resumeText: string;
  resumeHash: string;
  verbs: string[];
  factHoldNotified?: boolean;
};

export type MailErrorRecord = {
  at: string;
  message: string;
};

export type HuntState = {
  previewedJobIds: string[];
  sentJobIds: string[];
  contactedCompanies: string[];
  sendsByDay: Record<string, number>;
  blockedJobIds: string[];
  alertedThreadIds: string[];
  dryRunLog: DraftLogEntry[];
  testSendLog: DraftLogEntry[];
  testSentJobIds: string[];
  verbReviewLog: DraftLogEntry[];
  verbHeldHashes: string[];
  heldDrafts: HeldDraft[];
  pendingVerbRetries: HeldDraft[];
  lastSettleError: string;
  settleErrorsMailed: string[];
  lastMailError: MailErrorRecord | null;
};

export function emptyState(): HuntState {
  return {
    previewedJobIds: [],
    sentJobIds: [],
    contactedCompanies: [],
    sendsByDay: {},
    blockedJobIds: [],
    alertedThreadIds: [],
    dryRunLog: [],
    testSendLog: [],
    testSentJobIds: [],
    verbReviewLog: [],
    verbHeldHashes: [],
    heldDrafts: [],
    pendingVerbRetries: [],
    lastSettleError: "",
    settleErrorsMailed: [],
    lastMailError: null,
  };
}

export function todayKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function sendsToday(state: HuntState, now = new Date()): number {
  return state.sendsByDay[todayKey(now)] ?? 0;
}

function mailErrorRecord(value: unknown): MailErrorRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as { at?: unknown; message?: unknown };
  if (typeof record.at !== "string" || typeof record.message !== "string") {
    return null;
  }
  return { at: record.at, message: record.message };
}

export async function loadState(files: StateFiles): Promise<HuntState> {
  const raw = await files.read(STATE_FILE, { scope: SCOPE });
  if (!raw) {
    return emptyState();
  }
  const parsed = JSON.parse(raw) as Partial<HuntState>;
  const base = emptyState();
  return {
    previewedJobIds: parsed.previewedJobIds ?? base.previewedJobIds,
    sentJobIds: parsed.sentJobIds ?? base.sentJobIds,
    contactedCompanies: parsed.contactedCompanies ?? base.contactedCompanies,
    sendsByDay: parsed.sendsByDay ?? base.sendsByDay,
    blockedJobIds: parsed.blockedJobIds ?? base.blockedJobIds,
    alertedThreadIds: parsed.alertedThreadIds ?? base.alertedThreadIds,
    dryRunLog: parsed.dryRunLog ?? base.dryRunLog,
    testSendLog: parsed.testSendLog ?? base.testSendLog,
    testSentJobIds: parsed.testSentJobIds ?? base.testSentJobIds,
    verbReviewLog: parsed.verbReviewLog ?? base.verbReviewLog,
    verbHeldHashes: parsed.verbHeldHashes ?? base.verbHeldHashes,
    heldDrafts: parsed.heldDrafts ?? base.heldDrafts,
    pendingVerbRetries: parsed.pendingVerbRetries ?? base.pendingVerbRetries,
    lastSettleError: parsed.lastSettleError ?? base.lastSettleError,
    settleErrorsMailed: parsed.settleErrorsMailed ?? base.settleErrorsMailed,
    lastMailError: mailErrorRecord(parsed.lastMailError),
  };
}

export async function saveState(files: StateFiles, state: HuntState): Promise<void> {
  const trimmed: HuntState = {
    previewedJobIds: state.previewedJobIds.slice(-2000),
    sentJobIds: state.sentJobIds.slice(-2000),
    contactedCompanies: state.contactedCompanies.slice(-2000),
    sendsByDay: state.sendsByDay,
    blockedJobIds: state.blockedJobIds.slice(-2000),
    alertedThreadIds: state.alertedThreadIds.slice(-2000),
    dryRunLog: state.dryRunLog.slice(-2000),
    testSendLog: state.testSendLog.slice(-2000),
    testSentJobIds: state.testSentJobIds.slice(-2000),
    verbReviewLog: state.verbReviewLog.slice(-2000),
    verbHeldHashes: state.verbHeldHashes.slice(-2000),
    heldDrafts: state.heldDrafts.slice(-100),
    pendingVerbRetries: state.pendingVerbRetries.slice(-50),
    lastSettleError: state.lastSettleError,
    settleErrorsMailed: state.settleErrorsMailed.slice(-50),
    lastMailError: state.lastMailError,
  };
  await files.write(STATE_FILE, JSON.stringify(trimmed, null, 2), { scope: SCOPE });
}

export function companyKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export type StoredPost = {
  company: string;
  role: string;
  url: string;
  postText: string;
};

export async function rememberPosts(
  files: StateFiles,
  leads: Array<StoredPost & { jobId: string }>,
): Promise<void> {
  const raw = await files.read(POSTS_FILE, { scope: SCOPE });
  const posts: Record<string, StoredPost> = raw ? (JSON.parse(raw) as Record<string, StoredPost>) : {};
  for (const lead of leads) {
    posts[lead.jobId] = {
      company: lead.company,
      role: lead.role,
      url: lead.url,
      postText: lead.postText,
    };
  }
  const ids = Object.keys(posts);
  for (const id of ids.slice(0, Math.max(0, ids.length - 300))) {
    delete posts[id];
  }
  await files.write(POSTS_FILE, JSON.stringify(posts), { scope: SCOPE });
}

export async function loadPost(files: StateFiles, jobId: string): Promise<StoredPost | undefined> {
  const raw = await files.read(POSTS_FILE, { scope: SCOPE });
  if (!raw) {
    return undefined;
  }
  const posts = JSON.parse(raw) as Record<string, StoredPost>;
  return posts[jobId];
}

export async function writeMarker(files: StateFiles, marker: string): Promise<void> {
  await files.write(MARKER_FILE, marker, { scope: SCOPE });
}

export async function readMarker(files: StateFiles): Promise<string> {
  return (await files.read(MARKER_FILE, { scope: SCOPE })) ?? "";
}
