/**
 * GitHub Copilot Usage Extension
 *
 * Queries the GitHub Copilot internal API for real-time quota information.
 * Reads the OAuth token from ~/.pi/agent/auth.json (github-copilot.refresh).
 *
 * Usage:
 *   /copilot-usage              Show current quota snapshot
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

interface QuotaSnapshot {
  overage_count: number;
  overage_entitlement: number;
  overage_permitted: boolean;
  percent_remaining: number;
  quota_id: string;
  quota_remaining: number;
  unlimited: boolean;
  timestamp_utc: string;
  has_quota: boolean;
  quota_reset_at: number;
  token_based_billing: boolean;
  remaining: number;
  entitlement: number;
}

interface CopilotUserResponse {
  login: string;
  access_type_sku: string;
  copilot_plan: string;
  assigned_date: string;
  chat_enabled: boolean;
  cli_enabled: boolean;
  is_mcp_enabled: boolean;
  endpoints: {
    api: string;
    proxy: string;
    telemetry: string;
    "origin-tracker": string;
  };
  quota_reset_date: string;
  quota_reset_date_utc: string;
  quota_snapshots: Record<string, QuotaSnapshot>;
  token_based_billing: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

function getOAuthToken(): string | null {
  try {
    const auth = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    return auth?.["github-copilot"]?.refresh ?? null;
  } catch {
    return null;
  }
}

/** Render a progress bar */
function bar(pct: number, width = 46): string {
  const frac = Math.min(Math.max(pct / 100, 0), 1);
  const filled = Math.round(frac * width);
  const empty = width - filled;
  return `\x1b[94m${"█".repeat(filled)}\x1b[90m${"█".repeat(empty)}\x1b[0;97m ${pct.toFixed(1)}%\x1b[0m`;
}

/** Format large numbers with commas */
function n(v: number): string { return v.toLocaleString(); }

/** Bold text (bright white + bold) */
function b(s: string | number): string { return `\x1b[1;97m${s}\x1b[0;97m`; }

/** Normal white text (not dimmed) */
function w(s: string): string { return `\x1b[97m${s}\x1b[0m`; }

/** Days between now and a date string */
function daysUntil(dateStr: string): number {
  const target = new Date(dateStr);
  const now = new Date();
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / 86_400_000));
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function copilotUsageExtension(pi: ExtensionAPI) {
  pi.registerCommand("copilot-usage", {
    description: "Show GitHub Copilot quota from the API (premium requests, chat, completions)",

    handler: async (_args, ctx) => {
      const token = getOAuthToken();
      if (!token) {
        ctx.ui.notify(
          `No GitHub Copilot OAuth token found.\nExpected in: ${AUTH_FILE}\n\nMake sure you're authenticated with a github-copilot provider.`,
          "error",
        );
        return;
      }

      // Fetch from the Copilot internal API
      let data: CopilotUserResponse;
      try {
        const resp = await fetch("https://api.github.com/copilot_internal/user", {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "User-Agent": "pi-copilot-usage-extension/1.0",
          },
        });

        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          ctx.ui.notify(
            `API request failed: ${resp.status} ${resp.statusText}\n${body.slice(0, 300)}`,
            "error",
          );
          return;
        }

        data = (await resp.json()) as CopilotUserResponse;
      } catch (err: any) {
        ctx.ui.notify(`Failed to fetch Copilot usage: ${err.message}`, "error");
        return;
      }

      const snapshots = data.quota_snapshots ?? {};
      const premium = snapshots.premium_interactions;
      const chat = snapshots.chat;
      const completions = snapshots.completions;
      const resetDate = data.quota_reset_date ?? data.quota_reset_date_utc ?? "unknown";
      const daysLeft = daysUntil(resetDate);

      // Compute usage percentage for premium (inverted: percent_remaining → percent_used)
      const pctUsed = premium ? (100 - premium.percent_remaining) : 0;
      const used = premium ? (premium.entitlement - premium.remaining) : 0;

      // Daily burn rate & projection
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const dayOfMonth = Math.max(1, Math.ceil((now.getTime() - monthStart.getTime()) / 86_400_000));

      let projectionLine = "";
      if (premium && !premium.unlimited && dayOfMonth > 0) {
        const dailyRate = used / dayOfMonth;
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const projected = dailyRate * daysInMonth;
        const projPct = ((projected / premium.entitlement) * 100).toFixed(1);
        projectionLine = w(`Projected : ${b(n(Math.round(projected)))} / ${b(n(premium.entitlement))}  (${b(projPct + "%")})`);
      }

      // Build report
      const L: string[] = [
        "",
        w(`── GitHub Copilot Usage ──────────────────────────────────────`),
        "",
        w(`Username      : ${b(data.login)}`),
        w(`Plan          : ${b(data.copilot_plan)}  (${data.access_type_sku})`),
        w(`Quota resets  : ${b(resetDate)}  (${b(daysLeft)} day${daysLeft !== 1 ? "s" : ""} remaining)`),
        "",
      ];

      // Premium interactions (the metered one)
      if (premium) {
        L.push(w(`── Premium Interactions ───────────────────────────────────────`));
        if (premium.unlimited) {
          L.push(w(`Status    : ${b("♾️  Unlimited")}`));
        } else {
          L.push(w(`Used      : ${b(n(used))} of ${b(n(premium.entitlement))}  (${b(pctUsed.toFixed(1) + "%")} used)`));
          L.push(w(`Remaining : ${b(n(premium.remaining))}  (${b(premium.percent_remaining.toFixed(1) + "%")} left)`));
          L.push(`  ${bar(pctUsed)}`);
          if (projectionLine) L.push(projectionLine);
          if (premium.overage_permitted) {
            L.push(w(`Overage   : ${b("permitted")} (${b(n(premium.overage_count))} so far)`));
          } else {
            L.push(w(`Overage   : ${b("not permitted")}`));
          }
        }
        L.push("");
      }

      // Chat
      if (chat) {
        L.push(w(`── Chat ──────────────────────────────────────────────────────`));
        if (chat.unlimited) {
          L.push(w(`Status    : ${b("♾️  Unlimited")}`));
        } else {
          const chatUsed = chat.entitlement - chat.remaining;
          L.push(w(`Used      : ${b(n(chatUsed))} of ${b(n(chat.entitlement))}  (${b((100 - chat.percent_remaining).toFixed(1) + "%")} used)`));
        }
        L.push("");
      }

      // Completions
      if (completions) {
        L.push(w(`── Completions ───────────────────────────────────────────────`));
        if (completions.unlimited) {
          L.push(w(`Status    : ${b("♾️  Unlimited")}`));
        } else {
          const compUsed = completions.entitlement - completions.remaining;
          L.push(w(`Used      : ${b(n(compUsed))} of ${b(n(completions.entitlement))}  (${b((100 - completions.percent_remaining).toFixed(1) + "%")} used)`));
        }
        L.push("");
      }

      // Features
      L.push(w(`── Features ──────────────────────────────────────────────────`));
      L.push(w(`Chat: ${b(data.chat_enabled ? "✅" : "❌")}   CLI: ${b(data.cli_enabled ? "✅" : "❌")}   MCP: ${b(data.is_mcp_enabled ? "✅" : "❌")}`));
      L.push("");

      // Endpoints
      if (data.endpoints) {
        L.push(w(`── Endpoints ─────────────────────────────────────────────────`));
        L.push(w(`API   : ${b(data.endpoints.api)}`));
        L.push(w(`Proxy : ${b(data.endpoints.proxy)}`));
        L.push("");
      }

      ctx.ui.notify(L.join("\n"), "info");
    },
  });
}
