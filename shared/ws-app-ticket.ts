import {
  type AuthedClientInfo,
  AuthedClientInfoSchema,
} from "@shellular/protocol";

import { createToken, verifyToken } from "./jwt";

const APP_WEBSOCKET_TOKEN_TTL_SECONDS = 30;

export async function createAppWebSocketToken(
  clientInfo: AuthedClientInfo,
): Promise<{ token: string; ttlSeconds: number }> {
  const token = await createToken(clientInfo, APP_WEBSOCKET_TOKEN_TTL_SECONDS);
  return { token, ttlSeconds: APP_WEBSOCKET_TOKEN_TTL_SECONDS };
}

export async function verifyAppWebSocketToken(
  token: string,
): Promise<AuthedClientInfo | null> {
  return verifyToken(token, AuthedClientInfoSchema);
}
