const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Path to database
const dbPath = path.join(__dirname, 'db', 'streamflow.db');

// Connect to database
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
    return;
  }
  console.log('Connected to database');
});

// Function to clean up ungrouped keys
function cleanupUngroupedKeys() {
  console.log('Starting cleanup of ungrouped stream keys...');
  
  // First, let's see what we have
  db.all(`
    SELECT sk.id, sk.name, sk.group_id, skg.name as group_name
    FROM stream_keys sk
    LEFT JOIN stream_key_groups skg ON sk.group_id = skg.id
    WHERE sk.group_id IS NOT NULL AND skg.id IS NULL
  `, [], (err, orphanedKeys) => {
    if (err) {
      console.error('Error finding orphaned keys:', err.message);
      return;
    }
    
    console.log(`Found ${orphanedKeys.length} orphaned stream keys:`);
    orphanedKeys.forEach(key => {
      console.log(`- ${key.name} (ID: ${key.id}, group_id: ${key.group_id})`);
    });
    
    if (orphanedKeys.length === 0) {
      console.log('No orphaned keys found. Database is clean!');
      db.close();
      return;
    }
    
    // Ask for confirmation
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question(`\nDo you want to delete these ${orphanedKeys.length} orphaned stream keys? (yes/no): `, (answer) => {
      if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
        // Delete orphaned keys
        const deleteQuery = `
          DELETE FROM stream_keys 
          WHERE group_id IS NOT NULL 
          AND group_id NOT IN (SELECT id FROM stream_key_groups)
        `;
        
        db.run(deleteQuery, [], function(err) {
          if (err) {
            console.error('Error deleting orphaned keys:', err.message);
          } else {
            console.log(`Successfully deleted ${this.changes} orphaned stream keys!`);
          }
          
          rl.close();
          db.close();
        });
      } else {
        console.log('Cleanup cancelled.');
        rl.close();
        db.close();
      }
    });
  });
}

// Run cleanup
cleanupUngroupedKeys();
