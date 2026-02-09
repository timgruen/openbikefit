import { initPose, startDetection, stopDetection, getAspectRatio, setSide, setOverlayVisible, detectVisibleSide, captureSnapshot } from "./pose.js";
import { computeAngles, getKneeLandmark } from "./angles.js";
import { CadenceDetector } from "./cadence.js";
import { initCharts, addDataPoint, resetCharts, rebuildCharts, updateChartRanges } from "./charts.js";
import { analyzeSession, renderRecommendations, trimCycles, updateThresholds } from "./analysis.js";

// --- Default Ranges ---
const DEFAULT_RANGES = {
  knee: [130, 145],
  hip: [45, 60],
  torso: [30, 55],
  elbow: [145, 170],
};

const STORAGE_KEY = "openbikefit-ranges";

function loadRanges() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return null;
}

function saveRanges(ranges) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ranges));
}

// --- State ---
const State = {
  DETECTING: "DETECTING",
  RECORDING: "RECORDING",
  COMPLETE: "COMPLETE",
};

let currentState = State.DETECTING;
let cameraSide = null;
let cadenceDetector = new CadenceDetector();
let cycleData = [];
let recordingStartTime = 0;
let pedalingStopped = false;

// Side detection: accumulate votes over frames
let sideVotes = { left: 0, right: 0 };

// --- Snapshot tracking ---
const SNAPSHOT_BUFFER_SIZE = 6;
const SNAPSHOT_REFRESH_MS = 5000;
const snapshotBuffers = { knee: [], hip: [], torso: [], elbow: [] };
const currentWindowSnaps = { knee: null, hip: null };
let bestKneeAngle = 0;
let bestHipAngle = Infinity;
let snapshotResetTime = 0;

// --- DOM refs ---
const videoEl = document.getElementById("webcam");
const canvasEl = document.getElementById("overlay");
const stopBtn = document.getElementById("stopBtn");
const resetBtn = document.getElementById("resetBtn");
const statusText = document.getElementById("statusText");
const statusBanner = document.getElementById("statusBanner");

// Gauge elements
const gauges = {
  knee: document.getElementById("gauge-knee"),
  hip: document.getElementById("gauge-hip"),
  torso: document.getElementById("gauge-torso"),
  elbow: document.getElementById("gauge-elbow"),
};

// Active target ranges (mutable — updated by settings)
const TARGET_RANGES = Object.fromEntries(
  Object.entries(DEFAULT_RANGES).map(([k, v]) => [k, [...v]])
);

const STATUS_COLORS = {
  green: "#22c55e",
  yellow: "#eab308",
  red: "#ef4444",
};

function getAngleColor(key, value) {
  const [tMin, tMax] = TARGET_RANGES[key];
  if (value >= tMin && value <= tMax) return STATUS_COLORS.green;
  if (value >= tMin - 10 && value <= tMax + 10) return STATUS_COLORS.yellow;
  return STATUS_COLORS.red;
}

/**
 * Apply target ranges to all subsystems: charts, analysis thresholds, gauge labels.
 */
function applyRanges(ranges) {
  for (const key of Object.keys(TARGET_RANGES)) {
    TARGET_RANGES[key] = ranges[key];
  }
  updateChartRanges(ranges);
  updateThresholds(ranges);
  // Update gauge labels
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const gauge = gauges[key];
    if (!gauge) continue;
    gauge.querySelector(".gauge__range").textContent = `Target: ${min}\u00B0\u2013${max}\u00B0`;
  }
}

// --- Welcome Modal ---
const welcomeModal = document.getElementById("welcomeModal");
const welcomeClose = document.getElementById("welcomeClose");
const welcomeGotIt = document.getElementById("welcomeGotIt");

function closeWelcome() {
  welcomeModal.hidden = true;
}

welcomeClose.addEventListener("click", closeWelcome);
welcomeGotIt.addEventListener("click", closeWelcome);
welcomeModal.addEventListener("click", (e) => {
  if (e.target === welcomeModal) closeWelcome();
});

document.getElementById("helpBtn").addEventListener("click", () => {
  welcomeModal.hidden = false;
});

// --- Settings Modal ---
const settingsModal = document.getElementById("settingsModal");
const settingsInputs = {
  knee: { min: document.getElementById("range-knee-min"), max: document.getElementById("range-knee-max") },
  hip: { min: document.getElementById("range-hip-min"), max: document.getElementById("range-hip-max") },
  torso: { min: document.getElementById("range-torso-min"), max: document.getElementById("range-torso-max") },
  elbow: { min: document.getElementById("range-elbow-min"), max: document.getElementById("range-elbow-max") },
};

function populateSettingsInputs(ranges) {
  for (const [key, [min, max]] of Object.entries(ranges)) {
    settingsInputs[key].min.value = min;
    settingsInputs[key].max.value = max;
  }
}

function readSettingsInputs() {
  const ranges = {};
  for (const [key, inputs] of Object.entries(settingsInputs)) {
    ranges[key] = [parseInt(inputs.min.value, 10), parseInt(inputs.max.value, 10)];
  }
  return ranges;
}

