#!/usr/bin/env tsx
/**
 * notices — manage the app notices file (content/notices.json).
 *
 * Notices are dismiss-once popups shown in the app. Each has a stable `id`;
 * the app remembers which ids a user dismissed, so a NEW id = a fresh popup
 * for everyone. This CLI owns id generation so ids are never hand-typed.
 *
 * The running server re-reads the file about once an hour, so changes made
 * here reach the app without a redeploy.
 *
 * Usage:
 *   pnpm notices list
 *   pnpm notices add                                  (prompts for title & body)
 *   pnpm notices add --title "Heads up" --body "..."  (non-interactive)
 *   pnpm notices edit <id> [--title "..."] [--body "..."]
 *   pnpm notices rm <id>
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { nanoid } from "nanoid";

const NOTICES_FILE = join(__dirname, "..", "content", "notices.json");

type Notice = {
	id: string;
	title: string;
	body: string;
	createdAt: string;
};

type NoticesFile = { notices: Notice[] };

async function load(): Promise<NoticesFile> {
	try {
		const raw = await readFile(NOTICES_FILE, "utf8");
		const parsed = JSON.parse(raw) as NoticesFile;
		if (!Array.isArray(parsed.notices)) return { notices: [] };
		return parsed;
	} catch {
		return { notices: [] };
	}
}

async function save(data: NoticesFile): Promise<void> {
	await writeFile(
		NOTICES_FILE,
		`${JSON.stringify(data, null, "\t")}\n`,
		"utf8",
	);
}

/** Parse `--flag value` pairs out of an argv slice. */
function parseFlags(args: string[]): Record<string, string> {
	const flags: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const value = args[i + 1];
			if (value === undefined || value.startsWith("--")) {
				fail(`Missing value for --${key}`);
			}
			flags[key] = value;
			i++;
		}
	}
	return flags;
}

function fail(message: string): never {
	console.error(`error: ${message}`);
	process.exit(1);
}

/**
 * Sequential terminal prompts. We pull from a single shared line iterator
 * rather than calling `rl.question()` repeatedly: with piped (non-TTY) stdin,
 * a second `question()` call can miss the buffered input and hang, whereas the
 * async line iterator drains every line reliably. Works the same for a real TTY.
 */
function makePrompter() {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const lines = rl[Symbol.asyncIterator]();

	async function required(label: string): Promise<string> {
		for (;;) {
			process.stdout.write(label);
			const next = await lines.next();
			if (next.done) fail("input ended before a value was entered");
			const answer = next.value.trim();
			if (answer) return answer;
			console.error("  (required — please enter a value)");
		}
	}

	return { required, close: () => rl.close() };
}

function printNotice(n: Notice): void {
	console.log(`${n.id}`);
	console.log(`  title: ${n.title}`);
	console.log(`  body:  ${n.body}`);
	console.log(`  added: ${n.createdAt}`);
	console.log("-".repeat(40));
}

async function cmdList(): Promise<void> {
	const { notices } = await load();
	if (notices.length === 0) {
		console.log("No notices.");
		return;
	}
	for (const n of notices) printNotice(n);
	console.log(`\n${notices.length} notice(s).`);
}

async function cmdAdd(args: string[]): Promise<void> {
	const flags = parseFlags(args);
	// Flags win when provided; otherwise fall back to interactive prompts so
	// `pnpm notices add` with no args just works. A single readline interface is
	// shared across prompts — closing one mid-command would kill stdin for the next.
	let title = flags.title;
	let body = flags.body;
	if (title === undefined || body === undefined) {
		const prompter = makePrompter();
		try {
			if (title === undefined) title = await prompter.required("Title: ");
			if (body === undefined) body = await prompter.required("Body:  ");
		} finally {
			prompter.close();
		}
	}

	const data = await load();
	const notice: Notice = {
		id: `notice-${nanoid(10)}`,
		title,
		body,
		createdAt: new Date().toISOString(),
	};
	data.notices.push(notice);
	await save(data);
	console.log("Added notice:");
	printNotice(notice);
}

async function cmdEdit(args: string[]): Promise<void> {
	const id = args[0];
	if (!id || id.startsWith("--")) fail("edit requires a notice id");
	const flags = parseFlags(args.slice(1));
	if (!flags.title && !flags.body) {
		fail("nothing to change; pass --title and/or --body");
	}

	const data = await load();
	const notice = data.notices.find((n) => n.id === id);
	if (!notice) fail(`no notice with id "${id}"`);
	if (flags.title) notice.title = flags.title;
	if (flags.body) notice.body = flags.body;
	await save(data);
	console.log("Updated notice:");
	printNotice(notice);
}

async function cmdRm(args: string[]): Promise<void> {
	const id = args[0];
	if (!id || id.startsWith("--")) fail("rm requires a notice id");

	const data = await load();
	const before = data.notices.length;
	data.notices = data.notices.filter((n) => n.id !== id);
	if (data.notices.length === before) fail(`no notice with id "${id}"`);
	await save(data);
	console.log(`Removed notice "${id}".`);
}

function usage(): void {
	console.log(
		[
			"Usage:",
			"  notices list",
			"  notices add                                  (prompts for title & body)",
			'  notices add --title "..." --body "..."       (non-interactive)',
			'  notices edit <id> [--title "..."] [--body "..."]',
			"  notices rm <id>",
		].join("\n"),
	);
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	switch (command) {
		case "list":
			await cmdList();
			break;
		case "add":
			await cmdAdd(rest);
			break;
		case "edit":
			await cmdEdit(rest);
			break;
		case "rm":
			await cmdRm(rest);
			break;
		default:
			usage();
			process.exit(command ? 1 : 0);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
