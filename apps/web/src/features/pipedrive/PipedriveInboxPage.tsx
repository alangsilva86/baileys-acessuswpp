import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchUiJson, formatUiError } from './api';

type BootstrapInstance = {
  id: string;
  name: string;
  connected: boolean;
  connectionState: string;
  linked_company_id: number | null;
};

type BootstrapPayload = {
  enabled: boolean;
  companyId: number;
  userId: number;
  apiDomain: string | null;
  defaultInstanceId: string | null;
  allowedInstanceIds: string[];
  instances: BootstrapInstance[];
};

type UiResponse<T> = { success: true; data: T };

type ConversationSummary = {
  key: string;
  person_id: number | null;
  deal_id: number | null;
  last_message_at_iso: string | null;
  last_direction: 'inbound' | 'outbound' | null;
  last_preview: string | null;
  unread_count: number;
};

type ConversationsPage = {
  items: ConversationSummary[];
  nextCursor: string | null;
};

type UiMessage = {
  id: string;
  ts_ms: number;
  created_at_iso: string;
  direction: 'inbound' | 'outbound';
  text: string;
  instance_id?: string | null;
};

type MessagesPage = {
  items: UiMessage[];
  nextBeforeTsMs: number | null;
};

const TOKEN_PARAM_CANDIDATES = ['token', 'jwt', 'pd_token', 'pdToken', 'auth_token', 'authToken', 'userToken'];

