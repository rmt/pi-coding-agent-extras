import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const HOME = process.env.HOME ?? "";

function displayCwd(cwd: string): string {
	return HOME && (cwd === HOME || cwd.startsWith(`${HOME}/`)) ? `~${cwd.slice(HOME.length)}` : cwd;
}

function sessionCost(ctx: any): number {
	let cost = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			cost += Number((e.message as AssistantMessage).usage?.cost?.total ?? 0);
		}
	}
	return cost;
}

function contextWindow(ctx: any): string {
	const usage = ctx.getContextUsage?.();
	const tokens = Number(usage?.tokens ?? usage?.totalTokens ?? 0);
	const total = Number(usage?.contextWindow ?? ctx.model?.contextWindow ?? 0);
	if (!Number.isFinite(tokens) || tokens <= 0) return total ? `0%/${formatTokens(total)}` : "ctx ?";
	if (!Number.isFinite(total) || total <= 0) return `${formatTokens(tokens)}`;
	return `${Math.round((tokens / total) * 100)}%/${formatTokens(total)}`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
	return String(Math.round(n));
}

function shortenMiddle(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width <= 3) return ".".repeat(width);
	const keep = width - 3;
	const left = Math.ceil(keep / 2);
	const right = Math.floor(keep / 2);
	const tail = right > 0 ? truncateToWidth(text.slice(-right), right, "") : "";
	return `${truncateToWidth(text, left, "")}...${tail}`;
}

function padLine(left: string, right: string, width: number): string {
	const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(`${left}${" ".repeat(pad)}${right}`, width, "…");
}

function statusLine(statuses: ReadonlyMap<string, string> | undefined, theme: any): string | undefined {
	if (!statuses) return undefined;
	const parts = Array.from(statuses.entries())
		.filter(([key, value]) => key !== "shell-permissions" && value.trim().length > 0)
		.map(([, value]) => value.trim());
	if (parts.length === 0) return undefined;
	return theme.fg("dim", parts.join(" • "));
}

export default function (pi: ExtensionAPI) {
	function install(ctx: any) {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const branch = footerData.getGitBranch?.() || "-";
					const statuses = footerData.getExtensionStatuses?.();
					const shellMode = statuses?.get("shell-permissions") || "(whitelist)";
					const cwd = displayCwd(ctx.cwd);
					const right = theme.fg("dim", `$${sessionCost(ctx).toFixed(3)} • ${contextWindow(ctx)} • ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model"} • ${pi.getThinkingLevel?.() ?? "off"}`);
					const status = statusLine(statuses, theme);

					const leftPrefix = theme.fg("dim", "");
					const leftSuffix = theme.fg("dim", ` • ${branch} • ${shellMode}`);
					let left = `${leftPrefix}${cwd}${leftSuffix}`;
					const lines: string[] = [];
					if (status) lines.push(truncateToWidth(status, width, "…"));

					if (visibleWidth(left) + 1 + visibleWidth(right) <= width) {
						return [...lines, padLine(left, right, width)];
					}

					const suffixWidth = visibleWidth(leftPrefix) + visibleWidth(leftSuffix);
					const cwdWidth = Math.max(1, width - suffixWidth);
					left = `${leftPrefix}${shortenMiddle(cwd, cwdWidth)}${leftSuffix}`;
					return [...lines, truncateToWidth(left, width, "…"), truncateToWidth(right, width, "…")];
				},
			};
		});
	}

	pi.on("session_start", (_event, ctx) => install(ctx));

	pi.on("model_select", (_event, ctx) => install(ctx));
	pi.on("thinking_level_select", (_event, ctx) => install(ctx));
}
