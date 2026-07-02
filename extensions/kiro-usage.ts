/**
 * Kiro Usage Extension
 *
 * Fetches credit usage from the Kiro/CodeWhisperer API using the locally
 * stored OIDC token from kiro-cli's SQLite database.
 *
 * Usage:
 *   /kiro-usage
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Token retrieval ───────────────────────────────────────────────────────────

function getKiroCliDbPath(): string | undefined {
  const p = process.platform;
  let dbPath: string;
  if (p === "win32")
    dbPath = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "kiro-cli", "data.sqlite3");
  else if (p === "darwin")
    dbPath = join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3");
  else
    dbPath = join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3");
  return existsSync(dbPath) ? dbPath : undefined;
}

function getAccessToken(): string | undefined {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return undefined;

  // Try IDC token first, then social/desktop token
  for (const key of ["kirocli:odic:token", "kirocli:social:token"]) {
    try {
      const result = execSync(
        `sqlite3 -json "${dbPath}" "SELECT value FROM auth_kv WHERE key = '${key}'"`,
        { encoding: "utf-8", timeout: 5000 }
      );
      const rows = JSON.parse(result);
      if (!rows[0]?.value) continue;
      const tokenData = JSON.parse(rows[0].value);
      if (tokenData.access_token) return tokenData.access_token;
    } catch {
      continue;
    }
  }
  return undefined;
}

// ── API call ──────────────────────────────────────────────────────────────────

interface UsageBreakdown {
  displayName: string;
  displayNamePlural: string;
  currentUsage: number;
  currentUsageWithPrecision: number;
  usageLimit: number;
  usageLimitWithPrecision: number;
  currentOverages: number;
  currentOveragesWithPrecision: number;
  overageRate: number;
  overageCharges: number;
  overageCap: number;
  overageCapWithPrecision: number;
  nextDateReset: number;
  resourceType: string;
  unit: string;
  bonuses: unknown[];
  currency: string;
}

interface UsageLimitsResponse {
  daysUntilReset: number;
  nextDateReset: number;
  limits: unknown[];
  overageConfiguration?: {
    overageStatus: string;
  };
  subscriptionInfo?: {
    subscriptionTitle: string;
    type: string;
    overageCapability: string;
    subscriptionManagementTarget: string;
    upgradeCapability: string;
  };
  usageBreakdownList?: UsageBreakdown[];
  userInfo?: {
    userId: string;
  };
}

async function fetchUsageLimits(token: string): Promise<UsageLimitsResponse> {
  const resp = await fetch("https://codewhisperer.us-east-1.amazonaws.com", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.0",
      "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
      "Authorization": `Bearer ${token}`,
    },
    body: "{}",
  });

  if (!resp.ok) {
    throw new Error(`API returned ${resp.status}: ${await resp.text()}`);
  }

  return resp.json() as Promise<UsageLimitsResponse>;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderProgressBar(used: number, total: number, width = 80): string {
  const pct = total > 0 ? Math.min(used / total, 1) : 0;
  const filled = Math.round(pct * width);
  const empty = width - filled;

  // Use ANSI colors: bright purple (95) for filled, dark gray (90) for empty
  const filledBar = `\x1b[95m${"█".repeat(filled)}\x1b[0m`;
  const emptyBar = `\x1b[90m${"█".repeat(empty)}\x1b[0m`;

  return `${filledBar}${emptyBar} ${Math.round(pct * 100)}%`;
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function kiroUsageExtension(pi: ExtensionAPI) {
  pi.registerCommand("kiro-usage", {
    description: "Show Kiro credit usage and plan information",

    handler: async (_args, ctx) => {
      const token = getAccessToken();
      if (!token) {
        ctx.ui.notify(
          "Could not find Kiro CLI token.\n\nMake sure you're logged into Kiro CLI (the token is stored in ~/Library/Application Support/kiro-cli/data.sqlite3).",
          "error",
        );
        return;
      }

      let data: UsageLimitsResponse;
      try {
        data = await fetchUsageLimits(token);
      } catch (err: any) {
        ctx.ui.notify(`Failed to fetch usage: ${err.message}`, "error");
        return;
      }

      const sub = data.subscriptionInfo;
      const planName = sub?.subscriptionTitle ?? "Unknown Plan";
      const breakdown = data.usageBreakdownList?.[0];

      if (!breakdown) {
        ctx.ui.notify("No usage breakdown available in response.", "error");
        return;
      }

      // Reset date
      const resetDate = new Date(data.nextDateReset * 1000);
      const resetStr = resetDate.toISOString().slice(0, 10);

      // Usage
      const used = breakdown.currentUsageWithPrecision;
      const limit = breakdown.usageLimitWithPrecision;

      // Overages
      const overageEnabled = data.overageConfiguration?.overageStatus === "ENABLED";
      const overageRate = breakdown.overageRate;
      const overageCreditsUsed = breakdown.currentOveragesWithPrecision;
      const overageCharges = breakdown.overageCharges;
      const currency = breakdown.currency || "USD";

      // Determine if org-managed
      const isOrgManaged = sub?.subscriptionManagementTarget === "MANAGE";

      // Build output
      const L: string[] = [
        "",
        `\x1b[97mEstimated Usage\x1b[0m | resets on ${resetStr} | \x1b[95m${planName}\x1b[0m`,
        `\x1b[97mCredits:\x1b[0m \x1b[1m${used.toFixed(2)}\x1b[0m of \x1b[1m${limit.toFixed(0)}\x1b[0m covered in plan (max \x1b[1m${breakdown.overageCapWithPrecision.toFixed(0)}\x1b[0m with overage)`,
        renderProgressBar(used, limit),
        "",
        `Overages: \x1b[1m${overageEnabled ? "Enabled" : "Disabled"}\x1b[0m  \x1b[2m\x1b[37mbilled at $${overageRate.toFixed(2)} per credit${isOrgManaged ? " (managed by your organization)" : ""}\x1b[0m`,
        `Overage credits used: \x1b[1m${overageCreditsUsed.toFixed(2)}\x1b[0m`,
        `Estimated overage cost: \x1b[1m$${overageCharges.toFixed(2)} ${currency}\x1b[0m`,
      ];

      if (isOrgManaged) {
        L.push("");
        L.push("Since your account is through your organization, for account management please contact your account administrator.");
      }

      L.push("");

      ctx.ui.notify(L.join("\n"), "info");
    },
  });
}
