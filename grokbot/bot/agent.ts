import { defineAgent } from "@grok/agent-sdk";

export default defineAgent({
  description:
    "Finds tech jobs with a public apply-by-email address and drafts a resume from Niteesh Kumar's GitHub and store. Interview mail is classified in code, outside the model.",
  model: {
    id: "grok-4.7",
    params: [
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  },
  hosting: {
    egressDomains: [
      "smtp.gmail.com",
      "imap.gmail.com",
      "api.github.com",
      "raw.githubusercontent.com",
      "kalingastore.shop",
      "www.kalingastore.shop",
      "remotive.com",
      "remoteok.com",
      "www.arbeitnow.com",
      "hn.algolia.com",
    ],
    secretNames: ["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD", "ALERT_TO", "DRY_RUN", "TEST_RECIPIENT", "MAX_SENDS_PER_DAY", "VERB_APPROVALS"],
  },
});
