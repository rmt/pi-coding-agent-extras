import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const CODEX_STATUS_TYPE = "codex-status";
const CODEX_STATUS_PROGRESS_TYPE = "codex-status-progress";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_PAGE = "https://chatgpt.com/codex/settings/usage";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";

type LimitWindow = {
	usedPercent: number;
	windowDurationMins?: number | null;
	resetsAt?: number | null;
};

type CreditsSnapshot = {
	hasCredits?: boolean;
	unlimited?: boolean;
	balance?: string | null;
};

type RateLimitResetCreditsSnapshot = {
	availableCount: number;
};

type LimitSnapshot = {
	primary?: LimitWindow | null;
	secondary?: LimitWindow | null;
	credits?: CreditsSnapshot | null;
	planType?: string | null;
	rateLimitReachedType?: string | null;
	rateLimitResetCredits?: RateLimitResetCreditsSnapshot;
};

type AccountInfo = {
	source: "pi" | "codex";
	accessToken: string;
	accountId?: string;
	email?: string;
	planType?: string;
};

type StatusDetails = {
	ok: boolean;
	generatedAt: number;
	model?: string;
	directory: string;
	agentsMd: string;
	account?: string;
	accountSource?: string;
	session?: string;
	isChatGptModel: boolean;
	limits?: LimitSnapshot;
	error?: string;
};

function decodeJwt(token: string): Record<string, any> | null {
	try {
		const payload = token.split(".")[1];
		if (!payload) return null;
		const padded = payload.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((payload.length + 3) % 4);
		return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
	} catch {
		return null;
	}
}

function accountInfoFromToken(source: AccountInfo["source"], token: string, explicitAccountId?: string): AccountInfo {
	const jwt = decodeJwt(token);
	const auth = jwt?.[JWT_AUTH_CLAIM];
	const profile = jwt?.[JWT_PROFILE_CLAIM];
	return {
		source,
		accessToken: token,
		accountId: explicitAccountId ?? auth?.chatgpt_account_id,
		email: typeof profile?.email === "string" ? profile.email : undefined,
		planType: typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
	};
}

async function getPiAccount(ctx: ExtensionCommandContext): Promise<AccountInfo | undefined> {
	// ModelRegistry no longer exposes authStorage. Resolve the provider token via
	// its public compatibility API; the JWT normally contains the account id.
	const token = await ctx.modelRegistry.getApiKeyForProvider(OPENAI_CODEX_PROVIDER);
	if (!token) return undefined;
	return accountInfoFromToken("pi", token);
}

async function getCodexCliAccount(): Promise<AccountInfo | undefined> {
	try {
		const authPath = join(process.env.HOME ?? "", ".codex", "auth.json");
		const raw = await readFile(authPath, "utf8");
		const parsed = JSON.parse(raw) as any;
		const token = parsed?.tokens?.access_token;
		if (typeof token !== "string" || token.length === 0) return undefined;
		return accountInfoFromToken("codex", token);
	} catch {
		return undefined;
	}
}

function mapWindow(window: any): LimitWindow | undefined {
	if (!window || typeof window !== "object") return undefined;
	const used = Number(window.used_percent ?? window.usedPercent);
	if (!Number.isFinite(used)) return undefined;
	const seconds = Number(window.limit_window_seconds);
	const minutes = Number(window.windowDurationMins ?? (Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : undefined));
	const reset = Number(window.reset_at ?? window.resetsAt);
	return {
		usedPercent: used,
		windowDurationMins: Number.isFinite(minutes) ? minutes : undefined,
		resetsAt: Number.isFinite(reset) ? reset : undefined,
	};
}

function mapCredits(raw: any): CreditsSnapshot | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	return {
		hasCredits: raw.has_credits ?? raw.hasCredits,
		unlimited: raw.unlimited,
		balance: raw.balance ?? undefined,
	};
}

function mapRateLimitResetCredits(raw: any): RateLimitResetCreditsSnapshot | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const availableCount = Number(raw.available_count ?? raw.availableCount);
	return Number.isFinite(availableCount) ? { availableCount } : undefined;
}

function normalizePlan(raw?: string | null): string | undefined {
	if (!raw) return undefined;
	const wire = raw.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/[\s-]+/g, "_");
	// ChatGPT's usage endpoint may report several workspace-ish wire names.
	// Display the user's visible ChatGPT plan label rather than Codex's internal grouping.
	if (wire === "team" || wire === "business" || wire === "self_serve_business_usage_based") return "Business";
	if (wire === "enterprise_cbp_usage_based" || wire === "enterprise") return "Enterprise";
	if (wire === "prolite" || wire === "pro_lite") return "Pro Lite";
	const words = wire.split(/_+/).filter(Boolean);
	if (words.length === 0) return undefined;
	return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

