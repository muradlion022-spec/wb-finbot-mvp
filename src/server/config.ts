import "dotenv/config";
import { z } from "zod";

const DEFAULT_ENCRYPTION_SECRET = "local-development-secret-change-me";

const envSchema = z.object({
  BOT_TOKEN: z.string().optional().default(""),
  DATABASE_URL: z.string().min(1).default("file:./dev.db"),
  ENCRYPTION_SECRET: z.string().min(16).default(DEFAULT_ENCRYPTION_SECRET),
  NODE_ENV: z.string().optional().default("development"),
  PUBLIC_API_URL: z.string().url().optional().default("http://localhost:3000"),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional().default(""),
  TELEGRAM_AUTH_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(86_400),
  WB_API_BASE_URL: z.string().url().default("https://statistics-api.wildberries.ru"),
  WB_FINANCE_API_BASE_URL: z.string().url().default("https://finance-api.wildberries.ru"),
  WB_CONTENT_API_BASE_URL: z.string().url().default("https://content-api.wildberries.ru"),
  MINI_APP_URL: z.string().url().default("http://localhost:5173"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  USE_DEMO_DATA: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  WB_REPORT_LOOKBACK_DAYS: z.coerce.number().int().positive().default(90)
});

const parsed = envSchema.parse(process.env);
const isProduction = parsed.NODE_ENV === "production";

if (isProduction) {
  const issues: string[] = [];

  if (!parsed.BOT_TOKEN) {
    issues.push("BOT_TOKEN is required");
  }
  if (!process.env.DATABASE_URL || parsed.DATABASE_URL.startsWith("file:")) {
    issues.push("DATABASE_URL must be a PostgreSQL connection string");
  }
  if (
    !process.env.ENCRYPTION_SECRET ||
    parsed.ENCRYPTION_SECRET === DEFAULT_ENCRYPTION_SECRET ||
    parsed.ENCRYPTION_SECRET.length < 32
  ) {
    issues.push("ENCRYPTION_SECRET must be a non-default secret of at least 32 characters");
  }
  if (!process.env.MINI_APP_URL) {
    issues.push("MINI_APP_URL is required");
  }
  if (!parsed.TELEGRAM_WEBHOOK_SECRET || parsed.TELEGRAM_WEBHOOK_SECRET.length < 16) {
    issues.push("TELEGRAM_WEBHOOK_SECRET must be at least 16 characters");
  }
  if (parsed.USE_DEMO_DATA) {
    issues.push("USE_DEMO_DATA must be false");
  }

  if (issues.length > 0) {
    throw new Error(`Invalid production configuration: ${issues.join("; ")}`);
  }
}

export const config = {
  ...parsed,
  IS_PRODUCTION: isProduction,
  BUILD_VERSION: (process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || process.env.BUILD_VERSION || "local").slice(0, 12),
  BUILT_AT: process.env.BUILD_TIMESTAMP || process.env.VERCEL_DEPLOYMENT_CREATED_AT || new Date().toISOString()
};