function openSettings() {
  populateSettingsInputs(TARGET_RANGES);
  settingsModal.hidden = false;
}

function closeSettings() {
  settingsModal.hidden = true;
}

document.getElementById("settingsBtn").addEventListener("click", openSettings);
document.getElementById("settingsClose").addEventListener("click", closeSettings);
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) closeSettings();
});

document.getElementById("settingsSave").addEventListener("click", () => {
  const ranges = readSettingsInputs();
  saveRanges(ranges);
  applyRanges(ranges);
  closeSettings();
});

document.getElementById("settingsReset").addEventListener("click", () => {
  populateSettingsInputs(DEFAULT_RANGES);
});

// --- Init ---
async function init() {
  initCharts();

  // Load saved ranges or use defaults, then apply everywhere to stay in sync
  const saved = loadRanges();
  applyRanges(saved || DEFAULT_RANGES);

  try {
    setStatus("Loading pose model...");
    await initPose(videoEl, canvasEl);
    beginDetecting();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    console.error(err);
  }
}

// --- Button handlers ---
stopBtn.addEventListener("click", () => {
  if (currentState === State.RECORDING) {
    stopSession();
  }
});

resetBtn.addEventListener("click", resetSession);

// --- Auto-detection phase ---
function beginDetecting() {
  currentState = State.DETECTING;
  cameraSide = null;
  sideVotes = { left: 0, right: 0 };
  cycleData = [];
  cadenceDetector.reset();
  pedalingStopped = false;
  resetCharts();
  resetGauges();
  resetSnapshots();
  setOverlayVisible(false);
  stopBtn.hidden = true;
  resetBtn.hidden = true;
  document.getElementById("recommendations").hidden = true;

  // Restore video visibility
  videoEl.hidden = false;
  canvasEl.getContext("2d").clearRect(0, 0, canvasEl.width, canvasEl.height);

  setStatus("Position yourself on the bike and start pedaling...");

  // Set up cycle callback — only records data during RECORDING state
  cadenceDetector.onCycle((summary) => {
    if (currentState !== State.RECORDING) return;

    cycleData.push(summary);
    setStatus(`Recording — ${cycleData.length} cycles captured (${summary.rpm} RPM)`, "recording");

    addDataPoint("knee", summary.cycleNumber, summary.angles.knee.max);
    addDataPoint("hip", summary.cycleNumber, summary.angles.hip.min);
    addDataPoint("torso", summary.cycleNumber, summary.angles.torso.avg);
    addDataPoint("elbow", summary.cycleNumber, summary.angles.elbow.avg);
  });

  startDetection(onFrame);
}

function transitionToRecording() {
  // Lock in the side based on accumulated votes
  cameraSide = sideVotes.left >= sideVotes.right ? "left" : "right";
  setSide(cameraSide);
  setOverlayVisible(true);

  currentState = State.RECORDING;
  recordingStartTime = performance.now();
  stopBtn.hidden = false;

  setStatus("Recording...", "recording");
}

function stopSession() {
  stopDetection();
  currentState = State.COMPLETE;
  stopBtn.hidden = true;
  resetBtn.hidden = false;
  finalizeAnalysis();
}

function resetSession() {
  // Stop any running detection before restarting
  stopDetection();
  beginDetecting();
}

// --- Frame callback ---
function onFrame(landmarks, timestamp) {
  if (currentState === State.DETECTING) {
    // Accumulate side votes from landmark visibility
    const side = detectVisibleSide(landmarks);
    sideVotes[side]++;

    // Feed the more-visible side's knee Y to cadence detector (no angles yet)
    const knee = getKneeLandmark(landmarks, side);
    if (knee) {
      cadenceDetector.addSample(timestamp, knee.y, null);

      // Check if steady pedaling detected (checked here because onCycle
      // doesn't fire without angle data during the detection phase)
      if (cadenceDetector.isSteady) {
        transitionToRecording();
      }
    }
    return;
  }

  if (currentState === State.RECORDING) {
    const angles = computeAngles(landmarks, cameraSide, getAspectRatio());
    const knee = getKneeLandmark(landmarks, cameraSide);

    if (angles) {
      updateGauges(angles);
      updateSnapshots(landmarks, angles, timestamp);
    }

    if (knee && !pedalingStopped) {
      cadenceDetector.addSample(timestamp, knee.y, angles);

      if (cadenceDetector.hasStopped(timestamp)) {
        pedalingStopped = true;
        stopSession();
      }
    }
  }
}

// --- Snapshot capture ---
function resetSnapshots() {
  for (const key of Object.keys(snapshotBuffers)) {
    snapshotBuffers[key] = [];
  }
  currentWindowSnaps.knee = null;
  currentWindowSnaps.hip = null;
  bestKneeAngle = 0;
  bestHipAngle = Infinity;
  snapshotResetTime = 0;
}

function pushBuffer(key, canvas) {
  if (!canvas) return;
  snapshotBuffers[key].push(canvas);
  if (snapshotBuffers[key].length > SNAPSHOT_BUFFER_SIZE) {
    snapshotBuffers[key].shift();
  }
}

