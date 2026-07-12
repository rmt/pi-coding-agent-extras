import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, relative, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type State = {
	patterns: string[];
	blacklistPatterns: string[];
};

const CUSTOM_TYPE = "shell-permissions-whitelist";
const HOME = resolve(process.env.HOME ?? "/HOME_ENV_NOT_SET");
const CONFIG_PATH = resolve(HOME, ".pi", "agent", "shell-permissions.json");
const DEFAULT_PATTERNS = ["^pwd$", "^ls(\\s|$)", "^head(\\s|$)", "^git status(\\s|$)", "^git diff(\\s|$)"];
const WRITE_TOOLS = new Set(["edit", "write", "quick_edit", "target_edit"]);
const SNAP_EDIT_TOOLS = new Set(["quick_edit", "target_edit"]);
const SNAP_EDIT_APPROVAL_CHANNEL = "pi-snap-edit:approval-request:v1";
const SNAP_EDIT_APPROVAL_CAPABILITY_CHANNEL = "pi-snap-edit:approval-capability:v1";

type SnapEditApprovalRequest = {
	version: 1;
	toolCallId: string;
	toolName: "quick_edit" | "target_edit";
	path: string;
	cwd: string;
	preview: string;
	attempt: number;
	signal?: AbortSignal;
	claim: () => boolean;
	respond: (decision: { approved: boolean; reason?: string }) => void;
};

function isSnapEditApprovalRequest(data: unknown): data is SnapEditApprovalRequest {
	if (typeof data !== "object" || data === null) return false;
	const request = data as Partial<SnapEditApprovalRequest>;
	return request.version === 1
		&& SNAP_EDIT_TOOLS.has(request.toolName ?? "")
		&& typeof request.toolCallId === "string"
		&& typeof request.path === "string"
		&& typeof request.cwd === "string"
		&& typeof request.preview === "string"
		&& Number.isInteger(request.attempt)
		&& (request.attempt ?? 0) >= 1
		&& typeof request.claim === "function"
		&& typeof request.respond === "function";
}

function safeRealpath(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function canonicalPathForComparison(path: string): string {
	const resolved = resolve(path);
	const exact = safeRealpath(resolved);
	if (exact) return exact;
	const parent = dirname(resolved);
	const parentRealpath = safeRealpath(parent);
	return parentRealpath ? resolve(parentRealpath, relative(parent, resolved)) : resolved;
}

const CANONICAL_HOME = canonicalPathForComparison(HOME);

function isInsideOrSame(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const BUILTIN_WRITE_ALLOWED_FILES = new Set([
	canonicalPathForComparison("/dev/null"),
]);

function isBuiltinWriteAllowedTarget(path: string): boolean {
	return BUILTIN_WRITE_ALLOWED_FILES.has(path);
}

function displayPath(path: string): string {
	const canonical = canonicalPathForComparison(path);
	return isInsideOrSame(CANONICAL_HOME, canonical) ? `~/${relative(CANONICAL_HOME, canonical)}`.replace(/\/$/, "") : canonical;
}

function toolPath(input: unknown): string | undefined {
	const path = (input as { path?: unknown })?.path;
	return typeof path === "string" && path.trim() ? path : undefined;
}

type ShellSegment = {
	part: string;
	joiner: string;
};

const DIM = "\x1b[2m";
const RESET_DIM = "\x1b[22m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET_FG = "\x1b[39m";

function splitShellSegments(command: string): ShellSegment[] {
	const parts: ShellSegment[] = [];
	let current = "";
	let quote: "'" | '"' | "`" | null = null;
	let escaped = false;

	function pushCurrent(joiner = "") {
		const trimmed = current.trim();
		if (trimmed) parts.push({ part: trimmed, joiner });
		current = "";
	}

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];
		const prev = command[i - 1];

		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}

		if (ch === "\\") {
			current += ch;
			escaped = true;
			continue;
		}

		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}

		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			current += ch;
			continue;
		}

		// Split common shell command separators/operators while leaving redirects
		// (>, <, 2>&1) attached to their command segment.
		if (ch === "|" && next !== "|" && prev !== "|") {
			pushCurrent("|");
			continue;
		}
		if (ch === "&" && next === "&") {
			pushCurrent("&&");
			i++;
			continue;
		}
		if (ch === "|" && next === "|") {
			pushCurrent("||");
			i++;
			continue;
		}
		if (ch === ";") {
			pushCurrent(";");
			continue;
		}
		if (ch === "&" && next !== ">" && prev !== ">") {
			pushCurrent("&");
			continue;
		}

		current += ch;
	}

	pushCurrent();
	return parts.length > 0 ? parts : [{ part: command.trim(), joiner: "" }];
}

