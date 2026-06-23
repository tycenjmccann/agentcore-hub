/**
 * Cloud Code shell wire protocol — Kubernetes channel-prefix framing.
 *
 * Each WebSocket binary message is [1-byte channel][payload]. Ported from the
 * bedrock_agentcore Python SDK (runtime/shell/protocol.py). Used by the browser
 * terminal to talk to the runtime PTY over the presigned wss:// socket.
 */

export enum ShellChannel {
  STDIN = 0x00,
  STDOUT = 0x01,
  STDERR = 0x02,
  STATUS = 0x03,
  RESIZE = 0x04,
  HEARTBEAT = 0x05,
  CLOSE = 0xff,
}

const MAX_FRAME = 64 * 1024;

export interface DecodedFrame {
  channel: number;
  payload: Uint8Array;
}

export function decodeFrame(data: ArrayBuffer | Uint8Array): DecodedFrame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return { channel: bytes[0], payload: bytes.subarray(1) };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function decodeText(payload: Uint8Array): string {
  return dec.decode(payload);
}

function frame(channel: ShellChannel, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1);
  out[0] = channel;
  out.set(payload, 1);
  return out;
}

/** Encode keyboard/paste input. Caller must chunk pastes > ~64 KB. */
export function encodeStdin(text: string): Uint8Array {
  const payload = enc.encode(text);
  if (payload.length > MAX_FRAME - 1) {
    throw new Error("stdin payload exceeds 64 KB frame limit");
  }
  return frame(ShellChannel.STDIN, payload);
}

export function encodeResize(width: number, height: number): Uint8Array {
  return frame(ShellChannel.RESIZE, enc.encode(JSON.stringify({ width, height })));
}

export function encodeHeartbeat(): Uint8Array {
  return frame(ShellChannel.HEARTBEAT, new Uint8Array(0));
}

export function encodeClose(): Uint8Array {
  return frame(ShellChannel.CLOSE, new Uint8Array(0));
}
