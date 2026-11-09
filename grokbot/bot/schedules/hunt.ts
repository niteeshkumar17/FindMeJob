import { defineSchedule } from "@grok/agent-sdk/schedules";
import { runHuntPass } from "../lib/hunt-pass.js";

const PROMPT = `Run one job-hunt pass. Call search_jobs and send_application only. Do not invent employers, emails, or resume facts. Do not read mail and do not ask for inbox contents.

1. Call search_jobs.
2. If factsOk is false, stop. Do not draft a resume.
3. For each job, write a plain-text resume that uses only words and numbers present in the facts text. Do not use these words in any case: led, lead, leading, architected, managed, owned, oversaw, spearheaded, headed. The tokens LED and LEDs are allowed. Then call send_application with only that job's jobId and resumeText. Do not pass an email address, company, role, or url.
4. If send_application returns reason "rewrite", follow its instruction once. That call is the only rewrite for those words.
5. If send_application returns flags, rewrite once using only the facts text and call send_application again. If it still returns flags, leave that job.
6. Reply with a short log: dry run, test recipient, or live; how many drafts; how many blocked. Do not mention inbox messages.`;

export default defineSchedule({
  cron: "0 */2 * * *",
  async run({ receive, waitUntil, appAuth, host }) {
    await runHuntPass({
      files: host.files,
      startModel() {
        waitUntil(
          receive("http", {
            message: PROMPT,
            auth: appAuth,
          }),
        );
      },
    });
  },
});
