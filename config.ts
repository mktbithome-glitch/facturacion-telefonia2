import { z } from "zod";

const optionalSecret = z.string().trim().optional().transform((value) => value || undefined);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  ADMIN_USERNAME: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(12),
  NEXLINK_BASE_URL: z.string().url().default("https://api.nextlinksolutions.es/v2"),
  NEXLINK_AUTH_TOKEN: optionalSecret,
  NEXLINK_USERNAME: optionalSecret,
  NEXLINK_PASSWORD: optionalSecret,
  NOTION_TOKEN: optionalSecret,
  NOTION_INVOICES_DATA_SOURCE_ID: optionalSecret,
  GMAIL_USER: z.string().email().default("info.redprime@gmail.com"),
  GMAIL_APP_PASSWORD: optionalSecret
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Configuración inválida: ${details}`);
  }
  return parsed.data;
}
