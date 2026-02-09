const WINDOW_DURATION_MS = 4000; // 4-second sliding window
const MIN_CYCLES_FOR_STEADY = 3;
const MAX_PERIOD_VARIATION = 0.25; // 25%
const MIN_CADENCE_RPM = 40;
const MAX_CADENCE_RPM = 120;
const STOP_TIMEOUT_MS = 2000;

export class CadenceDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this.samples = [];       // { t, y } knee Y positions
    this.peaks = [];         // timestamps of detected peaks (knee at lowest = BDC, highest Y value)
    this.troughs = [];       // timestamps of detected troughs (knee at highest = TDC, lowest Y value)
    this.isSteady = false;
    this.lastCycleTime = 0;
    this.cycleCount = 0;
    this.onCycleCallback = null;

    // Per-cycle angle tracking
    this.currentCycleAngles = [];
  }

  /**
   * Set a callback invoked when a full pedal cycle completes.
   * callback receives: { cycleNumber, angles: { knee: { max }, hip: { min }, torso: { avg }, elbow: { avg } } }
   */
  onCycle(callback) {
    this.onCycleCallback = callback;
  }

  /**
   * Add a new sample. Call every frame with the knee Y position and current angles.
   * In MediaPipe normalized coords, Y increases downward, so BDC (knee lowest on screen)
   * corresponds to the highest Y value.
   */
  addSample(timestamp, kneeY, angles) {
    this.samples.push({ t: timestamp, y: kneeY });
    if (angles) {
      this.currentCycleAngles.push(angles);
    }

    // Trim old samples outside the window
    const cutoff = timestamp - WINDOW_DURATION_MS;
    while (this.samples.length > 0 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }

    // Need at least some samples to detect peaks
    if (this.samples.length < 10) return;

    this._detectPeaks(timestamp);
  }

  /**
   * Returns true if pedaling has stopped (no cycle for >2s).
   */
  hasStopped(timestamp) {
    if (this.lastCycleTime === 0) return false;
    return timestamp - this.lastCycleTime > STOP_TIMEOUT_MS;
  }

  _detectPeaks(timestamp) {
    const samples = this.samples;
    const len = samples.length;

    // Look at the sample 3 positions back (to allow for some smoothing lag)
    // and check if it's a local max (peak / BDC) or local min (trough / TDC)
    const lookback = 5;
    if (len < lookback * 2 + 1) return;

    const idx = len - 1 - lookback;
    const candidate = samples[idx];

    // Smooth: average of candidate and neighbors
    const smoothY = this._smoothY(idx);

    // Check if it's a peak (local maximum in Y = BDC, knee at bottom of stroke)
    let isPeak = true;
    let isTrough = true;
    for (let i = idx - lookback; i <= idx + lookback; i++) {
      if (i === idx) continue;
      const sy = this._smoothY(i);
      if (sy >= smoothY) isPeak = false;
      if (sy <= smoothY) isTrough = false;
    }

    // Minimum prominence: the peak/trough must differ from recent average by some amount
    const avgY = samples.reduce((sum, s) => sum + s.y, 0) / samples.length;
    const prominence = Math.abs(smoothY - avgY);
    const minProminence = 0.01; // 1% of normalized image height

    if (isPeak && prominence > minProminence) {
      // Avoid duplicate peaks too close together (< 300ms)
      const lastPeak = this.peaks[this.peaks.length - 1];
      if (!lastPeak || candidate.t - lastPeak > 300) {
        this.peaks.push(candidate.t);
        this._checkCycleComplete(candidate.t);
      }
    }

    if (isTrough && prominence > minProminence) {
      const lastTrough = this.troughs[this.troughs.length - 1];
      if (!lastTrough || candidate.t - lastTrough > 300) {
        this.troughs.push(candidate.t);
      }
    }

    // Trim old peaks/troughs
    const oldCutoff = timestamp - WINDOW_DURATION_MS * 2;
    while (this.peaks.length > 0 && this.peaks[0] < oldCutoff) this.peaks.shift();
    while (this.troughs.length > 0 && this.troughs[0] < oldCutoff) this.troughs.shift();
  }

  _smoothY(idx) {
    const samples = this.samples;
    const radius = 2;
    let sum = 0;
    let count = 0;
    for (let i = Math.max(0, idx - radius); i <= Math.min(samples.length - 1, idx + radius); i++) {
      sum += samples[i].y;
      count++;
    }
    return sum / count;
  }

  _checkCycleComplete(peakTime) {
    if (this.peaks.length < 2) return;

    // A cycle is peak-to-peak
    const prevPeak = this.peaks[this.peaks.length - 2];
    const period = peakTime - prevPeak;

    // Check if period corresponds to reasonable cadence
    const rpm = 60000 / period;
    if (rpm < MIN_CADENCE_RPM || rpm > MAX_CADENCE_RPM) return;

    this.cycleCount++;
    this.lastCycleTime = peakTime;

    // Extract per-cycle angle summary
    const cycleAngles = this.currentCycleAngles;
    this.currentCycleAngles = [];

    if (cycleAngles.length > 0) {
      const summary = {
        cycleNumber: this.cycleCount,
        timestamp: peakTime,
        rpm: Math.round(rpm),
        angles: {
          knee: { max: Math.max(...cycleAngles.map((a) => a.knee)) },
          hip: { min: Math.min(...cycleAngles.map((a) => a.hip)) },
          torso: { avg: cycleAngles.reduce((s, a) => s + a.torso, 0) / cycleAngles.length },
          elbow: { avg: cycleAngles.reduce((s, a) => s + a.elbow, 0) / cycleAngles.length },
        },
      };

      if (this.onCycleCallback) {
        this.onCycleCallback(summary);
      }
    }

    // Check steadiness
    this._checkSteady();
  }

  _checkSteady() {
    if (this.peaks.length < MIN_CYCLES_FOR_STEADY + 1) {
      this.isSteady = false;
      return;
    }

    // Check last N+1 peaks for consistent periods
    const recentPeaks = this.peaks.slice(-(MIN_CYCLES_FOR_STEADY + 1));
    const periods = [];
    for (let i = 1; i < recentPeaks.length; i++) {
      periods.push(recentPeaks[i] - recentPeaks[i - 1]);
    }

    const avgPeriod = periods.reduce((s, p) => s + p, 0) / periods.length;
    const maxVariation = Math.max(...periods.map((p) => Math.abs(p - avgPeriod) / avgPeriod));

    this.isSteady = maxVariation < MAX_PERIOD_VARIATION;
  }
}
