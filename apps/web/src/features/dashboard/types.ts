export type InstanceStatus = 'connected' | 'connecting' | 'disconnected' | 'qr_expired';

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
