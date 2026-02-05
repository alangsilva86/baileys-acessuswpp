import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Circle,
  Filter,
  Pause,
  Play,
  Search,
  X,
} from 'lucide-react';
import type { BrokerEvent } from '../types';
import { fetchJson, formatApiError } from '../../../lib/api';

type MessageMonitorDrawerProps = {
  open: boolean;
  apiKey: string;
  instanceId: string;
  instanceName: string;
  onClose: () => void;
};

type StreamState = 'idle' | 'connecting' | 'connected' | 'error';

type FilterState = {
  inbound: boolean;
  outbound: boolean;
  status: boolean;
  webhook: boolean;
  system: boolean;
};

const DEFAULT_FILTERS: FilterState = {
  inbound: true,
  outbound: true,
  status: true,
  webhook: true,
  system: false,
};

const FEED_MAX_ITEMS = 500;

function clampFeed(events: BrokerEvent[]): BrokerEvent[] {
  if (events.length <= FEED_MAX_ITEMS) return events;
  return events.slice(events.length - FEED_MAX_ITEMS);
}

function formatTime(value: number | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

function maskPhone(value: string | null | undefined): string {
  if (!value) return '—';
  const digits = String(value).replace(/\D+/g, '');
  if (digits.length <= 4) return '••••';
  return `+${digits.slice(0, 2)}••••••${digits.slice(-2)}`;
}

function maskText(value: string | null | undefined): string {
  if (!value) return '';
  const len = String(value).length;
  if (!len) return '';
  if (len <= 8) return '••••••••';
  return '••••••••••••••••';
}

function extractStructuredMessage(event: BrokerEvent): {
  messageId: string | null;
  chatId: string | null;
  type: string | null;
  text: string | null;
  phone: string | null;
  displayName: string | null;
  timestampIso: string | null;
} | null {
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') return null;
  const message = payload.message as Record<string, unknown> | null;
  const contact = payload.contact as Record<string, unknown> | null;
  const metadata = payload.metadata as Record<string, unknown> | null;
  if (!message || typeof message !== 'object') return null;

  const messageId = typeof message.id === 'string' ? message.id : null;
  const chatId = typeof message.chatId === 'string' ? message.chatId : null;
  const type = typeof message.type === 'string' ? message.type : null;
  const text = typeof message.text === 'string' ? message.text : null;

  const phone = contact && typeof contact.phone === 'string' ? contact.phone : null;
  const displayName = contact && typeof contact.displayName === 'string' ? contact.displayName : null;
  const timestampIso = metadata && typeof metadata.timestamp === 'string' ? metadata.timestamp : null;

  return { messageId, chatId, type, text, phone, displayName, timestampIso };
}

function extractWebhookDelivery(event: BrokerEvent): {
  eventId: string | null;
  state: string | null;
  status: number | null;
  attempt: number | null;
  errorMessage: string | null;
} | null {
  if (event.type !== 'WEBHOOK_DELIVERY') return null;
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload) return null;
  const eventId = typeof payload.eventId === 'string' ? payload.eventId : null;
  const state = typeof payload.state === 'string' ? payload.state : null;
  const attempt = typeof payload.attempt === 'number' ? payload.attempt : null;
  const status = typeof payload.status === 'number' ? payload.status : null;
  const rawError = payload.error as Record<string, unknown> | null;
  const errorMessage = rawError && typeof rawError.message === 'string' ? rawError.message : null;
  return { eventId, state, status, attempt, errorMessage };
}

function extractMessageStatus(event: BrokerEvent): { messageId: string | null; status: number | null; chatId: string | null } | null {
  if (event.type !== 'MESSAGE_STATUS') return null;
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload) return null;
  const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
  const status = typeof payload.status === 'number' ? payload.status : null;
  const chatId = typeof payload.chatId === 'string' ? payload.chatId : null;
  return { messageId, status, chatId };
}

function statusLabel(code: number | null | undefined): string {
  if (code == null) return '—';
  if (code === 0) return 'Falhou';
  if (code === 1) return 'Pendente';
  if (code === 2) return 'ServerAck';
  if (code === 3) return 'Entregue';
  if (code === 4) return 'Lida';
  if (code === 5) return 'Reproduzida';
  return `Status ${code}`;
}

