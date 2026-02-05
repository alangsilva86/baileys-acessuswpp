import path from 'node:path';

export function resolvePipedriveDataDir(): string {
  const custom = process.env.PIPEDRIVE_DATA_DIR;
  if (custom && custom.trim()) {
    const trimmed = custom.trim();
    return path.isAbsolute(trimmed) ? trimmed : path.join(process.cwd(), trimmed);
  }
  return path.join(process.cwd(), 'data');
}

