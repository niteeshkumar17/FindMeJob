import net from "node:net";
import tls from "node:tls";
import { gmailAddress } from "./profile.js";

export const SMTP_HOST = "smtp.gmail.com";
export const SMTP_PORT = 587;
export const IMAP_HOST = "imap.gmail.com";
export const IMAP_PORT = 993;

const FETCH_ITEMS =
  "UID X-GM-THRID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID REFERENCES)] BODY.PEEK[TEXT]<0.500>";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export type MailMessage = {
  to: string;
  subject: string;
  body: string;
  pdf?: { name: string; bytes: Uint8Array };
};

export type InboxItem = {
  id: string;
  conversationId: string;
  subject: string;
  from: string;
  preview: string;
  received: string;
};

export class MailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailAuthError";
  }
}

export function isMailAuthError(error: unknown): error is MailAuthError {
  return error instanceof MailAuthError;
}

export type MailSocket = {
  write(data: string): void;
  onData(handler: (chunk: Buffer) => void): void;
  onError(handler: (error: Error) => void): void;
  onClose(handler: () => void): void;
  end(): void;
  startTls(): Promise<void>;
};

type Creds = { address: string; password: string };
type Connect = (host: string, port: number) => Promise<MailSocket>;

let connectOverride: Connect | undefined;

/** Tests inject a socket. Production uses smtp.gmail.com:587 and imap.gmail.com:993. */
export function setMailConnectForTests(next: Connect | undefined): void {
  connectOverride = next;
}

export function imapSinceDate(now: Date): string {
  const start = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  return `${start.getUTCDate()}-${MONTHS[start.getUTCMonth()]}-${start.getUTCFullYear()}`;
}

/** Gmail thread id, otherwise the first References id, otherwise the message id. */
export function inboxThreadId(input: {
  threadId?: string;
  references?: string;
  messageId?: string;
  uid: string;
}): string {
  const thread = input.threadId?.trim();
  if (thread) {
    return thread;
  }
  const refs = input.references?.match(/<[^>]+>/g);
  if (refs && refs.length > 0) {
    return refs[0];
  }
  const message = input.messageId?.trim();
  if (message) {
    return message;
  }
  return input.uid;
}

/** Check SMTP and IMAP login. An auth failure throws before any hunt work. */
export async function assertMailReady(): Promise<void> {
  const creds = requireGmail();
  await verifySmtp(creds);
  await verifyImap(creds);
}

export async function sendViaSmtp(message: MailMessage): Promise<void> {
  const creds = requireGmail();
  const socket = await connectMail(SMTP_HOST, SMTP_PORT);
  const lines = bind(socket);
  try {
    await smtpHandshake(socket, lines, creds);
    const from = await smtpCommand(socket, lines, `MAIL FROM:<${creds.address}>`);
    if (from.code !== 250) {
      throw smtpFailure("SMTP MAIL FROM", from, creds);
    }
    const rcpt = await smtpCommand(socket, lines, `RCPT TO:<${singleLine(message.to)}>`);
    if (rcpt.code !== 250 && rcpt.code !== 251) {
      throw smtpFailure("SMTP RCPT TO", rcpt, creds);
    }
    const data = await smtpCommand(socket, lines, "DATA");
    if (data.code !== 354) {
      throw smtpFailure("SMTP DATA", data, creds);
    }
    socket.write(`${buildData(creds.address, message)}\r\n.\r\n`);
    const sent = await readSmtp(lines);
    if (sent.code !== 250) {
      throw smtpFailure("SMTP send", sent, creds);
    }
    socket.write("QUIT\r\n");
  } finally {
    socket.end();
  }
}

