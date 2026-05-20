import postgres from 'postgres';

declare global {
  // eslint-disable-next-line no-var
  var __sql: ReturnType<typeof postgres> | undefined;
}

function init() {
  // Prefer the non-pooled (direct) connection. For this single-admin app at
  // very low QPS, the simplicity of direct connections beats PgBouncer's
  // failure modes (timed-out invocations leaving connections stuck "in use").
  const url = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL is not set');
  return postgres(url, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export const sql = globalThis.__sql ?? init();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__sql = sql;
}