function formatShellSegment(segment: ShellSegment, joiner = "", color = ""): string {
	const prefix = joiner ? `${DIM}${joiner}${RESET_DIM} ` : "";
	return color ? `${color}${prefix}${segment.part}${RESET_FG}` : `${prefix}${segment.part}`;
}

function formatShellSegments(segments: ShellSegment[], blacklistedIndexes: Set<number>, approvedIndexes: Set<number>): string[] {
	return segments.map((segment, index) => {
		const color = blacklistedIndexes.has(index) ? RED : approvedIndexes.has(index) ? GREEN : "";
		return formatShellSegment(segment, segments[index - 1]?.joiner ?? "", color);
	});
}

type ShellFileAccess = { mode: "read" | "write"; path: string; source: string };

type ShellToken = { text: string; quoted: boolean };

function shellTokens(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let current = "";
	let quote: "'" | '"' | "`" | null = null;
	let escaped = false;
	let quoted = false;
	const push = () => {
		if (current) tokens.push({ text: current, quoted });
		current = "";
		quoted = false;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			quoted = true;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			quoted = true;
			continue;
		}
		if (/\s/.test(ch)) {
			push();
			continue;
		}
		if ((ch === ">" || ch === "<") || (/\d/.test(ch) && (next === ">" || next === "<"))) {
			push();
			let op = ch;
			if (/\d/.test(ch)) {
				i++;
				op += command[i];
			}
			while ([">", "<", "&", "|"].includes(command[i + 1])) op += command[++i];
			if (/^(?:\d*)<<$/.test(op) && command[i + 1] === "-") op += command[++i];
			tokens.push({ text: op, quoted: false });
			continue;
		}
		if (["|", ";", "&"].includes(ch)) {
			push();
			let op = ch;
			if (command[i + 1] === ch) op += command[++i];
			tokens.push({ text: op, quoted: false });
			continue;
		}
		current += ch;
	}
	push();
	return tokens;
}

function isRedirect(token: string): boolean {
	return /^(?:\d*)[<>]/.test(token);
}

function isHereDocRedirect(token: string): boolean {
	return /^(?:\d*)<<-?$/.test(token);
}

function isHereStringRedirect(token: string): boolean {
	return /^(?:\d*)<<<$/.test(token);
}

function isFdTarget(token: string | undefined): boolean {
	return !token || token === "-" || /^&?-?\d+$/.test(token) || token === "&-";
}

function stripCommandName(token: string): string {
	return token.split("/").pop() ?? token;
}

function looksLikePath(token: string): boolean {
	return token.length > 0 && !token.startsWith("-") && !/^[A-Z_][A-Z0-9_]*=/.test(token) && !/[{};$|&<>]/.test(token);
}

type HereDoc = { delimiter: string; stripTabs: boolean };

function hereDocDelimiters(commandLine: string): HereDoc[] {
	const tokens = shellTokens(commandLine);
	const delimiters: HereDoc[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i].text;
		if (!isHereDocRedirect(token)) continue;
		const delimiter = tokens[i + 1]?.text;
		if (delimiter && !isFdTarget(delimiter)) {
			delimiters.push({ delimiter, stripTabs: token.endsWith("-") });
			i++;
		}
	}
	return delimiters;
}

function stripHereDocBodies(command: string): string {
	const lines = command.split("\n");
	const kept: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		kept.push(line);

		for (const doc of hereDocDelimiters(line)) {
			i++;
			while (i < lines.length) {
				const candidate = doc.stripTabs ? lines[i].replace(/^\t+/, "") : lines[i];
				if (candidate === doc.delimiter) break;
				i++;
			}
		}
	}

	return kept.join("\n");
}

