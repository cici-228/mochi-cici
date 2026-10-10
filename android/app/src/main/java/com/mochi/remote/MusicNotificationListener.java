package com.mochi.remote;

import android.service.notification.NotificationListenerService;

public class MusicNotificationListener extends NotificationListenerService {
    @Override public void onListenerConnected() { MainActivity.requestVisibleRefresh(); }
    @Override public void onListenerDisconnected() { MainActivity.requestVisibleRefresh(); }
}
