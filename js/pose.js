const VISION_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task";

let poseLandmarker = null;
let videoElement = null;
let aspectRatio = 16 / 9;
let canvasCtx = null;
let canvasElement = null;
let animFrameId = null;
let onFrameCallback = null;
let currentSide = "left";
let running = false;
let overlayVisible = false;

// Side-specific skeleton connections (no face, no cross-body)
const SIDE_CONNECTIONS = {
  left: [
    [11, 13], [13, 15], // left arm
    [11, 23],           // left torso
    [23, 25], [25, 27], // left leg
  ],
  right: [
    [12, 14], [14, 16], // right arm
    [12, 24],           // right torso
    [24, 26], [26, 28], // right leg
  ],
};

// Side-specific landmark indices to draw
const SIDE_LANDMARK_INDICES = {
  left: new Set([11, 13, 15, 23, 25, 27]),
  right: new Set([12, 14, 16, 24, 26, 28]),
};

/**
 * Set which side's skeleton to draw.
 */
export function setSide(side) {
  currentSide = side;
}

/**
 * Control whether the skeleton overlay is drawn on the live canvas.
 */
export function setOverlayVisible(visible) {
  overlayVisible = visible;
}

/**
 * Determine which side of the body is more visible to the camera.
 * Compares average visibility of left-side vs right-side landmarks.
 */
export function detectVisibleSide(landmarks) {
  const leftIndices = [11, 13, 15, 23, 25, 27];
  const rightIndices = [12, 14, 16, 24, 26, 28];

  const leftVis = leftIndices.reduce((sum, i) => sum + (landmarks[i]?.visibility || 0), 0);
  const rightVis = rightIndices.reduce((sum, i) => sum + (landmarks[i]?.visibility || 0), 0);

  return leftVis > rightVis ? "left" : "right";
}

/**
 * Initialize MediaPipe Pose Landmarker and webcam.
 */
export async function initPose(video, canvas) {
  videoElement = video;
  canvasElement = canvas;
  canvasCtx = canvas.getContext("2d");

  const vision = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs");
  const { FilesetResolver, PoseLandmarker } = vision;

  const filesetResolver = await FilesetResolver.forVisionTasks(VISION_CDN);

  poseLandmarker = await PoseLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numPoses: 1,
  });

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720, facingMode: "environment" },
  });
  videoElement.srcObject = stream;

  return new Promise((resolve) => {
    videoElement.onloadedmetadata = () => {
      canvasElement.width = videoElement.videoWidth;
      canvasElement.height = videoElement.videoHeight;
      aspectRatio = videoElement.videoWidth / videoElement.videoHeight;
      resolve();
    };
  });
}

/**
 * Start the detection loop. Calls onFrame(landmarks, timestamp) each frame.
 */
export function startDetection(onFrame) {
  onFrameCallback = onFrame;
  running = true;
  detect();
}

/**
 * Get the video aspect ratio (width / height) for coordinate correction.
 */
export function getAspectRatio() {
  return aspectRatio;
}

/**
 * Stop the detection loop.
 */