function analyzeShellFileAccess(command: string): ShellFileAccess[] {
	const tokens = shellTokens(stripHereDocBodies(command));
	const accesses: ShellFileAccess[] = [];
	let commandName: string | undefined;
	const args: string[] = [];
	const flushCommand = () => {
		if (!commandName) return;
		const name = stripCommandName(commandName);
		const readArgCommands = new Set(["cat", "head", "tail", "less", "more", "wc", "sort", "uniq"]);
		if (readArgCommands.has(name)) {
			for (const arg of args) if (looksLikePath(arg)) accesses.push({ mode: "read", path: arg, source: `${name} argument` });
		}
		if (name === "grep") {
			let sawPattern = false;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === "-e" || arg === "-f") {
					if (arg === "-f" && looksLikePath(args[i + 1] ?? "")) accesses.push({ mode: "read", path: args[i + 1], source: "grep pattern file" });
					i++;
					continue;
				}
				if (arg.startsWith("-")) continue;
				if (!sawPattern) {
					sawPattern = true;
					continue;
				}
				if (looksLikePath(arg)) accesses.push({ mode: "read", path: arg, source: "grep input" });
			}
		}
		if (name === "sed" || name === "awk") {
			let sawProgram = false;
			for (const arg of args) {
				if (arg.startsWith("-")) continue;
				if (!sawProgram) {
					sawProgram = true;
					continue;
				}
				if (looksLikePath(arg)) accesses.push({ mode: "read", path: arg, source: `${name} input` });
			}
		}
		if ((name === "cp" || name === "mv") && args.length >= 2) {
			for (const arg of args.slice(0, -1)) if (looksLikePath(arg)) accesses.push({ mode: "read", path: arg, source: `${name} source` });
			const target = args[args.length - 1];
			if (looksLikePath(target)) accesses.push({ mode: "write", path: target, source: `${name} target` });
		}
		if (name === "touch") {
			for (const arg of args) if (looksLikePath(arg)) accesses.push({ mode: "write", path: arg, source: "touch argument" });
		}
		commandName = undefined;
		args.length = 0;
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i].text;
		if (["|", "||", "&&", ";", "&"].includes(token)) {
			flushCommand();
			continue;
		}
		if (isRedirect(token)) {
			if (isHereDocRedirect(token) || isHereStringRedirect(token)) {
				i++;
				continue;
			}
			const target = tokens[i + 1]?.text;
			if (target && !isFdTarget(target) && looksLikePath(target)) {
				accesses.push({ mode: token.includes(">") ? "write" : "read", path: target, source: `redirection ${token}` });
			}
			i++;
			continue;
		}
		if (!commandName) commandName = token;
		else args.push(token);
	}
	flushCommand();
	return accesses;
}

function compile(patterns: string[]): RegExp[] {
	return patterns.flatMap((pattern) => {
		try {
			return [new RegExp(pattern)];
		} catch {
			return [];
		}
	});
}

function formatList(patterns: string[], name: string): string {
	if (patterns.length === 0) return `Shell ${name} is empty.`;
	return patterns.map((p, i) => `${i + 1}. /${p}/`).join("\n");
}

function validPatterns(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : undefined;
}

function loadSavedState(): State | undefined {
	try {
		if (!existsSync(CONFIG_PATH)) return undefined;
		const data = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<State>;
		const patterns = validPatterns(data.patterns);
		const blacklistPatterns = validPatterns(data.blacklistPatterns) ?? [];
		return patterns ? { patterns, blacklistPatterns } : undefined;
	} catch {
		return undefined;
	}
}

function saveState(state: State): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
}

