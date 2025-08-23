#!/usr/bin/env node

/**
 * Real-time Stream Monitor
 * 
 * Script ini untuk monitoring stream secara real-time
 * Jalankan dengan: node monitor-streams.js
 */

const http = require('http');
const readline = require('readline');

class RealTimeStreamMonitor {
  constructor(baseUrl = 'http://localhost:7575') {
    this.baseUrl = baseUrl;
    this.monitoring = false;
    this.updateInterval = null;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  async startMonitoring() {
    console.log('🚀 Starting Real-time Stream Monitor...');
    console.log(`📡 Monitoring: ${this.baseUrl}`);
    console.log('📋 Commands:');
    console.log('   status - Show current status');
    console.log('   refresh - Refresh immediately');
    console.log('   quit/exit - Stop monitoring');
    console.log('   help - Show this help');
    console.log('');
    
    this.monitoring = true;
    this.updateInterval = setInterval(() => {
      this.updateStatus();
    }, 10000); // Update every 10 seconds
    
    // Initial update
    await this.updateStatus();
    
    // Setup command handling
    this.setupCommands();
  }

  setupCommands() {
    this.rl.on('line', async (input) => {
      const command = input.trim().toLowerCase();
      
      switch (command) {
        case 'status':
        case 's':
          await this.updateStatus();
          break;
          
        case 'refresh':
        case 'r':
          await this.updateStatus();
          break;
          
        case 'quit':
        case 'exit':
        case 'q':
          this.stopMonitoring();
          break;
          
        case 'help':
        case 'h':
          this.showHelp();
          break;
          
        default:
          if (command) {
            console.log(`❓ Unknown command: ${command}`);
            console.log('Type "help" for available commands');
          }
          break;
      }
      
      if (this.monitoring) {
        this.rl.prompt();
      }
    });
    
    this.rl.setPrompt('monitor> ');
    this.rl.prompt();
  }

  showHelp() {
    console.log('\n📋 Available Commands:');
    console.log('  status (s)  - Show current stream status');
    console.log('  refresh (r) - Refresh status immediately');
    console.log('  help (h)    - Show this help message');
    console.log('  quit (q)    - Stop monitoring and exit');
    console.log('');
  }

  async updateStatus() {
    try {
      const timestamp = new Date().toLocaleTimeString();
      console.log(`\n⏰ [${timestamp}] Updating stream status...`);
      
      const result = await this.fetchActiveStreams();
      
      if (result.success) {
        this.displayStreamStatus(result.activeStreams);
      } else {
        console.log('❌ Failed to fetch stream status');
      }
      
    } catch (error) {
      console.log(`❌ Error updating status: ${error.message}`);
    }
  }

  async fetchActiveStreams() {
    return new Promise((resolve, reject) => {
      const url = new URL('/api/streams/active/status', this.baseUrl);
      
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        }
      };

      const req = http.request(options, (res) => {
        let responseData = '';
        
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseData);
            resolve(parsed);
          } catch (error) {
            reject(new Error('Failed to parse response'));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.end();
    });
  }

  displayStreamStatus(activeStreams) {
    if (!activeStreams || activeStreams.length === 0) {
      console.log('📭 No active streams found');
      return;
    }

    console.log(`\n📊 Active Streams: ${activeStreams.length}`);
    console.log('=' .repeat(50));
    
    activeStreams.forEach((stream, index) => {
      console.log(`\n${index + 1}. ${stream.title}`);
      console.log(`   ID: ${stream.id}`);
      console.log(`   Status: ${this.getStatusIcon(stream)} ${stream.status || 'live'}`);
      
      if (stream.runtimeInfo) {
        const runtime = stream.runtimeInfo;
        console.log(`   Runtime: Total ${runtime.totalRuntimeMinutes}m | Session ${runtime.currentSessionRuntimeMinutes}m`);
      }
      
      if (stream.duration) {
        const remaining = stream.duration - (stream.runtimeInfo?.totalRuntimeMinutes || 0);
        const remainingText = remaining > 0 ? `${remaining}m remaining` : 'Duration exceeded';
        const remainingIcon = remaining > 0 ? (remaining <= 10 ? '⚠️' : '✅') : '❌';
        console.log(`   Duration: ${remainingIcon} ${remainingText} (${stream.duration}m total)`);
      }
      
      if (stream.hasScheduledTermination) {
        console.log(`   ⏰ Scheduled termination: YES`);
      }
      
      if (stream.start_time) {
        const startTime = new Date(stream.start_time).toLocaleTimeString();
        console.log(`   Started: ${startTime}`);
      }
    });
    
    console.log('\n' + '=' .repeat(50));
  }

  getStatusIcon(stream) {
    if (stream.hasScheduledTermination) {
      return '🟡'; // Yellow for scheduled termination
    }
    
    if (stream.runtimeInfo && stream.duration) {
      const remaining = stream.duration - stream.runtimeInfo.totalRuntimeMinutes;
      if (remaining <= 0) {
        return '🔴'; // Red for duration exceeded
      } else if (remaining <= 10) {
        return '🟠'; // Orange for ending soon
      } else {
        return '🟢'; // Green for running normally
      }
    }
    
    return '🔵'; // Blue for unknown status
  }

  stopMonitoring() {
    console.log('\n🛑 Stopping stream monitor...');
    
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    this.monitoring = false;
    this.rl.close();
    
    console.log('👋 Stream monitor stopped. Goodbye!');
    process.exit(0);
  }

  async testConnection() {
    try {
      const result = await this.fetchActiveStreams();
      return result.success;
    } catch (error) {
      return false;
    }
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const baseUrl = args[0] || 'http://localhost:7575';
  
  const monitor = new RealTimeStreamMonitor(baseUrl);
  
  // Test connection first
  console.log('🔍 Testing connection...');
  const connected = await monitor.testConnection();
  
  if (!connected) {
    console.log(`❌ Cannot connect to ${baseUrl}`);
    console.log('Make sure the server is running and accessible');
    process.exit(1);
  }
  
  console.log('✅ Connection successful!');
  
  // Start monitoring
  await monitor.startMonitoring();
}

// Run if this file is executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Failed to start monitor:', error.message);
    process.exit(1);
  });
}

module.exports = RealTimeStreamMonitor;
