import postgres from 'postgres';

declare global {
  // eslint-disable-next-line no-var
  var __sql: ReturnType<typeof postgres> | undefined;
}

function init() {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL is not set');
  return postgres(url, { prepare: false });
}

export const sql = globalThis.__sql ?? init();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__sql = sql;
}
