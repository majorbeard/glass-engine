package com.glass.example.producer;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

// Two separate permission gates stand between src/producer.ts's plain
// getUserMedia() call and a real camera frame, and both have to be
// satisfied - found live, the hard way, when a first real-device test
// failed with Chromium's classic "Could not start video source"
// (NotReadableError) despite the CAMERA permission being declared in the
// manifest:
//
//   1. The OS-level RUNTIME permission (android.permission.CAMERA) - a
//      "dangerous" permission on API 23+, which requires an explicit
//      runtime request (a real system dialog) separate from the manifest
//      declaration. Without this actually being granted, the camera
//      hardware refuses to open for this process at all, regardless of
//      what the WebView itself does - this is what onCreate below fixes.
//   2. The WebView-level in-page permission (WebChromeClient.
//      onPermissionRequest) - Capacitor's own Bridge doesn't auto-grant a
//      raw getUserMedia() call the way it does for native plugins - this
//      is what onStart below fixes, unchanged from before this file's
//      first version.
//
// Both are required; neither alone is sufficient. Requested eagerly in
// onCreate (not lazily on first getUserMedia failure) so the real system
// dialog has already been resolved by the time a user gets through the
// UI and taps "Start streaming."
//
// RECORD_AUDIO needs the exact same gate-1 treatment as CAMERA - found
// live the same way, a real device test: producer.ts's own
// getUserMedia({video,audio}) call silently degraded to its video-only
// fallback (by design - see that file's own doc comment) because the OS
// runtime permission was never requested, not because the mic was denied
// outright. Requesting both up front in one system dialog, rather than
// camera-then-mic sequentially, avoids a second interruption once the
// user's already past the first prompt.
public class MainActivity extends BridgeActivity {
    private final ActivityResultLauncher<String[]> requestMediaPermissions =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), grantResults -> {
                // No action needed here - once granted, the camera/mic open
                // normally for any subsequent getUserMedia call. If the
                // user denies either, getUserMedia will fail or fall back
                // (producer.ts's own catch/onStateChange path), not hang
                // silently.
            });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        java.util.List<String> missing = new java.util.ArrayList<>();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.CAMERA);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.RECORD_AUDIO);
        }
        // POST_NOTIFICATIONS is itself a runtime "dangerous" permission on
        // API 33+ - denying it doesn't stop StreamingForegroundService from
        // actually protecting the process (startForeground() still works),
        // it just means the operator won't see the "streaming" notification
        // explaining why. Still worth asking for up front alongside the
        // others rather than leaving that notification silently missing.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!missing.isEmpty()) {
            requestMediaPermissions.launch(missing.toArray(new String[0]));
        }

        // See StreamingForegroundService's own doc comment - started for
        // this Activity's whole lifetime (stopped in onDestroy below), not
        // scoped precisely to actual streaming state, since this example
        // app's only purpose is producing a stream.
        Intent serviceIntent = new Intent(this, StreamingForegroundService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent);
        } else {
            startService(serviceIntent);
        }
    }

    @Override
    public void onDestroy() {
        stopService(new Intent(this, StreamingForegroundService.class));
        super.onDestroy();
    }

    @Override
    public void onStart() {
        super.onStart();
        getBridge().getWebView().setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });
    }
}
