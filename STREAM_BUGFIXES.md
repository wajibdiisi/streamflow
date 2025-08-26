# Stream Bug Fixes - August 26, 2025

## Issues Fixed

### 4. Stream Restart After Duration Exceeded (REVISED)
**Problem**: Stream yang sudah mencapai durasi maksimum dan berhasil dihentikan oleh scheduler malah restart lagi karena FFmpeg exit dengan error code non-zero (seperti code 255). Ini menyebabkan stream yang seharusnya sudah selesai malah berjalan lagi.

**Root Cause**: 
Pada fungsi `handleStreamExit` di `streamingService.js`, pengecekan durasi maksimum hanya dilakukan di awal fungsi, tapi tidak dilakukan lagi ketika menangani error code non-zero atau SIGSEGV. Akibatnya:

1. Stream berhasil dihentikan oleh scheduler setelah mencapai durasi maksimum
2. Stream history disimpan dengan durasi yang benar
3. Tapi kemudian FFmpeg exit dengan error code (misal 255)
4. Sistem menganggap ini sebagai error dan mencoba restart tanpa mengecek durasi lagi
5. Stream restart dan berjalan lagi

**Solution**:
Menambahkan pengecekan durasi maksimum pada semua kondisi restart dengan pendekatan yang lebih seimbang:

1. **SIGSEGV handling**: Tambah pengecekan durasi sebelum restart, allow restart sampai 30 menit runtime
2. **Error code handling**: Tambah pengecekan durasi sebelum restart, hanya restart untuk error code yang recoverable (1, 255) sampai 60 menit runtime

**Code Changes**:
```javascript
// Pada bagian SIGSEGV handling
if (signal === 'SIGSEGV') {
  // Check if stream has exceeded total duration before attempting restart
  const currentTotalRuntime = streamTotalRuntime.get(streamId) || 0;
  const currentStream = await Stream.findById(streamId);
  if (currentStream && currentStream.duration) {
    const maxDurationMs = currentStream.duration * 60 * 1000;
    if (currentTotalRuntime >= maxDurationMs) {
      console.log(`[StreamingService] Stream ${streamId} has exceeded total duration (${Math.floor(currentTotalRuntime/60000)}min >= ${currentStream.duration}min), not restarting due to SIGSEGV`);
      // ... handle offline status
      return;
    }
  }
  
  // Allow restart for longer runtime for SIGSEGV (crash) as it's usually a system issue
  const allowRestart = runtimeInfo.totalRuntimeMinutes < 30; // Increased from 10 to 30 minutes for crashes
  // ... existing restart logic
}

// Pada bagian error code handling
else {
  if (code !== 0 && code !== null) {
    // Only restart for certain error codes that are likely recoverable
    // Error code 1 often means "End of file" which can be temporary
    const isRecoverableError = code === 1 || code === 255; // Common recoverable errors
    
    if (isRecoverableError) {
      // Allow restart for longer runtime if it's a recoverable error
      const allowRestart = runtimeInfo.totalRuntimeMinutes < 60; // Increased from 10 to 60 minutes
      // ... existing restart logic
    } else {
      console.log(`[StreamingService] Stream ${streamId} exited with non-recoverable error code ${code}, not restarting`);
    }
  }
}
```

**Testing**:
- Stream yang mencapai durasi maksimum tidak akan restart meskipun FFmpeg exit dengan error
- Stream yang crash sebelum mencapai durasi maksimum masih bisa restart (sampai 30 menit runtime)
- Stream dengan error code recoverable (1, 255) bisa restart sampai 60 menit runtime
- Stream dengan error code non-recoverable tidak akan restart
- Log akan menunjukkan alasan yang jelas mengapa stream tidak restart

**Files Modified**:
- `services/streamingService.js`

**Revision Notes**:
- Versi awal terlalu agresif dan menyebabkan stream berhenti tiba-tiba
- Versi revisi lebih seimbang dengan membedakan error code recoverable vs non-recoverable
- Meningkatkan batas runtime untuk restart dari 10 menit menjadi 30-60 menit tergantung jenis error