export function stopDetection() {
  running = false;
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

function detect() {
  if (!running) return;

  if (!poseLandmarker || !videoElement || videoElement.readyState < 2) {
    animFrameId = requestAnimationFrame(detect);
    return;
  }

  const now = performance.now();
  const result = poseLandmarker.detectForVideo(videoElement, now);

  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

  if (result.landmarks && result.landmarks.length > 0) {
    const landmarks = result.landmarks[0];

    if (overlayVisible) {
      drawSkeletonOnCtx(canvasCtx, canvasElement.width, canvasElement.height, landmarks, currentSide);
    }

    if (onFrameCallback) {
      onFrameCallback(landmarks, now);
    }
  }

  if (running) {
    animFrameId = requestAnimationFrame(detect);
  }
}

/**
 * Draw side-filtered skeleton on any canvas context.
 */
function drawSkeletonOnCtx(ctx, w, h, landmarks, side) {
  const connections = SIDE_CONNECTIONS[side];
  const indices = SIDE_LANDMARK_INDICES[side];

  // Draw connections
  ctx.strokeStyle = "#00ff88";
  ctx.lineWidth = 3;
  for (const [i, j] of connections) {
    const a = landmarks[i];
    const b = landmarks[j];
    if (a.visibility > 0.5 && b.visibility > 0.5) {
      ctx.beginPath();
      ctx.moveTo(a.x * w, a.y * h);
      ctx.lineTo(b.x * w, b.y * h);
      ctx.stroke();
    }
  }

  // Draw joints (only for the chosen side)
  for (const idx of indices) {
    const lm = landmarks[idx];
    if (lm && lm.visibility > 0.5) {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(lm.x * w, lm.y * h, 5, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
}

// Landmark name → index mapping per side (for angle overlay drawing)
const SIDE_LANDMARK_MAP = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 },
};

// Which joints form each measured angle
const ANGLE_JOINTS = {
  knee: { joint: "knee", from: "hip", to: "ankle" },
  hip: { joint: "hip", from: "shoulder", to: "knee" },
  torso: { joint: "hip", from: null, to: "shoulder" }, // null = horizontal reference
  elbow: { joint: "elbow", from: "shoulder", to: "wrist" },
};

/**
 * Capture a snapshot of the current video frame with skeleton overlay,
 * angle visualization, and label badge.
 * @param {Array} landmarks - MediaPipe landmarks
 * @param {string} side - "left" or "right"
 * @param {string} label - text for the badge (e.g., "Knee (at BDC)")
 * @param {string} angleKey - which angle to visualize ("knee", "hip", "torso", "elbow")
 * @param {number} angleValue - the computed angle in degrees
 * @returns {HTMLCanvasElement|null} offscreen canvas with the composited image
 */
export function captureSnapshot(landmarks, side, label, angleKey, angleValue, color = "#fbbf24") {
  if (!videoElement || videoElement.readyState < 2) return null;

  const w = canvasElement.width;
  const h = canvasElement.height;

  const offscreen = document.createElement("canvas");
  offscreen.width = w;
  offscreen.height = h;
  const ctx = offscreen.getContext("2d");

  // Draw video frame
  ctx.drawImage(videoElement, 0, 0, w, h);

  // Draw only the angle measurement lines (no full skeleton)
  if (angleKey && ANGLE_JOINTS[angleKey]) {
    drawAngleOverlay(ctx, w, h, landmarks, side, angleKey, angleValue, color);
  }

  // Draw label badge
  drawLabelBadge(ctx, h, label);

  return offscreen;
}

/**
 * Draw the angle arc, highlighted limbs, and degree value at a joint.
 */
function drawAngleOverlay(ctx, w, h, landmarks, side, angleKey, angleValue, color = "#fbbf24") {
  const indices = SIDE_LANDMARK_MAP[side];
  const spec = ANGLE_JOINTS[angleKey];

  const jointLm = landmarks[indices[spec.joint]];
  const toLm = landmarks[indices[spec.to]];

  const jx = jointLm.x * w;
  const jy = jointLm.y * h;
  const tx = toLm.x * w;
  const ty = toLm.y * h;

  let fx, fy;
  const isHorizontalRef = spec.from === null;

  if (isHorizontalRef) {
    // Horizontal reference for torso: extend in direction of the shoulder
    const dir = toLm.x < jointLm.x ? -1 : 1;
    fx = jx + dir * 80;
    fy = jy;
  } else {
    const fromLm = landmarks[indices[spec.from]];
    fx = fromLm.x * w;
    fy = fromLm.y * h;
  }

  // Highlight the two limbs forming the angle
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 4;

  if (isHorizontalRef) {
    // Dashed horizontal reference line
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    ctx.moveTo(jx - 70, jy);
    ctx.lineTo(jx + 70, jy);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.beginPath();
    ctx.moveTo(jx, jy);
    ctx.lineTo(fx, fy);
    ctx.stroke();
  }

  // Second limb
  ctx.beginPath();
  ctx.moveTo(jx, jy);
  ctx.lineTo(tx, ty);
  ctx.stroke();

  // Draw joint dots at endpoints
  ctx.fillStyle = "#ffffff";
  for (const [px, py] of [[jx, jy], [tx, ty], ...(isHorizontalRef ? [] : [[fx, fy]])]) {
    ctx.beginPath();
    ctx.arc(px, py, 6, 0, 2 * Math.PI);
    ctx.fill();
  }

  // Draw angle arc
  const a1 = Math.atan2(fy - jy, fx - jx);
  const a2 = Math.atan2(ty - jy, tx - jx);

  let delta = a2 - a1;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;

  const radius = Math.min(w, h) * 0.045;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(jx, jy, radius, a1, a1 + delta, delta < 0);
  ctx.stroke();

  // Draw angle value near the arc
  const midAngle = a1 + delta / 2;
  const textR = radius + Math.round(h * 0.03);
  const labelX = jx + Math.cos(midAngle) * textR;
  const labelY = jy + Math.sin(midAngle) * textR;

  const fontSize = Math.round(h * 0.035);
  ctx.shadowBlur = 6;
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${Math.round(angleValue)}°`, labelX, labelY);
  ctx.restore();
}

/**
 * Draw a label badge in the top-left corner of a canvas.
 */
function drawLabelBadge(ctx, h, label) {
  const fontSize = Math.round(h * 0.04);
  ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  const metrics = ctx.measureText(label);
  const px = fontSize * 0.6;
  const py = fontSize * 0.35;
  const bx = 10;
  const by = 10;
  const bw = metrics.width + px * 2;
  const bh = fontSize + py * 2;
  const r = 6;

  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.beginPath();
  ctx.moveTo(bx + r, by);
  ctx.lineTo(bx + bw - r, by);
  ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
  ctx.lineTo(bx + bw, by + bh - r);
  ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
  ctx.lineTo(bx + r, by + bh);
  ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
  ctx.lineTo(bx, by + r);
  ctx.quadraticCurveTo(bx, by, bx + r, by);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(label, bx + px, by + bh / 2);
}
