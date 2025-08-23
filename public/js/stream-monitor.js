class StreamMonitor {
  constructor() {
    this.updateInterval = null;
    this.activeStreams = new Map();
    this.init();
  }

  init() {
    this.startMonitoring();
    this.setupEventListeners();
  }

  setupEventListeners() {
    // Add event listeners for any UI interactions
    document.addEventListener('DOMContentLoaded', () => {
      this.setupStreamControls();
    });
  }

  setupStreamControls() {
    // Add reset runtime buttons to stream cards
    const streamCards = document.querySelectorAll('.stream-card');
    streamCards.forEach(card => {
      const streamId = card.dataset.streamId;
      if (streamId) {
        this.addResetRuntimeButton(card, streamId);
      }
    });
  }

  addResetRuntimeButton(card, streamId) {
    const existingButton = card.querySelector('.reset-runtime-btn');
    if (existingButton) return;

    const button = document.createElement('button');
    button.className = 'reset-runtime-btn bg-yellow-500 hover:bg-yellow-600 text-white px-3 py-1 rounded text-sm ml-2';
    button.textContent = 'Reset Timer';
    button.onclick = () => this.resetStreamRuntime(streamId);
    
    const actionsDiv = card.querySelector('.stream-actions') || card.querySelector('.card-actions');
    if (actionsDiv) {
      actionsDiv.appendChild(button);
    }
  }

  startMonitoring() {
    // Update every 30 seconds
    this.updateInterval = setInterval(() => {
      this.updateActiveStreamsStatus();
    }, 30000);
    
    // Initial update
    this.updateActiveStreamsStatus();
  }

  async updateActiveStreamsStatus() {
    try {
      const response = await fetch('/api/streams/active/status');
      if (!response.ok) throw new Error('Failed to fetch stream status');
      
      const data = await response.json();
      if (data.success) {
        this.updateStreamDisplay(data.activeStreams);
      }
    } catch (error) {
      console.error('Error updating stream status:', error);
    }
  }

  updateStreamDisplay(activeStreams) {
    activeStreams.forEach(stream => {
      this.updateStreamCard(stream);
    });
  }

  updateStreamCard(stream) {
    const card = document.querySelector(`[data-stream-id="${stream.id}"]`);
    if (!card) return;

    // Update runtime display
    const runtimeDisplay = card.querySelector('.runtime-display');
    if (runtimeDisplay) {
      const runtimeInfo = stream.runtimeInfo;
      if (runtimeInfo) {
        const totalMinutes = runtimeInfo.totalRuntimeMinutes;
        const currentMinutes = runtimeInfo.currentSessionRuntimeMinutes;
        
        let displayText = `Total: ${totalMinutes}m`;
        if (currentMinutes > 0) {
          displayText += ` | Session: ${currentMinutes}m`;
        }
        
        if (stream.duration) {
          const remaining = Math.max(0, stream.duration - totalMinutes);
          displayText += ` | Remaining: ${remaining}m`;
        }
        
        runtimeDisplay.textContent = displayText;
        runtimeDisplay.className = 'runtime-display text-sm text-gray-600 font-mono';
      }
    } else {
      // Create runtime display if it doesn't exist
      this.createRuntimeDisplay(card, stream);
    }

    // Update status indicators
    this.updateStatusIndicator(card, stream);
  }

  createRuntimeDisplay(card, stream) {
    const runtimeInfo = stream.runtimeInfo;
    if (!runtimeInfo) return;

    const runtimeDiv = document.createElement('div');
    runtimeDiv.className = 'runtime-display text-sm text-gray-600 font-mono mt-2';
    
    const totalMinutes = runtimeInfo.totalRuntimeMinutes;
    const currentMinutes = runtimeInfo.currentSessionRuntimeMinutes;
    
    let displayText = `Total: ${totalMinutes}m`;
    if (currentMinutes > 0) {
      displayText += ` | Session: ${currentMinutes}m`;
    }
    
    if (stream.duration) {
      const remaining = Math.max(0, stream.duration - totalMinutes);
      displayText += ` | Remaining: ${remaining}m`;
    }
    
    runtimeDiv.textContent = displayText;
    
    // Insert after title or in appropriate location
    const titleElement = card.querySelector('.stream-title') || card.querySelector('h3') || card.querySelector('h4');
    if (titleElement) {
      titleElement.parentNode.insertBefore(runtimeDiv, titleElement.nextSibling);
    }
  }

  updateStatusIndicator(card, stream) {
    const statusIndicator = card.querySelector('.status-indicator');
    if (!statusIndicator) return;

    if (stream.hasScheduledTermination) {
      statusIndicator.className = 'status-indicator inline-block w-3 h-3 bg-yellow-500 rounded-full mr-2';
      statusIndicator.title = 'Stream scheduled to terminate';
    } else if (stream.runtimeInfo && stream.duration) {
      const remaining = stream.duration - stream.runtimeInfo.totalRuntimeMinutes;
      if (remaining <= 0) {
        statusIndicator.className = 'status-indicator inline-block w-3 h-3 bg-red-500 rounded-full mr-2';
        statusIndicator.title = 'Stream duration exceeded';
      } else if (remaining <= 10) {
        statusIndicator.className = 'status-indicator inline-block w-3 h-3 bg-orange-500 rounded-full mr-2';
        statusIndicator.title = `Stream ending soon (${remaining}m remaining)`;
      } else {
        statusIndicator.className = 'status-indicator inline-block w-3 h-3 bg-green-500 rounded-full mr-2';
        statusIndicator.title = 'Stream running normally';
      }
    }
  }

  async resetStreamRuntime(streamId) {
    if (!confirm('Are you sure you want to reset the stream timer? This will stop the current stream and reset all timing.')) {
      return;
    }

    try {
      const response = await fetch(`/api/streams/${streamId}/reset-runtime`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) throw new Error('Failed to reset stream runtime');
      
      const data = await response.json();
      if (data.success) {
        // Refresh the page or update the UI
        location.reload();
      } else {
        alert('Failed to reset stream runtime: ' + data.error);
      }
    } catch (error) {
      console.error('Error resetting stream runtime:', error);
      alert('Error resetting stream runtime: ' + error.message);
    }
  }

  async getStreamRuntime(streamId) {
    try {
      const response = await fetch(`/api/streams/${streamId}/runtime`);
      if (!response.ok) throw new Error('Failed to fetch stream runtime');
      
      const data = await response.json();
      return data.success ? data : null;
    } catch (error) {
      console.error('Error fetching stream runtime:', error);
      return null;
    }
  }

  stopMonitoring() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  // Method to manually refresh a specific stream
  async refreshStream(streamId) {
    const runtimeData = await this.getStreamRuntime(streamId);
    if (runtimeData) {
      this.updateStreamCard(runtimeData.stream);
    }
  }
}

// Initialize stream monitor when page loads
let streamMonitor;
document.addEventListener('DOMContentLoaded', () => {
  streamMonitor = new StreamMonitor();
});

// Export for use in other scripts
window.StreamMonitor = StreamMonitor;
