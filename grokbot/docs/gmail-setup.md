# Gmail setup for grokbot

Grokbot sends mail with SMTP and reads the inbox with IMAP. The mailbox is `GMAIL_ADDRESS`. Sign-in uses a Google app password. There is no `mail-login` command.

## Create an app password

1. Open the Google account that will send applications.
2. Turn on 2-Step Verification.
3. Open https://myaccount.google.com/apppasswords.
4. Create an app password for Mail.
5. Copy the 16-character password. The code ignores spaces in that value.

## Local file

From the grokbot folder, put the values in `.env.local`:

```
GMAIL_ADDRESS=you@gmail.com
GMAIL_APP_PASSWORD=the-app-password
DRY_RUN=true
```

`ALERT_TO` is optional. When it is unset, interview alerts and dry-run drafts go to `GMAIL_ADDRESS`. Set `ALERT_TO` only when those notices should go to a different address.

Do not put the app password on the command line, in chat, or in git. The local copy is the `GMAIL_APP_PASSWORD` line in `grokbot/.env.local`. Agent SDK reads that file, then `.env`, for local runs. `.env.local` and `.env` are both listed in `grokbot/.gitignore`.

Cursor hosting does not read `.env.local`. After the first deploy, set the values in the scheduler secret store. Each command prompts for the value. Do not pass the value on the command line.

```powershell
npx @grok/agent-sdk secret set grokbot GMAIL_ADDRESS
npx @grok/agent-sdk secret set grokbot GMAIL_APP_PASSWORD
npx @grok/agent-sdk secret set grokbot ALERT_TO
npx @grok/agent-sdk secret set grokbot DRY_RUN
npx @grok/agent-sdk secret set grokbot TEST_RECIPIENT
npx @grok/agent-sdk secret set grokbot MAX_SENDS_PER_DAY
npx @grok/agent-sdk secret set grokbot VERB_APPROVALS
```

Enter `true` for DRY_RUN. Leave it true until a dry-run draft looks right. The first live day is a separate sequence in [go-live.md](go-live.md). Do not set DRY_RUN to `false` until that page's test send has arrived.

Set MAX_SENDS_PER_DAY to `8` until the first live day, then set it to `2`. Set VERB_APPROVALS to `none` until you approve a draft. An approved value is the SHA-256 hex of the exact resume text, from the review email. Separate hashes with commas. A job id is not an approval. See [go-live.md](go-live.md).

Skip `ALERT_TO` when dry-run drafts and alerts should go to `GMAIL_ADDRESS`.

## How mail is sent and read

SMTP uses `smtp.gmail.com` port 587. The connection starts in clear text, then upgrades with STARTTLS before login. The username is `GMAIL_ADDRESS`. The password is the app password.

IMAP uses `imap.gmail.com` port 993 with TLS. The mailbox is opened with EXAMINE, which is read-only. Message bodies are read with BODY.PEEK, so nothing is marked read. The hunt does not delete, move, copy, or flag mail. It searches the last 3 days.

An interview alert is sent once per thread. The thread key is the Gmail thread id. When that id is missing, the key is the first id in the References header.

The resume contact email is `GMAIL_ADDRESS`. That address is part of the fact text, so a resume that includes it still passes the source check.

## When login fails

If SMTP or IMAP rejects the login, the hunt stores `lastMailError` with a timestamp and the schedule run fails. It does not scan the inbox, settle held drafts, start a model turn, or send mail. Put a new app password in `.env.local`, then set `GMAIL_APP_PASSWORD` on the deployment to that same value. The error text does not include the password.