function readFirstParam(params: URLSearchParams, keys: string[]): string {
  const lower = new Map<string, string>();
  for (const [key, value] of params.entries()) {
    lower.set(key.toLowerCase(), value);
  }
  for (const key of keys) {
    const value = lower.get(key.toLowerCase());
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function parseToken(): string {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  const tokenFromQuery = readFirstParam(params, TOKEN_PARAM_CANDIDATES);
  if (tokenFromQuery) return tokenFromQuery;

  const hash = window.location.hash?.replace(/^#/, '') ?? '';
  if (hash) {
    const hashParams = new URLSearchParams(hash);
    const tokenFromHash = readFirstParam(hashParams, TOKEN_PARAM_CANDIDATES);
    if (tokenFromHash) return tokenFromHash;
  }

  return '';
}

function formatTs(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export default function PipedriveInboxPage() {
  const token = useMemo(() => parseToken(), []);
  const queryKeys = useMemo(() => {
    if (typeof window === 'undefined') return [];
    const params = new URLSearchParams(window.location.search);
    return Array.from(new Set(Array.from(params.keys()).map((key) => key.trim()).filter(Boolean))).sort();
  }, []);
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(false);

  const [defaultInstanceId, setDefaultInstanceId] = useState<string>('');
  const [isSavingInstance, setIsSavingInstance] = useState(false);

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [conversationsError, setConversationsError] = useState<string | null>(null);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);

  const [composerText, setComposerText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const refreshBootstrap = useCallback(async () => {
    if (!token) {
      setBootstrapError('Token ausente na URL do painel do Pipedrive.');
      setBootstrap(null);
      return;
    }
    setIsBootstrapping(true);
    setBootstrapError(null);
    try {
      const payload = await fetchUiJson<UiResponse<BootstrapPayload>>('/pipedrive/ui/bootstrap', token);
      setBootstrap(payload.data);
      setDefaultInstanceId(payload.data.defaultInstanceId ?? '');
    } catch (err) {
      setBootstrapError(formatUiError(err));
      setBootstrap(null);
    } finally {
      setIsBootstrapping(false);
    }
  }, [token]);

  const refreshConversations = useCallback(async () => {
    if (!token) return;
    setIsLoadingConversations(true);
    setConversationsError(null);
    try {
      const payload = await fetchUiJson<UiResponse<ConversationsPage>>('/pipedrive/ui/conversations?limit=80', token);
      setConversations(payload.data.items);
      if (!selectedKey && payload.data.items.length) {
        setSelectedKey(payload.data.items[0].key);
      }
    } catch (err) {
      setConversationsError(formatUiError(err));
      setConversations([]);
    } finally {
      setIsLoadingConversations(false);
    }
  }, [selectedKey, token]);

  const refreshMessages = useCallback(async (key: string) => {
    if (!token) return;
    setIsLoadingMessages(true);
    setMessagesError(null);
    try {
      const payload = await fetchUiJson<UiResponse<MessagesPage>>(
        `/pipedrive/ui/conversations/${encodeURIComponent(key)}/messages?limit=200`,
        token,
      );
      setMessages(payload.data.items);
    } catch (err) {
      setMessagesError(formatUiError(err));
      setMessages([]);
    } finally {
      setIsLoadingMessages(false);
    }
  }, [token]);

  useEffect(() => {
    void refreshBootstrap();
  }, [refreshBootstrap]);

  useEffect(() => {
    if (!bootstrap) return;
    void refreshConversations();
  }, [bootstrap, refreshConversations]);

  useEffect(() => {
    if (!selectedKey) return;
    void refreshMessages(selectedKey);
  }, [refreshMessages, selectedKey]);

  const handleSaveInstance = useCallback(async () => {
    if (!token || isSavingInstance) return;
    setIsSavingInstance(true);
    try {
      await fetchUiJson<UiResponse<any>>('/pipedrive/ui/settings/default-instance', token, {
        method: 'POST',
        body: JSON.stringify({ instanceId: defaultInstanceId }),
      });
      await refreshBootstrap();
      await refreshConversations();
    } catch (err) {
      setBootstrapError(formatUiError(err));
    } finally {
      setIsSavingInstance(false);
    }
  }, [defaultInstanceId, isSavingInstance, refreshBootstrap, refreshConversations, token]);

  const selectedConversation = useMemo(
    () => conversations.find((conv) => conv.key === selectedKey) ?? null,
    [conversations, selectedKey],
  );

  const pipedrivePersonLink = useMemo(() => {
    if (!bootstrap?.apiDomain || !selectedConversation?.person_id) return null;
    return `${bootstrap.apiDomain.replace(/\/$/, '')}/person/${selectedConversation.person_id}`;
  }, [bootstrap?.apiDomain, selectedConversation?.person_id]);

  const handleSend = useCallback(async () => {
    if (!token || !selectedKey || isSending) return;
    const text = composerText.trim();
    if (!text) return;
    setIsSending(true);
    setSendError(null);
    try {
      const payload = await fetchUiJson<UiResponse<{ id: string }>>(
        `/pipedrive/ui/conversations/${encodeURIComponent(selectedKey)}/messages`,
        token,
        { method: 'POST', body: JSON.stringify({ text }) },
      );
      setComposerText('');
      setMessages((prev) => [
        ...prev,
        {
          id: payload.data.id,
          ts_ms: Date.now(),
          created_at_iso: new Date().toISOString(),
          direction: 'outbound',
          text,
          instance_id: bootstrap?.defaultInstanceId ?? null,
        },
      ]);
      await refreshConversations();
    } catch (err) {
      setSendError(formatUiError(err));
    } finally {
      setIsSending(false);
    }
  }, [bootstrap?.defaultInstanceId, composerText, isSending, refreshConversations, selectedKey, token]);

  if (bootstrapError) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <div className="mx-auto max-w-3xl rounded-2xl border border-rose-100 bg-white p-6 text-sm text-rose-700 shadow-sm">
          <p className="font-semibold">Pipedrive Inbox</p>
          <p className="mt-2">{bootstrapError}</p>
          {!token ? (
            <div className="mt-3 space-y-2 text-[11px] text-slate-600">
              <p>
                Isso normalmente acontece quando o Pipedrive não está enviando o token na URL do painel. Abra dentro do Pipedrive e confirme que o link do painel contém
                <span className="font-mono"> token=</span> (ou <span className="font-mono">jwt=</span>).
              </p>
              {queryKeys.length ? (
                <p className="break-words">
                  Parâmetros recebidos: <span className="font-mono">{queryKeys.join(', ')}</span>
                </p>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => void refreshBootstrap()}
            className="mt-4 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
          >
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }

  if (isBootstrapping || !bootstrap) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <div className="mx-auto max-w-3xl rounded-2xl border border-slate-100 bg-white p-6 text-sm text-slate-600 shadow-sm">
          {isBootstrapping ? 'Carregando…' : 'Aguardando configuração…'}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4">
      <div className="mx-auto max-w-6xl space-y-4">
        <header className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Pipedrive</p>
              <h1 className="text-lg font-semibold text-slate-900">Inbox embutido</h1>
              <p className="mt-1 text-xs text-slate-500">Company {bootstrap.companyId} • User {bootstrap.userId}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={defaultInstanceId}
                onChange={(e) => setDefaultInstanceId(e.target.value)}
                className="w-56 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm"
              >
                <option value="">Desativado</option>
                {bootstrap.instances.map((inst) => (
                  <option key={inst.id} value={inst.id} disabled={inst.linked_company_id && inst.linked_company_id !== bootstrap.companyId}>
                    {inst.name} {inst.connected ? '' : '(offline)'}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void handleSaveInstance()}
                disabled={isSavingInstance}
                className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {isSavingInstance ? 'Salvando…' : 'Salvar'}
              </button>
              <button
                type="button"
                onClick={() => void refreshConversations()}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
              >
                Atualizar
              </button>
            </div>
          </div>
        </header>

        <main className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <section className="rounded-2xl border border-slate-100 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-4 py-3">
              <p className="text-xs font-semibold text-slate-700">Conversas</p>
              {conversationsError ? <p className="mt-1 text-xs text-rose-600">{conversationsError}</p> : null}
            </div>
            <div className="max-h-[70vh] overflow-auto p-2">
              {isLoadingConversations ? (
                <p className="px-2 py-3 text-xs text-slate-500">Carregando…</p>
              ) : conversations.length ? (
                <div className="space-y-1">
                  {conversations.map((conv) => {
                    const active = conv.key === selectedKey;
                    return (
                      <button
                        key={conv.key}
                        type="button"
                        onClick={() => setSelectedKey(conv.key)}
                        className={`w-full rounded-xl px-3 py-2 text-left text-xs ${active ? 'bg-emerald-50 border border-emerald-100' : 'hover:bg-slate-50 border border-transparent'}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[11px] text-slate-700">{conv.key}</span>
                          <span className="text-[10px] text-slate-400">{formatTs(conv.last_message_at_iso)}</span>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2">
                          <span className="truncate text-slate-600">{conv.last_preview ?? '—'}</span>
                          {conv.unread_count ? (
                            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700">
                              {conv.unread_count}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="px-2 py-3 text-xs text-slate-500">Sem conversas ainda.</p>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-100 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <div>
                <p className="text-xs font-semibold text-slate-700">Mensagens</p>
                <p className="mt-1 font-mono text-[11px] text-slate-500">{selectedKey ?? '—'}</p>
              </div>
              <div className="flex items-center gap-2">
                {pipedrivePersonLink ? (
                  <a
                    href={pipedrivePersonLink}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
                  >
                    Ver no Pipedrive
                  </a>
                ) : null}
                <button
                  type="button"
                  onClick={() => (selectedKey ? void refreshMessages(selectedKey) : undefined)}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
                >
                  Recarregar
                </button>
              </div>
            </div>

            <div className="max-h-[60vh] overflow-auto px-4 py-3">
              {messagesError ? <p className="mb-2 text-xs text-rose-600">{messagesError}</p> : null}
              {isLoadingMessages ? (
                <p className="text-xs text-slate-500">Carregando…</p>
              ) : messages.length ? (
                <div className="space-y-2">
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs ${msg.direction === 'outbound' ? 'ml-auto bg-emerald-600 text-white' : 'mr-auto bg-slate-100 text-slate-800'}`}
                    >
                      <div className="whitespace-pre-wrap break-words">{msg.text}</div>
                      <div className={`mt-1 text-[10px] ${msg.direction === 'outbound' ? 'text-emerald-100' : 'text-slate-500'}`}>
                        {formatTs(msg.created_at_iso)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-500">Selecione uma conversa.</p>
              )}
            </div>

            <div className="border-t border-slate-100 px-4 py-3">
              {sendError ? <p className="mb-2 text-xs text-rose-600">{sendError}</p> : null}
              <div className="flex items-end gap-2">
                <textarea
                  value={composerText}
                  onChange={(e) => setComposerText(e.target.value)}
                  placeholder="Digite sua mensagem…"
                  rows={2}
                  className="flex-1 resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-200"
                />
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={!selectedKey || !composerText.trim() || isSending}
                  className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {isSending ? 'Enviando…' : 'Enviar'}
                </button>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
