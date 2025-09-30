const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * FFmpeg Configuration Utility
 * Handles FFmpeg and FFprobe path detection for Windows and Linux
 */

class FFmpegConfig {
  constructor() {
    this.platform = os.platform();
    this.projectRoot = path.resolve(__dirname, '..');
    this.binDir = path.join(this.projectRoot, 'bin');
    
    // Initialize paths
    this.ffmpegPath = this.detectFFmpegPath();
    this.ffprobePath = this.detectFFprobePath();
    
    console.log(`[FFmpegConfig] Platform: ${this.platform}`);
    console.log(`[FFmpegConfig] FFmpeg path: ${this.ffmpegPath}`);
    console.log(`[FFmpegConfig] FFprobe path: ${this.ffprobePath}`);
  }

  /**
   * Detect FFmpeg path based on platform
   * @returns {string} Path to FFmpeg executable
   */
  detectFFmpegPath() {
    if (this.platform === 'win32') {
      // Windows: Check project/bin/ffmpeg.exe first, then system PATH
      const localPath = path.join(this.binDir, 'ffmpeg.exe');
      if (fs.existsSync(localPath)) {
        return localPath;
      }
      
      // Fallback to system PATH
      return 'ffmpeg';
    } else {
      // Linux/Unix: Check /usr/bin/ffmpeg first, then system PATH
      const systemPath = '/usr/bin/ffmpeg';
      if (fs.existsSync(systemPath)) {
        return systemPath;
      }
      
      // Fallback to system PATH
      return 'ffmpeg';
    }
  }

  /**
   * Detect FFprobe path based on platform
   * @returns {string} Path to FFprobe executable
   */
  detectFFprobePath() {
    if (this.platform === 'win32') {
      // Windows: Check project/bin/ffprobe.exe first, then system PATH
      const localPath = path.join(this.binDir, 'ffprobe.exe');
      if (fs.existsSync(localPath)) {
        return localPath;
      }
      
      // Fallback to system PATH
      return 'ffprobe';
    } else {
      // Linux/Unix: Check /usr/bin/ffprobe first, then system PATH
      const systemPath = '/usr/bin/ffprobe';
      if (fs.existsSync(systemPath)) {
        return systemPath;
      }
      
      // Fallback to system PATH
      return 'ffprobe';
    }
  }

  /**
   * Get FFmpeg path
   * @returns {string} Path to FFmpeg executable
   */
  getFFmpegPath() {
    return this.ffmpegPath;
  }

  /**
   * Get FFprobe path
   * @returns {string} Path to FFprobe executable
   */
  getFFprobePath() {
    return this.ffprobePath;
  }

  /**
   * Check if FFmpeg is available
   * @returns {boolean} True if FFmpeg is found
   */
  isFFmpegAvailable() {
    if (this.platform === 'win32') {
      return fs.existsSync(this.ffmpegPath) || this.ffmpegPath === 'ffmpeg';
    } else {
      return fs.existsSync(this.ffmpegPath) || this.ffmpegPath === 'ffmpeg';
    }
  }

  /**
   * Check if FFprobe is available
   * @returns {boolean} True if FFprobe is found
   */
  isFFprobeAvailable() {
    if (this.platform === 'win32') {
      return fs.existsSync(this.ffprobePath) || this.ffprobePath === 'ffprobe';
    } else {
      return fs.existsSync(this.ffprobePath) || this.ffprobePath === 'ffprobe';
    }
  }

  /**
   * Get source type (local or system)
   * @returns {object} Object with ffmpeg and ffprobe source types
   */
  getSourceInfo() {
    const ffmpegSource = this.getSourceType(this.ffmpegPath);
    const ffprobeSource = this.getSourceType(this.ffprobePath);
    
    return {
      ffmpeg: ffmpegSource,
      ffprobe: ffprobeSource
    };
  }

  /**
   * Determine if path is local or system
   * @param {string} executablePath Path to executable
   * @returns {string} 'local' or 'system'
   */
  getSourceType(executablePath) {
    if (this.platform === 'win32') {
      return executablePath.includes(this.binDir) ? 'local' : 'system';
    } else {
      return executablePath.startsWith('/usr/bin/') ? 'local' : 'system';
    }
  }

  /**
   * Get configuration info for API
   * @returns {object} Configuration information
   */
  getConfigInfo() {
    return {
      platform: this.platform,
      projectRoot: this.projectRoot,
      binDir: this.binDir,
      ffmpeg: {
        path: this.ffmpegPath,
        available: this.isFFmpegAvailable(),
        source: this.getSourceType(this.ffmpegPath)
      },
      ffprobe: {
        path: this.ffprobePath,
        available: this.isFFprobeAvailable(),
        source: this.getSourceType(this.ffprobePath)
      }
    };
  }

  /**
   * Create bin directory if it doesn't exist (Windows)
   */
  ensureBinDirectory() {
    if (this.platform === 'win32' && !fs.existsSync(this.binDir)) {
      try {
        fs.mkdirSync(this.binDir, { recursive: true });
        console.log(`[FFmpegConfig] Created bin directory: ${this.binDir}`);
      } catch (error) {
        console.error(`[FFmpegConfig] Failed to create bin directory: ${error.message}`);
      }
    }
  }
}

// Create singleton instance
const ffmpegConfig = new FFmpegConfig();

module.exports = ffmpegConfig;
