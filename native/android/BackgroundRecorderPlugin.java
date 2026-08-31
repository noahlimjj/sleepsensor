package app.sleepsensor.monitor;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.media.AudioFocusRequest;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.PermissionState;

/*
 * BackgroundRecorder (Android) — keeps SleepSensor recording while the screen
 * is locked by running a foreground Service (persistent notification) and a
 * partial wake lock. The WebView / AudioContext keep running because the
 * process hosts a foreground service. Also brokers battery-optimisation
 * exemption and audio-focus interruptions.
 *
 * Copy into android/app/src/main/java/app/sleepsensor/monitor/ after
 * `npx cap add android`, register it in MainActivity, and add the permissions
 * + <service> to AndroidManifest.xml (see docs/CAPACITOR.md).
 */
@CapacitorPlugin(
    name = "BackgroundRecorder",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class BackgroundRecorderPlugin extends Plugin {

    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        switch (change) {
            case AudioManager.AUDIOFOCUS_LOSS:
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                notifyListeners("interruptionBegan", new JSObject());
                break;
            case AudioManager.AUDIOFOCUS_GAIN:
                notifyListeners("interruptionEnded", new JSObject());
                break;
        }
    };

    @Override
    public void load() {
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    @PluginMethod
    public void start(PluginCall call) {
        String title = call.getString("title", "SleepSensor");
        String text = call.getString("text", "Monitoring your sleep…");

        Intent i = new Intent(getContext(), RecordingService.class);
        i.setAction(RecordingService.ACTION_START);
        i.putExtra("title", title);
        i.putExtra("text", text);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(i);
        } else {
            getContext().startService(i);
        }
        requestAudioFocus();

        JSObject r = new JSObject();
        r.put("started", true);
        call.resolve(r);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        abandonAudioFocus();
        Intent i = new Intent(getContext(), RecordingService.class);
        i.setAction(RecordingService.ACTION_STOP);
        getContext().startService(i);
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        Intent i = new Intent(getContext(), RecordingService.class);
        i.setAction(RecordingService.ACTION_UPDATE);
        i.putExtra("text", call.getString("text", ""));
        getContext().startService(i);
        call.resolve();
    }

    @PluginMethod
    public void isBatteryOptimizationExempt(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        boolean exempt = Build.VERSION.SDK_INT < Build.VERSION_CODES.M
            || pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        JSObject r = new JSObject();
        r.put("exempt", exempt);
        call.resolve(r);
    }

    @PluginMethod
    public void requestBatteryOptimizationExemption(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
        } catch (Exception e) {
            // some OEMs block the direct intent — fall back to the settings screen
            Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
        }
        isBatteryOptimizationExempt(call);
    }

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        JSObject r = new JSObject();
        r.put("microphone", getPermissionState("microphone") == PermissionState.GRANTED ? "granted" : "prompt");
        call.resolve(r);
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        requestAllPermissions(call, "permsCallback");
    }

    // ---- audio focus (interruptions) -------------------------------
    private void requestAudioFocus() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attrs)
                .setWillPauseWhenDucked(false)
                .setOnAudioFocusChangeListener(focusListener)
                .build();
            audioManager.requestAudioFocus(focusRequest);
        } else {
            audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
    }

    private void abandonAudioFocus() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
            audioManager.abandonAudioFocusRequest(focusRequest);
        } else {
            audioManager.abandonAudioFocus(focusListener);
        }
    }
}