export async function readRecentInbox(now = new Date()): Promise<InboxItem[]> {
  const creds = requireGmail();
  const socket = await connectMail(IMAP_HOST, IMAP_PORT);
  const lines = bind(socket);
  const tags = { n: 0 };
  let loggedIn = false;
  try {
    await imapGreet(lines);
    await imapLogin(socket, lines, tags, creds);
    loggedIn = true;
    const examine = await imapCommand(socket, lines, tags, "EXAMINE INBOX");
    if (!examine.ok) {
      throw imapFailure("IMAP EXAMINE", examine.status, creds);
    }
    const search = await imapCommand(socket, lines, tags, `UID SEARCH SINCE ${imapSinceDate(now)}`);
    if (!search.ok) {
      throw imapFailure("IMAP SEARCH", search.status, creds);
    }
    const uids = parseSearch(search.text);
    const items: InboxItem[] = [];
    for (let index = 0; index < uids.length; index += 30) {
      const batch = uids.slice(index, index + 30);
      const fetched = await imapCommand(socket, lines, tags, `UID FETCH ${batch.join(",")} (${FETCH_ITEMS})`);
      if (!fetched.ok) {
        throw imapFailure("IMAP FETCH", fetched.status, creds);
      }
      items.push(...parseFetchBlocks(fetched.text));
    }
    return items;
  } finally {
    if (loggedIn) {
      await imapCommand(socket, lines, tags, "LOGOUT").catch(() => undefined);
    }
    socket.end();
  }
}

function requireGmail(): Creds {
  const address = gmailAddress();
  const password = (process.env.GMAIL_APP_PASSWORD ?? "").replace(/\s+/g, "");
  if (!address || !password) {
    throw new MailAuthError("GMAIL_ADDRESS or GMAIL_APP_PASSWORD is missing from the scheduler secret store");
  }
  return { address, password };
}

async function verifySmtp(creds: Creds): Promise<void> {
  const socket = await connectMail(SMTP_HOST, SMTP_PORT);
  const lines = bind(socket);
  try {
    await smtpHandshake(socket, lines, creds);
    socket.write("QUIT\r\n");
  } finally {
    socket.end();
  }
}

async function verifyImap(creds: Creds): Promise<void> {
  const socket = await connectMail(IMAP_HOST, IMAP_PORT);
  const lines = bind(socket);
  const tags = { n: 0 };
  let loggedIn = false;
  try {
    await imapGreet(lines);
    await imapLogin(socket, lines, tags, creds);
    loggedIn = true;
  } finally {
    if (loggedIn) {
      await imapCommand(socket, lines, tags, "LOGOUT").catch(() => undefined);
    }
    socket.end();
  }
}

async function connectMail(host: string, port: number): Promise<MailSocket> {
  if (connectOverride) {
    return connectOverride(host, port);
  }
  if (port === SMTP_PORT) {
    return connectPlain(host, port);
  }
  return connectTls(host, port);
}

function connectPlain(host: string, port: number): Promise<MailSocket> {
  return new Promise((resolve, reject) => {
    const plain = net.connect({ host, port, timeout: 20_000 });
    const fail = (error: Error) => {
      plain.destroy();
      reject(error);
    };
    plain.once("error", fail);
    plain.once("timeout", () => fail(new Error("mail connection timed out")));
    plain.once("connect", () => {
      plain.removeListener("error", fail);
      resolve(wrapUpgradeable(plain, host));
    });
  });
}

function connectTls(host: string, port: number): Promise<MailSocket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ host, port, servername: host, rejectUnauthorized: true, timeout: 20_000 });
    const fail = (error: Error) => {
      secure.destroy();
      reject(error);
    };
    secure.once("error", fail);
    secure.once("timeout", () => fail(new Error("mail connection timed out")));
    secure.once("secureConnect", () => {
      secure.removeListener("error", fail);
      resolve(wrapSecure(secure));
    });
  });
}