function getSnapshot(key) {
  const buf = [...snapshotBuffers[key]];
  if (key === "knee" || key === "hip") {
    if (currentWindowSnaps[key]) buf.push(currentWindowSnaps[key]);
  }
  if (buf.length === 0) return null;
  return buf[Math.max(0, buf.length - 3)];
}

function updateSnapshots(landmarks, angles, timestamp) {
  if (timestamp - snapshotResetTime > SNAPSHOT_REFRESH_MS) {
    pushBuffer("knee", currentWindowSnaps.knee);
    pushBuffer("hip", currentWindowSnaps.hip);
    pushBuffer("torso", captureSnapshot(landmarks, cameraSide, "Torso", "torso", angles.torso, getAngleColor("torso", angles.torso)));
    pushBuffer("elbow", captureSnapshot(landmarks, cameraSide, "Elbow", "elbow", angles.elbow, getAngleColor("elbow", angles.elbow)));

    currentWindowSnaps.knee = null;
    currentWindowSnaps.hip = null;
    bestKneeAngle = 0;
    bestHipAngle = Infinity;
    snapshotResetTime = timestamp;
  }

  if (angles.knee > bestKneeAngle) {
    bestKneeAngle = angles.knee;
    currentWindowSnaps.knee = captureSnapshot(landmarks, cameraSide, "Knee (at BDC)", "knee", angles.knee, getAngleColor("knee", angles.knee));
  }

  if (angles.hip < bestHipAngle) {
    bestHipAngle = angles.hip;
    currentWindowSnaps.hip = captureSnapshot(landmarks, cameraSide, "Hip (at TDC)", "hip", angles.hip, getAngleColor("hip", angles.hip));
  }
}

function showSnapshotGrid() {
  const w = canvasEl.width;
  const h = canvasEl.height;
  const ctx = canvasEl.getContext("2d");

  videoEl.hidden = true;
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, w, h);

  const gap = 4;
  const cellW = (w - gap) / 2;
  const cellH = (h - gap) / 2;

  const cells = [
    { key: "knee", x: 0, y: 0 },
    { key: "hip", x: cellW + gap, y: 0 },
    { key: "torso", x: 0, y: cellH + gap },
    { key: "elbow", x: cellW + gap, y: cellH + gap },
  ];

  for (const { key, x, y } of cells) {
    const snap = getSnapshot(key);
    if (snap) {
      ctx.drawImage(snap, 0, 0, snap.width, snap.height, x, y, cellW, cellH);
    } else {
      ctx.fillStyle = "#1e293b";
      ctx.fillRect(x, y, cellW, cellH);
    }
  }
}

// --- Gauge updates ---
function updateGauges(angles) {
  for (const [key, value] of Object.entries(angles)) {
    const gauge = gauges[key];
    if (!gauge) continue;

    const valueEl = gauge.querySelector(".gauge__value");
    valueEl.textContent = `${Math.round(value)}°`;

    const [tMin, tMax] = TARGET_RANGES[key];
    gauge.classList.remove("gauge--green", "gauge--yellow", "gauge--red");
    if (value >= tMin && value <= tMax) {
      gauge.classList.add("gauge--green");
    } else if (value >= tMin - 10 && value <= tMax + 10) {
      gauge.classList.add("gauge--yellow");
    } else {
      gauge.classList.add("gauge--red");
    }
  }
}

function updateGaugesFromAnalysis(results) {
  for (const rec of results) {
    const gauge = gauges[rec.key];
    if (!gauge) continue;

    const valueEl = gauge.querySelector(".gauge__value");
    valueEl.textContent = `${rec.avg}°`;

    gauge.classList.remove("gauge--green", "gauge--yellow", "gauge--red");
    gauge.classList.add(`gauge--${rec.status}`);
  }
}

function resetGauges() {
  for (const gauge of Object.values(gauges)) {
    gauge.querySelector(".gauge__value").textContent = "--°";
    gauge.classList.remove("gauge--green", "gauge--yellow", "gauge--red");
  }
}

// --- Analysis ---
function finalizeAnalysis() {
  if (cycleData.length === 0) {
    setStatus("No pedal cycles captured. Try again.");
    return;
  }

  // Trim last 5 seconds (stepping off)
  const originalCount = cycleData.length;
  cycleData = trimCycles(cycleData);

  if (cycleData.length === 0) {
    setStatus("No valid pedal cycles after filtering. Try again.");
    return;
  }

  if (cycleData.length < originalCount) {
    rebuildCharts(cycleData);
  }

  const results = analyzeSession(cycleData);
  renderRecommendations(results);
  updateGaugesFromAnalysis(results);
  showSnapshotGrid();

  setStatus("Analysis complete", "complete");

  setTimeout(() => {
    document.getElementById("recommendations").scrollIntoView({ behavior: "smooth", block: "start" });
  }, 100);
}

// --- Status ---
function setStatus(text, mode) {
  statusText.textContent = text;
  statusBanner.className = "status-banner";
  if (mode === "recording") statusBanner.classList.add("status-banner--recording");
  if (mode === "complete") statusBanner.classList.add("status-banner--complete");
}

// --- Boot ---
init();
