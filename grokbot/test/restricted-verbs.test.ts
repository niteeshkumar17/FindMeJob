import assert from "node:assert/strict";
import test from "node:test";
import { restrictedVerbs, reviewResume } from "../bot/lib/facts.js";
import { hiringTitle, plainJobLabel } from "../bot/lib/jobs.js";
import { withHuntLock } from "../bot/lib/state.js";
import { IMAP_HOST, IMAP_PORT, SMTP_HOST, SMTP_PORT, inboxThreadId, setMailConnectForTests, type MailSocket } from "../bot/lib/gmail.js";
import { HELD_DRAFT_TTL_MS, heldDraftExpired, shouldMailSettleError, transmit } from "../bot/lib/deliver.js";
import { runHuntPass } from "../bot/lib/hunt-pass.js";
import { MailAuthError, isInterviewMail, recentInbox } from "../bot/lib/mail.js";
import { dryRunDraftHeader } from "../bot/lib/mail.js";
import { alertTo, gmailAddress, identityText, resumeApprovalHash, verbApproved } from "../bot/lib/profile.js";
import { emptyState, loadState, todayKey, type StateFiles } from "../bot/lib/state.js";
import { decideLiveVerbRetry } from "../bot/lib/verb-retry.js";

test("a hiring post becomes a short subject, not the raw HTML", () => {
  const comment =
    "DiaMonTech AG | Software Engineer | Berlin, Germany | Full-time | ONSITE &#x2F; PARTIAL REMOTE<p>We are an innovative team. Email bartosz.plotka@diamontech.de";
  const title = hiringTitle(comment);
  assert.equal(title.company, "DiaMonTech AG");
  assert.equal(title.role, "Software Engineer");
  const subject = `[dry-run] ${plainJobLabel(title.role, 60)} at ${plainJobLabel(title.company, 40)}`;
  assert.equal(subject, "[dry-run] Software Engineer at DiaMonTech AG");
  assert.equal(subject.includes("<p>"), false);
  assert.equal(subject.includes("&#"), false);
});

test("overlapping state changes do not drop a write", async () => {
  let value = 0;
  await Promise.all([
    withHuntLock(async () => {
      const seen = value;
      await new Promise((resolve) => setTimeout(resolve, 20));
      value = seen + 1;
    }),
    withHuntLock(async () => {
      const seen = value;
      await new Promise((resolve) => setTimeout(resolve, 20));
      value = seen + 1;
    }),
  ]);
  assert.equal(value, 2);
});

test("Led a team is flagged", () => {
  assert.ok(restrictedVerbs("Led a team").includes("led"));
});

test("LED indicator is not flagged", () => {
  assert.deepEqual(restrictedVerbs("LED indicator"), []);
  assert.deepEqual(restrictedVerbs("LED indicator. Led a team"), ["led"]);
});

test("LEDs is not flagged", () => {
  assert.deepEqual(restrictedVerbs("LEDs on the board"), []);
});

test("Managed inventory is flagged", () => {
  assert.ok(restrictedVerbs("Managed inventory").includes("managed"));
});

test("other restricted verbs match any case as whole words", () => {
  assert.ok(restrictedVerbs("She will Lead the work").includes("lead"));
  assert.ok(restrictedVerbs("LEADING the rollout").includes("leading"));
  assert.ok(restrictedVerbs("oversaw the migration").includes("oversaw"));
  assert.ok(restrictedVerbs("Spearheaded the launch").includes("spearheaded"));
  assert.ok(restrictedVerbs("headed the group").includes("headed"));
  assert.deepEqual(restrictedVerbs("leadership and unmanaged inventory"), []);
});

