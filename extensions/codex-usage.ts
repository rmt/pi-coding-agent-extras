import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MESSAGE_TYPE = "codex-usage";
const PROGRESS_TYPE = "codex-usage-progress";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const PROFILE_URL = "https://chatgpt.com/backend-api/wham/profiles/me";
const LIMITS_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CONSUME_RESET_CREDIT_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";
const WEEK_COUNT = 52;
const DAY_COUNT = 7;
const CELL_COUNT = WEEK_COUNT * DAY_COUNT;

type View = "daily" | "weekly";
type Mode = "show" | "redeem";

type AccountInfo = {
	source: "pi";
	accessToken: string;
	accountId?: string;
	email?: string;
	planType?: string;
};

type UsageBucket = {
	startDate: string;
	tokens: number;
};

type UsageProfile = {
	lifetimeTokens?: number;
	peakDailyTokens?: number;
	currentStreakDays?: number;
	longestStreakDays?: number;
	longestRunningTurnSec?: number;
	dailyUsageBuckets: UsageBucket[];
};

type LimitWindow = {
	usedPercent: number;
	windowDurationMins?: number;
	resetsAt?: number;
};

type ResetCredit = {
	id?: string;
	title?: string;
	status?: string;
	grantedAt?: string;
	expiresAt?: string;
};

type ResetCredits = {
	availableCount?: number;
	credits: ResetCredit[];
};

type Limits = {
	primary?: LimitWindow;
	secondary?: LimitWindow;
};

