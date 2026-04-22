import { env } from "@/env";

class Logger {
	private paddingLeft: number;

	constructor({ paddingLeft = 2 }: { paddingLeft?: number } = {}) {
		this.paddingLeft = paddingLeft - 1;
	}

	get padding() {
		if (this.paddingLeft <= 0) {
			return "";
		}

		return " ".repeat(this.paddingLeft);
	}

	info(...args: unknown[]) {
		this._log("info", args);
	}

	debug(...args: unknown[]) {
		if (env.NODE_ENV === "prod") {
			return;
		}

		this._log("debug", args);
	}

	warn(...args: unknown[]) {
		this._log("warn", args);
	}

	error(...args: unknown[]) {
		this._log("error", args);
	}

	private _log(level: "info" | "debug" | "warn" | "error", args: unknown[]) {
		const logLevelTag = level === "info" ? "" : `[${level}]`;

		const prefix = logLevelTag
			? `${this.padding} ${logLevelTag}`
			: this.padding;

		const timestamp = `[${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}]`;

		console[level](prefix, timestamp, ...args);
	}
}

export const logger = new Logger({ paddingLeft: 2 });
