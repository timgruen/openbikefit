const THRESHOLDS = {
  knee: {
    name: "Knee (at BDC)",
    category: "Injury risk",
    min: 135,
    max: 150,
    lowSuggestion: "Your knee is bending too much under load at the bottom of the pedal stroke. This places excessive stress on the patellar tendon and can lead to anterior knee pain over time. Raise your saddle in small increments (5 mm at a time) until this angle increases into the target range.",
    highSuggestion: "Your leg is overextending at the bottom of the pedal stroke. This can strain the hamstrings and IT band, and may cause your hips to rock side to side to reach the pedals. Lower your saddle in small increments (5 mm at a time) until this angle decreases into the target range.",
    goodSuggestion: "Knee extension is in a healthy range. Your saddle height is well-set — no changes needed.",
  },
  hip: {
    name: "Hip (at TDC)",
    category: "Injury risk",
    min: 60,
    max: 80,
    lowSuggestion: "Your hip is closing too tightly at the top of the pedal stroke. Over time, this can lead to hip impingement, lower-back pain, and restricted breathing. Consider raising your handlebars, using a shorter stem, or moving the saddle back slightly to open up this angle.",
    highSuggestion: "Your hip angle is unusually open at the top of the stroke, which may indicate the saddle is too far back or too low relative to the handlebars. Check your saddle fore/aft position — you may need to slide it forward slightly.",
    goodSuggestion: "Hip closure is in a comfortable, sustainable range. No risk of impingement or back strain from this angle.",
  },
  torso: {
    name: "Torso",
    category: "Mixed",
    min: 30,
    max: 55,
    lowSuggestion: "Your riding position is quite aggressive. While aerodynamically efficient, this degree of forward lean can cause lower-back strain, neck pain, and shoulder tension on longer rides. If you experience any discomfort, consider raising your handlebars or using a shorter stem. If you're comfortable, this is a performance-oriented position and may not need adjustment.",
    highSuggestion: "Your torso is relatively upright. This is a comfortable position but comes with an aerodynamic penalty. If you're looking to improve speed, consider lowering handlebars or extending the stem for a more aero profile. If comfort is your priority, there's no issue staying here.",
    goodSuggestion: "Torso angle is in a good range — a solid balance between aerodynamic efficiency and comfort.",
  },
  elbow: {
    name: "Elbow",
    category: "Comfort",
    min: 145,
    max: 170,
    lowSuggestion: "Your arms are quite bent, which can lead to forearm fatigue and wrist pressure on longer rides. This usually means the handlebars are too close. Consider a longer stem, or slide your saddle back slightly. That said, this is a comfort concern — if it feels fine, it's not harmful.",
    highSuggestion: "Your arms are nearly locked out, which transmits road vibration directly into your shoulders and neck. A slight elbow bend acts as a natural shock absorber. Consider a shorter stem or sliding the saddle forward slightly. This is a comfort concern — not an injury risk, but you'll likely feel better with a bit more bend.",
    goodSuggestion: "Elbow bend is in a comfortable range — enough to absorb road vibration without causing arm fatigue.",
  },
};

const TRIM_END_MS = 5_000; // 5 seconds

/**
 * Trim the last 5 seconds of cycle data from a session.
 * This removes data captured while the rider is stepping off the bike.
 * If the session is shorter than 5 seconds, return all data untouched.
 * @param {Array} cycleData - raw cycle summaries (must have .timestamp)
 * @returns {Array} trimmed cycle data
 */
export function trimCycles(cycleData) {
  if (cycleData.length <= 1) return cycleData;

  const lastTime = cycleData[cycleData.length - 1].timestamp;
  const firstTime = cycleData[0].timestamp;

  if (lastTime - firstTime <= TRIM_END_MS) return cycleData;

  return cycleData.filter((c) => c.timestamp <= lastTime - TRIM_END_MS);
}

/**
 * Analyze recorded cycle data and produce recommendations.
 * @param {Array} cycleData - array of cycle summaries from cadence detector
 * @returns {Array} recommendations - one per angle
 */
export function analyzeSession(cycleData) {
  if (cycleData.length === 0) return [];

  const kneeValues = cycleData.map((c) => c.angles.knee.max);
  const hipValues = cycleData.map((c) => c.angles.hip.min);
  const torsoValues = cycleData.map((c) => c.angles.torso.avg);
  const elbowValues = cycleData.map((c) => c.angles.elbow.avg);

  const angleValues = { knee: kneeValues, hip: hipValues, torso: torsoValues, elbow: elbowValues };

  const results = [];
  for (const [key, threshold] of Object.entries(THRESHOLDS)) {
    const values = angleValues[key];
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const std = Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length);

    let status, suggestion;
    const diff = avg < threshold.min
      ? threshold.min - avg
      : avg > threshold.max
        ? avg - threshold.max
        : 0;

    if (avg < threshold.min) {
      status = diff > 10 ? "red" : "yellow";
      suggestion = threshold.lowSuggestion;
    } else if (avg > threshold.max) {
      status = diff > 10 ? "red" : "yellow";
      suggestion = threshold.highSuggestion;
    } else {
      status = "green";
      suggestion = threshold.goodSuggestion;
    }

    results.push({
      key,
      name: threshold.name,
      category: threshold.category,
      avg: Math.round(avg * 10) / 10,
      min: Math.round(min * 10) / 10,
      max: Math.round(max * 10) / 10,
      std: Math.round(std * 10) / 10,
      targetMin: threshold.min,
      targetMax: threshold.max,
      status,
      suggestion,
    });
  }

  return results;
}

/**
 * Render recommendation cards into the DOM.
 */
export function renderRecommendations(recommendations) {
  const container = document.getElementById("recommendationCards");
  container.innerHTML = "";

  for (const rec of recommendations) {
    const card = document.createElement("div");
    card.className = `rec-card rec-card--${rec.status}`;

    const statusLabel = rec.status === "green" ? "In range" : rec.status === "yellow" ? "Slightly out of range" : "Out of range";

    // Only show the category badge (injury risk, comfort, mixed) when out of range
    let categoryHtml = "";
    if (rec.status !== "green") {
      const categoryClass = rec.category === "Injury risk" ? "injury" : rec.category === "Comfort" ? "comfort" : "mixed";
      categoryHtml = `<span class="rec-card__category rec-card__category--${categoryClass}">${rec.category}</span>`;
    }

    card.innerHTML = `
      <div class="rec-card__header">
        <span class="rec-card__name">${rec.name}</span>
        <div class="rec-card__badges">
          ${categoryHtml}
          <span class="rec-card__badge rec-card__badge--${rec.status}">${statusLabel}</span>
        </div>
      </div>
      <div class="rec-card__stats">
        <span class="rec-card__avg">Average: <strong>${rec.avg}°</strong></span>
        <span class="rec-card__target-range">Target: ${rec.targetMin}°–${rec.targetMax}°</span>
      </div>
      <div class="rec-card__detail">Range: ${rec.min}°–${rec.max}° · SD: ${rec.std}°</div>
      <div class="rec-card__suggestion">${rec.suggestion}</div>
    `;
    container.appendChild(card);
  }

  document.getElementById("recommendations").hidden = false;
}
