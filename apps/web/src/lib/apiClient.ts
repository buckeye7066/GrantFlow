import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@grantflow/api';

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export const trpcClient = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${apiUrl}/trpc`,
      fetch: (url, options) =>
        fetch(url, {
          ...options,
          credentials: 'include',
        }),
    }),
  ],
});