test("approval is the SHA-256 of the exact resume text", () => {
  const text = "Led a team";
  const changed = "Led a team.";
  const hash = resumeApprovalHash(text);
  assert.equal(hash, resumeApprovalHash(text));
  assert.notEqual(hash, resumeApprovalHash(changed));
  assert.match(hash, /^[0-9a-f]{64}$/);
  const saved = process.env.VERB_APPROVALS;
  process.env.VERB_APPROVALS = `${hash}, not-a-hash`;
  assert.equal(verbApproved(hash), true);
  assert.equal(verbApproved(resumeApprovalHash(changed)), false);
  assert.equal(verbApproved("remotive:1"), false);
  if (saved === undefined) {
    delete process.env.VERB_APPROVALS;
  } else {
    process.env.VERB_APPROVALS = saved;
  }
});

test("dry-run draft header shows recipient, domain, and post URL", () => {
  const header = dryRunDraftHeader("jobs@acme.com", "https://example.com/jobs/1");
  assert.equal(
    header,
    "Recipient: jobs@acme.com\nDomain: acme.com\nJob post: https://example.com/jobs/1\n",
  );
});

test("live verb retry sends a clean rewrite and holds the original when it fails", () => {
  const corpus = "Niteesh Kumar writes python";
  const original = "Niteesh Kumar managed python";
  const first = decideLiveVerbRetry({
    pending: false,
    originalText: original,
    resumeText: original,
    corpus,
  });
  assert.equal(first.kind, "rewrite");
  if (first.kind !== "rewrite") {
    return;
  }
  assert.ok(first.verbs.includes("managed"));
  assert.match(first.instruction, /managed/);
  assert.match(first.instruction, /send_application one time/);

  const clean = decideLiveVerbRetry({
    pending: true,
    originalText: original,
    resumeText: "Niteesh Kumar writes python",
    corpus,
  });
  assert.deepEqual(clean, { kind: "send", resumeText: "Niteesh Kumar writes python" });

  const stillVerb = decideLiveVerbRetry({
    pending: true,
    originalText: original,
    resumeText: "Niteesh Kumar Managed python",
    corpus,
  });
  assert.equal(stillVerb.kind, "hold");
  if (stillVerb.kind !== "hold") {
    return;
  }
  assert.equal(stillVerb.resumeText, original);
  assert.ok(stillVerb.retryVerbs.includes("managed"));

  const unknownWord = decideLiveVerbRetry({
    pending: true,
    originalText: original,
    resumeText: "Niteesh Kumar writes cobol",
    corpus,
  });
  assert.equal(unknownWord.kind, "hold");
  if (unknownWord.kind !== "hold") {
    return;
  }
  assert.equal(unknownWord.resumeText, original);
  assert.ok(unknownWord.retryFlags.some((flag) => flag.includes("cobol")));

  const ledToken = decideLiveVerbRetry({
    pending: true,
    originalText: original,
    resumeText: "Niteesh Kumar writes python LED",
    corpus,
  });
  assert.deepEqual(ledToken, { kind: "send", resumeText: "Niteesh Kumar writes python LED" });
});

test("retry send goes through transmit and the daily cap blocks it", async () => {
  const decision = decideLiveVerbRetry({
    pending: true,
    originalText: "Niteesh Kumar managed python",
    resumeText: "Niteesh Kumar writes python",
    corpus: "Niteesh Kumar writes python",
  });
  assert.equal(decision.kind, "send");
  if (decision.kind !== "send") {
    return;
  }
  const saved = process.env.MAX_SENDS_PER_DAY;
  process.env.MAX_SENDS_PER_DAY = "2";
  try {
    const state = emptyState();
    const day = todayKey();
    state.sendsByDay[day] = 2;
    const result = await transmit(
      state,
      {
        jobId: "remotive:1",
        company: "Acme",
        role: "Engineer",
        url: "https://example.com/job",
        targetEmail: "jobs@acme.com",
        resumeText: decision.resumeText,
      },
      "employer",
    );
    assert.deepEqual(result, { sent: false, reason: "daily cap reached" });
    assert.deepEqual(state.sentJobIds, []);
    assert.deepEqual(state.contactedCompanies, []);
    assert.equal(state.sendsByDay[day], 2);
  } finally {
    if (saved === undefined) {
      delete process.env.MAX_SENDS_PER_DAY;
    } else {
      process.env.MAX_SENDS_PER_DAY = saved;
    }
  }
});

