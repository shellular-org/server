import type { Duplex } from "node:stream";

/**
 * Reject an HTTP upgrade request by sending a 403 response and closing the socket.
 *
 * @param socket The duplex stream representing the client connection.
 */
export function rejectUpgrade(socket: Duplex): void {
  socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  socket.destroy();
}