function mapUsagePayload(payload: any): LimitSnapshot {
	const rateLimit = payload?.rate_limit ?? payload?.rateLimit ?? {};
	const reached = payload?.rate_limit_reached_type?.type ?? payload?.rateLimitReachedType;
	return {
		primary: mapWindow(rateLimit.primary_window ?? rateLimit.primary),
		secondary: mapWindow(rateLimit.secondary_window ?? rateLimit.secondary),
		credits: mapCredits(payload?.credits),
		planType: normalizePlan(payload?.plan_type ?? payload?.planType),
		rateLimitReachedType: typeof reached === "string" ? reached : undefined,
		rateLimitResetCredits: mapRateLimitResetCredits(payload?.rate_limit_reset_credits ?? payload?.rateLimitResetCredits),
	};
}

async function fetchLimits(account: AccountInfo, signal?: AbortSignal): Promise<LimitSnapshot> {
	if (!account.accountId) throw new Error("Could not determine ChatGPT account id from OAuth token.");
	const response = await fetch(USAGE_URL, {
		method: "GET",
		signal,
		headers: {
			Authorization: `Bearer ${account.accessToken}`,
			"ChatGPT-Account-Id": account.accountId,
			originator: "pi",
			"User-Agent": "pi-codex-status-extension",
			Accept: "application/json",
		},
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`GET ${USAGE_URL} failed: ${response.status} ${response.statusText}${body ? `; ${body.slice(0, 300)}` : ""}`);
	}
	return mapUsagePayload(await response.json());
}

function modelDisplay(ctx: ExtensionCommandContext, pi: ExtensionAPI): string | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	const level = pi.getThinkingLevel();
	return level && level !== "off" ? `${model.id} (reasoning ${level})` : model.id;
}

function shortDir(cwd: string): string {
	const home = process.env.HOME;
	return home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
}

