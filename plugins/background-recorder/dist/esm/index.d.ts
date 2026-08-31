export interface BackgroundRecorderPlugin {
  start(options: { title?: string; text?: string }): Promise<{ started: boolean }>;
  stop(): Promise<void>;
  update(options: { text: string }): Promise<void>;
  checkPermissions(): Promise<{ microphone: string }>;
  requestPermissions(): Promise<{ microphone: string }>;
  isBatteryOptimizationExempt(): Promise<{ exempt: boolean }>;
  requestBatteryOptimizationExemption(): Promise<{ exempt: boolean }>;
}
export declare const BackgroundRecorder: BackgroundRecorderPlugin;
