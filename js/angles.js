// Landmark indices for left and right sides
const SIDE_LANDMARKS = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 },
};

/**
 * Compute the angle (in degrees) at the vertex point B given three 2D points A-B-C.
 * Returns a value in [0, 180].
 */
function angleDeg(a, b, c) {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;

  const dot = v1x * v2x + v1y * v2y;
  const cross = v1x * v2y - v1y * v2x;
  const rad = Math.atan2(Math.abs(cross), dot);
  return (rad * 180) / Math.PI;
}

/**
 * Compute the angle of a vector relative to horizontal (positive X axis).
 * Returns degrees in [0, 90] representing the deviation from horizontal.
 */
function angleFromHorizontal(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const rad = Math.atan2(Math.abs(dy), Math.abs(dx));
  return (rad * 180) / Math.PI;
}

/**
 * Extract the relevant landmarks for the given side, check visibility,
 * and correct for aspect ratio so x and y are in equal physical units.
 *
 * MediaPipe normalized coords map x to [0,1] over image width and y to [0,1]
 * over image height. On a 16:9 image, the same physical distance produces
 * different normalized values in x vs y. Multiplying x by the aspect ratio
 * puts both axes in the same scale.
 */
function getLandmarks(allLandmarks, side, aspectRatio, visibilityThreshold = 0.6) {
  const indices = SIDE_LANDMARKS[side];
  const result = {};
  for (const [name, idx] of Object.entries(indices)) {
    const lm = allLandmarks[idx];
    if (!lm || (lm.visibility !== undefined && lm.visibility < visibilityThreshold)) {
      return null;
    }
    result[name] = { x: lm.x * aspectRatio, y: lm.y };
  }
  return result;
}

/**
 * Compute all 4 bike-fit angles from a set of side landmarks.
 * @param {Array} allLandmarks - MediaPipe landmarks array
 * @param {string} side - "left" or "right"
 * @param {number} aspectRatio - video width / height
 * Returns { knee, hip, torso, elbow } in degrees, or null if landmarks are missing.
 */
export function computeAngles(allLandmarks, side, aspectRatio = 16 / 9) {
  const lm = getLandmarks(allLandmarks, side, aspectRatio);
  if (!lm) return null;

  const knee = angleDeg(lm.hip, lm.knee, lm.ankle);
  const hip = angleDeg(lm.shoulder, lm.hip, lm.knee);
  const torso = angleFromHorizontal(lm.hip, lm.shoulder);
  const elbow = angleDeg(lm.shoulder, lm.elbow, lm.wrist);

  return { knee, hip, torso, elbow };
}

/**
 * Get the knee landmark for cadence tracking (raw normalized coords, no aspect correction needed).
 */
export function getKneeLandmark(allLandmarks, side) {
  const indices = SIDE_LANDMARKS[side];
  const lm = allLandmarks[indices.knee];
  if (!lm || (lm.visibility !== undefined && lm.visibility < 0.6)) return null;
  return { x: lm.x, y: lm.y };
}
