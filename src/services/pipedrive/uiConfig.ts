import {
  PIPEDRIVE_CLIENT_SECRET,
  PIPEDRIVE_UI_ENABLED,
  PIPEDRIVE_UI_JWT_SECRET,
} from './config.js';

export function resolvePipedriveUiJwtSecret(): string | null {
  const configured = (PIPEDRIVE_UI_JWT_SECRET || '').trim();
  if (configured) return configured;
  if ((process.env.NODE_ENV || '').toLowerCase() !== 'production') {
    const fallback = (PIPEDRIVE_CLIENT_SECRET || '').trim();
    if (fallback) return fallback;
  }
  return null;
}

export function assertPipedriveUiConfig(): void {
  if (!PIPEDRIVE_UI_ENABLED) return;
  const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
  if (nodeEnv === 'production' && !(PIPEDRIVE_UI_JWT_SECRET || '').trim()) {
    throw new Error('pipedrive_ui_jwt_secret_required');
  }
  if (!resolvePipedriveUiJwtSecret()) {
    throw new Error('pipedrive_ui_jwt_secret_missing');
  }
}