function wrapUpgradeable(plain: net.Socket, host: string): MailSocket {
  let current: net.Socket | tls.TLSSocket = plain;
  let dataHandler: ((chunk: Buffer) => void) | undefined;
  let errorHandler: ((error: Error) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  const pending: Buffer[] = [];
  const emit = (chunk: Buffer) => {
    if (dataHandler) {
      dataHandler(chunk);
    } else {
      pending.push(chunk);
    }
  };
  const watch = (socket: net.Socket | tls.TLSSocket) => {
    socket.on("data", emit);
    socket.on("error", (error: Error) => errorHandler?.(error));
    socket.on("close", () => closeHandler?.());
  };
  watch(plain);
  return {
    write(data) {
      current.write(data);
    },
    onData(handler) {
      dataHandler = handler;
      for (const chunk of pending) {
        handler(chunk);
      }
      pending.length = 0;
    },
    onError(handler) {
      errorHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    end() {
      current.end();
    },
    startTls() {
      return new Promise((resolve, reject) => {
        plain.removeAllListeners("data");
        plain.removeAllListeners("error");
        plain.removeAllListeners("close");
        const secure = tls.connect({ socket: plain, servername: host, rejectUnauthorized: true }, () => {
          current = secure;
          watch(secure);
          resolve();
        });
        secure.once("error", reject);
      });
    },
  };
}

function wrapSecure(secure: tls.TLSSocket): MailSocket {
  let dataHandler: ((chunk: Buffer) => void) | undefined;
  const pending: Buffer[] = [];
  secure.on("data", (chunk: Buffer) => {
    if (dataHandler) {
      dataHandler(chunk);
    } else {
      pending.push(chunk);
    }
  });
  return {
    write(data) {
      secure.write(data);
    },
    onData(handler) {
      dataHandler = handler;
      for (const chunk of pending) {
        handler(chunk);
      }
      pending.length = 0;
    },
    onError(handler) {
      secure.on("error", handler);
    },
    onClose(handler) {
      secure.on("close", () => handler());
    },
    end() {
      secure.end();
    },
    startTls() {
      return Promise.reject(new Error("TLS is already active"));
    },
  };
}

class LineBuffer {
  private buf = Buffer.alloc(0);
  private failed: Error | undefined;
  private closed = false;
  private lineWaiter: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
  private byteWaiter: { n: number; resolve: (bytes: Buffer) => void; reject: (error: Error) => void } | undefined;

  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > 5_000_000) {
      this.failed = new Error("mail response was too large");
    }
    this.flush();
  }

  fail(error: Error): void {
    this.failed = error;
    this.flush();
  }

  close(): void {
    this.closed = true;
    this.flush();
  }

  readLine(): Promise<string> {
    return withTimeout(this.readLineInner(), "mail read");
  }

  readBytes(n: number): Promise<Buffer> {
    return withTimeout(this.readBytesInner(n), "mail read");
  }

  async readImapLine(): Promise<string> {
    let line = await this.readLine();
    for (;;) {
      const literal = /\{(\d+)\}$/.exec(line);
      if (!literal) {
        return line;
      }
      const bytes = await this.readBytes(Number(literal[1]));
      const rest = await this.readLine();
      const next = `${line}\n${bytes.toString("utf8")}${rest}`;
      if (next === line) {
        return line;
      }
      line = next;
    }
  }

  private readLineInner(): Promise<string> {
    const line = this.takeLine();
    if (line !== undefined) {
      return Promise.resolve(line);
    }
    if (this.failed) {
      return Promise.reject(this.failed);
    }
    if (this.closed) {
      return Promise.reject(new Error("mail connection closed"));
    }
    return new Promise((resolve, reject) => {
      this.lineWaiter = { resolve, reject };
    });
  }

  private readBytesInner(n: number): Promise<Buffer> {
    if (this.buf.length >= n) {
      const out = Buffer.from(this.buf.subarray(0, n));
      this.buf = Buffer.from(this.buf.subarray(n));
      return Promise.resolve(out);
    }
    if (this.failed) {
      return Promise.reject(this.failed);
    }
    if (this.closed) {
      return Promise.reject(new Error("mail connection closed"));
    }
    return new Promise((resolve, reject) => {
      this.byteWaiter = { n, resolve, reject };
    });
  }

  private takeLine(): string | undefined {
    const idx = this.buf.indexOf(0x0a);
    if (idx < 0) {
      return undefined;
    }
    let line = this.buf.subarray(0, idx).toString("utf8");
    this.buf = Buffer.from(this.buf.subarray(idx + 1));
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    return line;
  }

  private flush(): void {
    if (this.byteWaiter && this.buf.length >= this.byteWaiter.n) {
      const waiter = this.byteWaiter;
      this.byteWaiter = undefined;
      const out = Buffer.from(this.buf.subarray(0, waiter.n));
      this.buf = Buffer.from(this.buf.subarray(waiter.n));
      waiter.resolve(out);
    }
    if (!this.byteWaiter && this.lineWaiter) {
      const line = this.takeLine();
      if (line !== undefined) {
        const waiter = this.lineWaiter;
        this.lineWaiter = undefined;
        waiter.resolve(line);
      }
    }
    const error = this.failed ?? (this.closed ? new Error("mail connection closed") : undefined);
    if (!error) {
      return;
    }
    if (this.lineWaiter && this.takeLine() === undefined) {
      const waiter = this.lineWaiter;
      this.lineWaiter = undefined;
      waiter.reject(error);
    }
    if (this.byteWaiter && this.buf.length < this.byteWaiter.n) {
      const waiter = this.byteWaiter;
      this.byteWaiter = undefined;
      waiter.reject(error);
    }
  }
}

