import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import App from '@/App.jsx';
import '@/index.css';
import { trpc } from '@/lib/trpc';

const queryClient = new QueryClient();

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const trpcClient = trpc.createClient({
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

ReactDOM.createRoot(document.getElementById('root')).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>,
);