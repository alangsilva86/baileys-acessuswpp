import { renderInstanceCard } from './components/instanceCard.js';
import { filterInstances } from './utils/instances.js';
import { STATUS_CODES } from './constants.js';

function createLockedSet(source) {
  if (!source) return new Set();
  if (source instanceof Set) return new Set(source);
  if (source instanceof Map) return new Set(source.keys());
  if (Array.isArray(source)) return new Set(source);
  if (typeof source === 'object') {
    return new Set(Object.keys(source).filter((key) => source[key]));
  }
  return new Set();
}

function getStatusCounts(src) {
  const result = {};
  STATUS_CODES.forEach((code) => {
    const num = Number(src?.[code]);
    result[code] = Number.isFinite(num) ? num : 0;
  });
  return result;
}

function percent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.min(Math.max(n, 0), 1);
  return Math.round(clamped * 100);
}

function createSignature(instance, meta) {
  const counters = instance?.counters || {};
  const rate = instance?.rate || {};
  return JSON.stringify({
    id: instance?.id,
    name: instance?.name,
    note: instance?.note || instance?.notes || '',
    userId: instance?.user?.id,
    counters: {
      sent: counters.sent,
      statusCounts: STATUS_CODES.map((code) => Number(counters.statusCounts?.[code] ?? counters.status?.[code] ?? 0)),
    },
    usage: rate.usage,
    connectionState: meta?.connection?.state,
    connectionUpdated: meta?.connection?.updatedText,
    selected: meta?.selected,
    locked: meta?.locked,
  });
}

function ensureContainerReady(container) {
  if (container.dataset.empty === 'true') {
    container.dataset.empty = 'false';
    container.textContent = '';
  }
}

export function createInstancesManager(container, handlers = {}) {
  if (!container) throw new Error('instances container not provided');
  const state = {
    items: new Map(),
  };

  function update(instances = [], options = {}) {
    const {
      selectedId = null,
      lockedIds = new Set(),
      filters = {},
      describeConnection,
    } = options;

    const lockedSet = createLockedSet(lockedIds);
    const filtered = filterInstances(instances, filters);

    if (!filtered.length) {
      clear();
      return;
    }

    ensureContainerReady(container);

    const nextItems = new Map();

    filtered.forEach((instance, index) => {
      const connection = typeof describeConnection === 'function'
        ? describeConnection(instance)
        : { state: 'unknown', meta: {} };
      const statusCounts = getStatusCounts(instance?.counters?.statusCounts || instance?.counters?.status || {});
      const usagePercent = percent(instance?.rate?.usage || 0);
      const noteValue = (instance?.note || instance?.notes || '').trim();
      const userId = instance?.user?.id ? String(instance.user.id) : '—';
      const sent = Number(instance?.counters?.sent) || 0;
      const selected = instance?.id === selectedId;
      const locked = lockedSet.has(instance?.id);

      const meta = { connection, selected, locked };
      const signature = createSignature(instance, { ...meta });
      const prev = state.items.get(instance?.id);
      let element = prev?.element;

      if (!prev || prev.signature !== signature) {
        const fragment = renderInstanceCard(instance, {
          connection,
          selected,
          locked,
          statusCounts,
          sent,
          usagePercent,
          userId,
          noteValue,
          handlers,
        });
        const cardElement = fragment.firstElementChild;
        if (prev?.element) {
          prev.element.replaceWith(cardElement);
        } else {
          const reference = container.children[index] || null;
          container.insertBefore(fragment, reference);
        }
        element = cardElement;
      } else if (container.children[index] !== element) {
        const reference = container.children[index] || null;
        container.insertBefore(element, reference);
      }

      nextItems.set(instance?.id, { element, signature, meta: { connection, selected, locked } });
    });

    state.items.forEach((value, key) => {
      if (!nextItems.has(key) && value?.element?.isConnected) {
        value.element.remove();
      }
    });

    state.items.clear();
    nextItems.forEach((value, key) => state.items.set(key, value));
  }

  function clear() {
    state.items.clear();
    container.textContent = '';
    container.dataset.empty = 'true';
  }

  function showEmptyState(html) {
    clear();
    container.innerHTML = html;
  }

  function getCard(iid) {
    return state.items.get(iid)?.element || null;
  }

  return {
    update,
    clear,
    showEmptyState,
    getCard,
  };
}
