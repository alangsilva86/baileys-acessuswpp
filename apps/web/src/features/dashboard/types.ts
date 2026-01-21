export type InstanceStatus = 'connected' | 'connecting' | 'disconnected' | 'qr_expired';

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
