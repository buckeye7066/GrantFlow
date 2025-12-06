console.warn(
  '[base44Client] Deprecated. Use trpc client from "@/lib/apiClient" instead.',
);

const handler = {
  get() {
    throw new Error('Base44 client is no longer available.');
  },
};

export const base44 = {
  functions: new Proxy({}, handler),
  entities: new Proxy({}, handler),
  auth: {
    async me() {
      throw new Error('Base44 client is no longer available.');
    },
  },
};
