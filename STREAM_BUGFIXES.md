# Stream Bug Fixes & Improvements

## Masalah yang Diperbaiki

### 1. Duplikasi FFmpeg Process
**Masalah**: Ketika ffmpeg crash dan restart, terkadang process lama masih berjalan sehingga terjadi duplikasi.

**Solusi**:
- Menambahkan pengecekan process yang sedang berjalan sebelum start stream baru
- Implementasi `safeKillProcess()` untuk memastikan process lama benar-benar berhenti
- Menambahkan tracking untuk active streams dengan Map

### 2. Timer Reset Setiap Restart
**Masalah**: Setiap kali stream restart karena crash, timer durasi di-reset dari awal, sehingga total durasi menjadi jauh lebih besar dari yang diinginkan.

**Solusi**:
- Implementasi runtime tracking yang melacak total waktu stream berjalan
- Menyimpan runtime kumulatif di `streamTotalRuntime` Map
- Menghitung remaining duration berdasarkan total runtime yang sudah berjalan
- Timer termination di-schedule berdasarkan remaining duration, bukan original duration

### 3. Stream Tidak Berhenti Setelah Durasi Habis
**Masalah**: Karena timer reset, stream bisa berjalan terus meskipun sudah melebihi durasi yang ditentukan.

**Solusi**:
- Pengecekan total runtime sebelum restart stream
- Stream tidak akan restart jika sudah melebihi total durasi
- Integrasi dengan scheduler service untuk monitoring durasi yang lebih akurat

## Fitur Baru yang Ditambahkan

### 1. Runtime Tracking System
```javascript
// Tracking runtime per session dan total
const streamStartTimes = new Map(); // Waktu start per session
const streamTotalRuntime = new Map(); // Total runtime kumulatif
```

### 2. Process Management yang Lebih Baik
```javascript
// Fungsi untuk memastikan process lama berhenti
async function safeKillProcess(process, streamId) {
  // Graceful termination dengan timeout
  // Force kill jika diperlukan
}
```

### 3. API Endpoints Baru
- `/api/streams/:id/runtime` - Mendapatkan informasi runtime stream
- `/api/streams/:id/reset-runtime` - Reset timer stream (untuk debugging)
- `/api/streams/active/status` - Status semua stream aktif dengan runtime info

### 4. Frontend Monitoring
- File `public/js/stream-monitor.js` untuk monitoring real-time
- Display runtime information di dashboard
- Tombol reset timer untuk debugging
- Status indicators dengan warna yang berbeda

## Cara Kerja Sistem Baru

### 1. Start Stream
```javascript
// 1. Cek apakah ada process lama yang masih berjalan
if (activeStreams.has(streamId)) {
  await safeKillProcess(existingProcess, streamId);
}

// 2. Hitung remaining duration
const totalRuntime = streamTotalRuntime.get(streamId) || 0;
const remainingDuration = Math.max(0, originalDuration - totalRuntime);

// 3. Schedule termination dengan remaining duration
schedulerService.scheduleStreamTermination(streamId, remainingMinutes);
```

### 2. Runtime Tracking
```javascript
// Setiap session stream
ffmpegProcess.on('exit', async (code, signal) => {
  // Hitung runtime session ini
  const sessionRuntime = Date.now() - sessionStartTime;
  
  // Tambahkan ke total runtime
  const currentTotal = streamTotalRuntime.get(streamId) || 0;
  streamTotalRuntime.set(streamId, currentTotal + sessionRuntime);
  
  // Cek apakah sudah melebihi total durasi
  if (totalRuntime >= maxDurationMs) {
    // Jangan restart, stop stream
    return;
  }
});
```

### 3. Scheduler Integration
```javascript
// Scheduler menggunakan runtime tracking untuk durasi yang akurat
const runtimeInfo = streamingService.getStreamRuntimeInfo(streamId);
if (runtimeInfo && runtimeInfo.totalRuntimeMinutes >= stream.duration) {
  // Stream sudah melebihi durasi, stop sekarang
  await streamingService.stopStream(streamId);
}
```

## Monitoring dan Debugging

### 1. Logs yang Ditingkatkan
- Tracking runtime per session dan total
- Informasi remaining duration
- Process management logs

### 2. Frontend Monitoring
- Real-time runtime display
- Status indicators dengan warna
- Tombol reset untuk debugging

### 3. API Monitoring
```bash
# Cek runtime stream tertentu
GET /api/streams/{streamId}/runtime

# Reset timer stream
POST /api/streams/{streamId}/reset-runtime

# Status semua stream aktif
GET /api/streams/active/status
```

## Konfigurasi dan Tuning

### 1. Retry Settings
```javascript
const MAX_RETRY_ATTEMPTS = 3; // Maksimal restart attempts
const RESTART_DELAY = 3000; // Delay sebelum restart (3 detik)
```

### 2. Process Termination
```javascript
const GRACEFUL_TERMINATION_TIMEOUT = 5000; // 5 detik untuk graceful termination
```

### 3. Monitoring Intervals
```javascript
// Update status setiap 30 detik
setInterval(() => {
  this.updateActiveStreamsStatus();
}, 30000);

// Sync stream statuses setiap 5 menit
setInterval(syncStreamStatuses, 5 * 60 * 1000);
```

## Testing

### 1. Test Crash Recovery
- Simulasi ffmpeg crash dengan SIGSEGV
- Verifikasi restart dengan remaining duration
- Cek tidak ada duplikasi process

### 2. Test Duration Limits
- Stream dengan durasi 10 menit
- Simulasi crash setelah 5 menit
- Verifikasi restart dengan 5 menit remaining
- Verifikasi stop otomatis setelah total 10 menit

### 3. Test Process Management
- Start multiple streams
- Simulasi crash dan restart
- Verifikasi tidak ada zombie processes

## Troubleshooting

### 1. Stream Tidak Restart
- Cek logs untuk error messages
- Verifikasi stream masih ada di database
- Cek apakah sudah melebihi total durasi

### 2. Duplikasi Process
- Gunakan `GET /api/streams/active/status` untuk cek
- Reset runtime jika diperlukan
- Restart aplikasi jika masalah persist

### 3. Timer Tidak Akurat
- Cek runtime info dengan API
- Reset timer jika diperlukan
- Verifikasi durasi di database

## Kesimpulan

Perbaikan ini mengatasi masalah utama:
1. **Duplikasi Process** - Dengan process management yang lebih baik
2. **Timer Reset** - Dengan runtime tracking kumulatif
3. **Stream Tidak Berhenti** - Dengan durasi monitoring yang akurat

Sistem sekarang lebih robust dan dapat menangani crash ffmpeg dengan lebih baik, sambil mempertahankan durasi stream yang akurat.
