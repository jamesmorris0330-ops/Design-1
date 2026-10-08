import { createApp } from './app';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be an integer between 1 and 65535');

const app = await createApp();
await app.listen({ port, host });
console.info(`THE EXPERIMENT server listening on ${host}:${port}`);
const shutdown = async (): Promise<void> => { await app.close(); process.exit(0); };
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
