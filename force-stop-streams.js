const { spawn } = require('child_process');
const { db } = require('./db/database');
const Stream = require('./models/Stream');

async function forceStopAllStreams() {
  console.log('=== FORCE STOP ALL STREAMS ===');
  
  try {
    // Get all live streams from database
    const liveStreams = await Stream.findAll(null, 'live');
    console.log(`Found ${liveStreams.length} live streams in database`);
    
    for (const stream of liveStreams) {
      console.log(`\n--- Processing stream: ${stream.id} ---`);
      console.log(`Title: ${stream.title}`);
      console.log(`Status: ${stream.status}`);
      console.log(`Start time: ${stream.start_time}`);
      
      // Update status to offline
      try {
        await Stream.updateStatus(stream.id, 'offline', stream.user_id);
        console.log(`✓ Updated stream ${stream.id} status to offline`);
      } catch (error) {
        console.error(`✗ Error updating stream status: ${error.message}`);
      }
    }
    
    // Kill any remaining FFmpeg processes
    console.log('\n--- Killing FFmpeg processes ---');
    
    if (process.platform === 'win32') {
      // Windows
      try {
        const taskkill = spawn('taskkill', ['/f', '/im', 'ffmpeg.exe'], {
          stdio: 'pipe'
        });
        
        taskkill.stdout.on('data', (data) => {
          console.log(`Taskkill output: ${data}`);
        });
        
        taskkill.stderr.on('data', (data) => {
          console.log(`Taskkill error: ${data}`);
        });
        
        taskkill.on('close', (code) => {
          if (code === 0) {
            console.log('✓ Successfully killed FFmpeg processes on Windows');
          } else {
            console.log(`✗ Taskkill exited with code ${code}`);
          }
        });
      } catch (error) {
        console.error(`✗ Error killing FFmpeg processes: ${error.message}`);
      }
    } else {
      // Unix-like systems
      try {
        const pkill = spawn('pkill', ['-f', 'ffmpeg'], {
          stdio: 'pipe'
        });
        
        pkill.stdout.on('data', (data) => {
          console.log(`Pkill output: ${data}`);
        });
        
        pkill.stderr.on('data', (data) => {
          console.log(`Pkill error: ${data}`);
        });
        
        pkill.on('close', (code) => {
          if (code === 0) {
            console.log('✓ Successfully killed FFmpeg processes on Unix');
          } else {
            console.log(`✗ Pkill exited with code ${code}`);
          }
        });
      } catch (error) {
        console.error(`✗ Error killing FFmpeg processes: ${error.message}`);
      }
    }
    
    console.log('\n=== FORCE STOP COMPLETED ===');
    console.log('All streams have been marked as offline');
    console.log('FFmpeg processes have been killed');
    console.log('You may need to restart the streaming service');
    
  } catch (error) {
    console.error('Error during force stop:', error);
  } finally {
    // Close database connection
    db.close((err) => {
      if (err) {
        console.error('Error closing database:', err.message);
      } else {
        console.log('Database connection closed');
      }
      process.exit(0);
    });
  }
}

// Run the force stop
forceStopAllStreams();
