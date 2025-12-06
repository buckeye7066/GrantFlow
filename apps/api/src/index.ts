import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { appRouter } from './router';
import { createContext } from './context';

const app = express();

app.use(cors());
app.use(express.json());

app.use(
  '/trpc',
  createExpressMiddleware({
    router: appRouter,
    createContext,
  }),
);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

const port = Number(process.env.PORT ?? 4000);

app.listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});

export type AppRouter = typeof appRouter;

