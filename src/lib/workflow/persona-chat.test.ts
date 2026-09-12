import { describe, it, expect } from "vitest";
import { extractChatTurns, CHAT_MARKER, QUESTION_MARKER } from "./persona-chat";

/**
 * TEAM-4498 — idle persona chat resumes the run's OWN memory session, so the
 * transcript reader has to separate the two kinds of turn living in it: tagged
 * operator chat, and the run's dispatch prompt + full work output (which the
 * modal already renders above the composer). Leaking the latter into the chat
 * pane would dump thousands of characters of agent work into a Q&A box.
 */

const chatPrompt = (question: string) =>
  [CHAT_MARKER, "You are Code Reviewer (agentcore_hub_code_reviewer)…", "", QUESTION_MARKER, question].join("\n");

describe("extractChatTurns", () => {
  it("keeps tagged chat turns and strips the preamble back off", () => {
    const turns = extractChatTurns([
      { role: "user", content: chatPrompt("why did you reject the first patch?") },
      { role: "assistant", content: "It reintroduced the race in the reaper." },
    ]);
    expect(turns).toEqual([
      { role: "user", text: "why did you reject the first patch?" },
      { role: "assistant", text: "It reintroduced the race in the reaper." },
    ]);
  });

  it("drops the run's own dispatch prompt and work output", () => {
    const turns = extractChatTurns([
      { role: "user", content: "You are assigned TEAM-4001. Review the branch and…" },
      { role: "assistant", content: "## Review\n\n80 lines of findings…" },
      { role: "user", content: chatPrompt("summarise that review") },
      { role: "assistant", content: "Two blockers, one nit." },
    ]);
    expect(turns).toEqual([
      { role: "user", text: "summarise that review" },
      { role: "assistant", text: "Two blockers, one nit." },
    ]);
  });

  it("stops admitting assistant turns once a run dispatch reopens work", () => {
    const turns = extractChatTurns([
      { role: "user", content: chatPrompt("all good?") },
      { role: "assistant", content: "Yes." },
      { role: "user", content: "You are assigned TEAM-4002. Fix the failing test." },
      { role: "assistant", content: "Pushed a fix." },
    ]);
    expect(turns.map(t => t.text)).toEqual(["all good?", "Yes."]);
  });

  it("is safe on empty, missing and blank input", () => {
    expect(extractChatTurns(undefined)).toEqual([]);
    expect(extractChatTurns(null)).toEqual([]);
    expect(extractChatTurns([{ role: "user", content: "   " }, {}])).toEqual([]);
  });
});
