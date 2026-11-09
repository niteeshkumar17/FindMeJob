import { defineEval } from "@grok/agent-sdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "A resume that claims COBOL is checked against GitHub and the store.",
  async test(t) {
    await t.send(
      'Call review_resume with resumeText set to "Niteesh Kumar is a QA Architect who uses COBOL. 35% growth."',
    );
    t.succeeded();
    t.calledTool("review_resume");
    t.notCalledTool("send_application");
  },
});
