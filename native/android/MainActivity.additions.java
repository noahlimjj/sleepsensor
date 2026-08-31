// android/app/src/main/java/app/sleepsensor/monitor/MainActivity.java
//
// Register the custom plugin. After `npx cap add android` the generated
// MainActivity extends BridgeActivity — add the registerPlugin call:

package app.sleepsensor.monitor;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BackgroundRecorderPlugin.class);   // <-- add this line
        super.onCreate(savedInstanceState);
    }
}
