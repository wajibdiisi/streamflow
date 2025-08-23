#!/usr/bin/env node

/**
 * Test Script untuk Stream Monitor
 * 
 * Script ini digunakan untuk testing fitur stream monitoring yang baru
 * Jalankan dengan: node test-stream-monitor.js
 */

const http = require('http');

class StreamMonitorTester {
  constructor(baseUrl = 'http://localhost:7575') {
    this.baseUrl = baseUrl;
    this.testResults = [];
  }

  async testEndpoint(endpoint, method = 'GET', data = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, this.baseUrl);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: method,
        headers: {
          'Content-Type': 'application/json',
        }
      };

      if (data) {
        const postData = JSON.stringify(data);
        options.headers['Content-Length'] = Buffer.byteLength(postData);
      }

      const req = http.request(options, (res) => {
        let responseData = '';
        
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseData);
            resolve({
              status: res.statusCode,
              data: parsed,
              headers: res.headers
            });
          } catch (error) {
            resolve({
              status: res.statusCode,
              data: responseData,
              headers: res.headers,
              parseError: error.message
            });
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      if (data) {
        req.write(JSON.stringify(data));
      }

      req.end();
    });
  }

  async runTests() {
    console.log('🚀 Starting Stream Monitor Tests...\n');
    
    // Test 1: Server Time
    await this.testServerTime();
    
    // Test 2: Active Streams Status
    await this.testActiveStreamsStatus();
    
    // Test 3: Stream Runtime (if stream exists)
    await this.testStreamRuntime();
    
    // Test 4: Stream Logs (if stream exists)
    await this.testStreamLogs();
    
    this.printResults();
  }

  async testServerTime() {
    console.log('📅 Testing Server Time Endpoint...');
    
    try {
      const result = await this.testEndpoint('/api/server-time');
      
      if (result.status === 200 && result.data.serverTime) {
        console.log('✅ Server Time: OK');
        console.log(`   Server Time: ${result.data.serverTime}`);
        console.log(`   Formatted: ${result.data.formattedTime}`);
        this.testResults.push({ test: 'Server Time', status: 'PASS', details: result.data });
      } else {
        console.log('❌ Server Time: FAILED');
        console.log(`   Status: ${result.status}`);
        console.log(`   Response: ${JSON.stringify(result.data, null, 2)}`);
        this.testResults.push({ test: 'Server Time', status: 'FAIL', details: result });
      }
    } catch (error) {
      console.log('❌ Server Time: ERROR');
      console.log(`   Error: ${error.message}`);
      this.testResults.push({ test: 'Server Time', status: 'ERROR', details: error.message });
    }
    
    console.log('');
  }

  async testActiveStreamsStatus() {
    console.log('📊 Testing Active Streams Status Endpoint...');
    
    try {
      const result = await this.testEndpoint('/api/streams/active/status');
      
      if (result.status === 200) {
        console.log('✅ Active Streams Status: OK');
        console.log(`   Active Streams: ${result.data.count || 0}`);
        
        if (result.data.activeStreams && result.data.activeStreams.length > 0) {
          console.log('   Active Streams Details:');
          result.data.activeStreams.forEach((stream, index) => {
            console.log(`     ${index + 1}. ${stream.title} (ID: ${stream.id})`);
            if (stream.runtimeInfo) {
              console.log(`        Total Runtime: ${stream.runtimeInfo.totalRuntimeMinutes}m`);
              console.log(`        Session Runtime: ${stream.runtimeInfo.currentSessionRuntimeMinutes}m`);
            }
            if (stream.duration) {
              console.log(`        Duration: ${stream.duration}m`);
            }
          });
        }
        
        this.testResults.push({ test: 'Active Streams Status', status: 'PASS', details: result.data });
      } else {
        console.log('❌ Active Streams Status: FAILED');
        console.log(`   Status: ${result.status}`);
        console.log(`   Response: ${JSON.stringify(result.data, null, 2)}`);
        this.testResults.push({ test: 'Active Streams Status', status: 'FAIL', details: result });
      }
    } catch (error) {
      console.log('❌ Active Streams Status: ERROR');
      console.log(`   Error: ${error.message}`);
      this.testResults.push({ test: 'Active Streams Status', status: 'ERROR', details: error.message });
    }
    
    console.log('');
  }

  async testStreamRuntime() {
    console.log('⏱️  Testing Stream Runtime Endpoint...');
    
    try {
      // Try to get runtime for a sample stream ID (this will likely fail if no streams exist)
      const sampleStreamId = 'test-stream-123';
      const result = await this.testEndpoint(`/api/streams/${sampleStreamId}/runtime`);
      
      if (result.status === 404) {
        console.log('✅ Stream Runtime: OK (Expected 404 for non-existent stream)');
        this.testResults.push({ test: 'Stream Runtime', status: 'PASS', details: 'Expected 404 for non-existent stream' });
      } else if (result.status === 200) {
        console.log('✅ Stream Runtime: OK');
        console.log(`   Stream ID: ${sampleStreamId}`);
        console.log(`   Runtime Info: ${JSON.stringify(result.data.runtimeInfo, null, 2)}`);
        this.testResults.push({ test: 'Stream Runtime', status: 'PASS', details: result.data });
      } else {
        console.log('❌ Stream Runtime: UNEXPECTED STATUS');
        console.log(`   Status: ${result.status}`);
        console.log(`   Response: ${JSON.stringify(result.data, null, 2)}`);
        this.testResults.push({ test: 'Stream Runtime', status: 'FAIL', details: result });
      }
    } catch (error) {
      console.log('❌ Stream Runtime: ERROR');
      console.log(`   Error: ${error.message}`);
      this.testResults.push({ test: 'Stream Runtime', status: 'ERROR', details: error.message });
    }
    
    console.log('');
  }

  async testStreamLogs() {
    console.log('📝 Testing Stream Logs Endpoint...');
    
    try {
      // Try to get logs for a sample stream ID
      const sampleStreamId = 'test-stream-123';
      const result = await this.testEndpoint(`/api/streams/${sampleStreamId}/logs`);
      
      if (result.status === 404) {
        console.log('✅ Stream Logs: OK (Expected 404 for non-existent stream)');
        this.testResults.push({ test: 'Stream Logs', status: 'PASS', details: 'Expected 404 for non-existent stream' });
      } else if (result.status === 200) {
        console.log('✅ Stream Logs: OK');
        console.log(`   Stream ID: ${sampleStreamId}`);
        console.log(`   Logs Count: ${result.data.logs ? result.data.logs.length : 0}`);
        this.testResults.push({ test: 'Stream Logs', status: 'PASS', details: result.data });
      } else {
        console.log('❌ Stream Logs: UNEXPECTED STATUS');
        console.log(`   Status: ${result.status}`);
        console.log(`   Response: ${JSON.stringify(result.data, null, 2)}`);
        this.testResults.push({ test: 'Stream Logs', status: 'FAIL', details: result });
      }
    } catch (error) {
      console.log('❌ Stream Logs: ERROR');
      console.log(`   Error: ${error.message}`);
      this.testResults.push({ test: 'Stream Logs', status: 'ERROR', details: error.message });
    }
    
    console.log('');
  }

  printResults() {
    console.log('📋 Test Results Summary:');
    console.log('========================');
    
    const passed = this.testResults.filter(r => r.status === 'PASS').length;
    const failed = this.testResults.filter(r => r.status === 'FAIL').length;
    const errors = this.testResults.filter(r => r.status === 'ERROR').length;
    
    this.testResults.forEach(result => {
      const icon = result.status === 'PASS' ? '✅' : result.status === 'FAIL' ? '❌' : '⚠️';
      console.log(`${icon} ${result.test}: ${result.status}`);
    });
    
    console.log('\n📊 Summary:');
    console.log(`   Passed: ${passed}`);
    console.log(`   Failed: ${failed}`);
    console.log(`   Errors: ${errors}`);
    console.log(`   Total: ${this.testResults.length}`);
    
    if (failed === 0 && errors === 0) {
      console.log('\n🎉 All tests passed! Stream monitor is working correctly.');
    } else {
      console.log('\n⚠️  Some tests failed. Check the details above.');
    }
  }

  // Helper method untuk testing dengan stream yang ada
  async testWithExistingStream(streamId) {
    console.log(`🔍 Testing with existing stream: ${streamId}`);
    
    try {
      // Test runtime
      const runtimeResult = await this.testEndpoint(`/api/streams/${streamId}/runtime`);
      console.log(`Runtime Status: ${runtimeResult.status}`);
      
      // Test logs
      const logsResult = await this.testEndpoint(`/api/streams/${streamId}/logs`);
      console.log(`Logs Status: ${logsResult.status}`);
      
    } catch (error) {
      console.log(`Error testing with stream ${streamId}: ${error.message}`);
    }
  }
}

// Main execution
async function main() {
  const tester = new StreamMonitorTester();
  
  // Check if custom base URL is provided
  const args = process.argv.slice(2);
  if (args.length > 0) {
    tester.baseUrl = args[0];
    console.log(`Using custom base URL: ${tester.baseUrl}`);
  }
  
  try {
    await tester.runTests();
  } catch (error) {
    console.error('Test execution failed:', error.message);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main();
}

module.exports = StreamMonitorTester;
