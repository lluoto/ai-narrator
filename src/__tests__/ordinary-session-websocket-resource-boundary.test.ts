import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  ORDINARY_SESSION_WEBSOCKET_BACKPRESSURE_LIMIT,
  ORDINARY_SESSION_WEBSOCKET_MAX_PAYLOAD_LENGTH,
  createOrdinarySessionWebSocketHandler,
  type WsConnectionData,
} from "../api/ws-handler";

interface FakeSocketResult {
  ws: ServerWebSocket<WsConnectionData>;
  sent: string[];
  closed: Array<{ code?: number; reason?: string }>;
}

function fakeSocket(): FakeSocketResult {
  const sent: string[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  const ws = {
    send: (message: string) => {
      sent.push(message);
      return Buffer.byteLength(message, "utf8");
    },
    close: (code?: number, reason?: string) => {
      closed.push({ code, reason });
    },
  } as unknown as ServerWebSocket<WsConnectionData>;
  return { ws, sent, closed };
}

describe("ordinary owner WebSocket resource boundary", () => {
  test("the production handler factory limits inbound payloads and fails closed on outbound backpressure", () => {
    const handler = createOrdinarySessionWebSocketHandler({});

    expect(handler.maxPayloadLength).toBe(ORDINARY_SESSION_WEBSOCKET_MAX_PAYLOAD_LENGTH);
    expect(handler.maxPayloadLength).toBe(1024);
    expect(handler.backpressureLimit).toBe(ORDINARY_SESSION_WEBSOCKET_BACKPRESSURE_LIMIT);
    expect(handler.backpressureLimit).toBe(256 * 1024);
    expect(handler.closeOnBackpressureLimit).toBe(true);
  });

  test("answers a small text ping, while malformed and unknown messages remain no-ops", () => {
    const handler = createOrdinarySessionWebSocketHandler({});
    const socket = fakeSocket();

    handler.message(socket.ws, JSON.stringify({ type: "ping" }));
    handler.message(socket.ws, "{");
    handler.message(socket.ws, JSON.stringify({ type: "future-message" }));

    expect(socket.sent).toEqual([JSON.stringify({ type: "pong" })]);
    expect(socket.closed).toEqual([]);
  });

  test("counts text in UTF-8 bytes before parsing and closes an oversized direct input", () => {
    const handler = createOrdinarySessionWebSocketHandler({});
    const socket = fakeSocket();
    const atLimit = "😀".repeat(ORDINARY_SESSION_WEBSOCKET_MAX_PAYLOAD_LENGTH / 4);
    const overLimit = `${atLimit}😀`;

    handler.message(socket.ws, atLimit);
    expect(socket.closed).toEqual([]);
    expect(socket.sent).toEqual([]);

    handler.message(socket.ws, overLimit);
    expect(socket.closed).toEqual([{ code: 1009, reason: "Message too big" }]);
    expect(socket.sent).toEqual([]);
  });

  test("accepts small valid UTF-8 binary pings, ignores malformed binary, and closes oversized binary before decoding", () => {
    const handler = createOrdinarySessionWebSocketHandler({});
    const socket = fakeSocket();
    const smallBinary = Buffer.from('{"type":"ping"}', "utf8");
    const malformedBinary = Buffer.from([0xc3, 0x28]);
    const oversizedBinary = Buffer.alloc(ORDINARY_SESSION_WEBSOCKET_MAX_PAYLOAD_LENGTH + 1);
    let convertedToText = false;
    oversizedBinary.toString = () => {
      convertedToText = true;
      return '{"type":"ping"}';
    };

    handler.message(socket.ws, smallBinary);
    handler.message(socket.ws, malformedBinary);
    handler.message(socket.ws, oversizedBinary);

    expect(convertedToText).toBe(false);
    expect(socket.sent).toEqual([JSON.stringify({ type: "pong" })]);
    expect(socket.closed).toEqual([{ code: 1009, reason: "Message too big" }]);
  });
});
