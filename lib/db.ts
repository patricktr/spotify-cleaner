import { neon } from '@neondatabase/serverless';

// Use Neon's HTTP-based query function. Each query is a stateless HTTP POST,
// so we sidestep any TCP-connection lifecycle weirdness in Vercel serverless
// (the `postgres` library's pooled and direct connections both stalled
// indefinitely from inside the cron handler for reasons we couldn't pin down).
//
// `neon()` returns a tagged-template function with the same call shape as the
// `postgres` library: `await sql\`SELECT ...\`` returns the rows. There's no
// socket state to cache, so no module-level singleton is needed.

const url = process.env.POSTGRES_URL ?? process.env.POSTGRES_URL_NON_POOLING;
if (!url) throw new Error('POSTGRES_URL is not set');

export const sql = neon(url);
