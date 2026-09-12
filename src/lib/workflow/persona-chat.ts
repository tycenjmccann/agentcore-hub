/**
 * Shared vocabulary for idle persona chat (TEAM-4498).
 *
 * Chat resumes the SAME memory session the run used, which is what lets the
 * persona answer with its own working context — but that session also holds the
 * run's own turns: a multi-thousand-character dispatch prompt and the full agent
 * output the modal already renders above the composer. So chat turns are tagged
 * with a marker on the way in and recognised by it on the way out; anything
 * untagged is run work, not conversation, and is left out of the transcript.
 *
 * Both sides of that contract live here so the writer (the agent-chat route) and
 * the reader (the modal) can't drift apart.
 */

/** First line of every chat prompt — the tag that separates chat from run work. */
export const CHAT_MARKER = "[operator-chat]";

/** Last line of the preamble; everything after it is what the operator typed. */
export const QUESTION_MARKER = "Operator's question:";

export interface MemoryMessage {
  role?: string;
  content?: string;
  timestamp?: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** The operator's words, with the read-only preamble stripped back off. */
function stripPreamble(content: string): string {
  const at = content.lastIndexOf(QUESTION_MARKER);
  if (at === -1) return content.replace(CHAT_MARKER, "").trim();
  return content.slice(at + QUESTION_MARKER.length).trim();
}

/**
 * Chat turns out of a persona's memory session, chronological.
 *
 * A tagged user turn opens a chat exchange and admits the assistant turns that
 * follow it; an untagged user turn (a run dispatch) closes it again, so the
 * agent's work output never leaks into the transcript.
 */
export function extractChatTurns(messages: MemoryMessage[] | undefined | null): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let inChat = false;
  for (const msg of messages || []) {
    const content = typeof msg?.content === "string" ? msg.content : "";
    if (!content.trim()) continue;
    if (msg.role === "user") {
      inChat = content.includes(CHAT_MARKER);
      if (inChat) turns.push({ role: "user", text: stripPreamble(content) });
      continue;
    }
    if (inChat) turns.push({ role: "assistant", text: content.trim() });
  }
  return turns;
}
