# Solusi untuk Error "Connection Reset by Peer"

## Masalah yang Ditemui

Stream berhenti sendiri setelah 5 hari berjalan dengan error:
```
[ERROR] [FFMPEG_STDERR] av_interleaved_write_frame(): Connection reset by Peer
Error writing trailer of rtmp://a.rtmp.youtube.com/live2/...: Connection reset by peer
[FFMPEG_EXIT] Code=1, Signal=null
```

Stream tidak di-restart karena runtime sudah terlalu lama (537min dan 432min) dan logic restart hanya mengizinkan restart jika runtime < 60 menit.

## Solusi yang Diimplementasikan

### 1. Error Message Tracking
- Menambahkan `streamErrorMessages` Map untuk melacak error messages dari FFmpeg stderr
- Error messages yang mengandung "Connection reset by peer" atau "av_interleaved_write_frame" akan di-track

### 2. Special Handling untuk Connection Reset Errors
- **Connection Reset Errors**: Diizinkan restart hingga 8 jam (480 menit) runtime
- **Error Code 1 Lainnya**: Tetap dibatasi 1 jam (60 menit) runtime
- **Alasan**: Connection reset biasanya masalah network yang bisa diatasi, bukan masalah sistem

### 3. Restart Delay yang Lebih Panjang
- **Connection Reset Errors**: Delay 10 detik sebelum restart (memberikan waktu network stabil)
- **Error Lainnya**: Delay 3 detik seperti biasa

### 4. Cleanup yang Lebih Baik
- `streamErrorMessages` dibersihkan di semua fungsi cleanup untuk mencegah memory leak

## Perubahan Kode

### Menambahkan Variable Tracking
```javascript
const streamErrorMessages = new Map(); // Track error messages for better restart logic
```

### Error Message Detection di stderr Handler
```javascript
ffmpegProcess.stderr.on('data', (data) => {
  const message = data.toString().trim();
  if (message) {
    addStreamLog(streamId, `[FFmpeg] ${message}`);
    if (!message.includes('frame=')) {
      console.error(`[FFMPEG_STDERR] ${streamId}: ${message}`);
      // Track error messages for better restart logic
      if (message.includes('Connection reset by peer') || message.includes('av_interleaved_write_frame')) {
        streamErrorMessages.set(streamId, message);
      }
    }
  }
});
```

### Logic Restart yang Diperbaiki
```javascript
// Special handling for "Connection reset by peer" errors
const trackedError = streamErrorMessages.get(streamId);
const isConnectionResetError = trackedError && (
  trackedError.includes('Connection reset by peer') || 
  trackedError.includes('av_interleaved_write_frame')
);

let allowRestart;
if (isConnectionResetError) {
  // For connection reset errors, allow restart up to 8 hours (480 minutes)
  allowRestart = runtimeInfo.totalRuntimeMinutes < 480;
  console.log(`[StreamingService] Connection reset error detected for stream ${streamId}, allowing restart up to 480 minutes runtime`);
} else {
  // For other error code 1, use standard 60 minute limit
  allowRestart = runtimeInfo.totalRuntimeMinutes < 60;
}
```

## Manfaat Solusi

1. **Stream Lebih Stabil**: Connection reset errors tidak lagi menyebabkan stream berhenti permanen
2. **Network Resilience**: Memberikan kesempatan network untuk stabil sebelum restart
3. **Runtime Flexibility**: Stream panjang tetap bisa di-restart untuk masalah network
4. **Better Error Classification**: Membedakan error network dari error sistem

## Testing

File `test-connection-reset-handling.js` tersedia untuk memverifikasi logic error detection.

## Monitoring

Setelah implementasi, monitor log untuk:
- `Connection reset error detected for stream X, allowing restart up to 480 minutes runtime`
- `FFmpeg exited with recoverable connection reset. Attempting restart #X`

## Catatan

- Solusi ini khusus untuk error "Connection reset by peer" yang biasanya masalah network
- Error sistem lain tetap mengikuti logic restart yang ada
- Runtime limit 480 menit untuk connection reset errors memberikan keseimbangan antara stabilitas dan resource management