type Report = {
	ok: boolean;
	view: View;
	mode: Mode;
	account?: string;
	usage?: UsageProfile;
	limits?: Limits;
	resetCredits?: ResetCredits;
	redeemOutcome?: string;
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

function accountInfoFromToken(token: string, explicitAccountId?: string): AccountInfo {
	const jwt = decodeJwt(token);
	const auth = jwt?.[JWT_AUTH_CLAIM];
	const profile = jwt?.[JWT_PROFILE_CLAIM];
	return {
		source: "pi",
		accessToken: token,
		accountId: explicitAccountId ?? auth?.chatgpt_account_id,
		email: typeof profile?.email === "string" ? profile.email : undefined,
		planType: typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
	};
}

async function getPiAccount(ctx: ExtensionCommandContext): Promise<AccountInfo> {
	// ModelRegistry no longer exposes authStorage. Resolve the provider token via
	// its public compatibility API; the JWT normally contains the account id.
	const token = await ctx.modelRegistry.getApiKeyForProvider(OPENAI_CODEX_PROVIDER);
	if (!token) throw new Error("No ChatGPT OAuth credentials found. Run /login and choose ChatGPT Plus/Pro (Codex Subscription).");
	const account = accountInfoFromToken(token);
	if (!account.accountId) throw new Error("Could not determine ChatGPT account id from OAuth token.");
	return account;
}

async function fetchJson(url: string, account: AccountInfo, signal?: AbortSignal, init?: RequestInit): Promise<any> {
	const response = await fetch(url, {
		...init,
		signal,
		headers: {
			Authorization: `Bearer ${account.accessToken}`,
			"ChatGPT-Account-ID": account.accountId ?? "",
			"OpenAI-Beta": "codex-1",
			originator: "pi",
			"User-Agent": "pi-codex-usage-extension",
			Accept: "application/json",
			...(init?.headers ?? {}),
		},
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`${init?.method ?? "GET"} ${url} failed: ${response.status} ${response.statusText}${body ? `; ${body.slice(0, 300)}` : ""}`);
	}
	return response.json();
}

function normalizeNumber(value: any): number | undefined {
	const number = Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function mapUsageProfile(payload: any): UsageProfile {
	const stats = payload?.stats ?? {};
	const buckets = Array.isArray(stats.daily_usage_buckets ?? stats.dailyUsageBuckets) ? stats.daily_usage_buckets ?? stats.dailyUsageBuckets : [];
	return {
		lifetimeTokens: normalizeNumber(stats.lifetime_tokens ?? stats.lifetimeTokens),
		peakDailyTokens: normalizeNumber(stats.peak_daily_tokens ?? stats.peakDailyTokens),
		currentStreakDays: normalizeNumber(stats.current_streak_days ?? stats.currentStreakDays),
		longestStreakDays: normalizeNumber(stats.longest_streak_days ?? stats.longestStreakDays),
		longestRunningTurnSec: normalizeNumber(stats.longest_running_turn_sec ?? stats.longestRunningTurnSec),
		dailyUsageBuckets: buckets.map((bucket: any) => ({
			startDate: String(bucket.start_date ?? bucket.startDate ?? ""),
			tokens: normalizeNumber(bucket.tokens) ?? 0,
		})).filter((bucket: UsageBucket) => bucket.startDate),
	};
}

function mapWindow(raw: any): LimitWindow | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const usedPercent = normalizeNumber(raw.used_percent ?? raw.usedPercent);
	if (usedPercent === undefined) return undefined;
	const seconds = normalizeNumber(raw.limit_window_seconds);
	return {
		usedPercent,
		windowDurationMins: normalizeNumber(raw.windowDurationMins) ?? (seconds && seconds > 0 ? Math.ceil(seconds / 60) : undefined),
		resetsAt: normalizeNumber(raw.reset_at ?? raw.resetsAt),
	};
}

function mapLimits(payload: any): Limits {
	const rateLimit = payload?.rate_limit ?? payload?.rateLimit ?? {};
	return {
		primary: mapWindow(rateLimit.primary_window ?? rateLimit.primary),
		secondary: mapWindow(rateLimit.secondary_window ?? rateLimit.secondary),
	};
}

function mapResetCredits(payload: any): ResetCredits {
	const rawCredits = Array.isArray(payload?.credits) ? payload.credits : [];
	return {
		availableCount: normalizeNumber(payload?.available_count ?? payload?.availableCount),
		credits: rawCredits.map((credit: any) => ({
			id: typeof credit.id === "string" ? credit.id : undefined,
			title: typeof credit.title === "string" ? credit.title : undefined,
			status: typeof credit.status === "string" ? credit.status : typeof credit.state === "string" ? credit.state : undefined,
			grantedAt: typeof credit.granted_at === "string" ? credit.granted_at : typeof credit.grantedAt === "string" ? credit.grantedAt : undefined,
			expiresAt: typeof credit.expires_at === "string" ? credit.expires_at : typeof credit.expiresAt === "string" ? credit.expiresAt : undefined,
		})),
	};
}

async function redeemResetCredit(account: AccountInfo, signal?: AbortSignal): Promise<string> {
	const payload = await fetchJson(CONSUME_RESET_CREDIT_URL, account, signal, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ redeem_request_id: crypto.randomUUID() }),
	});
	return String(payload?.outcome ?? payload?.status ?? payload?.result ?? "unknown");
}

async function buildReport(ctx: ExtensionCommandContext, view: View, mode: Mode): Promise<Report> {
	try {
		const account = await getPiAccount(ctx);
		const accountLabel = account.email ?? account.accountId ?? "ChatGPT account";
		const redeemOutcome = mode === "redeem" ? await redeemResetCredit(account, ctx.signal) : undefined;
		const [profilePayload, limitsPayload, resetCreditsPayload] = await Promise.all([
			fetchJson(PROFILE_URL, account, ctx.signal),
			fetchJson(LIMITS_URL, account, ctx.signal),
			fetchJson(RESET_CREDITS_URL, account, ctx.signal),
		]);
		return {
			ok: true,
			view,
			mode,
			account: accountLabel,
			usage: mapUsageProfile(profilePayload),
			limits: mapLimits(limitsPayload),
			resetCredits: mapResetCredits(resetCreditsPayload),
			redeemOutcome,
		};
	} catch (error) {
		return { ok: false, view, mode, error: error instanceof Error ? error.message : String(error) };
	}
}

