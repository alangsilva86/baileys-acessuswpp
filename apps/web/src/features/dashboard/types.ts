export type InstanceStatus = 'connected' | 'connecting' | 'disconnected' | 'qr_expired';

export type NetworkStatus = 'unknown' | 'ok' | 'blocked' | 'failed';

export type AggregatedStatusCounts = {
  pending: number;
  serverAck: number;
  delivered: number;
  read: number;
  played: number;
  failed: number;
};

export type InstanceMetricCounters = {
  sent: number;
  byType: Record<string, number>;
  statusCounts: Record<string, number>;
  statusAggregated: AggregatedStatusCounts;
  inFlight: number;
};

export type InstanceMetricDelivery = AggregatedStatusCounts & {
  inFlight: number;
};

export type InstanceMetricRate = {
  limit: number;
  windowMs: number;
  inWindow: number;
  usage: number;
};

export type MetricsRangeSummary = {
  points: number;
  durationMs: number;
  deltas: {
    sent: number;
    delivered: number;
    read: number;
    played: number;
    failed: number;
  };
  latest: AggregatedStatusCounts & { inFlight: number };
  averages: {
    rateInWindow: number;
  };
};

export type InstanceMetricsPayload = {
  counters: InstanceMetricCounters;
  delivery: InstanceMetricDelivery;
  rate?: InstanceMetricRate;
  range?: {
    requested: { from: number | null; to: number | null };
    effective: { from: number | null; to: number | null; points: number };
    summary: MetricsRangeSummary;
  };
};

export type InstanceRiskConfig = {
  threshold: number;
  interleaveEvery: number;
  safeContacts: string[];
};

export type InstanceRiskRuntime = {
  ratio: number;
  unknown: number;
  known: number;
  responses: number;
  paused: boolean;
};

export type InstanceRiskSnapshot = {
  config: InstanceRiskConfig;
  runtime: InstanceRiskRuntime;
};

export type InstanceNetworkSnapshot = {
  status: NetworkStatus;
  proxyUrl: string | null;
  ip: string | null;
  asn: string | null;
  isp: string | null;
  latencyMs: number | null;
  blockReason: string | null;
  lastCheckAt: number | null;
  validatedAt: number | null;
};

export type SendQueueMetrics = {
  enabled: boolean;
  waiting?: number;
  active?: number;
  delayed?: number;
  failed?: number;
  completed?: number;
  etaSeconds?: number | null;
};

export type SendQueueJobSummary = {
  id: string;
  iid: string;
  type: string;
  jid: string;
  to: string | null;
  attemptsMade: number;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  failedReason: string | null;
};

export type SendQueueFailedJobsPayload = {
  enabled: boolean;
  jobs: SendQueueJobSummary[];
};

export type BrokerEventDirection = 'inbound' | 'outbound' | 'system';

export type BrokerEventDeliveryState = {
  state: 'pending' | 'retry' | 'success' | 'failed';
  attempts: number;
  lastAttemptAt: number | null;
  lastStatus?: number | null;
  lastError?:
    | {
        message: string;
        status?: number;
        statusText?: string;
        responseBody?: string;
      }
    | null;
};

export type BrokerEvent = {
  id: string;
  sequence: number;
  instanceId: string;
  direction: BrokerEventDirection;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
  acknowledged: boolean;
  delivery?: BrokerEventDeliveryState | null;
};

export type InstanceLogsPayload = {
  events: BrokerEvent[];
};

export type HealthSnapshot = {
  network: string;
  risk: string;
  queue: string;
};

export type MetricTone = 'neutral' | 'positive' | 'warning' | 'danger';

export type MetricDatum = {
  key: string;
  label: string;
  value: string;
  helper?: string;
  tone?: MetricTone;
};

export type DashboardInstance = {
  id: string;
  name: string;
  status: InstanceStatus;
  updatedAt?: string;
  qrUrl?: string;
  note?: string;
  userJid?: string | null;
  userPhone?: string | null;
  risk?: InstanceRiskSnapshot | null;
  network?: InstanceNetworkSnapshot | null;
  queueEnabled?: boolean;
  health: HealthSnapshot;
  metrics?: MetricDatum[];
};

export type InstanceSummary = Pick<DashboardInstance, 'id' | 'name' | 'status' | 'updatedAt'>;

export type InstanceStats = {
  total: number;
  connected: number;
  issues: number;
  connecting: number;
};