test("held drafts expire after 7 days", () => {
  const now = Date.parse("2026-11-09T00:00:00Z");
  const draft = {
    at: "",
    jobId: "remotive:1",
    company: "Acme",
    role: "Engineer",
    url: "https://example.com/job",
    targetEmail: "jobs@acme.com",
    postText: "jobs@acme.com",
    resumeText: "Niteesh Kumar writes python",
    resumeHash: "abc",
    verbs: ["managed"],
  };
  assert.equal(heldDraftExpired({ ...draft, at: new Date(now - HELD_DRAFT_TTL_MS + 1).toISOString() }, now), false);
  assert.equal(heldDraftExpired({ ...draft, at: new Date(now - HELD_DRAFT_TTL_MS).toISOString() }, now), true);
});

test("a settle error is mailed once per distinct message", () => {
  const mailed = ["SMTP send failed: 535"];
  assert.equal(shouldMailSettleError(mailed, "SMTP send failed: 535"), false);
  assert.equal(shouldMailSettleError(mailed, "SMTP send failed: 450"), true);
});

test("the resume contact email comes from GMAIL_ADDRESS", () => {
  const previousAddress = process.env.GMAIL_ADDRESS;
  const previousAlert = process.env.ALERT_TO;
  process.env.GMAIL_ADDRESS = "Applicant.Name@gmail.com";
  delete process.env.ALERT_TO;
  try {
    assert.equal(gmailAddress(), "applicant.name@gmail.com");
    assert.equal(alertTo(), "applicant.name@gmail.com");
    process.env.ALERT_TO = "alerts@example.com";
    assert.equal(alertTo(), "alerts@example.com");
    const text = identityText();
    assert.equal(text.includes("applicant.name@gmail.com"), true);
    assert.equal(text.includes("outlook.com"), false);
    const review = reviewResume("Niteesh Kumar applicant.name@gmail.com Greater Noida 2022 2026", text);
    assert.deepEqual(
      review.flags.filter((flag) => /applicant|gmail|outlook/.test(flag)),
      [],
    );
  } finally {
    restoreEnv("GMAIL_ADDRESS", previousAddress);
    restoreEnv("ALERT_TO", previousAlert);
  }
});

test("thread id prefers the Gmail thread id, then References", () => {
  assert.equal(
    inboxThreadId({ threadId: "99", references: "<root@acme.com>", messageId: "<m@acme.com>", uid: "10" }),
    "99",
  );
  assert.equal(
    inboxThreadId({ references: "<root@acme.com> <m@acme.com>", messageId: "<m@acme.com>", uid: "10" }),
    "<root@acme.com>",
  );
  assert.equal(inboxThreadId({ messageId: "<m@acme.com>", uid: "10" }), "<m@acme.com>");
  assert.equal(inboxThreadId({ uid: "10" }), "10");
});

test("SMTP auth failure records lastMailError and sends no application", async () => {
  await assertAuthFailureSkipsHunt("smtp");
});

test("IMAP auth failure records lastMailError and sends no application", async () => {
  await assertAuthFailureSkipsHunt("imap");
});