function findAgentsMd(cwd: string): string {
	const names = ["AGENTS.md", "Agents.md", "agents.md"];
	let dir = cwd;
	while (true) {
		for (const name of names) {
			const path = join(dir, name);
			if (existsSync(path)) {
				const rel = relative(cwd, path);
				return rel && !rel.startsWith("..") ? rel : path;
			}
		}
		const parent = join(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return "<none>";
}

async function buildStatus(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<StatusDetails> {
	const generatedAt = Date.now();
	const isChatGptModel = ctx.model?.provider === OPENAI_CODEX_PROVIDER || ctx.model?.api === "openai-codex-responses";
	try {
		const account = (await getPiAccount(ctx)) ?? (await getCodexCliAccount());
		if (!account) throw new Error("No ChatGPT OAuth credentials found. Run /login and choose ChatGPT Plus/Pro (Codex Subscription)." );
		const limits = await fetchLimits(account, ctx.signal);
		const plan = normalizePlan(limits.planType ?? account.planType);
		const accountLabel = account.email ? `${account.email}${plan ? ` (${plan})` : ""}` : `${account.accountId ?? "ChatGPT account"}${plan ? ` (${plan})` : ""}`;
		return {
			ok: true,
			generatedAt,
			model: modelDisplay(ctx, pi),
			directory: shortDir(ctx.cwd),
			agentsMd: findAgentsMd(ctx.cwd),
			account: accountLabel,
			accountSource: account.source === "pi" ? "pi /login" : "~/.codex/auth.json",
			session: ctx.sessionManager.getSessionId(),
			isChatGptModel,
			limits: { ...limits, planType: plan },
		};
	} catch (error) {
		return {
			ok: false,
			generatedAt,
			model: modelDisplay(ctx, pi),
			directory: shortDir(ctx.cwd),
			agentsMd: findAgentsMd(ctx.cwd),
			session: ctx.sessionManager.getSessionId(),
			isChatGptModel,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function resetText(epochSeconds?: number | null): string {
	if (!epochSeconds) return "reset unknown";
	const date = new Date(epochSeconds * 1000);
	const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
	const day = date.getDate();
	const month = date.toLocaleString(undefined, { month: "short" });
	return `resets ${time} on ${day} ${month}`;
}

function durationLabel(window: LimitWindow | undefined | null, fallback: string): string {
	const mins = window?.windowDurationMins;
	if (!mins) return fallback;
	if (mins >= 60 * 24 * 6) return "Weekly limit";
	if (mins % 60 === 0) return `${mins / 60}h limit`;
	return `${mins}m limit`;
}

function progressLine(label: string, window: LimitWindow | undefined | null, theme: any, innerWidth: number): string {
	if (!window) return `${label.padEnd(22)} unavailable`;
	const left = clamp(100 - window.usedPercent, 0, 100);
	const barWidth = clamp(Math.min(20, innerWidth - 46), 8, 20);
	const filled = Math.round((left / 100) * barWidth);
	const color = left <= 5 ? "error" : left <= 25 ? "warning" : "success";
	const bar = theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(barWidth - filled));
	return `${label.padEnd(22)} [${bar}] ${Math.round(left)}% left (${resetText(window.resetsAt)})`;
}

function field(label: string, value: string | undefined): string {
	return `${`${label}:`.padEnd(22)} ${value ?? "<unknown>"}`;
}

function renderStatus(details: StatusDetails, width: number, theme: any): string[] {
	const boxWidth = clamp(Math.min(width, 86), 20, 86);
	const innerWidth = Math.max(1, boxWidth - 4);
	const top = `╭${"─".repeat(boxWidth - 2)}╮`;
	const bottom = `╰${"─".repeat(boxWidth - 2)}╯`;
	const line = (content = "") => {
		const trimmed = truncateToWidth(content, innerWidth, "…");
		const pad = Math.max(0, innerWidth - visibleWidth(trimmed));
		return `│  ${trimmed}${" ".repeat(pad)}│`;
	};

	const title = `${theme.fg("accent", theme.bold(">_ pi Codex Status"))}`;
	const rows = [top, line(title), line(), line(`Visit ${theme.fg("accent", USAGE_PAGE)} for up-to-date`), line("information on rate limits and credits"), line(), line(field("Model", details.model)), line(field("Directory", details.directory)), line(field("Agents.md", details.agentsMd)), line(field("Account", details.account ?? (details.ok ? undefined : "<unavailable>"))), line(field("Auth source", details.accountSource)), line(field("Session", details.session))];
	if (!details.isChatGptModel) {
		rows.push(line(theme.fg("warning", "Note: current model is not an openai-codex ChatGPT model.")));
	}
	rows.push(line());
	if (details.ok && details.limits) {
		// ChatGPT may expose only a weekly primary window. Do not render a
		// nonexistent secondary limit as an unavailable duplicate.
		if (details.limits.primary) {
			rows.push(line(progressLine(durationLabel(details.limits.primary, "5h limit"), details.limits.primary, theme, innerWidth)));
		}
		if (details.limits.secondary) {
			rows.push(line(progressLine(durationLabel(details.limits.secondary, "Weekly limit"), details.limits.secondary, theme, innerWidth)));
		}
		if (!details.limits.primary && !details.limits.secondary) {
			rows.push(line("Rate limits unavailable"));
		}
		if (details.limits.credits) {
			const c = details.limits.credits;
			const credits = c.unlimited ? "unlimited" : c.balance ? c.balance : c.hasCredits === false ? "none" : undefined;
			if (credits) rows.push(line(field("Credits", credits)));
		}
		if (details.limits.rateLimitResetCredits) {
			const count = details.limits.rateLimitResetCredits.availableCount;
			rows.push(line(field("Reset credits", String(count))));
		}
	} else {
		rows.push(line(theme.fg("error", `Unable to fetch rate limits: ${details.error ?? "unknown error"}`)));
	}
	rows.push(bottom);
	return rows;
}

export default function (pi: ExtensionAPI) {
	pi.on("context", (event) => ({
		messages: event.messages.filter((message: any) => !(message.role === "custom" && (message.customType === CODEX_STATUS_TYPE || message.customType === CODEX_STATUS_PROGRESS_TYPE))),
	}));

	pi.registerMessageRenderer(CODEX_STATUS_TYPE, (message, _options, theme) => {
		const details = message.details as StatusDetails;
		return {
			render: (width: number) => renderStatus(details, width, theme),
			invalidate() {},
		};
	});

	pi.registerMessageRenderer(CODEX_STATUS_PROGRESS_TYPE, (message, _options, theme) => ({
		render: (width: number) => [truncateToWidth(theme.fg("dim", String(message.content)), width, "…")],
		invalidate() {},
	}));

	pi.registerCommand("codex-status", {
		description: "Show ChatGPT/Codex subscription rate-limit status locally",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				const details = await buildStatus(ctx, pi);
				process.stdout.write(`\n${renderStatus(details, 86, {
					fg: (_name: string, text: string) => text,
					bold: (text: string) => text,
				}).join("\n")}\n`);
				return;
			}

			pi.sendMessage({
				customType: CODEX_STATUS_PROGRESS_TYPE,
				content: "Querying ChatGPT Codex usage API…",
				display: true,
				details: { generatedAt: Date.now() },
			});

			const details = await buildStatus(ctx, pi);
			pi.sendMessage({
				customType: CODEX_STATUS_TYPE,
				content: "Codex status",
				display: true,
				details,
			});
		},
	});
}
