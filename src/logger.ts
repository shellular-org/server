import chalk from "chalk";

type LogLevel = "info" | "warn" | "error" | "debug";

const isDev = process.env.NODE_ENV !== "production";

function formatMessage(level: LogLevel, message: string, meta?: unknown) {
	const timestamp = new Date().toISOString();
	const base = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

	if (!meta) return base;

	try {
		return `${base} ${JSON.stringify(meta)}`;
	} catch {
		return `${base} ${meta}`;
	}
}

function log(level: LogLevel, message: string, meta?: unknown) {
	const formatted = formatMessage(level, message, meta);

	switch (level) {
		case "info":
			console.log(formatted);
			break;
		case "warn":
			console.warn(formatted);
			break;
		case "error":
			console.error(chalk.redBright(formatted));
			break;
		case "debug":
			if (isDev) {
				console.debug(formatted);
			}
			break;
	}
}

export const logger = {
	info: (msg: string, meta?: unknown) => log("info", msg, meta),
	warn: (msg: string, meta?: unknown) => log("warn", msg, meta),
	error: (msg: string, meta?: unknown) => log("error", msg, meta),
	debug: (msg: string, meta?: unknown) => log("debug", msg, meta),
};
