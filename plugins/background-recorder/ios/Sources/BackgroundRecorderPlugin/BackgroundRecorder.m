#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Registers the BackgroundRecorder Swift plugin with the Capacitor bridge.
// Copy this file next to BackgroundRecorder.swift in ios/App/App/.

CAP_PLUGIN(BackgroundRecorder, "BackgroundRecorder",
  CAP_PLUGIN_METHOD(start, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(stop, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(update, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(checkPermissions, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(requestPermissions, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(isBatteryOptimizationExempt, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(requestBatteryOptimizationExemption, CAPPluginReturnPromise);
)
