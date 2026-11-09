# Go live

Run these steps from the grokbot folder after the first deploy. Mail setup is in [gmail-setup.md](gmail-setup.md). Leave DRY_RUN true until the dry-run drafts look right. The commands prompt for secret values. Do not put a secret value on the command line.

An SMTP or IMAP login failure records `lastMailError` and the hunt stops. It does not scan the inbox, settle held drafts, start a model turn, or send mail.

## State survival

This check uses the hosted deployment store. A local tool call writes `grokbot/.agent-serve` and does not prove that a redeploy kept state.

1. Write a marker on the hosted deployment:

```powershell
npx @grok/agent-sdk tool call state_marker --prod --slug grokbot --dir . --input '{"action":"write"}'
```

2. Copy the `marker` string from the result.
3. Redeploy grokbot.
4. Read the marker from the same hosted store:

```powershell
npx @grok/agent-sdk tool call state_marker --prod --slug grokbot --dir . --input '{"action":"read"}'
```

5. The `marker` string must be the same text you copied. The file is `deploy-marker.txt` in the deployment file scope, the same scope as `job-hunt-state.json`.

## First live day

1. Set MAX_SENDS_PER_DAY to `2`. The default, when the secret is unset or not a positive integer, is 8.
2. Set TEST_RECIPIENT to an address you control.
3. Note the current employer count:

```powershell
npx @grok/agent-sdk tool call search_jobs --prod --slug grokbot --dir . --input '{}'
```

Copy `sendsToday`.
4. Set DRY_RUN to `false` while TEST_RECIPIENT is still set. In this mode the application goes to TEST_RECIPIENT. It is logged in `testSendLog`. It does not increment `sendsByDay` and it does not add the company to `contactedCompanies`.
5. Wait for one hunt, or run the hunt schedule once. Confirm one message arrived at TEST_RECIPIENT. Its subject starts with `[test]`.
6. Run the same `search_jobs` command again. `sendsToday` must be the same number you copied. That is the check that the test send did not count toward the cap.
7. Unset TEST_RECIPIENT:

```powershell
npx @grok/agent-sdk secret delete grokbot TEST_RECIPIENT
```

After this, with DRY_RUN still `false`, send_application mails the address that appears verbatim in the stored job post, up to MAX_SENDS_PER_DAY employer emails per India calendar day.

## Restricted verbs

A draft that contains a whole word `led`, `lead`, `leading`, `architected`, `managed`, `owned`, `oversaw`, `spearheaded`, or `headed` is not sent to an employer. Any case matches. The tokens `LED` and `LEDs` do not match.

While DRY_RUN is true, that draft is stored and emailed to ALERT_TO with the subject prefix `[review]`. When ALERT_TO is unset, that mail goes to GMAIL_ADDRESS. While DRY_RUN is false, send_application returns one rewrite instruction. The next `send_application` call for that job is the retry. If the rewritten text has none of those words and passes the source check, that rewrite is sent. If it does not, the original text is stored and the review mail is sent once.

Adding the hash does not send mail by itself. The hunt schedule runs `settleHeldDrafts` at the start of the next run. That function sends a stored draft whose hash is in `VERB_APPROVALS` when DRY_RUN is false. The attached resume is the stored text. The source check still has to pass. A company is still emailed once, and MAX_SENDS_PER_DAY still applies. While TEST_RECIPIENT is set, that send goes there instead of the employer. A held draft older than 7 days is dropped, and the hunt sends one `[review]` mail listing the dropped drafts.

The review mail includes the SHA-256 hex of that exact resume text. Store approvals in the deployment secret `VERB_APPROVALS`. Local runs read the same name from `grokbot/.env.local`. `heldDrafts` in the deployment state file stores the resume text. `verbHeldHashes` only records that the review mail for that text was already sent. Neither list is an approval.

To add an approval, copy the hash from the review mail. Include every hash you still want, separated by commas, because this command replaces the whole secret:

```powershell
npx @grok/agent-sdk secret set grokbot VERB_APPROVALS
```

For a local run, set `VERB_APPROVALS` in `.env.local` to that same comma-separated list. If the resume text changes by one character, the hash changes and the old approval does not apply. The resume must still pass the GitHub and store check inside send_application.

Every dry-run draft starts with the employer recipient, that address's domain, and the job post URL.
