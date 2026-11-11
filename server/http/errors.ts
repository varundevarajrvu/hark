import type { z } from 'zod';

/** An error whose message is safe to show to the user, with the HTTP status to send. */
export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const notFound = (what = 'Not found.'): HttpError => new HttpError(404, what);

/** Validate untrusted input; throws a 400 with a readable message naming the first offending field. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw new HttpError(400, `${where}${issue?.message ?? 'Invalid request.'}`);
}
