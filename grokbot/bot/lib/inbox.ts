import { isInterviewMail, recentInbox, sendMail } from "./mail.js";
import { alertTo } from "./profile.js";
import { loadState, saveState } from "./state.js";

type StateFiles = {
  read(path: string, options?: { scope?: { kind: "deployment" } }): Promise<string | undefined>;
  write(path: string, data: string, options?: { scope?: { kind: "deployment" } }): Promise<void>;
};

/**
 * Reads the inbox and sends at most one alert per thread.
 * Returns a count only. Callers must not pass message text to the model.
 */
export async function scanInbox(files: StateFiles): Promise<{ alerts: number }> {
  const items = await recentInbox();
  const state = await loadState(files);
  let alerts = 0;
  for (const item of items) {
    if (!isInterviewMail(item) || state.alertedThreadIds.includes(item.conversationId)) {
      continue;
    }
    await sendMail({
      to: alertTo(),
      subject: `Interview alert: ${item.subject || item.from}`,
      body: [
        "This inbox thread matched the interview rules. This alert is sent once for the thread.",
        `From: ${item.from}`,
        `Received: ${item.received}`,
        `Subject: ${item.subject}`,
        "",
        item.preview,
      ].join("\n"),
    });
    state.alertedThreadIds.push(item.conversationId);
    alerts += 1;
  }
  if (alerts > 0) {
    await saveState(files, state);
  }
  return { alerts };
}
