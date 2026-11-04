export const env = (name: string) => process.env[name]?.trim() || undefined;

export const flag = (name: string) => ["1", "true"].includes(env(name)?.toLowerCase() ?? "");

export const positive = (name: string, fallback: number) => {
  const n = Math.floor(Number(process.env[name]));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  server: {
    port: () => Number(env("PORT")) || 3000,
    isTest: () => env("NODE_ENV") === "test",
    isProduction: () => (env("NODE_ENV") ?? "").toLowerCase().startsWith("prod"),
    trustProxy: () => flag("TRUST_PROXY"),
  },

  rate: {
    windowMs: () => positive("RATE_LIMIT_WINDOW_MINUTES", 15) * 60000,
    write: () => positive("RATE_LIMIT_WRITE", 300),
    uploads: () => positive("RATE_LIMIT_UPLOADS", 100),
    montages: () => positive("RATE_LIMIT_MONTAGES", 5),
    invites: () => positive("RATE_LIMIT_INVITES", 30),
  },

  postgres: {
    url: () => {
      const url = env("POSTGRES_URL") ?? env("DATABASE_URL");
      if (!url) throw new Error("POSTGRES_URL is not set");
      return url;
    },
  },

  auth: {
    sessionTtlDays: () => positive("SESSION_TTL_DAYS", 365),
    emailLoginTtlMinutes: () => positive("EMAIL_LOGIN_TTL_MINUTES", 15),
    rateWindowMs: () => positive("EMAIL_LOGIN_RATE_WINDOW_MINUTES", 15) * 60000,
    emailLoginMaxAttempts: () => positive("EMAIL_LOGIN_MAX_ATTEMPTS", 5),
    rateMaxPerEmail: () => positive("EMAIL_LOGIN_RATE_MAX", 5),
    rateMaxPerIp: () => positive("EMAIL_LOGIN_RATE_MAX_PER_IP", 50),
    devLoginCode: () => {
      const value = env("EMAIL_LOGIN_DEV_BYPASS");
      if (!value) return undefined;
      if ((env("NODE_ENV") ?? "").toLowerCase().startsWith("prod")) return undefined;
      if (!/^\d{6}$/.test(value)) {
        throw new Error("EMAIL_LOGIN_DEV_BYPASS must be six digits");
      }
      return value;
    },
    reviewLogin: () => {
      const value = env("REVIEW_LOGIN");
      if (!value) return undefined;
      const [, email, code] = /^([^\s@:]+@[^\s@:]+):(\d{6})$/.exec(value) ?? [];
      if (!email || !code || email !== email.toLowerCase()) {
        throw new Error("REVIEW_LOGIN is not a lowercase address, a colon and six digits");
      }
      return { email, code };
    },
  },

  media: {
    maxFileBytes: () => positive("MEDIA_MAX_FILE_BYTES", 1024 ** 3),
    maxVideoSeconds: () => positive("MEDIA_MAX_VIDEO_SECONDS", 300),
    projectMaxBytes: () => positive("PROJECT_MAX_STORAGE_BYTES", 10 * 1024 ** 3),
    projectMaxFiles: () => positive("PROJECT_MAX_FILES", 1000),
    partBytes: () => positive("MEDIA_UPLOAD_PART_BYTES", 8 * 1024 ** 2),
    uploadTtlSeconds: () => positive("MEDIA_UPLOAD_TTL_SECONDS", 3600),
    downloadTtlSeconds: () => positive("MEDIA_DOWNLOAD_TTL_SECONDS", 900),
  },

  smtp: {
    timeoutMs: 5000,
    secure: () => flag("SMTP_SECURE"),
    port: () => positive("SMTP_PORT", flag("SMTP_SECURE") ? 465 : 587),
    host: () => env("SMTP_HOST"),
    user: () => env("SMTP_USER"),
    password: () => env("SMTP_PASSWORD"),
    from: () => env("SMTP_FROM"),
    configured: () =>
      Boolean(env("SMTP_HOST") && env("SMTP_USER") && env("SMTP_PASSWORD") && env("SMTP_FROM")),
  },

  s3: {
    endpoint: () => env("S3_ENDPOINT")?.replace(/\/+$/, ""),
    publicEndpoint: () => (env("S3_PUBLIC_ENDPOINT") ?? env("S3_ENDPOINT"))?.replace(/\/+$/, ""),
    bucket: () => env("S3_BUCKET"),
    accessKeyId: () => env("S3_ACCESS_KEY_ID"),
    secretAccessKey: () => env("S3_SECRET_ACCESS_KEY"),
    region: () => env("S3_REGION") ?? "auto",
  },

  push: {
    batch: 100,
    timeoutMs: 5000,
    url: () => (env("PUSH_URL") ?? "https://exp.host/--/api/v2/push/send").trim(),
  },

  worker: {
    token: () => env("INTERNAL_WORKER_TOKEN"),
  },

  montage: {
    targetSeconds: () => positive("MONTAGE_TARGET_SECONDS", 60),
    viewerWindowSeconds: () => positive("MONTAGE_VIEWER_WINDOW_SECONDS", 20),
  },
};
