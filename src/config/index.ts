import { z } from 'zod';
import raw from '../../config/pipeline.config.ts';
import { SafeZone } from '../contracts.ts';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');
const base = { enabled: z.boolean(), visibility: z.enum(['public', 'private']), slots: z.array(hhmm).min(1), cta: z.string().min(1), safe: SafeZone };

const schema = z
  .object({
    timezone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'unknown time zone'),
    produceAt: hhmm,
    platforms: z.object({
      youtube: z.object(base),
      facebook: z.object(base),
      instagram: z.object(base),
      tiktok: z.object({ ...base, mode: z.enum(['bridge', 'direct', 'inbox']) }),
    }),
    publish: z.object({
      maxLatenessMinutes: z.number().positive(),
      retryMinutes: z.array(z.number().positive()),
      uploadTimeoutMinutes: z.number().positive(),
      timeoutMinutes: z.number().positive(),
    }),
    creative: z.object({ voices: z.array(z.string()).min(1), music: z.object({ enabled: z.boolean(), gainDb: z.number().max(0) }) }),
    claims: z.object({ fromPhotos: z.boolean() }),
    llm: z.object({
      models: z.object({ script: z.string(), copy: z.string(), qa: z.string(), escalation: z.string() }),
      monthlyCapUsd: z.number().positive(),
      escalationEnabled: z.boolean(),
    }),
    hooks: z.object({ noRepeatDays: z.number().int().min(0), poolFactor: z.number().min(1) }),
    render: z.object({ produceTimeoutMinutes: z.number().positive(), maxAttempts: z.number().int().min(1) }),
    disclosure: z.object({ tier0: z.boolean() }),
    watchdogMinutes: z.number().positive(),
  })
  .superRefine((c, ctx) => {
    if (c.publish.timeoutMinutes >= c.publish.uploadTimeoutMinutes) ctx.addIssue({ code: 'custom', path: ['publish', 'timeoutMinutes'], message: 'must be less than uploadTimeoutMinutes' });
    const counts = new Set(Object.values(c.platforms).filter((p) => p.enabled).map((p) => p.slots.length));
    if (counts.size > 1) ctx.addIssue({ code: 'custom', path: ['platforms'], message: 'enabled platforms must have the same number of slots' });
  });

export type Config = z.infer<typeof schema>;
export type PlatformName = keyof Config['platforms'];

// .env is loaded by src/cli.ts only, so tests never read a developer's .env.
// Throws a readable Error on invalid input.
export function parseConfig(input: unknown): Config {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  throw new Error('invalid config:\n' + r.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n'));
}

export function loadConfig(): Config {
  return parseConfig(raw);
}

// Read lazily so tests can change process.env. Never log these values.
export const env = {
  dryRun: () => process.env.DRY_RUN === '1',
  dataDir: () => process.env.DATA_DIR || './data',
  outDir: () => process.env.OUT_DIR || './out',
  discordWebhook: () => process.env.ALERT_DISCORD_WEBHOOK || undefined,
  telegramToken: () => process.env.ALERT_TELEGRAM_BOT_TOKEN || undefined,
  telegramChat: () => process.env.ALERT_TELEGRAM_CHAT_ID || undefined,
  healthcheckUrl: () => process.env.HEALTHCHECK_URL || undefined,
  shop: () => process.env.SHOPIFY_SHOP || undefined, // e.g. my-store.myshopify.com
  shopifyClientId: () => process.env.SHOPIFY_CLIENT_ID || undefined,
  shopifyClientSecret: () => process.env.SHOPIFY_CLIENT_SECRET || undefined,
  llmStub: () => process.env.LLM_STUB === '1', // model calls return fixtures
};
