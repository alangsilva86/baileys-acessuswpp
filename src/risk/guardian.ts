export interface RiskConfig {
  threshold: number;
  interleaveEvery: number;
  safeContacts: string[];
}

interface RiskState {
  knownContacts: Set<string>;
  unknownCount: number;
  knownCount: number;
  responses: number;
  paused: boolean;
  config: RiskConfig;
}

interface BeforeSendResult {
  allowed: boolean;
  reason?: string;
  ratio: number;
  isKnown: boolean;
  injectSafeJid?: string | null;
}

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_INTERLEAVE = 5;

function normalizeJid(value: string): string {
  return value?.trim().toLowerCase();
}

function toJid(phoneOrJid: string): string {
  const trimmed = phoneOrJid.trim();
  if (trimmed.includes('@')) return normalizeJid(trimmed);
  return normalizeJid(`${trimmed.replace(/\D+/g, '')}@s.whatsapp.net`);
}

function defaultConfig(): RiskConfig {
  return { threshold: DEFAULT_THRESHOLD, interleaveEvery: DEFAULT_INTERLEAVE, safeContacts: [] };
}

class RiskGuardian {
  private state = new Map<string, RiskState>();

  setConfig(instanceId: string, config: Partial<RiskConfig>): RiskConfig {
    const state = this.ensure(instanceId);
    const next: RiskConfig = {
      threshold: Number.isFinite(Number(config.threshold)) ? Number(config.threshold) : state.config.threshold,
      interleaveEvery:
        Number.isFinite(Number(config.interleaveEvery)) && Number(config.interleaveEvery) > 0
          ? Number(config.interleaveEvery)
          : state.config.interleaveEvery,
      safeContacts: Array.isArray(config.safeContacts)
        ? config.safeContacts
            .map((v) => (typeof v === 'string' ? v : ''))
            .filter(Boolean)
            .map(toJid)
        : state.config.safeContacts,
    };
    state.config = next;
    next.safeContacts.forEach((jid) => state.knownContacts.add(jid));
    return next;
  }

  getConfig(instanceId: string): RiskConfig {
    return { ...this.ensure(instanceId).config };
  }

  getState(instanceId: string): RiskState {
    return this.ensure(instanceId);
  }

  reset(instanceId: string): void {
    this.state.delete(instanceId);
  }

  registerInbound(instanceId: string, jid: string | null | undefined): void {
    if (!jid) return;
    const state = this.ensure(instanceId);
    const key = normalizeJid(jid);
    if (!key) return;
    state.knownContacts.add(key);
    state.responses += 1;
  }

  afterSend(instanceId: string, jid: string, isKnown: boolean): void {
    const state = this.ensure(instanceId);
    if (isKnown) state.knownCount += 1;
    else state.unknownCount += 1;
  }

  beforeSend(instanceId: string, jid: string | null | undefined): BeforeSendResult {
    const state = this.ensure(instanceId);
    const key = normalizeJid(jid ?? '');
    const isKnown = key ? state.knownContacts.has(key) : false;
    const total = Math.max(1, state.unknownCount + state.knownCount + state.responses);
    const currentRatio = state.unknownCount / total;

    // Always allow the very first message while we build baseline.
    if (state.unknownCount + state.knownCount + state.responses === 0) {
      return { allowed: true, ratio: 0, isKnown, injectSafeJid: null };
    }

    if (state.paused && currentRatio > state.config.threshold) {
      return { allowed: false, reason: 'risk_paused', ratio: currentRatio, isKnown };
    }

    if (!isKnown) {
      const projectedUnknown = state.unknownCount + 1;
      const projectedTotal = Math.max(1, projectedUnknown + state.knownCount + state.responses);
      const projectedRatio = projectedUnknown / projectedTotal;
      if (projectedRatio > state.config.threshold) {
        state.paused = true;
        return { allowed: false, reason: 'risk_threshold', ratio: projectedRatio, isKnown };
      }
    }

    let injectSafeJid: string | null = null;
    if (!isKnown && state.config.safeContacts.length && state.unknownCount > 0) {
      const every = state.config.interleaveEvery || DEFAULT_INTERLEAVE;
      if (every > 0 && state.unknownCount % every === 0) {
        const idx = state.unknownCount % state.config.safeContacts.length;
        injectSafeJid = state.config.safeContacts[idx];
      }
    }

    return { allowed: true, ratio: currentRatio, isKnown, injectSafeJid };
  }

  resume(instanceId: string): void {
    const state = this.ensure(instanceId);
    state.paused = false;
  }

  private ensure(instanceId: string): RiskState {
    let state = this.state.get(instanceId);
    if (!state) {
      state = {
        knownContacts: new Set<string>(),
        unknownCount: 0,
        knownCount: 0,
        responses: 0,
        paused: false,
        config: defaultConfig(),
      };
      this.state.set(instanceId, state);
    }
    return state;
  }
}

export const riskGuardian = new RiskGuardian();
