import pino from 'pino';
import axios from 'axios';
import { config } from '../config';

const transport =
  config.env === 'development'
    ? pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } })
    : undefined;

export const logger = pino(
  {
    level: config.logging.level,
    base: { service: 'nifty-bot' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport,
);

// ── Webhook alert (Slack / Discord / Telegram) ─────────────────────────────

async function sendWebhookAlert(level: string, message: string, meta?: Record<string, unknown>): Promise<void> {
  if (!config.alerts.webhookUrl) return;
  try {
    await axios.post(config.alerts.webhookUrl, {
      text: `[${level.toUpperCase()}] ${message}`,
      attachments: meta ? [{ text: JSON.stringify(meta, null, 2) }] : undefined,
    });
  } catch {
    // Do not throw — alert failure must never crash the bot
  }
}

export const alert = {
  info: (message: string, meta?: Record<string, unknown>) => {
    logger.info(meta ?? {}, message);
    sendWebhookAlert('info', message, meta);
  },
  warn: (message: string, meta?: Record<string, unknown>) => {
    logger.warn(meta ?? {}, message);
    sendWebhookAlert('warn', message, meta);
  },
  error: (message: string, meta?: Record<string, unknown>) => {
    logger.error(meta ?? {}, message);
    sendWebhookAlert('error', message, meta);
  },
  critical: (message: string, meta?: Record<string, unknown>) => {
    logger.fatal(meta ?? {}, message);
    sendWebhookAlert('CRITICAL', message, meta);
  },
};
