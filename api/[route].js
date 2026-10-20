// Vercel function serving every /api/<route> endpoint.
import { createHandler } from '../server/app.js';

const handle = createHandler({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export const GET = handle;
export const POST = handle;