test("inbox scan is read-only and uses the Gmail thread id", async () => {
  const previousAddress = process.env.GMAIL_ADDRESS;
  const previousPassword = process.env.GMAIL_APP_PASSWORD;
  const commands: string[] = [];
  process.env.GMAIL_ADDRESS = "applicant@gmail.com";
  process.env.GMAIL_APP_PASSWORD = APP_PASSWORD;
  setMailConnectForTests(async (host, port) => {
    assert.equal(host, IMAP_HOST);
    assert.equal(port, IMAP_PORT);
    return scriptedImap(commands);
  });
  try {
    const now = new Date("2026-11-09T03:32:00.000Z");
    const items = await recentInbox(now);
    const wire = commands.join("\n");
    assert.equal(wire.includes(APP_PASSWORD), false);
    assert.match(wire, /EXAMINE INBOX/);
    assert.match(wire, /UID SEARCH SINCE 6-Nov-2026/);
    assert.match(wire, /BODY\.PEEK\[/);
    assert.equal(/\b(STORE|EXPUNGE|MOVE|DELETE|COPY|CLOSE|SELECT)\b/i.test(wire), false);
    assert.equal(/\bBODY\[/.test(wire), false);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.conversationId, "99");
    assert.equal(items[0]?.from, "hr@acme.com");
    assert.equal(items[0]?.subject, "Interview on Monday");
    assert.equal(items[0]?.preview, "Hello there");
    assert.equal(isInterviewMail(items[0], now), true);
  } finally {
    setMailConnectForTests(undefined);
    restoreEnv("GMAIL_ADDRESS", previousAddress);
    restoreEnv("GMAIL_APP_PASSWORD", previousPassword);
  }
});

const APP_PASSWORD = "app-secret-value";

async function assertAuthFailureSkipsHunt(kind: "smtp" | "imap"): Promise<void> {
  const sent: string[] = [];
  const files = memoryFiles();
  const previousAddress = process.env.GMAIL_ADDRESS;
  const previousPassword = process.env.GMAIL_APP_PASSWORD;
  process.env.GMAIL_ADDRESS = "applicant@gmail.com";
  process.env.GMAIL_APP_PASSWORD = APP_PASSWORD;
  setMailConnectForTests(async (host, port) => {
    if (host === SMTP_HOST) {
      assert.equal(port, SMTP_PORT);
      return scriptedSmtp(kind === "smtp" ? "reject" : "accept");
    }
    if (kind === "smtp") {
      throw new Error("application scan attempted");
    }
    assert.equal(host, IMAP_HOST);
    assert.equal(port, IMAP_PORT);
    return scriptedImapReject();
  });
  try {
    await assert.rejects(
      () =>
        runHuntPass({
          files,
          now: new Date("2026-11-09T03:32:00.000Z"),
          scanInbox: async () => {
            sent.push("scan");
          },
          settleHeldDrafts: async () => {
            sent.push("settle");
          },
          clearSettleError: async () => {
            sent.push("clear");
          },
          recordSettleError: async () => {
            sent.push("settle-mail");
          },
          startModel: () => {
            sent.push("model");
          },
        }),
      (error: unknown) => {
        if (!(error instanceof MailAuthError)) {
          return false;
        }
        if (error.message.includes(APP_PASSWORD)) {
          return false;
        }
        return kind === "smtp" ? /Username and Password not accepted/.test(error.message) : /Invalid credentials/.test(error.message);
      },
    );
    const state = await loadState(files);
    assert.deepEqual(sent, []);
    assert.deepEqual(state.sentJobIds, []);
    assert.deepEqual(state.contactedCompanies, []);
    assert.equal(state.lastMailError?.at, "2026-11-09T03:32:00.000Z");
    assert.equal((state.lastMailError?.message ?? "").includes(APP_PASSWORD), false);
    assert.match(
      state.lastMailError?.message ?? "",
      kind === "smtp" ? /Username and Password not accepted/ : /Invalid credentials/,
    );
  } finally {
    setMailConnectForTests(undefined);
    restoreEnv("GMAIL_ADDRESS", previousAddress);
    restoreEnv("GMAIL_APP_PASSWORD", previousPassword);
  }
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function verbOf(line: string): string {
  const parts = line.trim().split(/\s+/);
  if (/^a\d+$/i.test(parts[0] ?? "")) {
    return (parts[1] ?? "").toUpperCase();
  }
  return (parts[0] ?? "").toUpperCase();
}

class FakeMailSocket implements MailSocket {
  private dataHandler: ((chunk: Buffer) => void) | undefined;
  private pending: Buffer[] = [];

  constructor(private respond: (line: string) => void) {}

  push(text: string): void {
    const chunk = Buffer.from(text);
    if (this.dataHandler) {
      this.dataHandler(chunk);
    } else {
      this.pending.push(chunk);
    }
  }

  write(data: string): void {
    this.respond(data);
  }

  onData(handler: (chunk: Buffer) => void): void {
    this.dataHandler = handler;
    for (const chunk of this.pending) {
      handler(chunk);
    }
    this.pending = [];
  }

  onError(): void {}

  onClose(): void {}

  end(): void {}

  startTls(): Promise<void> {
    return Promise.resolve();
  }
}

function scriptedSmtp(mode: "accept" | "reject"): MailSocket {
  const socket = new FakeMailSocket((data) => {
    const verb = verbOf(data);
    if (verb === "EHLO") {
      socket.push("250 AUTH PLAIN\r\n");
      return;
    }
    if (verb === "STARTTLS") {
      socket.push("220 Ready\r\n");
      return;
    }
    if (verb === "AUTH") {
      socket.push(mode === "accept" ? "235 Accepted\r\n" : "535 5.7.8 Username and Password not accepted\r\n");
      return;
    }
    if (verb === "QUIT") {
      socket.push("221 Bye\r\n");
      return;
    }
    throw new Error(`application send attempted: ${verb}`);
  });
  socket.push("220 smtp.gmail.com ESMTP\r\n");
  return socket;
}

function scriptedImapReject(): MailSocket {
  const socket = new FakeMailSocket((data) => {
    const verb = verbOf(data);
    const tag = data.trim().split(/\s+/)[0];
    if (verb === "LOGIN") {
      socket.push(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
      return;
    }
    throw new Error(`application scan attempted: ${verb}`);
  });
  socket.push("* OK Gimap ready\r\n");
  return socket;
}

function scriptedImap(commands: string[]): MailSocket {
  const socket = new FakeMailSocket((data) => {
    const verb = verbOf(data);
    const tag = data.trim().split(/\s+/)[0];
    if (verb === "LOGIN" || verb === "AUTH") {
      commands.push(verb);
    } else {
      commands.push(data.replace(/\r?\n/g, " ").trim());
    }
    if (verb === "LOGIN") {
      socket.push(`${tag} OK LOGIN completed\r\n`);
      return;
    }
    if (verb === "EXAMINE") {
      socket.push(`* 1 EXISTS\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
      return;
    }
    if (verb === "UID" && data.includes("SEARCH")) {
      socket.push(`* SEARCH 10\r\n${tag} OK SEARCH completed\r\n`);
      return;
    }
    if (verb === "UID" && data.includes("FETCH")) {
      const header =
        "From: HR <hr@acme.com>\r\nSubject: Interview on Monday\r\nDate: Mon, 09 Nov 2026 03:00:00 +0000\r\nMessage-ID: <m@acme.com>\r\nReferences: <root@acme.com>\r\n";
      const body = "Hello there";
      socket.push(
        `* 1 FETCH (UID 10 X-GM-THRID 99 BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID REFERENCES)] {${Buffer.byteLength(header)}}\r\n` +
          header +
          ` BODY[TEXT]<0> {${Buffer.byteLength(body)}}\r\n` +
          body +
          `)\r\n` +
          `${tag} OK FETCH completed\r\n`,
      );
      return;
    }
    if (verb === "LOGOUT") {
      socket.push(`${tag} OK LOGOUT completed\r\n`);
      return;
    }
    throw new Error(`application scan attempted: ${verb}`);
  });
  socket.push("* OK Gimap ready\r\n");
  return socket;
}

function memoryFiles(): StateFiles {
  const store = new Map<string, string>();
  return {
    async read(path) {
      return store.get(path);
    },
    async write(path, data) {
      store.set(path, data);
    },
  };
}