---

### 1. Stream Cannot Be Stopped (Duration Exceeded)
**Problem**: Stream yang sudah melebihi durasi maksimum tidak bisa dihentikan, menyebabkan program mencoba menghentikan stream yang sama berkali-kali.

**Root Cause**: 
- Race condition di `checkStreamDurations()` yang dipanggil setiap menit
- Tidak ada flag untuk mencegah multiple stop attempts
- FFmpeg process tidak benar-benar berhenti meskipun sudah dikirim signal

**Solution**:
- Menambahkan `streamsBeingStopped` Set untuk track stream yang sedang dihentikan
- Mencegah duplicate stop attempts dengan flag checking
- Memperbaiki process killing dengan timeout dan fallback ke SIGKILL
- Menambahkan event listener untuk process exit

### 2. Inconsistent Stream Status
**Problem**: Stream ditandai sebagai 'live' di database tapi tidak aktif di memory, atau sebaliknya.

**Root Cause**:
- Stream status tidak sinkron antara memory dan database
- Cleanup tidak lengkap ketika process exit unexpectedly
- Tidak ada handling untuk orphaned processes

**Solution**:
- Memperbaiki `syncStreamStatuses()` dengan better cleanup logic
- Menambahkan `cleanupZombieProcesses()` untuk membersihkan dead processes
- Menambahkan process exit event listeners
- Better handling untuk streams yang sedang dihentikan

### 3. Duplicate Stop Attempts
**Problem**: Program mencoba menghentikan stream yang sama berkali-kali dalam interval yang pendek.

**Root Cause**:
- `checkStreamDurations()` tidak memeriksa apakah stream sudah dihentikan
- Tidak ada debouncing mechanism

**Solution**:
- Menambahkan flag `streamsBeingStopped` untuk mencegah duplicate attempts
- Skip streams yang sudah memiliki scheduled termination
- Better error handling dan cleanup

## Code Changes Made

### services/schedulerService.js
- Menambahkan `streamsBeingStopped` Set
- Memperbaiki `checkStreamDurations()` dengan duplicate prevention
- Better error handling untuk stop attempts

### services/streamingService.js
- Memperbaiki `stopStream()` dengan better process management
- Menambahkan process exit event listeners
- Memperbaiki `syncStreamStatuses()` dengan comprehensive cleanup
- Menambahkan `cleanupZombieProcesses()` function
- Better memory cleanup untuk stopped streams

### force-stop-streams.js (New File)
- Script untuk force stop semua stream yang sedang berjalan
- Kill FFmpeg processes secara paksa
- Update database status ke offline

## How to Use

### 1. Apply the Fixes
Restart streaming service setelah menerapkan perbaikan:
```bash
# Stop current service
# Apply code changes
# Restart service
```

### 2. Force Stop Current Streams (if needed)
Jika masih ada stream yang tidak bisa dihentikan:
```bash
node force-stop-streams.js
```

### 3. Monitor Logs
Perhatikan log untuk memastikan:
- Stream berhenti dengan benar
- Tidak ada duplicate stop attempts
- Status stream sinkron antara memory dan database

## Prevention Measures

1. **Regular Cleanup**: Zombie process cleanup setiap 2 menit
2. **Status Sync**: Stream status sync setiap 5 menit
3. **Process Monitoring**: Event listeners untuk process exit
4. **Duplicate Prevention**: Flags untuk mencegah multiple stop attempts

## Testing

Setelah menerapkan perbaikan, test dengan:
1. Start stream dengan durasi pendek (1-2 menit)
2. Monitor apakah stream berhenti otomatis
3. Check logs untuk memastikan tidak ada duplicate attempts
4. Verify database status consistency

## Notes

- Perbaikan ini mengatasi masalah utama yang menyebabkan stream tidak bisa dihentikan
- Process killing sekarang lebih robust dengan timeout dan fallback
- Memory cleanup lebih comprehensive
- Status synchronization lebih reliable