function parseArgs(args: string): { view: View; mode: Mode } | { error: string } {
	const text = args.trim().toLowerCase();
	if (!text || text === "daily" || text === "day") return { view: "daily", mode: "show" };
	if (text === "weekly" || text === "week") return { view: "weekly", mode: "show" };
	if (text === "redeem") return { view: "daily", mode: "redeem" };
	return { error: "Usage: /codex-usage [daily|weekly|redeem]" };
}

function formatTokens(value?: number): string {
	if (value === undefined) return "n/a";
	return new Intl.NumberFormat(undefined, { notation: value >= 1_000_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function parseDate(value: string): Date | undefined {
	const date = new Date(`${value}T00:00:00Z`);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function isoDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
	const next = new Date(date);
	next.setUTCDate(next.getUTCDate() + days);
	return next;
}

function startOfWeek(date: Date): Date {
	const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const day = start.getUTCDay();
	start.setUTCDate(start.getUTCDate() - day);
	return start;
}

function recentDailyBuckets(buckets: UsageBucket[], count: number): UsageBucket[] {
	const byDate = new Map(buckets.map((bucket) => [bucket.startDate, bucket.tokens]));
	const latest = buckets.map((bucket) => parseDate(bucket.startDate)).filter((date): date is Date => !!date).sort((a, b) => a.getTime() - b.getTime()).at(-1) ?? new Date();
	const end = new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth(), latest.getUTCDate()));
	return Array.from({ length: count }, (_, index) => {
		const date = addDays(end, index - count + 1);
		return { startDate: isoDate(date), tokens: byDate.get(isoDate(date)) ?? 0 };
	});
}

function recentWeeklyBuckets(buckets: UsageBucket[], count: number): UsageBucket[] {
	const totals = new Map<string, number>();
	for (const bucket of buckets) {
		const date = parseDate(bucket.startDate);
		if (!date) continue;
		const week = isoDate(startOfWeek(date));
		totals.set(week, (totals.get(week) ?? 0) + bucket.tokens);
	}
	const latest = buckets.map((bucket) => parseDate(bucket.startDate)).filter((date): date is Date => !!date).sort((a, b) => a.getTime() - b.getTime()).at(-1) ?? new Date();
	const end = startOfWeek(latest);
	return Array.from({ length: count }, (_, index) => {
		const date = addDays(end, (index - count + 1) * 7);
		return { startDate: isoDate(date), tokens: totals.get(isoDate(date)) ?? 0 };
	});
}

function weeklyUsageLines(usage: UsageProfile): string[] {
	const buckets = recentWeeklyBuckets(usage.dailyUsageBuckets, 12);
	const max = Math.max(1, ...buckets.map((bucket) => bucket.tokens));
	const barWidth = 22;
	return buckets.map((bucket) => {
		const filled = Math.round((bucket.tokens / max) * barWidth);
		const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
		return `${bucket.startDate} ${bar} ${formatTokens(bucket.tokens)}`;
	});
}

function chartStart(today: Date): Date {
	const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
	start.setUTCDate(start.getUTCDate() - start.getUTCDay() - (WEEK_COUNT - 1) * DAY_COUNT);
	return start;
}

function dailyValues(buckets: UsageBucket[]): number[] {
	const byDate = new Map<string, number>();
	for (const bucket of buckets) byDate.set(bucket.startDate, (byDate.get(bucket.startDate) ?? 0) + Math.max(0, bucket.tokens));
	const latest = buckets.map((bucket) => parseDate(bucket.startDate)).filter((date): date is Date => !!date).sort((a, b) => a.getTime() - b.getTime()).at(-1) ?? new Date();
	const today = new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth(), latest.getUTCDate()));
	const start = chartStart(today);
	return Array.from({ length: CELL_COUNT }, (_, offset) => {
		const date = addDays(start, offset);
		if (date > today) return 0;
		return byDate.get(isoDate(date)) ?? 0;
	});
}

