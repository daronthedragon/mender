import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DriftFinding } from "./history.js";
import type { Cause } from "./types.js";

/**
 * A scraper that repairs itself at 4am is only useful if somebody finds out.
 * These are the channels; watch.ts decides *when* to fire them, which matters
 * more — a monitor that reports the same break every fifteen minutes gets muted
 * within a day and then it protects nothing.
 */

export type NotifyEvent =
  | "broken"
  | "repaired"
  | "unrepaired"
  | "recovered"
  | "drift"
  | "blocked";

export const ALL_EVENTS: NotifyEvent[] = [
  "broken",
  "repaired",
  "unrepaired",
  "recovered",
  "drift",
  "blocked",
];

export interface Notification {
  event: NotifyEvent;
  scraper: string;
  url: string;
  ts: string;
  cause?: Cause;
  detail: string;
  rows?: number;
  fixes?: { target: string; from: string; to: string; via: string }[];
  drift?: DriftFinding[];
}

export interface Notifier {
  readonly name: string;
  send(n: Notification): Promise<void>;
}

const EMOJI: Record<NotifyEvent, string> = {
  broken: "🔴",
  repaired: "🟢",
  unrepaired: "🟠",
  recovered: "🟢",
  drift: "🟡",
  blocked: "⛔",
};

const HEADLINE: Record<NotifyEvent, (n: Notification) => string> = {
  broken: (n) => `${n.scraper} is broken`,
  repaired: (n) => `${n.scraper} repaired itself`,
  unrepaired: (n) => `${n.scraper} is broken and could not be repaired`,
  recovered: (n) => `${n.scraper} is healthy again`,
  drift: (n) => `${n.scraper} data changed meaning`,
  blocked: (n) => `${n.scraper} is being blocked`,
};

export function headline(n: Notification): string {
  return HEADLINE[n.event](n);
}

/** One plain-text block usable by any channel that has no rich formatting. */
export function renderText(n: Notification): string {
  const lines = [`${EMOJI[n.event]} ${headline(n)}`, n.detail];
  if (n.cause) lines.push(`cause: ${n.cause}`);
  for (const fix of n.fixes ?? []) {
    lines.push(`  ${fix.target}: ${fix.from}  ->  ${fix.to}   (${fix.via})`);
  }
  for (const d of n.drift ?? []) {
    lines.push(`  ${d.field === "__rows__" ? "rows" : d.field}: ${d.detail}`);
  }
  lines.push(n.url);
  return lines.join("\n");
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function consoleNotifier(write = (s: string) => process.stdout.write(s)): Notifier {
  return {
    name: "console",
    async send(n) {
      write(renderText(n) + "\n");
    },
  };
}

/** Append-only JSONL. The channel that never rate-limits and never goes down. */
export function fileNotifier(path: string): Notifier {
  return {
    name: `file:${path}`,
    async send(n) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(n) + "\n");
    },
  };
}

export function webhookNotifier(url: string, headers: Record<string, string> = {}): Notifier {
  return {
    name: "webhook",
    async send(n) {
      await postJson(url, n, headers);
    },
  };
}

export function slackNotifier(webhookUrl: string): Notifier {
  return {
    name: "slack",
    async send(n) {
      const blocks: unknown[] = [
        {
          type: "section",
          text: { type: "mrkdwn", text: `${EMOJI[n.event]} *${headline(n)}*\n${n.detail}` },
        },
      ];
      if (n.fixes?.length) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: n.fixes
              .map((f) => `\`${f.target}\`\n\`${f.from}\` → \`${f.to}\` _(${f.via})_`)
              .join("\n"),
          },
        });
      }
      if (n.drift?.length) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: n.drift
              .map((d) => `\`${d.field === "__rows__" ? "rows" : d.field}\` ${d.detail}`)
              .join("\n"),
          },
        });
      }
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `<${n.url}|${n.url}> · ${n.ts}` }],
      });
      await postJson(webhookUrl, { text: headline(n), blocks });
    },
  };
}

export function discordNotifier(webhookUrl: string): Notifier {
  const COLOR: Record<NotifyEvent, number> = {
    broken: 0xef4444,
    unrepaired: 0xf97316,
    blocked: 0x991b1b,
    repaired: 0x14b8a6,
    recovered: 0x22c55e,
    drift: 0xeab308,
  };
  return {
    name: "discord",
    async send(n) {
      const fields = [
        ...(n.fixes ?? []).map((f) => ({
          name: f.target,
          value: `\`${f.from}\` → \`${f.to}\` (${f.via})`.slice(0, 1024),
        })),
        ...(n.drift ?? []).map((d) => ({
          name: d.field === "__rows__" ? "rows" : d.field,
          value: d.detail.slice(0, 1024),
        })),
      ];
      await postJson(webhookUrl, {
        embeds: [
          {
            title: `${EMOJI[n.event]} ${headline(n)}`,
            description: n.detail.slice(0, 4000),
            color: COLOR[n.event],
            url: n.url.startsWith("http") ? n.url : undefined,
            fields: fields.slice(0, 25),
            timestamp: n.ts,
          },
        ],
      });
    },
  };
}

export interface NotifyConfig {
  /** Which events to send. Defaults to everything except "drift". */
  on?: NotifyEvent[];
  slack?: { webhookEnv: string };
  discord?: { webhookEnv: string };
  webhook?: { urlEnv: string; headers?: Record<string, string> };
  file?: { path: string };
  console?: boolean;
}

export class NotifyConfigError extends Error {}

/**
 * Build channels from config. Webhook URLs are secrets, so — like auth — the
 * config names an environment variable rather than holding the value, which
 * keeps a committed config file safe.
 */
export function notifiersFrom(config: NotifyConfig | undefined, env = process.env): Notifier[] {
  if (!config) return [];
  const out: Notifier[] = [];

  const secret = (name: string, what: string): string => {
    const value = env[name];
    if (!value) {
      throw new NotifyConfigError(`notify: environment variable ${name} is not set (for ${what})`);
    }
    return value;
  };

  if (config.slack) out.push(slackNotifier(secret(config.slack.webhookEnv, "slack")));
  if (config.discord) out.push(discordNotifier(secret(config.discord.webhookEnv, "discord")));
  if (config.webhook) {
    out.push(webhookNotifier(secret(config.webhook.urlEnv, "webhook"), config.webhook.headers ?? {}));
  }
  if (config.file) out.push(fileNotifier(config.file.path));
  if (config.console) out.push(consoleNotifier());
  return out;
}

export function shouldSend(config: NotifyConfig | undefined, event: NotifyEvent): boolean {
  const on = config?.on ?? ALL_EVENTS.filter((e) => e !== "drift");
  return on.includes(event);
}

export interface DispatchResult {
  sent: string[];
  failed: { notifier: string; error: string }[];
}

/**
 * Deliver to every channel. A channel that is down must never take the run with
 * it: a failed Slack post is worth reporting, not worth losing a repair over.
 */
export async function dispatch(notifiers: Notifier[], n: Notification): Promise<DispatchResult> {
  const result: DispatchResult = { sent: [], failed: [] };
  await Promise.all(
    notifiers.map(async (notifier) => {
      try {
        await notifier.send(n);
        result.sent.push(notifier.name);
      } catch (e) {
        result.failed.push({ notifier: notifier.name, error: (e as Error).message });
      }
    }),
  );
  return result;
}
