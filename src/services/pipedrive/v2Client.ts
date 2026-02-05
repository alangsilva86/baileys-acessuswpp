import axios, { type AxiosInstance } from 'axios';
import pino from 'pino';
import { PIPEDRIVE_API_BASE_URL_V2 } from './config.js';
import { pipedriveClient } from './client.js';
import type { PipedriveOAuthToken } from './store.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const logger = pino({ level: process.env.LOG_LEVEL || 'info', base: { service: 'pipedrive-v2-client' } });

export type PipedriveV2SortDirection = 'asc' | 'desc';

export interface PipedriveV2PersonPhone {
  value: string;
  primary?: boolean;
  label?: string | null;
}

export interface PipedriveV2Person {
  id: number;
  name: string;
  phone?: PipedriveV2PersonPhone[];
  phones?: PipedriveV2PersonPhone[];
}

export interface PipedriveV2Activity {
  id: number;
  subject: string;
}

interface PipedriveV2Pagination {
  next_cursor?: string | null;
}

interface PipedriveV2AdditionalData {
  pagination?: PipedriveV2Pagination;
}

interface PipedriveV2Response<T> {
  data?: T;
  additional_data?: PipedriveV2AdditionalData;
}

function buildApiBase(apiDomain?: string | null): string {
  const configured = (PIPEDRIVE_API_BASE_URL_V2 || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  if (apiDomain) {
    const normalized = apiDomain.replace(/\/$/, '');
    if (normalized.endsWith('/api/v2')) return normalized;
    return `${normalized}/api/v2`;
  }
  return 'https://api.pipedrive.com/api/v2';
}

function getNextCursor(payload: unknown): string | null {
  const obj = payload as PipedriveV2Response<unknown> | null;
  const cursor = obj?.additional_data?.pagination?.next_cursor;
  return typeof cursor === 'string' && cursor.trim() ? cursor.trim() : null;
}

function normalizePerson(raw: any): PipedriveV2Person | null {
  const id = typeof raw?.id === 'number' ? raw.id : typeof raw?.id === 'string' ? Number(raw.id) : NaN;
  if (!Number.isFinite(id) || id <= 0) return null;
  const name = typeof raw?.name === 'string' ? raw.name : '';
  if (!name) return null;
  const phone = Array.isArray(raw?.phone) ? raw.phone : Array.isArray(raw?.phones) ? raw.phones : undefined;
  return { id, name, phone: Array.isArray(phone) ? phone : undefined };
}

function normalizeActivity(raw: any): PipedriveV2Activity | null {
  const id = typeof raw?.id === 'number' ? raw.id : typeof raw?.id === 'string' ? Number(raw.id) : NaN;
  if (!Number.isFinite(id) || id <= 0) return null;
  const subject = typeof raw?.subject === 'string' ? raw.subject : '';
  return { id, subject };
}

export class PipedriveV2Client {
  private readonly http: AxiosInstance;

  constructor(options: { httpClient?: AxiosInstance } = {}) {
    this.http = options.httpClient ?? axios.create({ timeout: DEFAULT_TIMEOUT_MS });
  }

  private async getToken(options: { companyId?: number | null; apiDomain?: string | null } = {}): Promise<PipedriveOAuthToken> {
    const tokenInfo = await pipedriveClient.getAccessToken({
      companyId: options.companyId ?? null,
      apiDomain: options.apiDomain ?? null,
    });
    if (!tokenInfo) throw new Error('pipedrive_token_missing');
    return tokenInfo.token;
  }

  async searchPersons(options: {
    term: string;
    fields?: string;
    exactMatch?: boolean;
    limit?: number;
    cursor?: string | null;
    sortBy?: string;
    sortDirection?: PipedriveV2SortDirection;
    companyId?: number | null;
    apiDomain?: string | null;
  }): Promise<{ items: PipedriveV2Person[]; nextCursor: string | null }> {
    const token = await this.getToken({ companyId: options.companyId ?? null, apiDomain: options.apiDomain ?? null });
    const apiBase = buildApiBase(token.api_domain ?? options.apiDomain ?? null);
    const query = new URLSearchParams();
    query.set('term', options.term);
    if (options.fields) query.set('fields', options.fields);
    if (typeof options.exactMatch === 'boolean') query.set('exact_match', options.exactMatch ? 'true' : 'false');
    if (typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0) {
      query.set('limit', String(Math.floor(options.limit)));
    }
    if (options.cursor) query.set('cursor', options.cursor);
    if (options.sortBy) query.set('sort_by', options.sortBy);
    if (options.sortDirection) query.set('sort_direction', options.sortDirection);

    const response = await this.http.get(`${apiBase}/persons/search?${query.toString()}`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });

    const payload = response.data as PipedriveV2Response<any> | null;
    const rawItems = Array.isArray(payload?.data) ? payload?.data : Array.isArray((payload as any)?.data?.items) ? (payload as any).data.items : [];
    const items = rawItems.map((item: any) => normalizePerson(item)).filter(Boolean) as PipedriveV2Person[];
    return { items, nextCursor: getNextCursor(payload) };
  }

  async findPersonByPhone(options: {
    phone: string;
    companyId?: number | null;
    apiDomain?: string | null;
  }): Promise<PipedriveV2Person | null> {
    const normalized = (options.phone || '').trim();
    if (!normalized) return null;
    const { items } = await this.searchPersons({
      term: normalized,
      fields: 'phone',
      exactMatch: true,
      limit: 10,
      sortBy: 'id',
      sortDirection: 'desc',
      companyId: options.companyId ?? null,
      apiDomain: options.apiDomain ?? null,
    });
    return items[0] ?? null;
  }

  async getPerson(options: { id: number; companyId?: number | null; apiDomain?: string | null }): Promise<PipedriveV2Person | null> {
    const token = await this.getToken({ companyId: options.companyId ?? null, apiDomain: options.apiDomain ?? null });
    const apiBase = buildApiBase(token.api_domain ?? options.apiDomain ?? null);
    const response = await this.http.get(`${apiBase}/persons/${options.id}`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const payload = response.data as PipedriveV2Response<any> | null;
    const personRaw = (payload as any)?.data ?? payload;
    return normalizePerson(personRaw);
  }

  async createPerson(options: {
    name: string;
    phone: string;
    companyId?: number | null;
    apiDomain?: string | null;
  }): Promise<PipedriveV2Person> {
    const token = await this.getToken({ companyId: options.companyId ?? null, apiDomain: options.apiDomain ?? null });
    const apiBase = buildApiBase(token.api_domain ?? options.apiDomain ?? null);

    const phone = options.phone.trim();
    const name = options.name.trim() || phone;

    const payloadCandidates: Record<string, unknown>[] = [
      { name, phone },
      { name, phones: [{ value: phone, primary: true }] },
      { name, phone: [{ value: phone, primary: true }] },
    ];

    let lastError: unknown = null;
    for (const payload of payloadCandidates) {
      try {
        const response = await this.http.post(`${apiBase}/persons`, payload, {
          headers: { Authorization: `Bearer ${token.access_token}` },
        });
        const data = response.data as PipedriveV2Response<any> | null;
        const personRaw = (data as any)?.data ?? data;
        const person = normalizePerson(personRaw);
        if (!person) throw new Error('pipedrive_v2_person_invalid');
        return person;
      } catch (err: any) {
        lastError = err;
        const status = err?.response?.status;
        if (status && status !== 400 && status !== 422) {
          break;
        }
        logger.warn({ err: err?.message ?? err, status }, 'v2.createPerson.payload_failed');
      }
    }
    throw lastError instanceof Error ? lastError : new Error('pipedrive_v2_create_person_failed');
  }

  async createActivity(options: {
    subject: string;
    type?: string | null;
    dueDate?: string | null;
    dueTime?: string | null;
    personId: number;
    dealId?: number | null;
    companyId?: number | null;
    apiDomain?: string | null;
  }): Promise<PipedriveV2Activity> {
    const token = await this.getToken({ companyId: options.companyId ?? null, apiDomain: options.apiDomain ?? null });
    const apiBase = buildApiBase(token.api_domain ?? options.apiDomain ?? null);

    const payload: Record<string, unknown> = {
      subject: options.subject,
      type: options.type ?? 'task',
      person_id: options.personId,
    };
    if (options.dueDate) payload.due_date = options.dueDate;
    if (options.dueTime) payload.due_time = options.dueTime;
    if (typeof options.dealId === 'number') payload.deal_id = options.dealId;

    const response = await this.http.post(`${apiBase}/activities`, payload, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });

    const data = response.data as PipedriveV2Response<any> | null;
    const activityRaw = (data as any)?.data ?? data;
    const activity = normalizeActivity(activityRaw);
    if (!activity) throw new Error('pipedrive_v2_activity_invalid');
    return activity;
  }
}

export const pipedriveV2Client = new PipedriveV2Client();
