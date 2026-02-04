import axios, { type AxiosInstance } from 'axios';
import {
  PIPEDRIVE_API_BASE_URL,
  PIPEDRIVE_CLIENT_ID,
  PIPEDRIVE_CLIENT_SECRET,
  PIPEDRIVE_OAUTH_BASE_URL,
  PIPEDRIVE_TEMPLATE_SUPPORT,
} from './config.js';
import {
  getLatestToken,
  getTokenByApiDomain,
  getTokenByCompanyId,
  upsertChannel,
  upsertToken,
  type PipedriveChannelRecord,
  type PipedriveOAuthToken,
} from './store.js';
import type { PipedriveAttachment, PipedriveParticipant } from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number | string;
  api_domain?: string;
  company_id?: number;
  user_id?: number;
  scope?: string;
  token_type?: string;
}

interface RegisterChannelPayload {
  name: string;
  provider_channel_id: string;
  avatar_url?: string | null;
  provider_type: string;
  template_support?: boolean;
}

interface ReceiveMessagePayload {
  channel_id: string | number;
  conversation_id: string;
  conversation_link?: string | null;
  message_id: string;
  message: string;
  created_at: string;
  status: string;
  sender: PipedriveParticipant;
  attachments?: PipedriveAttachment[];
  reply_by?: string | null;
}

function buildApiBase(apiDomain?: string | null): string {
  if (PIPEDRIVE_API_BASE_URL) return PIPEDRIVE_API_BASE_URL.replace(/\/$/, '');
  if (apiDomain) {
    const normalized = apiDomain.replace(/\/$/, '');
    if (normalized.endsWith('/api/v1') || normalized.endsWith('/v1')) return normalized;
    return `${normalized}/api/v1`;
  }
  return 'https://api.pipedrive.com/v1';
}

function computeExpiresAt(expiresIn?: number | string): number | null {
  const parsed = typeof expiresIn === 'string' ? Number(expiresIn) : expiresIn;
  if (!parsed || !Number.isFinite(parsed)) return null;
  const bufferMs = 60_000;
  return Date.now() + parsed * 1000 - bufferMs;
}

