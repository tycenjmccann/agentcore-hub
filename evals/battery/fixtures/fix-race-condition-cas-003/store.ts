// Sanitized battery fixture — conversation state store wrapper for sample-service.
// The backing client supports conditional writes (expectedVersion), but this
// wrapper performs unconditional read-modify-write saves.

export interface ConversationRecord {
  sessionId: string;
  messages: { role: string; content: string }[];
  stopRequested: boolean;
  version: number;
}

interface BackingClient {
  get(key: string): Promise<ConversationRecord | null>;
  put(key: string, record: ConversationRecord): Promise<void>;
  // Available but unused: rejects when stored version !== expectedVersion.
  putIfVersion(key: string, record: ConversationRecord, expectedVersion: number): Promise<void>;
}

export class ConversationStore {
  constructor(private client: BackingClient) {}

  async appendMessage(sessionId: string, role: string, content: string): Promise<void> {
    const record = (await this.client.get(sessionId)) ?? {
      sessionId,
      messages: [],
      stopRequested: false,
      version: 0,
    };
    record.messages.push({ role, content });
    // BUG LIVES HERE: unconditional save; a concurrent stop write between the
    // get() above and this put() is overwritten with the stale record.
    await this.client.put(sessionId, record);
  }

  async requestStop(sessionId: string): Promise<void> {
    const record = await this.client.get(sessionId);
    if (!record) return;
    record.stopRequested = true;
    await this.client.put(sessionId, record);
  }

  async isStopRequested(sessionId: string): Promise<boolean> {
    const record = await this.client.get(sessionId);
    return record?.stopRequested ?? false;
  }
}