function gradedLevels(values: number[]): number[] {
	const max = Math.max(0, ...values);
	return values.map((value) => {
		if (value <= 0 || max <= 0) return 0;
		if (value * 4 > max * 3) return 4;
		if (value * 2 > max) return 3;
		if (value * 4 > max) return 2;
		return 1;
	});
}

function ansiBg(rgb: [number, number, number], text = " "): string {
	return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[0m`;
}

function heatCell(level: number): string {
	const colors: Array<[number, number, number]> = [
		[38, 38, 38],
		[74, 25, 25],
		[122, 34, 34],
		[184, 45, 45],
		[255, 72, 72],
	];
	return ansiBg(colors[Math.max(0, Math.min(4, level))]);
}

function monthLabelsForDailyGraph(usage: UsageProfile): string {
	const latest = usage.dailyUsageBuckets.map((bucket) => parseDate(bucket.startDate)).filter((date): date is Date => !!date).sort((a, b) => a.getTime() - b.getTime()).at(-1) ?? new Date();
	const today = new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth(), latest.getUTCDate()));
	const start = chartStart(today);
	const cells = Array.from({ length: WEEK_COUNT }, () => " ");
	let lastEnd = 0;
	for (let column = 0; column < WEEK_COUNT; column++) {
		const date = addDays(start, column * DAY_COUNT);
		if (date.getUTCDate() > 7) continue;
		const label = date.toLocaleString(undefined, { month: "short", timeZone: "UTC" });
		if (column < lastEnd || column + label.length > cells.length) continue;
		for (let index = 0; index < label.length; index++) cells[column + index] = label[index];
		lastEnd = column + label.length + 1;
	}
	return `    ${cells.join("")}`;
}

function dailyHeatGraphLines(usage: UsageProfile): string[] {
	const levels = gradedLevels(dailyValues(usage.dailyUsageBuckets));
	const labels = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
	const lines = [monthLabelsForDailyGraph(usage)];
	for (let row = 0; row < DAY_COUNT; row++) {
		let line = `${labels[row]}  `;
		for (let column = 0; column < WEEK_COUNT; column++) {
			line += heatCell(levels[column * DAY_COUNT + row] ?? 0);
		}
		lines.push(line);
	}
	lines.push(`    Less ${heatCell(0)}${heatCell(1)}${heatCell(2)}${heatCell(3)}${heatCell(4)} More`);
	return lines;
}

function resetText(epochSeconds?: number): string {
	if (!epochSeconds) return "reset unknown";
	return new Date(epochSeconds * 1000).toLocaleString();
}

function limitLine(label: string, window?: LimitWindow): string {
	if (!window) return `${label}: unavailable`;
	const left = Math.max(0, Math.min(100, 100 - window.usedPercent));
	return `${label}: ${Math.round(left)}% left (${resetText(window.resetsAt)})`;
}

function durationLabel(window: LimitWindow, fallback: string): string {
	const mins = window.windowDurationMins;
	if (!mins) return fallback;
	if (mins >= 60 * 24 * 6) return "Weekly limit";
	if (mins % 60 === 0) return `${mins / 60}h limit`;
	return `${mins}m limit`;
}

function expiryText(value?: string): string {
	if (!value) return "expiry unknown";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const minutes = Math.max(0, Math.floor((date.getTime() - Date.now()) / 60000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	const remaining = days ? `${days}d ${hours}h` : hours ? `${hours}h ${mins}m` : `${mins}m`;
	return `${date.toLocaleString()} (${remaining})`;
}

function renderReport(report: Report, width: number, theme: any): string[] {
	const boxWidth = Math.max(30, Math.min(width, 92));
	const innerWidth = Math.max(1, boxWidth - 4);
	const top = `╭${"─".repeat(boxWidth - 2)}╮`;
	const bottom = `╰${"─".repeat(boxWidth - 2)}╯`;
	const line = (content = "") => {
		const trimmed = truncateToWidth(content, innerWidth, "…");
		const pad = Math.max(0, innerWidth - visibleWidth(trimmed));
		return `│  ${trimmed}${" ".repeat(pad)}│`;
	};
	const rows = [top, line(theme.fg("accent", theme.bold(`>_ Codex usage (${report.view})`))), line()];
	if (!report.ok || !report.usage) {
		rows.push(line(theme.fg("error", `Unable to fetch usage: ${report.error ?? "unknown error"}`)), bottom);
		return rows;
	}
	if (report.redeemOutcome) rows.push(line(theme.fg("success", `Redeem result: ${report.redeemOutcome}`)), line());
	rows.push(line(`Account: ${report.account ?? "unknown"}`));
	rows.push(line(`Lifetime total: ${formatTokens(report.usage.lifetimeTokens)}`));
	rows.push(line(`Peak daily: ${formatTokens(report.usage.peakDailyTokens)}`));
	rows.push(line(`Streak: ${report.usage.currentStreakDays ?? "n/a"} current / ${report.usage.longestStreakDays ?? "n/a"} longest`));
	rows.push(line());
	// ChatGPT may expose only a weekly primary window.
	if (report.limits?.primary) {
		rows.push(line(limitLine(durationLabel(report.limits.primary, "5h limit"), report.limits.primary)));
	}
	if (report.limits?.secondary) {
		rows.push(line(limitLine(durationLabel(report.limits.secondary, "Weekly limit"), report.limits.secondary)));
	}
	if (!report.limits?.primary && !report.limits?.secondary) {
		rows.push(line("Rate limits: unavailable"));
	}
	rows.push(line());
	rows.push(line(`${report.view === "daily" ? "Daily" : "Weekly"} token activity:`));
	if (report.view === "daily") {
		for (const row of dailyHeatGraphLines(report.usage)) rows.push(line(`  ${row}`));
	} else {
		for (const row of weeklyUsageLines(report.usage)) rows.push(line(`  ${row}`));
	}
	rows.push(line());
	const resetCredits = report.resetCredits;
	const activeCredits = resetCredits?.credits.filter((credit) => (credit.status ?? "available") === "available") ?? [];
	rows.push(line(`Pending reset credits: ${resetCredits?.availableCount ?? activeCredits.length} (redeem with the "/codex-usage redeem" command)`));
	if (activeCredits.length === 0) {
		rows.push(line("  none"));
	} else {
		for (const credit of activeCredits) rows.push(line(`  ${credit.title ?? "Reset credit"}: expires ${expiryText(credit.expiresAt)}`));
	}
	rows.push(bottom);
	return rows;
}

export default function (pi: ExtensionAPI) {
	pi.on("context", (event) => ({
		messages: event.messages.filter((message: any) => !(message.role === "custom" && (message.customType === MESSAGE_TYPE || message.customType === PROGRESS_TYPE))),
	}));

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options, theme) => ({
		render: (width: number) => renderReport(message.details as Report, width, theme),
		invalidate() {},
	}));

	pi.registerMessageRenderer(PROGRESS_TYPE, (message, _options, theme) => ({
		render: (width: number) => [truncateToWidth(theme.fg("dim", String(message.content)), width, "…")],
		invalidate() {},
	}));

	pi.registerCommand("codex-usage", {
		description: "Show Codex usage, reset credits, or redeem a reset credit",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			if ("error" in parsed) {
				if (ctx.hasUI) {
					ctx.ui.notify(parsed.error, "error");
				} else {
					process.stderr.write(`${parsed.error}\n`);
				}
				return;
			}
			if (!ctx.hasUI) {
				const report = await buildReport(ctx, parsed.view, parsed.mode);
				process.stdout.write(`\n${renderReport(report, 92, { fg: (_name: string, text: string) => text, bold: (text: string) => text }).join("\n")}\n`);
				return;
			}
			pi.sendMessage({ customType: PROGRESS_TYPE, content: "Querying ChatGPT Codex usage APIs…", display: true, details: { generatedAt: Date.now() } });
			const report = await buildReport(ctx, parsed.view, parsed.mode);
			pi.sendMessage({ customType: MESSAGE_TYPE, content: "Codex usage", display: true, details: report });
		},
	});
}
