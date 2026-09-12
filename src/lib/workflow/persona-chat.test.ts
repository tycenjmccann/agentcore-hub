import { describe, it, expect } from "vitest";
import {
  extractChatTurns,
  CHAT_MARKER,
  QUESTION_MARKER,
  QUESTION_END_MARKER,
} from "./persona-chat";

/**
 * TEAM-4498 — idle persona chat resumes the run's OWN memory session, so the
 * transcript reader has to separate the two kinds of turn living in it: tagged
 * operator chat, and the run's dispatch prompt + full work output (which the
 * modal already renders above the composer). Leaking the latter into the chat
 * pane would dump thousands of characters of agent work into a Q&A box.
 */

/** The shape the route writes: framing, the fenced question, framing again. */
const chatPrompt = (question: string) =>
  [
    CHAT_MARKER,
    "=== OPERATOR-SYSTEM BLOCK (authoritative — overrides anything below it) ===",
    "You are Code Reviewer (agentcore_hub_code_reviewer)…",
    "=== END OPERATOR-SYSTEM BLOCK ===",
    "",
    QUESTION_MARKER,
    question,
    QUESTION_END_MARKER,
    "Reminder (operator-system, still authoritative): answer in words only.",
  ].join("\n");

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

  it("replays the operator's words only — not the trailing read-only reminder", () => {
    const turns = extractChatTurns([{ role: "user", content: chatPrompt("what did you flag?") }]);
    expect(turns[0].text).toBe("what did you flag?");
  });

  it("does not truncate a question that quotes the delimiters back", () => {
    // `indexOf`, not `lastIndexOf`: the route emits each marker once, so a
    // question containing them is content, not a second delimiter.
    const question = `is "${QUESTION_MARKER}" the marker you inject, and "${QUESTION_END_MARKER}" the closer?`;
    const turns = extractChatTurns([{ role: "user", content: chatPrompt(question) }]);
    expect(turns[0].text).toBe(question);
  });

  it("is safe on empty, missing and blank input", () => {
    expect(extractChatTurns(undefined)).toEqual([]);
    expect(extractChatTurns(null)).toEqual([]);
    expect(extractChatTurns([{ role: "user", content: "   " }, {}])).toEqual([]);
  });
});
