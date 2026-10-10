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

/** Keeps the WebView's pending chat work moving while this personal-use app is in the background. */
public final class ChatKeepAliveService extends Service {
    static final String ACTION_READY = "com.mochi.remote.CHAT_READY";
    static final String ACTION_BACKGROUND = "com.mochi.remote.CHAT_BACKGROUND";
    static final String ACTION_FOREGROUND = "com.mochi.remote.CHAT_FOREGROUND";
    private static final String CHANNEL = "cici_chat_background";
    private static final int NOTIFICATION_ID = 1008;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!background) return;
            MainActivity.requestBackgroundChatTick();
            handler.postDelayed(this, 2000);
        }
    };
    private PowerManager.WakeLock wakeLock;
    private boolean background;
    private boolean foregroundService;

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(
            CHANNEL, "后台聊天", NotificationManager.IMPORTANCE_LOW));
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_READY : intent.getAction();
        if (!foregroundService) {
            Notification notification = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setContentTitle("CiCi传讯")
                .setContentText("后台消息运行中")
                .setOngoing(true)
                .build();
            startForeground(NOTIFICATION_ID, notification);
            foregroundService = true;
        }
        if (ACTION_BACKGROUND.equals(action)) {
            background = true;
            try {
                if (wakeLock == null) {
                    PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
                    wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CiCi:BackgroundChat");
                    wakeLock.setReferenceCounted(false);
                }
                if (!wakeLock.isHeld()) wakeLock.acquire();
            } catch (Exception ignored) {}
            handler.removeCallbacks(tick);
            handler.post(tick);
        } else if (ACTION_FOREGROUND.equals(action) || ACTION_READY.equals(action)) {
            background = false;
            handler.removeCallbacks(tick);
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        }
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        background = false;
        handler.removeCallbacks(tick);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