function isTokenExpired(token: PipedriveOAuthToken | null): boolean {
  if (!token?.expires_at) return false;
  return Date.now() >= token.expires_at;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function pickToken(options: { companyId?: number | null; apiDomain?: string | null } = {}): Promise<PipedriveOAuthToken | null> {
  if (options.companyId != null) {
    const byCompany = await getTokenByCompanyId(options.companyId);
    if (byCompany) return byCompany;
  }
  if (options.apiDomain) {
    const byDomain = await getTokenByApiDomain(options.apiDomain);
    if (byDomain) return byDomain;
  }
  return await getLatestToken();
}

export class PipedriveClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({ timeout: DEFAULT_TIMEOUT_MS });
  }

  async exchangeToken(code: string, redirectUri: string): Promise<PipedriveOAuthToken> {
    const url = `${PIPEDRIVE_OAUTH_BASE_URL.replace(/\/$/, '')}/oauth/token`;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: PIPEDRIVE_CLIENT_ID,
      client_secret: PIPEDRIVE_CLIENT_SECRET,
    });
    const response = await this.http.post(url, body.toString(), {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const data = response.data as OAuthTokenResponse;
    return upsertToken({
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? null,
      expires_at: computeExpiresAt(data.expires_in),
      api_domain: data.api_domain ?? null,
      company_id: toNumber(data.company_id),
      user_id: toNumber(data.user_id),
      scope: data.scope ?? null,
    });
  }

  async refreshToken(token: PipedriveOAuthToken): Promise<PipedriveOAuthToken> {
    if (!token.refresh_token) return token;
    const url = `${PIPEDRIVE_OAUTH_BASE_URL.replace(/\/$/, '')}/oauth/token`;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      client_id: PIPEDRIVE_CLIENT_ID,
      client_secret: PIPEDRIVE_CLIENT_SECRET,
    });
    const response = await this.http.post(url, body.toString(), {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const data = response.data as OAuthTokenResponse;
    return upsertToken({
      id: token.id,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? token.refresh_token,
      expires_at: computeExpiresAt(data.expires_in),
      api_domain: data.api_domain ?? token.api_domain ?? null,
      company_id: toNumber(data.company_id) ?? token.company_id ?? null,
      user_id: toNumber(data.user_id) ?? token.user_id ?? null,
      scope: data.scope ?? token.scope ?? null,
    });
  }

  async getAccessToken(options: { companyId?: number | null; apiDomain?: string | null } = {}): Promise<{ token: PipedriveOAuthToken; apiBase: string } | null> {
    const token = await pickToken(options);
    if (!token) return null;
    const refreshed = isTokenExpired(token) ? await this.refreshToken(token) : token;
    const apiBase = buildApiBase(refreshed.api_domain ?? options.apiDomain ?? null);
    return { token: refreshed, apiBase };
  }

  async registerChannel(options: {
    providerChannelId: string;
    name: string;
    providerType: string;
    avatarUrl?: string | null;
    templateSupport?: boolean;
    companyId?: number | null;
    apiDomain?: string | null;
  }): Promise<PipedriveChannelRecord> {
    const tokenInfo = await this.getAccessToken({ companyId: options.companyId ?? null, apiDomain: options.apiDomain ?? null });
    if (!tokenInfo) {
      throw new Error('pipedrive_token_missing');
    }
    const payload: RegisterChannelPayload = {
      name: options.name,
      provider_channel_id: options.providerChannelId,
      provider_type: options.providerType,
      avatar_url: options.avatarUrl ?? null,
      template_support: options.templateSupport ?? PIPEDRIVE_TEMPLATE_SUPPORT,
    };
    const response = await this.http.post(`${tokenInfo.apiBase}/channels`, payload, {
      headers: { Authorization: `Bearer ${tokenInfo.token.access_token}` },
    });
    const data = response.data?.data ?? response.data;
    const channelId = String(data?.id ?? data?.channel_id ?? '');
    if (!channelId) {
      throw new Error('pipedrive_channel_id_missing');
    }
    return upsertChannel({
      id: channelId,
      provider_channel_id: options.providerChannelId,
      name: options.name,
      provider_type: options.providerType,
      template_support: options.templateSupport ?? PIPEDRIVE_TEMPLATE_SUPPORT,
      avatar_url: options.avatarUrl ?? null,
      company_id: tokenInfo.token.company_id ?? null,
      api_domain: tokenInfo.token.api_domain ?? null,
    });
  }

  async receiveMessage(
    channel: PipedriveChannelRecord,
    payload: Omit<ReceiveMessagePayload, 'channel_id'>,
  ): Promise<void> {
    const tokenInfo = await this.getAccessToken({
      companyId: channel.company_id ?? null,
      apiDomain: channel.api_domain ?? null,
    });
    if (!tokenInfo) {
      throw new Error('pipedrive_token_missing');
    }
    const numericChannelId = Number(channel.id);
    const channelIdValue = Number.isFinite(numericChannelId) ? numericChannelId : channel.id;
    await this.http.post(
      `${tokenInfo.apiBase}/channels/messages/receive`,
      { ...payload, channel_id: channelIdValue },
      { headers: { Authorization: `Bearer ${tokenInfo.token.access_token}` } },
    );
  }

  async deleteChannel(channel: PipedriveChannelRecord): Promise<void> {
    const tokenInfo = await this.getAccessToken({
      companyId: channel.company_id ?? null,
      apiDomain: channel.api_domain ?? null,
    });
    if (!tokenInfo) {
      throw new Error('pipedrive_token_missing');
    }
    await this.http.delete(`${tokenInfo.apiBase}/channels/${channel.id}`, {
      headers: { Authorization: `Bearer ${tokenInfo.token.access_token}` },
    });
  }
}

export const pipedriveClient = new PipedriveClient();
