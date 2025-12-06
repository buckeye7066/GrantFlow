import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '@grantflow/api';

export const trpc = createTRPCReact<AppRouter>();

