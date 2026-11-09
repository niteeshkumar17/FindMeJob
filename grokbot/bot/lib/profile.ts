import { createHash } from "node:crypto";

/** Mailbox that sends applications. The resume contact line uses this address. */
export function gmailAddress(): string {
  return (process.env.GMAIL_ADDRESS ?? "").trim().toLowerCase();
}

/** Interview alerts and dry-run drafts. Unset means GMAIL_ADDRESS. */
export function alertTo(): string {
  const configured = (process.env.ALERT_TO ?? "").trim();
  return configured.length > 0 ? configured : gmailAddress();
}

/** Identity that is not in the GitHub repos. Skills and job titles stay out of this text. */
export function identityText(): string {
  return [
    "Niteesh Kumar",
    "7217786935",
    gmailAddress(),
    "IEC College of Engineering and Technology",
    "Greater Noida",
    "Bachelor of Technology",
    "Computer Science and Engineering",
    "2022",
    "2026",
    "https://github.com/niteeshkumar17",
    "https://kalingastore.shop",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export const DAILY_CAP_DEFAULT = 8;

export const STATE_FILE = "job-hunt-state.json";
export const POSTS_FILE = "job-posts.json";
export const MARKER_FILE = "deploy-marker.txt";

export function maxSendsPerDay(): number {
  const raw = (process.env.MAX_SENDS_PER_DAY ?? "").trim();
  if (raw === "") {
    return DAILY_CAP_DEFAULT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DAILY_CAP_DEFAULT;
  }
  return parsed;
}

/** SHA-256 hex of the exact resume text. A changed character is a different approval. */
export function resumeApprovalHash(resumeText: string): string {
  return createHash("sha256").update(resumeText, "utf8").digest("hex");
}

export function verbApproved(resumeHash: string): boolean {
  const wanted = resumeHash.trim().toLowerCase();
  return (process.env.VERB_APPROVALS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[0-9a-f]{64}$/.test(item))
    .includes(wanted);
}
