const axios = require('axios');
const { aggregateActivitiesToSessions } = require('./sessionAggregator');

class NetworkSync {
  constructor(tracker, authManager = null) {
    this.tracker = tracker;
    this.authManager = authManager;
    this.syncInterval = null;
    this.syncIntervalMs = 30 * 60 * 1000; // 30 minutes
    this.apiEndpoint = process.env.API_ENDPOINT;
    this.apiKey = process.env.API_KEY;
  }

  startSync() {
    console.log('🔄 Network sync initialized (every 30 minutes)');
    
    // Sync immediately on start if there's unsynced data
    setTimeout(() => this.syncNow(), 5000); // Wait 5 seconds after startup
    
    // Then sync every 30 minutes
    this.syncInterval = setInterval(() => {
      this.syncNow();
    }, this.syncIntervalMs);
  }

  stopSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    console.log('🛑 Network sync stopped');
  }

  async syncNow() {
    try {
      const unsyncedData = this.tracker.getUnsyncedActivities();
      
      if (unsyncedData.length === 0) {
        console.log('✅ No data to sync');
        return { success: true, synced: 0 };
      }

      // Aggregate raw samples into higher-level sessions
      const { sessions, sourceIds } = aggregateActivitiesToSessions(unsyncedData);

      if (sessions.length === 0) {
        console.log('⚠️ Aggregation produced no sessions; skipping sync');
        return { success: false, synced: 0, error: 'No sessions after aggregation' };
      }

      console.log(`📤 Syncing ${sessions.length} aggregated sessions from ${unsyncedData.length} raw records...`);

      // Optional: include authenticated user ID if authManager is provided
      let userId = null;
      let authCookie = null;

      if (this.authManager) {
        const user = this.authManager.getUser?.();
        if (user && user.id) {
          userId = user.id;
        }

        const authHeadersConfig = this.authManager.getAuthHeaders?.() || {};
        authCookie = authHeadersConfig.headers?.Cookie;
      }

      const payload = {
        userId,
        activities: sessions.map(session => ({
          // Time and duration
          timestamp: session.startTimestamp,
          start_timestamp: session.startTimestamp,
          end_timestamp: session.endTimestamp,
          duration_seconds: session.durationSeconds,

          // App/window/browser data
          window_title: session.window_title,
          process_name: session.process_name,
          process_path: session.process_path,
          platform: session.platform,
          browser_url: session.browser_url,
          browser_tab_title: session.browser_tab_title,

          // Aggregated metrics
          cpu_usage: session.cpu_usage_avg,
          memory_usage: session.memory_usage_avg,
          mouse_movements: session.mouse_movements_total,
          input_events: session.input_events_total,
          is_user_active: session.is_user_active,

          // Debug/analytics fields (optional on server)
          sample_count: session.sample_count
        })),
        metadata: {
          total_records: unsyncedData.length,
          total_sessions: sessions.length,
          sync_timestamp: new Date().toISOString(),
          device_platform: process.platform
        }
      };

      // Send to API endpoint
      const headers = {
        'Content-Type': 'application/json'
      };

      // Include Better Auth cookie if available
      if (authCookie) {
        headers['Cookie'] = authCookie;
      }

      // Add API key if configured
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await axios.post(this.apiEndpoint, payload, {
        headers,
        timeout: 30000 // 30 second timeout
      });

      if (response.status >= 200 && response.status < 300) {
        // Mark all underlying raw records as synced in local database
        this.tracker.markAsSynced(sourceIds);
        
        console.log(`✅ Successfully synced ${sessions.length} sessions (${sourceIds.length} raw records)`);
        return { success: true, synced: sessions.length, rawSynced: sourceIds.length };
      } else {
        console.error(`❌ Sync failed with status: ${response.status}`);
        return { success: false, error: `HTTP ${response.status}` };
      }

    } catch (error) {
      console.error('❌ Network sync error:', error.message);
      
      // Log more details for debugging
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      } else if (error.request) {
        console.error('No response received from server');
      }
      
      return { success: false, error: error.message };
    }
  }
}

module.exports = NetworkSync;
