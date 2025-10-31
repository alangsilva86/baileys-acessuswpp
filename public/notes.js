(function (global) {
  const root = global || {};

  function applyNoteSaveResult(state, payload = {}, options = {}) {
    if (!state || typeof state !== 'object') return state;

    const metadata = payload && typeof payload === 'object' ? payload.metadata || {} : {};
    const noteValue = Object.prototype.hasOwnProperty.call(options, 'note') ? options.note : payload?.note;
    if (typeof noteValue === 'string') {
      state.pending = noteValue;
      state.lastSaved = noteValue.trim();
    }

    if (metadata && typeof metadata === 'object') {
      if (metadata.updatedAt) {
        state.updatedAt = metadata.updatedAt;
      } else if (options.fallbackUpdatedAt) {
        state.updatedAt = options.fallbackUpdatedAt;
      }
      if (metadata.createdAt) {
        state.createdAt = metadata.createdAt;
      }
    } else if (options.fallbackUpdatedAt) {
      state.updatedAt = options.fallbackUpdatedAt;
    }

    return state;
  }

  function cancelAutosave(state) {
    if (!state || typeof state !== 'object' || !state.timer) return false;
    clearTimeout(state.timer);
    state.timer = null;
    return true;
  }

  root.NoteHelpers = {
    applyNoteSaveResult,
    cancelAutosave,
  };
})(typeof window !== 'undefined' ? window : this);
