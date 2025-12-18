export function createError(code: string, message?: string): Error {
  const err = new Error(message ?? code);
  (err as any).code = code;
  return err;
}
