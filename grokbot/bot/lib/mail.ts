import {
  assertMailReady,
  isMailAuthError,
  MailAuthError,
  readRecentInbox,
  sendViaSmtp,
  setMailConnectForTests,
  type InboxItem,
  type MailMessage,
} from "./gmail.js";
import { alertTo, gmailAddress } from "./profile.js";

export {
  assertMailReady,
  isMailAuthError,
  MailAuthError,
  setMailConnectForTests,
  type InboxItem,
  type MailMessage,
};

export function dryRunEnabled(): boolean {
  const value = (process.env.DRY_RUN ?? "true").trim().toLowerCase();
  return value !== "false" && value !== "0" && value !== "no";
}

/** When set, live applications go here instead of the employer. */
export function testRecipient(): string | undefined {
  const value = (process.env.TEST_RECIPIENT ?? "").trim();
  return value.length > 0 ? value : undefined;
}

export type SendMode = "dry" | "test" | "employer";

export function sendMode(): SendMode {
  if (dryRunEnabled()) {
    return "dry";
  }
  if (testRecipient()) {
    return "test";
  }
  return "employer";
}

/** First lines of a dry-run draft: employer address, its domain, and the post URL. */
export function dryRunDraftHeader(address: string, postUrl: string): string {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return `Recipient: ${address}\nDomain: ${domain}\nJob post: ${postUrl}\n`;
}

export async function sendMail(message: MailMessage): Promise<void> {
  await sendViaSmtp(message);
}

export async function recentInbox(now = new Date()): Promise<InboxItem[]> {
  return readRecentInbox(now);
}

/** Keyword rule: a human sender, not a no-reply mailbox. */
export const HUMAN_INTERVIEW_KEYWORDS = [
  "interview",
  "phone screen",
  "hiring manager",
  "schedule a call",
  "schedule a chat",
  "coding round",
  "technical round",
  "next round",
  "offer letter",
  "invitation to interview",
  "online assessment",
  "are you available",
  "availability for",
  "shortlisted",
  "hr round",
  "telephonic",
  "face to face",
  "discuss your profile",
];

/** Platform rule: the platform name plus an invite word, including no-reply senders. */
export const ASSESSMENT_PLATFORMS = ["hackerrank", "coderpad", "codility", "hackerearth"];
export const ASSESSMENT_CONTEXT = ["invited", "invitation", "assessment", "challenge", "test", "round"];

export function isInterviewMail(item: InboxItem, now = new Date()): boolean {
  const received = Date.parse(item.received);
  if (Number.isFinite(received) && now.getTime() - received > 3 * 24 * 60 * 60 * 1000) {
    return false;
  }
  const from = item.from.toLowerCase();
  const own = new Set([gmailAddress(), alertTo().toLowerCase()].filter((address) => address.length > 0));
  if (!from || own.has(from)) {
    return false;
  }
  const subject = item.subject.toLowerCase();
  if (
    subject.startsWith("[dry-run]") ||
    subject.startsWith("[grokbot]") ||
    subject.startsWith("[review]") ||
    subject.startsWith("[test]") ||
    subject.startsWith("interview alert:")
  ) {
    return false;
  }
  const blob = `${item.subject}\n${item.preview}\n${item.from}`.toLowerCase();
  const platform = ASSESSMENT_PLATFORMS.some((name) => blob.includes(name));
  const platformContext = ASSESSMENT_CONTEXT.some((word) => new RegExp(`\\b${word}\\b`).test(blob));
  if (platform && platformContext) {
    return true;
  }
  const local = from.split("@")[0] ?? "";
  if (/noreply|no-reply|donotreply|notifications|mailer-daemon|newsletter/.test(local)) {
    return false;
  }
  return HUMAN_INTERVIEW_KEYWORDS.some((keyword) => blob.includes(keyword));
}

export function resumePdf(text: string): Uint8Array {
  const lines = wrap(ascii(text), 90).slice(0, 52);
  const commands = ["BT", "/F1 10 Tf", "48 800 Td", "14 TL"];
  lines.forEach((line, index) => {
    if (index === 0) {
      commands.push(`(${pdfEscape(line)}) Tj`);
    } else {
      commands.push("T*");
      commands.push(`(${pdfEscape(line)}) Tj`);
    }
  });
  commands.push("ET");
  const stream = commands.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (next.length > width && current) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) {
      lines.push(current);
    }
  }
  return lines;
}

function ascii(text: string): string {
  return text.replace(/[^\n\r\t\x20-\x7E]/g, " ");
}

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
