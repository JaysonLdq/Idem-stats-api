import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function notFound(_req, res) {
  res.status(404).json({ error: 'not_found' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'validation_error', issues: err.issues });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code || 'http_error', message: err.message });
  }
  // Prisma unique-constraint (code P2002) — pratique pour pseudo + match code
  if (err?.code === 'P2002') {
    return res.status(409).json({ error: 'conflict', target: err.meta?.target });
  }
  if (process.env.NODE_ENV !== 'test') {
    console.error(err);
  }
  res.status(500).json({ error: 'internal_error' });
}
