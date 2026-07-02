import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOME = process.env.HOME ?? "";

function displayPath(path: string): string {
	return HOME && (path === HOME || path.startsWith(`${HOME}/`)) ? `~${path.slice(HOME.length)}` : path;
}

function parseFilename(args: string): string | undefined {
	const trimmed = args.trim();
	if (!trimmed) return undefined;
	const quoted = trimmed.match(/^(["'])(.*)\1$/s);
	return quoted ? quoted[2] : trimmed;
}

function extractText(value: any): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
	if (!value || typeof value !== "object") return "";
	if (value.type === "thinking" || value.type === "toolCall") return "";
	if (typeof value.text === "string") return value.text;
	if (value.text && typeof value.text === "object") {
		if (typeof value.text.value === "string") return value.text.value;
		if (typeof value.text.content === "string") return value.text.content;
	}
	if (typeof value.content === "string") return value.content;
	if (Array.isArray(value.content)) return value.content.map(extractText).filter(Boolean).join("\n");
	if (typeof value.value === "string") return value.value;
	return "";
}

function lastAssistantResponse(ctx: any): string | undefined {
	const branch = ctx.sessionManager.getBranch?.() ?? [];
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const text = extractText(entry.message?.content);
		if (text.trim().length > 0) return text;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("save", {
		description: "Save the last assistant response to a file (usage: /save <filename.md>)",
		handler: async (args, ctx) => {
			const rawName = parseFilename(args);
			if (!rawName) {
				ctx.ui.notify("Usage: /save <filename.md>", "error");
				return;
			}

			const response = lastAssistantResponse(ctx);
			if (!response) {
				ctx.ui.notify("No previous assistant response found to save.", "error");
				return;
			}

			const target = resolve(ctx.cwd, rawName);
			try {
				const handle = await open(target, "wx");
				try {
					await handle.writeFile(response.endsWith("\n") ? response : `${response}\n`, "utf8");
				} finally {
					await handle.close();
				}
				ctx.ui.notify(`Saved last assistant response to ${displayPath(target)}`, "success");
			} catch (err) {
				const code = typeof err === "object" && err && "code" in err ? String((err as any).code) : undefined;
				if (code === "EEXIST") {
					ctx.ui.notify(`File already exists: ${displayPath(target)}`, "error");
					return;
				}

				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to save ${displayPath(target)}: ${message}`, "error");
			}
		},
	});
}