export default function (pi: ExtensionAPI) {
	let state: State = loadSavedState() ?? { patterns: DEFAULT_PATTERNS, blacklistPatterns: [] };
	let rules = compile(state.patterns);
	let blacklistRules = compile(state.blacklistPatterns);
	let sessionApprovedCommands = new Set<string>();
	let sessionApprovedWriteFiles = new Set<string>();
	let sessionApprovedWriteDirs = new Set<string>();
	let yoloMode = false;
	let currentCtx: ExtensionContext | undefined;
	let snapEditApprovalQueue: Promise<void> = Promise.resolve();

	function persist() {
		saveState(state);
		pi.appendEntry(CUSTOM_TYPE, { patterns: state.patterns, blacklistPatterns: state.blacklistPatterns });
		rules = compile(state.patterns);
		blacklistRules = compile(state.blacklistPatterns);
	}

	function isWhitelisted(commandPart: string): boolean {
		return rules.some((rule) => rule.test(commandPart));
	}

	function isBlacklisted(commandPart: string): boolean {
		return blacklistRules.some((rule) => rule.test(commandPart));
	}

	function updateStatus(ctx: { ui: { setStatus: (key: string, value: string | undefined) => void } }) {
		ctx.ui.setStatus("shell-permissions", yoloMode ? "\x1b[91m(yolo)\x1b[39m" : "(whitelist)");
	}

	function requiresWriteApproval(target: string, cwd: string): boolean {
		const normalizedCwd = canonicalPathForComparison(cwd);
		const normalizedTarget = canonicalPathForComparison(resolve(cwd, target));
		const cwdIsHome = normalizedCwd === CANONICAL_HOME;
		const cwdOutsideHome = !isInsideOrSame(CANONICAL_HOME, normalizedCwd);

		if (isBuiltinWriteAllowedTarget(normalizedTarget)) return false;
		if (sessionApprovedWriteFiles.has(normalizedTarget)) return false;
		for (const dir of sessionApprovedWriteDirs) {
			if (isInsideOrSame(dir, normalizedTarget)) return false;
		}

		if (cwdIsHome || cwdOutsideHome) return true;
		return !isInsideOrSame(normalizedCwd, normalizedTarget);
	}

	function hasSnapEditApprovalProtocol(): boolean {
		let supported = false;
		pi.events.emit(SNAP_EDIT_APPROVAL_CAPABILITY_CHANNEL, {
			version: 1,
			acknowledge() {
				supported = true;
			},
		});
		return supported;
	}

	async function approveWriteTool(event: { toolName: string; input: unknown }, ctx: any) {
		if (!WRITE_TOOLS.has(event.toolName)) return undefined;

		const rawPath = toolPath(event.input);
		if (!rawPath) return { block: true, reason: `${event.toolName} call has no valid path` };

		const target = canonicalPathForComparison(resolve(ctx.cwd, rawPath));
		if (!requiresWriteApproval(rawPath, ctx.cwd)) return undefined;

		const dir = dirname(target);
		const normalizedCwd = canonicalPathForComparison(ctx.cwd);
		const reason = normalizedCwd === CANONICAL_HOME
			? "CWD is your home directory"
			: !isInsideOrSame(CANONICAL_HOME, normalizedCwd)
				? "CWD is outside your home directory"
				: "target is outside the CWD";

		if (!ctx.hasUI) {
			return { block: true, reason: `${event.toolName} requires approval: ${displayPath(target)} (${reason})` };
		}

		const choice = await ctx.ui.select(
			`Approve ${event.toolName}?

File:
  ${displayPath(target)}

CWD:
  ${displayPath(normalizedCwd)}

Reason: ${reason}`,
			["Allow once", `Allow directory for session (${displayPath(dir)})`, `Allow explicit file for session (${displayPath(target)})`, "Reject with feedback", "Reject"],
		);

		if (choice === "Allow once") return undefined;
		if (choice?.startsWith("Allow directory")) {
			sessionApprovedWriteDirs.add(dir);
			return undefined;
		}
		if (choice?.startsWith("Allow explicit file")) {
			sessionApprovedWriteFiles.add(target);
			return undefined;
		}
		if (choice === "Reject with feedback" || choice === undefined) {
			const feedback = await ctx.ui.input(`Reject ${event.toolName} with feedback`, "Tell the assistant what to do instead...");
			const suffix = feedback ? ` Feedback: ${feedback}` : "";
			return { block: true, reason: `Blocked ${event.toolName} to ${displayPath(target)} (${reason}).${suffix}` };
		}
		return { block: true, reason: `Blocked ${event.toolName} to ${displayPath(target)} (${reason})` };
	}

	function shellWriteTargetsNeedingApproval(accesses: ShellFileAccess[], ctx: any) {
		return accesses
			.filter((access) => access.mode === "write" && requiresWriteApproval(access.path, ctx.cwd))
			.map((access) => ({ ...access, target: canonicalPathForComparison(resolve(ctx.cwd, access.path)) }));
	}

	async function approveSnapEditRequest(data: SnapEditApprovalRequest): Promise<void> {
		try {
			if (yoloMode || !requiresWriteApproval(data.path, data.cwd)) {
				data.respond({ approved: true });
				return;
			}

			const ctx = currentCtx;
			if (!ctx) {
				data.respond({ approved: false, reason: `${data.toolName} approval unavailable: no active session context` });
				return;
			}

			const target = canonicalPathForComparison(resolve(data.cwd, data.path));
			const dir = dirname(target);
			const normalizedCwd = canonicalPathForComparison(data.cwd);
			const reason = normalizedCwd === CANONICAL_HOME
				? "CWD is your home directory"
				: !isInsideOrSame(CANONICAL_HOME, normalizedCwd)
					? "CWD is outside your home directory"
					: "target is outside the CWD";

			if (!ctx.hasUI) {
				data.respond({ approved: false, reason: `${data.toolName} requires approval: ${displayPath(target)} (${reason})` });
				return;
			}

			const refreshed = data.attempt > 1
				? `\n\nThe file changed after the previous preview. Review refreshed plan #${data.attempt}.`
				: "";
			const choice = await ctx.ui.select(
				`Approve ${data.toolName} planned patch?${refreshed}

File:
  ${displayPath(target)}

CWD:
  ${displayPath(normalizedCwd)}

Reason: ${reason}`,
				["Allow once", `Allow directory for session (${displayPath(dir)})`, `Allow explicit file for session (${displayPath(target)})`, "Reject with feedback", "Reject"],
				data.signal ? { signal: data.signal } : undefined,
			);

			if (choice === "Allow once") {
				data.respond({ approved: true });
				return;
			}
			if (choice?.startsWith("Allow directory")) {
				sessionApprovedWriteDirs.add(dir);
				data.respond({ approved: true });
				return;
			}
			if (choice?.startsWith("Allow explicit file")) {
				sessionApprovedWriteFiles.add(target);
				data.respond({ approved: true });
				return;
			}
			if (choice === "Reject with feedback" && !data.signal?.aborted) {
				const feedback = await ctx.ui.input(`Reject ${data.toolName} with feedback`, "Tell the assistant what to do instead...");
				const suffix = feedback?.trim() ? ` Feedback: ${feedback.trim()}` : "";
				data.respond({ approved: false, reason: `Rejected ${data.toolName} planned patch.${suffix}` });
				return;
			}
			data.respond({ approved: false, reason: data.signal?.aborted ? `${data.toolName} approval cancelled` : `Rejected ${data.toolName} planned patch.` });
		} catch (error) {
			data.respond({ approved: false, reason: `${data.toolName} approval failed: ${error instanceof Error ? error.message : String(error)}` });
		}
	}

	pi.events.on(SNAP_EDIT_APPROVAL_CHANNEL, async (data) => {
		if (!isSnapEditApprovalRequest(data) || !data.claim()) return;
		if (yoloMode || !requiresWriteApproval(data.path, data.cwd)) {
			data.respond({ approved: true });
			return;
		}

		const queued = snapEditApprovalQueue.then(
			() => approveSnapEditRequest(data),
			() => approveSnapEditRequest(data),
		);
		snapEditApprovalQueue = queued.catch(() => {});
		await queued;
	});

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		snapEditApprovalQueue = Promise.resolve();
		sessionApprovedCommands = new Set<string>();
		sessionApprovedWriteFiles = new Set<string>();
		sessionApprovedWriteDirs = new Set<string>();
		yoloMode = false;
		const savedState = loadSavedState();
		if (savedState) {
			state = savedState;
		} else {
			const entries = ctx.sessionManager.getEntries();
			for (const entry of entries) {
				if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
					const data = entry.data as Partial<State> | undefined;
					const patterns = validPatterns(data?.patterns);
					const blacklistPatterns = validPatterns(data?.blacklistPatterns) ?? [];
					if (patterns) state = { patterns, blacklistPatterns };
				}
			}
		}
		rules = compile(state.patterns);
		blacklistRules = compile(state.blacklistPatterns);
		updateStatus(ctx);
	});

	pi.registerCommand("yolo", {
		description: "Toggle permissions YOLO mode (allow non-blacklisted shell commands and auto-approve snap edits)",
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			if (mode === "on") {
				yoloMode = true;
			} else if (mode === "off") {
				yoloMode = false;
			} else if (mode === "") {
				yoloMode = !yoloMode;
			} else {
				ctx.ui.notify("Usage: /yolo [on|off]", "error");
				return;
			}

			updateStatus(ctx);
			ctx.ui.notify(`Shell permissions mode: ${yoloMode ? "YOLO (shell blacklist still applies; snap edits auto-approved)" : "whitelist"}`, "info");
		},
	});

	function registerPatternCommand(commandName: "whitelist" | "blacklist", patternsKey: "patterns" | "blacklistPatterns") {
		pi.registerCommand(commandName, {
			description: `List/add/remove shell command ${commandName} regexes`,
			handler: async (args, ctx) => {
				const trimmed = args.trim();
				const [subcommand = "list", ...rest] = trimmed.split(/\s+/);

			if (subcommand === "list" || subcommand === "") {
				ctx.ui.notify(formatList(state[patternsKey], commandName), "info");
				return;
			}

			if (subcommand === "add") {
				let pattern = trimmed.slice(trimmed.indexOf("add") + 3).trim();
				if (!pattern) {
					ctx.ui.notify(`Usage: /${commandName} add <command|regex>`, "error");
					return;
				}
				if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(pattern)) {
					pattern = `^${pattern}(\\s|$)`;
				}
				try {
					new RegExp(pattern);
				} catch (error) {
					ctx.ui.notify(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}
				state[patternsKey].push(pattern);
				persist();
				ctx.ui.notify(`Added shell ${commandName} regex:\n/${pattern}/`, "info");
				return;
			}

			if (subcommand === "remove" || subcommand === "rm") {
				const index = Number(rest[0]);
				if (!Number.isInteger(index) || index < 1 || index > state[patternsKey].length) {
					ctx.ui.notify(`Usage: /${commandName} remove <1-${state[patternsKey].length}>`, "error");
					return;
				}
				const [removed] = state[patternsKey].splice(index - 1, 1);
				persist();
				ctx.ui.notify(`Removed shell ${commandName} regex:\n/${removed}/`, "info");
				return;
			}

			if (subcommand === "clear") {
				const ok = !ctx.hasUI || (await ctx.ui.confirm(`Clear shell ${commandName}?`, `Remove all shell command ${commandName} regexes?`));
				if (!ok) return;
				state[patternsKey] = [];
				persist();
				ctx.ui.notify(`Cleared shell ${commandName}.`, "info");
				return;
			}

			ctx.ui.notify(`Usage: /${commandName} [list|add <command|regex>|remove <index>|clear]`, "error");
			},
		});
	}

	registerPatternCommand("whitelist", "patterns");
	registerPatternCommand("blacklist", "blacklistPatterns");

	pi.on("tool_call", async (event, ctx) => {
		const usesExecutionApproval = SNAP_EDIT_TOOLS.has(event.toolName) && hasSnapEditApprovalProtocol();
		if (!usesExecutionApproval) {
			const writeApproval = await approveWriteTool(event, ctx);
			if (writeApproval) return writeApproval;
		}

		if (event.toolName !== "bash") return undefined;

		const command = String((event.input as { command?: unknown }).command ?? "");
		if (sessionApprovedCommands.has(command)) return undefined;

		const fileAccesses = analyzeShellFileAccess(command);
		const writeTargets = shellWriteTargetsNeedingApproval(fileAccesses, ctx);

		const segments = splitShellSegments(command);
		const blacklistedIndexes = new Set<number>();
		const unapprovedIndexes = new Set<number>();
		for (let i = 0; i < segments.length; i++) {
			const segment = segments[i];
			const blacklisted = isBlacklisted(segment.part);
			if (blacklisted) blacklistedIndexes.add(i);
			if (blacklisted || (!yoloMode && !isWhitelisted(segment.part))) unapprovedIndexes.add(i);
		}
		if (unapprovedIndexes.size === 0 && writeTargets.length === 0) return undefined;

		if (!ctx.hasUI) {
			const reasons = [];
			if (unapprovedIndexes.size > 0) reasons.push(`${blacklistedIndexes.size > 0 ? `blacklisted segment(s): ${Array.from(blacklistedIndexes).map((index) => segments[index].part).join(", ")}; ` : ""}unapproved segment(s): ${Array.from(unapprovedIndexes).map((index) => segments[index].part).join(", ")}`);
			if (writeTargets.length > 0) reasons.push(`write target(s): ${writeTargets.map((access) => displayPath(access.target)).join(", ")}`);
			return { block: true, reason: `Shell command requires approval; ${reasons.join("; ")}` };
		}

		const segmentLines = formatShellSegments(segments, blacklistedIndexes, new Set<number>(Array.from(segments.keys()).filter((i) => !unapprovedIndexes.has(i))))
			.map((segment) => `  ${segment.replace(/\n/g, "\n  ")}`)
			.join("\n");
		const fileAccessLines = fileAccesses.length > 0
			? `\n\nFile access detected:\n${fileAccesses.map((access) => {
				const target = canonicalPathForComparison(resolve(ctx.cwd, access.path));
				const needsApproval = writeTargets.some((write) => write.target === target);
				return `  ${access.mode === "write" ? "write" : "read "} ${displayPath(target)} (${access.source}${needsApproval ? "; needs approval" : ""})`;
			}).join("\n")}`
			: "";
		const blacklistWarning = blacklistedIndexes.size > 0
			? `\n\n\x1b[91mWARNING: blacklisted segment(s) matched (blacklist overrides whitelist):\x1b[39m`
			: "";
		const choices = ["Allow once", "Allow this line for session"];
		if (writeTargets.length > 0) {
			const dirs = Array.from(new Set(writeTargets.map((access) => dirname(access.target))));
			const files = Array.from(new Set(writeTargets.map((access) => access.target)));
			choices.push(
				dirs.length === 1
					? `Allow command + future writes in this session to ${displayPath(dirs[0])}`
					: `Allow command + future writes in this session to ${dirs.length} directories`,
				files.length === 1
					? `Allow command + future writes in this session to ${displayPath(files[0])}`
					: `Allow command + future writes in this session to ${files.length} files`,
			);
		}
		choices.push("Reject with feedback", "Reject");
		const choice = await ctx.ui.select(
			`Approve shell command?${blacklistWarning}\n\nCommand:\n${segmentLines}${fileAccessLines}`,
			choices,
		);

		if (choice === "Allow once") return undefined;

		if (choice === "Allow this line for session") {
			sessionApprovedCommands.add(command);
			return undefined;
		}
		if (choice?.startsWith("Allow command + future writes in this session to ")) {
			const dirs = Array.from(new Set(writeTargets.map((access) => dirname(access.target))));
			const files = Array.from(new Set(writeTargets.map((access) => access.target)));
			const isFileChoice = files.length === 1 ? choice.endsWith(displayPath(files[0])) : choice.endsWith(`${files.length} files`);
			if (isFileChoice) {
				for (const file of files) sessionApprovedWriteFiles.add(file);
			} else {
				for (const dir of dirs) sessionApprovedWriteDirs.add(dir);
			}
			return undefined;
		}

		if (choice === "Reject with feedback" || choice === undefined) {
			const feedback = await ctx.ui.input("Reject shell command with feedback", "Tell the assistant what to do instead...");
			const suffix = feedback?.trim() ? ` Feedback: ${feedback.trim()}` : "";
			return { block: true, reason: `Rejected shell command by user.${suffix}` };
		}

		return { block: true, reason: `Blocked shell command; ${blacklistedIndexes.size > 0 ? `blacklisted segment(s): ${Array.from(blacklistedIndexes).map((index) => segments[index].part).join(", ")}; ` : ""}unapproved segment(s): ${Array.from(unapprovedIndexes).map((index) => segments[index].part).join(", ")}` };
	});
}
