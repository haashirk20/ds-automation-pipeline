import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import raw from '../../config/pipeline.config.ts';
import { SafeZone } from '../contracts.ts';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');
const base = { handle: z.string().min(1), enabled: z.boolean(), visibility: z.enum(['public', 'private']), slots: z.array(hhmm).min(1), cta: z.string().min(1), safe: SafeZone };

const tierSchema = z.object({
  provider: z.string().min(1), model: z.string().min(1), usdPerClip: z.number().positive(),
  params: z.record(z.string(), z.unknown()).default({}), maxCredits: z.number().positive().optional(), keepCredits: z.number().min(0).optional(),
});

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
      tiktok: z.object(base),
    }),
    publish: z.object({
      maxLatenessMinutes: z.number().positive(),
      retryMinutes: z.array(z.number().positive()),
      uploadTimeoutMinutes: z.number().positive(),
      timeoutMinutes: z.number().positive(),
    }),
    brand: z.object({ name: z.string().min(1).nullable(), logo: z.string().min(1).nullable() }),
    creative: z.object({ mode: z.enum(['ugc', 'ad']), voices: z.array(z.string()).min(1), music: z.object({ enabled: z.boolean(), gainDb: z.number().max(0) }) }),
    ugc: z.object({ reuseAfterDays: z.number().int().min(1), captionPx: z.number().min(56).max(110) }),
    llm: z.object({
      models: z.object({ script: z.string(), copy: z.string(), qa: z.string(), escalation: z.string() }),
      monthlyCapUsd: z.number().positive(),
      escalationEnabled: z.boolean(),
    }),
    hooks: z.object({ noRepeatDays: z.number().int().min(0), poolFactor: z.number().min(1) }),
    render: z.object({ produceTimeoutMinutes: z.number().positive(), maxAttempts: z.number().int().min(1) }),
    disclosure: z.object({ tier0: z.boolean() }),
    tiers: z.object({
      mix: z.object({ t0: z.number().min(0), t1: z.number().min(0), t2: z.number().min(0) }),
      capsUsd: z.object({ t1: z.number().min(0), t2: z.number().min(0) }),
      clipSeconds: z.number().positive(),
      maxJobsPerSlot: z.number().int().min(1),
      t1: tierSchema,
      t2: tierSchema,
    }),
    ops: z.object({ summaryAt: hhmm, snapshotAt: hhmm, keepDays: z.number().int().min(1), diskAlertPercent: z.number().min(1).max(100) }),
    watchdogMinutes: z.number().positive(),
  })
  .superRefine((c, ctx) => {
    if (c.publish.timeoutMinutes >= c.publish.uploadTimeoutMinutes) ctx.addIssue({ code: 'custom', path: ['publish', 'timeoutMinutes'], message: 'must be less than uploadTimeoutMinutes' });
    const counts = new Set(Object.values(c.platforms).filter((p) => p.enabled).map((p) => p.slots.length));
    const m = c.tiers.mix;
    if (Math.abs(m.t0 + m.t1 + m.t2 - 1) > 1e-6) ctx.addIssue({ code: 'custom', path: ['tiers', 'mix'], message: 'shares must sum to 1' });
    if (c.creative.mode === 'ugc' && (c.tiers.clipSeconds < 14 || c.tiers.clipSeconds > 16)) ctx.addIssue({ code: 'custom', path: ['tiers', 'clipSeconds'], message: "must be between 14 and 16 when creative.mode is 'ugc'" });
    if (c.creative.mode === 'ugc' && c.render.produceTimeoutMinutes < c.tiers.maxJobsPerSlot * 40 + 10) ctx.addIssue({ code: 'custom', path: ['render', 'produceTimeoutMinutes'], message: "must be at least tiers.maxJobsPerSlot * 40 + 10 when creative.mode is 'ugc'" });
    if (c.platforms.instagram.enabled && c.platforms.instagram.visibility === 'private') ctx.addIssue({ code: 'custom', path: ['platforms', 'instagram', 'visibility'], message: "instagram has no private mode: set its visibility to 'public' or disable it" });
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

// PIPELINE_CONFIG names a file to load in place of config/pipeline.config.ts; it is validated the same way.
export async function loadConfig(): Promise<Config> {
  const file = process.env.PIPELINE_CONFIG;
  return parseConfig(file ? (await import(pathToFileURL(path.resolve(file)).href)).default : raw);
}

// Accepts 'my-store', 'my-store.myshopify.com' or 'https://my-store.myshopify.com/'. The result goes
// into request URLs, so anything that is not a plain myshopify.com host is rejected.
export function normalizeShop(input: string | undefined): string | undefined {
  let h = input?.trim().toLowerCase();
  if (!h) return undefined;
  h = h.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  if (!h.includes('.')) h += '.myshopify.com';
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(h)) throw new Error('SHOPIFY_SHOP must be a myshopify.com host such as my-store.myshopify.com');
  return h;
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
  healthcheckDailyUrl: () => process.env.HEALTHCHECK_DAILY_URL || undefined, // pinged after the daily summary is delivered
  backupStatusDir: () => process.env.BACKUP_STATUS_DIR || undefined, // the backup container writes last-ok here
  shop: () => normalizeShop(process.env.SHOPIFY_SHOP), // bare host, e.g. my-store.myshopify.com
  bridgeKey: () => process.env.BRIDGE_API_KEY || undefined,
  shopifyClientId: () => process.env.SHOPIFY_CLIENT_ID || undefined,
  shopifyClientSecret: () => process.env.SHOPIFY_CLIENT_SECRET || undefined,
  clipStubFile: () => process.env.CLIP_STUB_FILE || undefined, // enables the 'fake' clip provider
  llmStub: () => process.env.LLM_STUB === '1', // model calls return fixtures
};
