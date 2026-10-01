package com.glass.example.call;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

// Without this, the app's whole WebRTC session (camera+mic capture, the
// producer's own RTCPeerConnection) dies the moment the Activity leaves the
// foreground - found live (2026-09-10): Android's background execution
// limits kill/throttle a plain Activity's process and its camera/mic
// sessions well before the operator can even switch to a messaging app to
// actually share the session's watch link, making that ordinary, expected
// phone workflow ("start streaming, then go share the link") impossible.
// A foreground service with a real, visible notification is Android's own
// documented mechanism for exempting genuinely ongoing work - a live
// stream, a call, a recording - from those limits. Started for the whole
// time MainActivity exists (see its onCreate/onDestroy) rather than
// precisely bracketing actual streaming state, since this example app's
// only purpose is producing a stream in the first place - not worth a
// separate JS<->native bridge call just to start/stop it more precisely.
public class StreamingForegroundService extends Service {
    private static final String CHANNEL_ID = "glass-streaming";
    private static final int NOTIFICATION_ID = 1;

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Glass streaming", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shown while this device is streaming to a Glass session.");
            NotificationManager manager = getSystemService(NotificationManager.class);
            manager.createNotificationChannel(channel);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Intent launchIntent = new Intent(this, MainActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, 0, launchIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Glass Call")
                .setContentText("In a call - camera and mic are active")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .build();

        // FOREGROUND_SERVICE_TYPE_CAMERA|MICROPHONE - required as of Android
        // 14 (targetSdkVersion 34, see android/variables.gradle) for any
        // foreground service that itself uses the camera/mic, matching the
        // manifest's own <service> foregroundServiceType declaration. The
        // type constants themselves live directly on the platform's
        // android.content.pm.ServiceInfo (added API 29/30), not a separate
        // androidx compat class - referencing them here is still safe on
        // minSdkVersion 22 devices, since they're plain int constants
        // (inlined at compile time) and ServiceCompat.startForeground below
        // is what actually handles falling back to the 2-arg platform call
        // on pre-Android-10 devices, where this type argument is simply
        // unsupported/ignored.
        ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                        | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);

        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