function statusTone(code: number | null | undefined): string {
  if (code == null) return 'bg-slate-100 text-slate-700';
  if (code === 0) return 'bg-rose-100 text-rose-700';
  if (code === 4 || code === 5) return 'bg-emerald-50 text-emerald-700';
  if (code === 3) return 'bg-indigo-50 text-indigo-700';
  if (code === 2) return 'bg-slate-100 text-slate-700';
  return 'bg-amber-50 text-amber-700';
}

function webhookTone(state: string | null | undefined): string {
  if (!state) return 'bg-slate-100 text-slate-700';
  if (state === 'failed') return 'bg-rose-100 text-rose-700';
  if (state === 'retry') return 'bg-amber-100 text-amber-700';
  if (state === 'success') return 'bg-emerald-50 text-emerald-700';
  return 'bg-slate-100 text-slate-700';
}

export default function MessageMonitorDrawer({
  open,
  apiKey,
  instanceId,
  instanceName,
  onClose,
}: MessageMonitorDrawerProps) {
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [events, setEvents] = useState<BrokerEvent[]>([]);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [query, setQuery] = useState('');
  const [blur, setBlur] = useState(false);
  const [followTail, setFollowTail] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusByMessageId, setStatusByMessageId] = useState<Record<string, number>>({});
  const [webhookByEventId, setWebhookByEventId] = useState<Record<string, { state: string | null; status: number | null; attempt: number | null; errorMessage: string | null }>>({});
  const [backlogError, setBacklogError] = useState<string | null>(null);
  const [backlogLoading, setBacklogLoading] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());

  const closeAndReset = useCallback(() => {
    onClose();
  }, [onClose]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    setFollowTail(true);
    setUnseen(0);
  }, []);

  useEffect(() => {
    if (!open) {
      setStreamState('idle');
      return;
    }
    setStreamState('connecting');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setSelectedId(null);
    setEvents([]);
    setStatusByMessageId({});
    setWebhookByEventId({});
    seenEventIdsRef.current = new Set();
    setUnseen(0);
    setFollowTail(true);
  }, [instanceId, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAndReset();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeAndReset, open]);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!apiKey.trim()) {
      setBacklogError('Informe a API key para carregar o monitor.');
      return;
    }
    setBacklogLoading(true);
    setBacklogError(null);
    (async () => {
      try {
        const payload = await fetchJson<{ events: BrokerEvent[] }>(
          `/instances/${encodeURIComponent(instanceId)}/logs?limit=200`,
          apiKey,
        );
        const incoming = Array.isArray(payload?.events) ? [...payload.events].reverse() : [];
        const deduped: BrokerEvent[] = [];
        const seen = new Set<string>();
        for (const event of incoming) {
          if (!event?.id) continue;
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          deduped.push(event);
        }
        seenEventIdsRef.current = new Set(seen);
        setEvents(clampFeed(deduped));
      } catch (err) {
        setBacklogError(formatApiError(err));
      } finally {
        setBacklogLoading(false);
      }
    })();
  }, [apiKey, instanceId, open]);

  useEffect(() => {
    if (!open) return undefined;
    if (!apiKey.trim()) return undefined;

    const params = new URLSearchParams({
      apiKey: apiKey.trim(),
      iid: instanceId,
    });
    const source = new EventSource(`/stream?${params.toString()}`);

    const onBrokerEvent = (evt: MessageEvent) => {
      try {
        const parsed = JSON.parse(evt.data) as BrokerEvent;
        if (!parsed?.id) return;
        if (seenEventIdsRef.current.has(parsed.id)) return;
        seenEventIdsRef.current.add(parsed.id);

        const status = extractMessageStatus(parsed);
        if (status?.messageId && typeof status.status === 'number') {
          setStatusByMessageId((current) => ({
            ...current,
            [status.messageId as string]: status.status as number,
          }));
        }

        const webhook = extractWebhookDelivery(parsed);
        if (webhook?.eventId) {
          setWebhookByEventId((current) => ({
            ...current,
            [webhook.eventId as string]: {
              state: webhook.state ?? null,
              status: webhook.status ?? null,
              attempt: webhook.attempt ?? null,
              errorMessage: webhook.errorMessage ?? null,
            },
          }));
        }

        setEvents((current) => {
          const next = clampFeed([...current, parsed]);
          return next;
        });

        if (followTail) {
          window.setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 0);
        } else {
          setUnseen((count) => count + 1);
        }
      } catch {
        // ignore parse errors
      }
    };

    source.addEventListener('broker:event', onBrokerEvent);
    source.onopen = () => setStreamState('connected');
    source.onerror = () => setStreamState('error');

    return () => {
      source.removeEventListener('broker:event', onBrokerEvent);
      source.close();
    };
  }, [apiKey, followTail, instanceId, open]);

  useEffect(() => {
    if (!open) return;
    if (!followTail) return;
    window.setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 0);
  }, [events.length, followTail, open]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 80;
    if (nearBottom && !followTail) {
      setFollowTail(true);
      setUnseen(0);
    } else if (!nearBottom && followTail) {
      setFollowTail(false);
    }
  }, [followTail]);

  const filteredEvents = useMemo(() => {
    const q = query.trim().toLowerCase();
    const selected = new Set<string>();
    const items = events.filter((event) => {
      if (!event) return false;
      const isInbound = event.type === 'MESSAGE_INBOUND';
      const isOutbound = event.type === 'MESSAGE_OUTBOUND';
      const isStatus = event.type === 'MESSAGE_STATUS';
      const isWebhook = event.type === 'WEBHOOK_DELIVERY';
      const isSystem = !isInbound && !isOutbound && !isStatus && !isWebhook;

      if (isInbound && !filters.inbound) return false;
      if (isOutbound && !filters.outbound) return false;
      if (isStatus && !filters.status) return false;
      if (isWebhook && !filters.webhook) return false;
      if (isSystem && !filters.system) return false;

      if (!q) return true;

      const haystack = safeJson({
        id: event.id,
        type: event.type,
        direction: event.direction,
        payload: event.payload,
      }).toLowerCase();
      return haystack.includes(q);
    });

    // Dedup by id just in case.
    const result: BrokerEvent[] = [];
    for (const item of items) {
      if (!item?.id) continue;
      if (selected.has(item.id)) continue;
      selected.add(item.id);
      result.push(item);
    }
    return result;
  }, [events, filters, query]);

  const selectedEvent = useMemo(() => {
    if (!selectedId) return null;
    return events.find((event) => event.id === selectedId) ?? null;
  }, [events, selectedId]);

  const streamBadge = useMemo<{ label: string; tone: string; icon: ReactNode }>(() => {
    if (streamState === 'connected') {
      return { label: 'Ao vivo', tone: 'bg-emerald-50 text-emerald-700', icon: <Circle className="h-2 w-2 fill-emerald-600 text-emerald-600" aria-hidden="true" /> };
    }
    if (streamState === 'connecting') {
      return { label: 'Conectando...', tone: 'bg-amber-50 text-amber-700', icon: <Circle className="h-2 w-2 fill-amber-600 text-amber-600" aria-hidden="true" /> };
    }
    if (streamState === 'error') {
      return { label: 'Falha no stream', tone: 'bg-rose-100 text-rose-700', icon: <Circle className="h-2 w-2 fill-rose-600 text-rose-600" aria-hidden="true" /> };
    }
    return { label: 'Idle', tone: 'bg-slate-100 text-slate-700', icon: <Circle className="h-2 w-2 fill-slate-500 text-slate-500" aria-hidden="true" /> };
  }, [streamState]);

  const toggleFilter = (key: keyof FilterState) => {
    setFilters((current) => ({ ...current, [key]: !current[key] }));
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={closeAndReset} aria-hidden="true" />

      <div className="relative ml-auto flex h-full w-full max-w-[680px] flex-col border-l border-slate-200 bg-white shadow-2xl">
        <header className="sticky top-0 z-10 border-b border-slate-100 bg-white/90 px-5 py-4 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Monitor de mensagens</p>
              <p className="truncate text-lg font-semibold text-slate-900">{instanceName}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium ${streamBadge.tone}`}>
                  {streamBadge.icon}
                  {streamBadge.label}
                </span>
                {backlogLoading ? (
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-600">
                    Carregando histórico...
                  </span>
                ) : null}
                {backlogError ? (
                  <span className="rounded-full bg-rose-100 px-3 py-1 text-[11px] font-medium text-rose-700">
                    {backlogError}
                  </span>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              onClick={closeAndReset}
              className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50"
              aria-label="Fechar monitor"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar (número, texto, messageId, webhook...)"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
              />
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setBlur((current) => !current)}
                className={`rounded-lg px-3 py-2 text-xs font-medium ${
                  blur ? 'bg-slate-900 text-white' : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {blur ? 'Blur ON' : 'Blur OFF'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEvents([]);
                  setSelectedId(null);
                  setStatusByMessageId({});
                  setWebhookByEventId({});
                  seenEventIdsRef.current = new Set();
                  setUnseen(0);
                }}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
              >
                Limpar
              </button>
              <button
                type="button"
                onClick={() => setFollowTail((current) => !current)}
                className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium ${
                  followTail ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
                title={followTail ? 'Seguindo em tempo real' : 'Pausado (não auto-scroll)'}
              >
                {followTail ? <Play className="h-4 w-4" aria-hidden="true" /> : <Pause className="h-4 w-4" aria-hidden="true" />}
                Ao vivo
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-700">
              <Filter className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
              Filtros
            </span>
            <FilterChip active={filters.inbound} onClick={() => toggleFilter('inbound')}>Entrando</FilterChip>
            <FilterChip active={filters.outbound} onClick={() => toggleFilter('outbound')}>Saindo</FilterChip>
            <FilterChip active={filters.status} onClick={() => toggleFilter('status')}>Status</FilterChip>
            <FilterChip active={filters.webhook} onClick={() => toggleFilter('webhook')}>Webhook</FilterChip>
            <FilterChip active={filters.system} onClick={() => toggleFilter('system')}>Sistema</FilterChip>
          </div>
        </header>

        <div className="relative flex-1 overflow-hidden">
          {!followTail && unseen > 0 ? (
            <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2">
              <button
                type="button"
                onClick={scrollToBottom}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-medium text-white shadow-lg hover:bg-slate-800"
              >
                {unseen} nova(s) • Ir ao vivo
              </button>
            </div>
          ) : null}

          <div
            ref={listRef}
            onScroll={handleScroll}
            className="h-full overflow-y-auto px-5 py-5"
          >
            {filteredEvents.length ? (
              <div className="space-y-2">
                {filteredEvents.map((event) => (
                  <FeedRow
                    key={event.id}
                    event={event}
                    blur={blur}
                    selected={event.id === selectedId}
                    statusByMessageId={statusByMessageId}
                    webhookByEventId={webhookByEventId}
                    onSelect={setSelectedId}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
                Nenhum evento para exibir com os filtros atuais.
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </div>

        <footer className="border-t border-slate-100 bg-white px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[11px] text-slate-500">
              Itens em memória: <span className="font-semibold text-slate-700">{events.length}</span> (máx {FEED_MAX_ITEMS})
            </div>
            {selectedEvent ? (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(safeJson(selectedEvent));
                  } catch {
                    // ignore
                  }
                }}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
              >
                Copiar JSON selecionado
              </button>
            ) : (
              <div className="text-[11px] text-slate-400">Selecione um item para ver detalhes.</div>
            )}
          </div>
          {selectedEvent ? (
            <details className="mt-3 rounded-xl border border-slate-100 bg-slate-50 p-3">
              <summary className="cursor-pointer text-xs font-semibold text-slate-700">Detalhes</summary>
              <pre className="mt-3 max-h-56 overflow-auto rounded-lg bg-white p-3 text-[11px] text-slate-700">
                {safeJson(selectedEvent)}
              </pre>
            </details>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

function FilterChip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-[11px] font-medium ${
        active ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
      }`}
    >
      {children}
    </button>
  );
}

function FeedRow({
  event,
  blur,
  selected,
  statusByMessageId,
  webhookByEventId,
  onSelect,
}: {
  event: BrokerEvent;
  blur: boolean;
  selected: boolean;
  statusByMessageId: Record<string, number>;
  webhookByEventId: Record<string, { state: string | null; status: number | null; attempt: number | null; errorMessage: string | null }>;
  onSelect: (id: string) => void;
}) {
  const message = extractStructuredMessage(event);
  const webhook = extractWebhookDelivery(event);
  const msgStatus = extractMessageStatus(event);
  const isInbound = event.type === 'MESSAGE_INBOUND';
  const isOutbound = event.type === 'MESSAGE_OUTBOUND';

  const baseTone =
    selected
      ? 'border-slate-900 bg-slate-900 text-white'
      : isInbound
      ? 'border-indigo-100 bg-indigo-50/40 text-slate-900'
      : isOutbound
      ? 'border-emerald-100 bg-emerald-50/40 text-slate-900'
      : event.type === 'WEBHOOK_DELIVERY'
      ? 'border-slate-100 bg-slate-50 text-slate-900'
      : 'border-slate-100 bg-white text-slate-900';

  const icon = isInbound ? (
    <ArrowDownLeft className={`h-4 w-4 ${selected ? 'text-white' : 'text-indigo-600'}`} aria-hidden="true" />
  ) : isOutbound ? (
    <ArrowUpRight className={`h-4 w-4 ${selected ? 'text-white' : 'text-emerald-600'}`} aria-hidden="true" />
  ) : (
    <Circle className={`h-3 w-3 ${selected ? 'fill-white text-white' : 'fill-slate-400 text-slate-400'}`} aria-hidden="true" />
  );

  let title = event.type;
  let subtitle: string | null = null;
  let metaRight: ReactNode = null;

  if (message) {
    const who = message.displayName || message.phone || message.chatId || '—';
    title = blur ? maskPhone(message.phone ?? who) : who;
    subtitle = [
      message.type ?? null,
      message.text ? (blur ? maskText(message.text) : message.text) : null,
    ]
      .filter(Boolean)
      .join(' • ') || null;

    const statusCode = message.messageId ? statusByMessageId[message.messageId] : undefined;
    const webhookState = webhookByEventId[event.id]?.state ?? null;
    metaRight = (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {typeof statusCode === 'number' ? (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${selected ? 'bg-white/15 text-white' : statusTone(statusCode)}`}>
            {statusLabel(statusCode)}
          </span>
        ) : null}
        {webhookState ? (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${selected ? 'bg-white/15 text-white' : webhookTone(webhookState)}`}>
            wh:{webhookState}
          </span>
        ) : null}
        <span className={`text-[11px] ${selected ? 'text-white/70' : 'text-slate-400'}`}>{formatTime(event.createdAt)}</span>
      </div>
    );
  } else if (msgStatus?.messageId) {
    title = `Status WhatsApp`;
    const statusCode = msgStatus.status;
    subtitle = `mid ${msgStatus.messageId.slice(0, 10)}… • ${statusLabel(statusCode)}`;
    metaRight = (
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${selected ? 'bg-white/15 text-white' : statusTone(statusCode)}`}>
          {statusLabel(statusCode)}
        </span>
        <span className={`text-[11px] ${selected ? 'text-white/70' : 'text-slate-400'}`}>{formatTime(event.createdAt)}</span>
      </div>
    );
  } else if (webhook) {
    title = 'Webhook';
    subtitle = [
      webhook.state ? `state:${webhook.state}` : null,
      webhook.status != null ? `HTTP ${webhook.status}` : null,
      webhook.errorMessage ? webhook.errorMessage : null,
    ]
      .filter(Boolean)
      .join(' • ') || null;
    metaRight = (
      <div className="flex items-center gap-2">
        {webhook.state ? (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${selected ? 'bg-white/15 text-white' : webhookTone(webhook.state)}`}>
            {webhook.state}
          </span>
        ) : null}
        <span className={`text-[11px] ${selected ? 'text-white/70' : 'text-slate-400'}`}>{formatTime(event.createdAt)}</span>
      </div>
    );
  } else {
    title = event.type;
    subtitle = null;
    metaRight = <span className={`text-[11px] ${selected ? 'text-white/70' : 'text-slate-400'}`}>{formatTime(event.createdAt)}</span>;
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(event.id)}
      className={`w-full rounded-xl border p-3 text-left shadow-sm transition ${baseTone}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-xl bg-white/70">
            {icon}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{title}</p>
            {subtitle ? (
              <p className={`mt-1 line-clamp-2 text-xs ${selected ? 'text-white/80' : 'text-slate-600'}`}>{subtitle}</p>
            ) : null}
          </div>
        </div>
        {metaRight}
      </div>
    </button>
  );
}
