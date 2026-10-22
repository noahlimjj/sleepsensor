import { test, assert, assertEqual, near } from './lib.mjs';
import { ApneaDetector, classifyArousalAcoustics } from '../js/apnea-detector.js';

export async function run() {
  test('Arousal acoustics classifier handles dynamic range jumps', () => {
    const surge = classifyArousalAcoustics({ rms: 0.05, peak: 0.08 }, 0.001);
    assert(surge.isSurge, 'Identifies large dB jump as arousal surge');
    assert(surge.dbJump >= 20, 'Calculates correct dB jump');
    assert(surge.confidence >= 0.7, 'High confidence for explosive arousal');

    const quiet = classifyArousalAcoustics({ rms: 0.0012, peak: 0.0015 }, 0.001);
    assert(!quiet.isSurge, 'Quiet sound is not an arousal surge');
  });

  test('ApneaDetector ignores continuous snoring without pause', () => {
    const detector = new ApneaDetector();
    let emitted = null;
    let t = 10000;

    // 10 windows of continuous snoring
    for (let i = 0; i < 10; i++) {
      const ev = detector.feed({ type: 'snoring', confidence: 0.8 }, { rms: 0.02, peak: 0.04 }, t);
      if (ev) emitted = ev;
      t += 2000;
    }

    assertEqual(emitted, null, 'No apnea event during continuous snoring');
    assertEqual(detector.getEvents().length, 0, 'Zero events recorded');
  });

  test('ApneaDetector ignores brief pauses under 10 seconds', () => {
    const detector = new ApneaDetector();
    let t = 10000;

    // 3 snore windows (6 sec)
    for (let i = 0; i < 3; i++) {
      detector.feed({ type: 'snoring', confidence: 0.8 }, { rms: 0.02, peak: 0.04 }, t);
      t += 2000;
    }

    // 3 quiet windows (6 sec pause — less than 10s clinical cutoff)
    for (let i = 0; i < 3; i++) {
      detector.feed({ type: 'quiet', confidence: 0.9 }, { rms: 0.0008, peak: 0.001 }, t);
      t += 2000;
    }

    // Sound resumes
    const ev = detector.feed({ type: 'noise', confidence: 0.7 }, { rms: 0.04, peak: 0.06 }, t);
    assertEqual(ev, null, 'No apnea for pause under 10 seconds');
  });

  test('ApneaDetector detects full apnea cycle (Snore -> Pause >= 10s -> Gasp)', () => {
    const detector = new ApneaDetector();
    let t = 10000;

    // 4 snore windows (8 sec)
    for (let i = 0; i < 4; i++) {
      detector.feed({ type: 'snoring', confidence: 0.85 }, { rms: 0.025, peak: 0.05 }, t);
      t += 2000;
    }

    // 8 quiet windows = 16 seconds silence pause
    for (let i = 0; i < 8; i++) {
      detector.feed({ type: 'quiet', confidence: 0.95 }, { rms: 0.0006, peak: 0.0009 }, t);
      t += 2000;
    }

    // Sudden loud arousal gasp (jump from 0.0006 to 0.045)
    const event = detector.feed(
      { type: 'noise', confidence: 0.75 },
      { rms: 0.035, peak: 0.06, timestamp: 32 },
      t
    );

    assert(event !== null, 'Apnea event must be detected');
    assertEqual(event.type, 'apnea');
    assert(event.duration >= 14 && event.duration <= 18, `Duration ~16s, got ${event.duration}`);
    assertEqual(event.severity, 'low'); // < 20s is low severity
    assert(event.confidence >= 0.6, 'Confidence >= 0.6');
    assertEqual(detector.getEvents().length, 1);
  });

  test('ApneaDetector classifies severity based on pause duration', () => {
    const detector = new ApneaDetector();
    let t = 10000;

    // Snore
    for (let i = 0; i < 3; i++) {
      detector.feed({ type: 'snoring', confidence: 0.8 }, { rms: 0.02, peak: 0.04 }, t);
      t += 2000;
    }

    // 16 quiet windows = 32 seconds pause (high severity >= 30s)
    for (let i = 0; i < 16; i++) {
      detector.feed({ type: 'quiet', confidence: 0.9 }, { rms: 0.0005, peak: 0.0008 }, t);
      t += 2000;
    }

    const event = detector.feed(
      { type: 'snoring', confidence: 0.8 },
      { rms: 0.03, peak: 0.07 },
      t
    );

    assert(event !== null, 'Detected long apnea event');
    assertEqual(event.severity, 'high');
    assert(event.duration >= 30);
  });

  test('ApneaDetector.calculateAhiMetrics computes accurate AHI and severity tiers', () => {
    // 7 hour session with 2 pauses -> AHI = 0.3 (Optimal < 5)
    const optimalMetrics = ApneaDetector.calculateAhiMetrics(
      7 * 3600,
      [
        { type: 'apnea', duration: 15, startTime: 1000, endTime: 16000 },
        { type: 'apnea', duration: 22, startTime: 20000, endTime: 42000 },
      ]
    );
    assertEqual(optimalMetrics.totalPauses, 2);
    near(optimalMetrics.estimatedAhi, 0.3, 0.1);
    assertEqual(optimalMetrics.severity, 'normal');
    assertEqual(optimalMetrics.category, 'Optimal');
    assertEqual(optimalMetrics.longestPauseSec, 22);

    // 6 hour session with 48 pauses -> AHI = 8.0 (Mild 5-15)
    const mildPauses = Array.from({ length: 48 }, (_, i) => ({
      type: 'apnea',
      duration: 18,
      startTime: i * 400000,
      endTime: i * 400000 + 18000,
    }));
    const mildMetrics = ApneaDetector.calculateAhiMetrics(6 * 3600, mildPauses);
    near(mildMetrics.estimatedAhi, 8.0, 0.1);
    assertEqual(mildMetrics.severity, 'mild');
    assertEqual(mildMetrics.category, 'Mild Disruption');

    // Cross-correlation with bruxism
    const bruxismEvents = [
      { type: 'bruxism', startTime: 18000 + 10000 }, // 10s after first pause
      { type: 'bruxism', startTime: 99999999 },      // unrelated
    ];
    const correlationMetrics = ApneaDetector.calculateAhiMetrics(
      7 * 3600,
      mildPauses.slice(0, 2),
      bruxismEvents
    );
    assertEqual(correlationMetrics.bruxismLinkedToApnea, 1);
    assertEqual(correlationMetrics.bruxismCorrelationPct, 50);
  });
}
