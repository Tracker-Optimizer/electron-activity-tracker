#!/usr/bin/env node

// Preview aggregated activity sessions from the local SQLite database.
// This script reuses the same aggregation logic used by the sync engine
// so you can inspect how raw samples get merged into sessions.

const path = require('path');
const ActivityTracker = require('../src/tracker');
const { aggregateActivitiesToSessions } = require('../src/sessionAggregator');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  console.log('🔍 Previewing aggregated sessions from activity.db...');

  const tracker = new ActivityTracker();
  tracker.initialize();

  // By default, only look at unsynced activities
  const unsynced = tracker.getUnsyncedActivities();

  console.log(`Found ${unsynced.length} unsynced raw records`);

  const { sessions, sourceIds } = aggregateActivitiesToSessions(unsynced);

  console.log(`Aggregated into ${sessions.length} sessions (covering ${sourceIds.length} raw records)\n`);

  // Pretty-print a concise view of each session
  sessions.forEach((session, index) => {
    const line = [
      `#${index + 1}`,
      `[${session.startTimestamp} → ${session.endTimestamp}]`,
      `(${session.durationSeconds}s, ${session.sample_count} samples)`,
      session.process_name || 'Unknown process',
      session.window_title || '',
      session.browser_url ? `URL: ${session.browser_url}` : '',
      `CPU avg: ${session.cpu_usage_avg != null ? session.cpu_usage_avg.toFixed(2) + '%' : 'n/a'}`,
      `Mem avg: ${session.memory_usage_avg != null ? session.memory_usage_avg.toFixed(2) + '%' : 'n/a'}`,
      `Input: ${session.input_events_total}`,
      session.is_user_active ? 'active' : 'idle'
    ].filter(Boolean).join(' | ');

    console.log(line);
  });

  // Also output raw JSON if needed (uncomment to use)
  // console.log(JSON.stringify({ sessions, sourceIds }, null, 2));

  tracker.stop();
}

main().catch((err) => {
  console.error('❌ Error while previewing sessions:', err);
  process.exit(1);
});