function bind(socket: MailSocket): LineBuffer {
  const lines = new LineBuffer();
  socket.onData((chunk) => lines.push(chunk));
  socket.onError((error) => lines.fail(error));
  socket.onClose(() => lines.close());
  return lines;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), 20_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type SmtpReply = { code: number; text: string };

async function readSmtp(lines: LineBuffer): Promise<SmtpReply> {
  const parts: string[] = [];
  for (;;) {
    const line = await lines.readLine();
    const match = /^(\d{3})([ -])(.*)$/.exec(line);
    if (!match) {
      throw new Error("SMTP protocol error");
    }
    parts.push(match[3]);
    if (match[2] === " ") {
      return { code: Number(match[1]), text: parts.join(" ") };
    }
  }
}

async function smtpCommand(socket: MailSocket, lines: LineBuffer, command: string): Promise<SmtpReply> {
  socket.write(`${command}\r\n`);
  return readSmtp(lines);
}

async function smtpHandshake(socket: MailSocket, lines: LineBuffer, creds: Creds): Promise<void> {
  const greet = await readSmtp(lines);
  if (greet.code !== 220) {
    throw new Error(`SMTP greeting failed: ${greet.code}`);
  }
  const ehlo = await smtpCommand(socket, lines, "EHLO grokbot");
  if (ehlo.code !== 250) {
    throw new Error(`SMTP EHLO failed: ${ehlo.code}`);
  }
  const ready = await smtpCommand(socket, lines, "STARTTLS");
  if (ready.code !== 220) {
    throw new Error(`SMTP STARTTLS failed: ${ready.code}`);
  }
  await socket.startTls();
  const secure = await smtpCommand(socket, lines, "EHLO grokbot");
  if (secure.code !== 250) {
    throw new Error(`SMTP EHLO failed: ${secure.code}`);
  }
  const token = Buffer.from(`\u0000${creds.address}\u0000${creds.password}`, "utf8").toString("base64");
  socket.write(`AUTH PLAIN ${token}\r\n`);
  const auth = await readSmtp(lines);
  if (auth.code !== 235) {
    throw new MailAuthError(publicText(`SMTP auth failed: ${auth.code} ${redact(auth.text, creds)}`));
  }
}

function smtpFailure(prefix: string, reply: SmtpReply, creds: Creds): Error {
  const message = publicText(`${prefix} failed: ${reply.code} ${redact(reply.text, creds)}`);
  if (reply.code === 530 || reply.code === 534 || reply.code === 535 || reply.code === 454) {
    return new MailAuthError(message);
  }
  return new Error(message);
}

async function imapGreet(lines: LineBuffer): Promise<void> {
  const line = await lines.readImapLine();
  if (!line.startsWith("* OK") && !line.startsWith("* PREAUTH")) {
    throw new Error("IMAP greeting failed");
  }
}

async function imapLogin(
  socket: MailSocket,
  lines: LineBuffer,
  tags: { n: number },
  creds: Creds,
): Promise<void> {
  const reply = await imapCommand(
    socket,
    lines,
    tags,
    `LOGIN ${imapQuote(creds.address)} ${imapQuote(creds.password)}`,
  );
  if (!reply.ok) {
    throw new MailAuthError(publicText(`IMAP auth failed: ${redact(reply.status, creds)}`));
  }
}

async function imapCommand(
  socket: MailSocket,
  lines: LineBuffer,
  tags: { n: number },
  command: string,
): Promise<{ ok: boolean; text: string; status: string }> {
  tags.n += 1;
  const tag = `a${tags.n}`;
  socket.write(`${tag} ${command}\r\n`);
  let text = "";
  for (;;) {
    const line = await lines.readImapLine();
    text += `${line}\n`;
    if (line.startsWith(`${tag} `)) {
      return { ok: line.startsWith(`${tag} OK`), text, status: line };
    }
  }
}

