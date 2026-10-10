package com.mochi.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

public final class PlaybackKeepAliveService extends Service {
    static final String ACTION_PLAY = "com.mochi.remote.PLAYBACK_ACTIVE";
    static final String ACTION_STOP = "com.mochi.remote.PLAYBACK_STOP";
    private static final String CHANNEL = "cici_music_playback";
    private static final int NOTIFICATION_ID = 1007;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable delayedStop = this::stopNow;
    private PowerManager.WakeLock wakeLock;
    private boolean foreground;

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "音乐播放", NotificationManager.IMPORTANCE_LOW));
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        handler.removeCallbacks(delayedStop);
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            // 切歌取新音源时会短暂停顿；保留服务一小段时间，避免后台重新启动受限。
            handler.postDelayed(delayedStop, 15000);
            return START_NOT_STICKY;
        }
        Notification notification = new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("CiCi传讯")
            .setContentText("正在播放音乐")
            .setOngoing(true)
            .build();
        try {
            if (!foreground) { startForeground(NOTIFICATION_ID, notification); foreground = true; }
            if (wakeLock == null) {
                PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
                wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CiCi:MusicPlayback");
                wakeLock.setReferenceCounted(false);
            }
            if (!wakeLock.isHeld()) wakeLock.acquire();
        } catch (Exception error) { stopNow(); }
        return START_NOT_STICKY;
    }

    private void stopNow() {
        handler.removeCallbacks(delayedStop);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (foreground) { stopForeground(true); foreground = false; }
        stopSelf();
    }

    @Override public void onDestroy() {
        handler.removeCallbacks(delayedStop);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
