import { PrismaClient } from '@prisma/client';

// instance unique pour tout le process (singleton implicite via module ESM)
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
});
