// Session aggregation for activity records
// Groups consecutive samples for the same app/window/URL into sessions.

/**
 * Convert a SQLite row timestamp into a Date.
 * Falls back across updated_at -> created_at -> timestamp.
 */
function getRecordTimes(record) {
  const created = record.created_at || record.timestamp;
  const updated = record.updated_at || created;

  const createdAt = created ? new Date(created) : null;
  const updatedAt = updated ? new Date(updated) : createdAt;

  return { createdAt, updatedAt };
}

/**
 * Build a grouping key for a record.
 * Keep it simple and deterministic so sessions represent
 * contiguous periods on the same window/tab/process.
 */
function buildKey(record) {
  return [
    record.process_name || '',
    record.window_title || '',
    record.browser_url || '',
    record.platform || '',
    record.process_path || ''
  ].join('|');
}

/**
 * Aggregate raw activity records into higher-level sessions.
 *
 * @param {Array<Object>} records Raw activity rows from SQLite
 * @param {Object} [options]
 * @param {number} [options.maxGapMs] Maximum allowed gap between samples in the same session
 * @returns {{ sessions: Array<Object>, sourceIds: Array<number> }}
 */
function aggregateActivitiesToSessions(records, options = {}) {
  const maxGapMs = options.maxGapMs ?? 15000; // 15 seconds by default

  if (!Array.isArray(records) || records.length === 0) {
    return { sessions: [], sourceIds: [] };
  }

  // Sort by time ascending to build contiguous sessions
  const sorted = [...records].sort((a, b) => {
    const aTimes = getRecordTimes(a);
    const bTimes = getRecordTimes(b);

    const aTime = aTimes.createdAt ? aTimes.createdAt.getTime() : 0;
    const bTime = bTimes.createdAt ? bTimes.createdAt.getTime() : 0;

    return aTime - bTime;
  });

  const sessions = [];
  const allSourceIds = new Set();

  let current = null;

  const flushCurrent = () => {
    if (!current) return;

    const durationMs = current.endTime && current.startTime
      ? current.endTime.getTime() - current.startTime.getTime()
      : 0;
    const durationSeconds = Math.max(1, Math.round(durationMs / 1000));

    const cpuAvg = current.cpuCount > 0 ? current.cpuSum / current.cpuCount : null;
    const memAvg = current.memCount > 0 ? current.memSum / current.memCount : null;

    sessions.push({
      startTimestamp: current.startTime.toISOString(),
      endTimestamp: current.endTime.toISOString(),
      durationSeconds,

      window_title: current.windowTitle,
      process_name: current.processName,
      process_path: current.processPath,
      platform: current.platform,
      browser_url: current.browserUrl,
      browser_tab_title: current.browserTabTitle,

      cpu_usage_avg: cpuAvg,
      memory_usage_avg: memAvg,

      mouse_movements_total: current.mouseMovementsTotal,
      input_events_total: current.inputEventsTotal,
      is_user_active: current.isUserActive,

      sample_count: current.sampleCount,
      source_ids: Array.from(current.sourceIds)
    });

    current = null;
  };

  for (const record of sorted) {
    const { createdAt, updatedAt } = getRecordTimes(record);
    if (!createdAt) {
      // Skip records with no usable timestamp
      continue;
    }

    const key = buildKey(record);
    const timestampMs = createdAt.getTime();

    const cpu = record.cpu_usage != null ? parseFloat(record.cpu_usage) : NaN;
    const mem = record.memory_usage != null ? parseFloat(record.memory_usage) : NaN;

    const mouseMovements = typeof record.mouse_movements === 'number'
      ? record.mouse_movements
      : (record.mouse_movements ? Number(record.mouse_movements) : 0);

    const inputEventsRaw = (typeof record.input_events === 'number'
      ? record.input_events
      : (record.input_events ? Number(record.input_events) : NaN));

    const inputEvents = Number.isNaN(inputEventsRaw) ? mouseMovements : inputEventsRaw;

    const isActive = record.is_user_active === 1 || record.is_user_active === true;

    if (!current) {
      // Start first session
      current = {
        key,
        startTime: createdAt,
        endTime: updatedAt || createdAt,

        windowTitle: record.window_title || '',
        processName: record.process_name || '',
        processPath: record.process_path || '',
        platform: record.platform || '',
        browserUrl: record.browser_url || '',
        browserTabTitle: record.browser_tab_title || '',

        cpuSum: Number.isNaN(cpu) ? 0 : cpu,
        cpuCount: Number.isNaN(cpu) ? 0 : 1,
        memSum: Number.isNaN(mem) ? 0 : mem,
        memCount: Number.isNaN(mem) ? 0 : 1,

        mouseMovementsTotal: mouseMovements,
        inputEventsTotal: inputEvents,
        isUserActive: isActive,

        sampleCount: 1,
        sourceIds: new Set(record.id != null ? [record.id] : [])
      };

      if (record.id != null) {
        allSourceIds.add(record.id);
      }
      continue;
    }

    const timeGap = timestampMs - current.endTime.getTime();

    const sameKey = key === current.key;
    const withinGap = timeGap >= 0 && timeGap <= maxGapMs;

    if (sameKey && withinGap) {
      // Extend current session
      if (updatedAt && updatedAt > current.endTime) {
        current.endTime = updatedAt;
      } else if (createdAt > current.endTime) {
        current.endTime = createdAt;
      }

      if (!Number.isNaN(cpu)) {
        current.cpuSum += cpu;
        current.cpuCount += 1;
      }
      if (!Number.isNaN(mem)) {
        current.memSum += mem;
        current.memCount += 1;
      }

      current.mouseMovementsTotal += mouseMovements;
      current.inputEventsTotal += inputEvents;
      current.isUserActive = current.isUserActive || isActive;
      current.sampleCount += 1;

      if (record.id != null) {
        current.sourceIds.add(record.id);
        allSourceIds.add(record.id);
      }
    } else {
      // Flush current session and start a new one
      flushCurrent();

      current = {
        key,
        startTime: createdAt,
        endTime: updatedAt || createdAt,

        windowTitle: record.window_title || '',
        processName: record.process_name || '',
        processPath: record.process_path || '',
        platform: record.platform || '',
        browserUrl: record.browser_url || '',
        browserTabTitle: record.browser_tab_title || '',

        cpuSum: Number.isNaN(cpu) ? 0 : cpu,
        cpuCount: Number.isNaN(cpu) ? 0 : 1,
        memSum: Number.isNaN(mem) ? 0 : mem,
        memCount: Number.isNaN(mem) ? 0 : 1,

        mouseMovementsTotal: mouseMovements,
        inputEventsTotal: inputEvents,
        isUserActive: isActive,

        sampleCount: 1,
        sourceIds: new Set(record.id != null ? [record.id] : [])
      };

      if (record.id != null) {
        allSourceIds.add(record.id);
      }
    }
  }

  // Flush final session
  flushCurrent();

  return {
    sessions,
    sourceIds: Array.from(allSourceIds)
  };
}

module.exports = {
  aggregateActivitiesToSessions
};
