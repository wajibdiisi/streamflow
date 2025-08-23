# Stream Monitor - Panduan Penggunaan

## Overview

Stream Monitor adalah fitur baru yang ditambahkan untuk mengatasi masalah streaming yang sering terjadi:
- Duplikasi FFmpeg process
- Timer reset setiap restart
- Stream tidak berhenti setelah durasi habis

## Fitur Utama

### 1. Runtime Tracking
- Melacak total waktu stream berjalan secara kumulatif
- Tidak ada reset timer saat restart
- Durasi yang akurat berdasarkan runtime sebenarnya

### 2. Process Management
- Mencegah duplikasi FFmpeg process
- Graceful termination dengan timeout
- Force kill jika diperlukan

### 3. Real-time Monitoring
- Dashboard dengan informasi runtime
- Status indicators dengan warna
- API endpoints untuk monitoring

## Cara Penggunaan

### 1. Dashboard Monitoring

Setelah login ke aplikasi, Anda akan melihat informasi tambahan di dashboard:

- **Runtime Display**: Menampilkan total runtime dan remaining time
- **Status Indicators**: 
  - 🟢 Hijau: Stream berjalan normal
  - 🟠 Oranye: Stream akan berakhir dalam 10 menit
  - 🔴 Merah: Durasi sudah habis
  - 🟡 Kuning: Scheduled termination

### 2. Tombol Reset Timer

Jika terjadi masalah dengan timer, Anda dapat menggunakan tombol "Reset Timer":
1. Klik tombol "Reset Timer" pada stream card
2. Konfirmasi reset
3. Stream akan berhenti dan timer di-reset

### 3. API Endpoints

#### Cek Runtime Stream
```bash
GET /api/streams/{streamId}/runtime
```

Response:
```json
{
  "success": true,
  "runtimeInfo": {
    "currentSessionRuntime": 300000,
    "totalRuntime": 1800000,
    "currentSessionRuntimeMinutes": 5,
    "totalRuntimeMinutes": 30
  },
  "isActive": true,
  "hasScheduledTermination": true,
  "stream": {
    "id": "stream-123",
    "title": "My Stream",
    "duration": 60,
    "start_time": "2024-01-01T10:00:00Z",
    "status": "live"
  }
}
```

#### Reset Timer Stream
```bash
POST /api/streams/{streamId}/reset-runtime
```

#### Status Semua Stream Aktif
```bash
GET /api/streams/active/status
```

## Command Line Tools

### 1. Testing Script

Untuk testing fitur monitoring:

```bash
# Test dengan default URL (localhost:7575)
npm run test-monitor

# Test dengan custom URL
node test-stream-monitor.js http://your-server:7575
```

### 2. Real-time Monitor

Untuk monitoring real-time:

```bash
# Monitor dengan default URL
npm run monitor

# Monitor dengan custom URL
node monitor-streams.js http://your-server:7575
```

Commands dalam monitor:
- `status` atau `s` - Tampilkan status saat ini
- `refresh` atau `r` - Refresh status
- `help` atau `h` - Tampilkan bantuan
- `quit` atau `q` - Keluar dari monitor

## Troubleshooting

### 1. Stream Tidak Restart

**Gejala**: Stream crash tapi tidak restart otomatis

**Solusi**:
1. Cek logs untuk error messages
2. Verifikasi stream masih ada di database
3. Cek apakah sudah melebihi total durasi
4. Gunakan tombol "Reset Timer" jika diperlukan

### 2. Duplikasi Process

**Gejala**: Multiple FFmpeg process untuk stream yang sama

**Solusi**:
1. Gunakan `GET /api/streams/active/status` untuk cek
2. Reset runtime jika diperlukan
3. Restart aplikasi jika masalah persist

### 3. Timer Tidak Akurat

**Gejala**: Durasi stream tidak sesuai dengan yang diinginkan

**Solusi**:
1. Cek runtime info dengan API
2. Reset timer jika diperlukan
3. Verifikasi durasi di database

## Monitoring Dashboard

### 1. Runtime Information

Setiap stream card akan menampilkan:
```
Total: 45m | Session: 15m | Remaining: 15m
```

- **Total**: Total waktu stream berjalan (kumulatif)
- **Session**: Waktu stream berjalan dalam session ini
- **Remaining**: Sisa waktu berdasarkan durasi yang ditentukan

### 2. Status Colors

- **🟢 Green**: Stream berjalan normal, durasi masih cukup
- **🟠 Orange**: Stream akan berakhir dalam 10 menit
- **🔴 Red**: Durasi sudah habis, stream seharusnya berhenti
- **🟡 Yellow**: Stream scheduled untuk berhenti

## Advanced Configuration

### 1. Retry Settings

Di `services/streamingService.js`:
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

## Logs dan Debugging

### 1. Stream Logs

Setiap stream memiliki logs yang detail:
```
[StreamingService] Starting stream with 15 minutes remaining out of 60 total
[StreamingService] Stream session runtime: 15min, Total runtime: 45min
[StreamingService] Stream exceeded total duration, not restarting
```

### 2. Process Management Logs

```
[StreamingService] Stream already has an active process, killing existing one...
[StreamingService] Force killed FFmpeg process after timeout
```

### 3. Scheduler Logs

```
[SchedulerService] Scheduling termination for stream after 15 minutes (remaining)
[SchedulerService] Stream exceeded duration, stopping now
```

## Best Practices

### 1. Monitoring Regular

- Gunakan dashboard untuk monitoring rutin
- Cek status stream setiap beberapa jam
- Monitor logs untuk error patterns

### 2. Maintenance

- Reset timer jika terjadi masalah
- Restart aplikasi jika ada masalah persist
- Backup database secara regular

### 3. Performance

- Monitor CPU dan memory usage
- Cek network bandwidth
- Optimize video settings jika diperlukan

## Support

Jika mengalami masalah:

1. **Cek logs** terlebih dahulu
2. **Gunakan API endpoints** untuk debugging
3. **Reset timer** jika diperlukan
4. **Restart aplikasi** jika masalah persist
5. **Buat issue** dengan detail logs dan error messages

## Changelog

### v2.1.0 - Stream Monitor
- ✅ Runtime tracking system
- ✅ Process management improvements
- ✅ Real-time monitoring dashboard
- ✅ API endpoints untuk monitoring
- ✅ Command line tools
- ✅ Enhanced logging dan debugging