function imapFailure(label: string, status: string, creds: Creds): Error {
  const message = publicText(`${label} failed: ${redact(status, creds)}`);
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(status)) {
    return new MailAuthError(message);
  }
  return new Error(message);
}

function parseSearch(text: string): string[] {
  const line = text.split("\n").find((item) => item.startsWith("* SEARCH"));
  if (!line) {
    return [];
  }
  return line
    .replace("* SEARCH", "")
    .trim()
    .split(/\s+/)
    .filter((uid) => /^\d+$/.test(uid));
}

function parseFetchBlocks(text: string): InboxItem[] {
  return text
    .split(/\n(?=\* \d+ FETCH )/)
    .filter((block) => block.includes("FETCH"))
    .flatMap((block) => {
      const item = parseFetchBlock(block);
      return item ? [item] : [];
    });
}

function parseFetchBlock(block: string): InboxItem | undefined {
  const uid = /\bUID (\d+)/.exec(block)?.[1];
  if (!uid) {
    return undefined;
  }
  const from = emailFrom(headerValue(block, "From"));
  const date = headerValue(block, "Date");
  const parsed = Date.parse(date);
  return {
    id: uid,
    conversationId: inboxThreadId({
      threadId: /\bX-GM-THRID (\d+)/.exec(block)?.[1],
      references: headerValue(block, "References"),
      messageId: headerValue(block, "Message-ID"),
      uid,
    }),
    subject: headerValue(block, "Subject"),
    from,
    preview: previewOf(bodySection(block)),
    received: Number.isFinite(parsed) ? new Date(parsed).toISOString() : date,
  };
}

function headerValue(block: string, name: string): string {
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  const match = new RegExp(`^${name}:\\s*(.*)$`, "im").exec(unfolded);
  return match?.[1]?.trim() ?? "";
}

function bodySection(block: string): string {
  const match = /BODY\[TEXT\][^\n]*\{(\d+)\}\n([\s\S]*)$/.exec(block);
  if (!match) {
    return "";
  }
  return match[2].slice(0, Number(match[1]));
}

function emailFrom(header: string): string {
  const matches = header.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi);
  return (matches?.[matches.length - 1] ?? "").toLowerCase();
}

function previewOf(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function buildData(from: string, message: MailMessage): string {
  const boundary = `grokbot_${Buffer.from(String(Date.now())).toString("hex")}`;
  const headers = [
    `From: ${from}`,
    `To: ${singleLine(message.to)}`,
    `Subject: ${encodeSubject(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
  ];
  if (!message.pdf) {
    headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64");
    return dotStuff(`${headers.join("\r\n")}\r\n\r\n${b64(message.body)}`);
  }
  const name = safeName(message.pdf.name);
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    headers.join("\r\n"),
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(message.body),
    `--${boundary}`,
    `Content-Type: application/pdf; name="${name}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${name}"`,
    "",
    b64(Buffer.from(message.pdf.bytes)),
    `--${boundary}--`,
    "",
  ];
  return dotStuff(parts.join("\r\n"));
}

function b64(data: string | Buffer): string {
  return Buffer.from(data).toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function dotStuff(text: string): string {
  return text.replace(/^\./gm, "..");
}

function encodeSubject(subject: string): string {
  const clean = singleLine(subject);
  if (/^[\x20-\x7E]*$/.test(clean)) {
    return clean;
  }
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function safeName(name: string): string {
  const clean = singleLine(name).replace(/["\\]/g, "");
  return clean.length > 0 ? clean : "resume.pdf";
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]/g, " ").trim();
}

function imapQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function redact(text: string, creds: Creds): string {
  let out = text;
  if (creds.password.length >= 8) {
    out = out.split(creds.password).join("[redacted]");
  }
  const token = Buffer.from(`\u0000${creds.address}\u0000${creds.password}`, "utf8").toString("base64");
  if (token.length > 8) {
    out = out.split(token).join("[redacted]");
  }
  return out;
}

function publicText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}
