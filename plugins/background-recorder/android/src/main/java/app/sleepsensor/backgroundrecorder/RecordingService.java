package app.sleepsensor.backgroundrecorder;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/*
 * Foreground service that keeps the app process (and therefore the WebView's
 * audio pipeline) alive while the phone is locked. Holds a PARTIAL_WAKE_LOCK so
 * the CPU keeps running with the screen off.
 */
public class RecordingService extends Service {

    public static final String ACTION_START = "app.sleepsensor.START";
    public static final String ACTION_STOP = "app.sleepsensor.STOP";
    public static final String ACTION_UPDATE = "app.sleepsensor.UPDATE";

    private static final String CHANNEL_ID = "sleepsensor_monitoring";
    private static final int NOTIF_ID = 4711;

    private PowerManager.WakeLock wakeLock;
    private String title = "SleepSensor";

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;
        if (ACTION_STOP.equals(action)) {
            releaseWakeLock();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (intent != null && intent.hasExtra("title")) title = intent.getStringExtra("title");
        String text = intent != null && intent.getStringExtra("text") != null
            ? intent.getStringExtra("text") : "Monitoring your sleep…";

        Notification n = buildNotification(text);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIF_ID, n);
        }

        if (ACTION_UPDATE.equals(action)) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            nm.notify(NOTIF_ID, n);
        } else {
            acquireWakeLock();
        }
        // START_STICKY: if the OS kills us under memory pressure, restart the
        // service so recording resumes as soon as possible.
        return START_STICKY;
    }

    private Notification buildNotification(String text) {
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = PendingIntent.getActivity(
            this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));

        int icon = getResources().getIdentifier("ic_stat_name", "drawable", getPackageName());
        if (icon == 0) icon = android.R.drawable.ic_media_play;

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(icon)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pi)
            .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Sleep monitoring", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shows while SleepSensor is listening overnight");
            ch.setShowBadge(false);
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            nm.createNotificationChannel(ch);
        }
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SleepSensor::Monitoring");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(15 * 60 * 60 * 1000L); // 15h ceiling — the engine stops itself well before
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
