const CONNECTION_PRIORITY = ['connecting', 'open', 'close'];

function normalizeState(instance) {
  const raw = typeof instance?.connectionState === 'string' ? instance.connectionState : undefined;
  if (raw && CONNECTION_PRIORITY.includes(raw)) return raw;
  return instance?.connected ? 'open' : 'close';
}

function compareStrings(a = '', b = '') {
  return a.localeCompare(b, 'pt-BR', { sensitivity: 'base' });
}

export function filterInstances(instances = [], options = {}) {
  const { search = '', status, sortBy = 'name', sortDir = 'asc' } = options;
  const items = Array.isArray(instances) ? [...instances] : [];
  const term = search.trim().toLowerCase();
  let filtered = term
    ? items.filter((inst) => {
        const name = inst?.name ? String(inst.name).toLowerCase() : '';
        const id = inst?.id ? String(inst.id).toLowerCase() : '';
        const userId = inst?.user?.id ? String(inst.user.id).toLowerCase() : '';
        return name.includes(term) || id.includes(term) || userId.includes(term);
      })
    : items;

  if (status && status !== 'all') {
    const allowed = Array.isArray(status) ? status : [status];
    const normalizedAllowed = allowed.map((s) => String(s));
    filtered = filtered.filter((inst) => normalizedAllowed.includes(normalizeState(inst)));
  }

  const direction = sortDir === 'desc' ? -1 : 1;
  filtered.sort((a, b) => {
    if (sortBy === 'state') {
      const stateA = normalizeState(a);
      const stateB = normalizeState(b);
      const indexA = CONNECTION_PRIORITY.indexOf(stateA);
      const indexB = CONNECTION_PRIORITY.indexOf(stateB);
      if (indexA !== indexB) return (indexA - indexB) * direction;
      return compareStrings(a?.name, b?.name) * direction;
    }

    if (sortBy === 'updatedAt') {
      const dateA = Date.parse(a?.connectionUpdatedAt ?? a?.updatedAt ?? 0) || 0;
      const dateB = Date.parse(b?.connectionUpdatedAt ?? b?.updatedAt ?? 0) || 0;
      if (dateA !== dateB) return (dateA - dateB) * direction;
      return compareStrings(a?.name, b?.name) * direction;
    }

    return compareStrings(a?.name, b?.name) * direction;
  });

  return filtered;
}
