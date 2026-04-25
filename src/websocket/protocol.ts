import { BaseMsgSchema } from "@shellular/protocol";
import { z } from "zod";

export const ClientToHostMsgSchema = BaseMsgSchema.extend({});

export const HostToClientMsgSchema = BaseMsgSchema.extend({
	/**
	 * Which client (app) to send this message to. The server will route it based on this `clientId`.
	 */
	clientId: z.string(),
});

export type ClientToHostMsg = z.infer<typeof ClientToHostMsgSchema>;
export type HostToClientMsg = z.infer<typeof HostToClientMsgSchema>;
