import type { Duplex } from "node:stream";

const STATUS_TEXT: Record<number, string> = {
  401: "Unauthorized",
  403: "Forbidden",
};

/**
 * Reject an HTTP upgrade request by sending an error response and closing the
 * socket. The status distinguishes retryable from permanent failures for the
 * client:
 *   - 401 Unauthorized → the token was missing/expired/invalid; the client should
 *     mint a fresh one and retry.
 *   - 403 Forbidden (default) → the request is otherwise not allowed; permanent.
 *
 * @param socket The duplex stream representing the client connection.
 * @param status HTTP status to send (defaults to 403).
 */
export function rejectUpgrade(socket: Duplex, status: 401 | 403 = 403): void {
  const reason = STATUS_TEXT[status];
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
