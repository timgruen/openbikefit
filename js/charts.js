const CHART_CONFIGS = {
  knee: { label: "Knee Angle (°)", min: 100, max: 180, targetMin: 135, targetMax: 150, margin: 10 },
  hip: { label: "Hip Angle (°)", min: 40, max: 120, targetMin: 60, targetMax: 80, margin: 10 },
  torso: { label: "Torso Angle (°)", min: 10, max: 80, targetMin: 30, targetMax: 55, margin: 10 },
  elbow: { label: "Elbow Angle (°)", min: 100, max: 180, targetMin: 145, targetMax: 170, margin: 10 },
};

const charts = {};

/**
 * Initialize all 4 charts. Call once after Chart.js is loaded.
 * The annotation plugin auto-registers via UMD when loaded after Chart.js.
 */
export function initCharts() {
  for (const [key, config] of Object.entries(CHART_CONFIGS)) {
    const canvas = document.getElementById(`chart-${key}`);
    charts[key] = new Chart(canvas, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: config.label,
            data: [],
            borderColor: "#3b82f6",
            backgroundColor: "rgba(59, 130, 246, 0.1)",
            borderWidth: 2,
            pointRadius: 4,
            pointBackgroundColor: [],
            tension: 0.2,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 2,
        animation: { duration: 200 },
        scales: {
          x: {
            title: { display: true, text: "Cycle #", color: "#94a3b8" },
            ticks: { color: "#94a3b8" },
            grid: { color: "rgba(148, 163, 184, 0.1)" },
          },
          y: {
            min: config.min,
            max: config.max,
            title: { display: true, text: "Degrees", color: "#94a3b8" },
            ticks: { color: "#94a3b8" },
            grid: { color: "rgba(148, 163, 184, 0.1)" },
          },
        },
        plugins: {
          legend: { display: false },
          annotation: {
            annotations: {
              redLow: {
                type: "box",
                yMin: config.min,
                yMax: config.targetMin - config.margin,
                backgroundColor: "rgba(239, 68, 68, 0.1)",
                borderWidth: 0,
              },
              yellowLow: {
                type: "box",
                yMin: config.targetMin - config.margin,
                yMax: config.targetMin,
                backgroundColor: "rgba(234, 179, 8, 0.12)",
                borderWidth: 0,
              },
              green: {
                type: "box",
                yMin: config.targetMin,
                yMax: config.targetMax,
                backgroundColor: "rgba(34, 197, 94, 0.12)",
                borderWidth: 0,
              },
              yellowHigh: {
                type: "box",
                yMin: config.targetMax,
                yMax: config.targetMax + config.margin,
                backgroundColor: "rgba(234, 179, 8, 0.12)",
                borderWidth: 0,
              },
              redHigh: {
                type: "box",
                yMin: config.targetMax + config.margin,
                yMax: config.max,
                backgroundColor: "rgba(239, 68, 68, 0.1)",
                borderWidth: 0,
              },
            },
          },
        },
      },
    });
  }
}

/**
 * Get the color for a data point based on whether it's in range.
 */
function getPointColor(value, targetMin, targetMax, margin = 10) {
  if (value >= targetMin && value <= targetMax) return "#22c55e"; // green
  if (value >= targetMin - margin && value <= targetMax + margin) return "#eab308"; // yellow
  return "#ef4444"; // red
}

/**
 * Add a new data point to a chart. Called once per completed pedal cycle.
 * @param {string} angleKey - "knee", "hip", "torso", or "elbow"
 * @param {number} cycleNumber - the cycle index
 * @param {number} value - the angle value
 */
export function addDataPoint(angleKey, cycleNumber, value) {
  const chart = charts[angleKey];
  if (!chart) return;

  const config = CHART_CONFIGS[angleKey];
  const color = getPointColor(value, config.targetMin, config.targetMax, config.margin);

  chart.data.labels.push(cycleNumber);
  chart.data.datasets[0].data.push(Math.round(value * 10) / 10);
  chart.data.datasets[0].pointBackgroundColor.push(color);
  chart.update();
}

/**
 * Rebuild all charts from trimmed cycle data (after removing anomalous tail cycles).
 * @param {Array} cycleData - the cleaned cycle summaries
 */
export function rebuildCharts(cycleData) {
  const angleExtractors = {
    knee: (c) => c.angles.knee.max,
    hip: (c) => c.angles.hip.min,
    torso: (c) => c.angles.torso.avg,
    elbow: (c) => c.angles.elbow.avg,
  };

  for (const [key, extractor] of Object.entries(angleExtractors)) {
    const chart = charts[key];
    if (!chart) continue;
    const config = CHART_CONFIGS[key];

    const labels = [];
    const data = [];
    const colors = [];
    for (const cycle of cycleData) {
      const value = Math.round(extractor(cycle) * 10) / 10;
      labels.push(cycle.cycleNumber);
      data.push(value);
      colors.push(getPointColor(value, config.targetMin, config.targetMax, config.margin));
    }

    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.data.datasets[0].pointBackgroundColor = colors;
    chart.update();
  }
}

/**
 * Reset all charts to empty state.
 */
export function resetCharts() {
  for (const chart of Object.values(charts)) {
    chart.data.labels = [];
    chart.data.datasets[0].data = [];
    chart.data.datasets[0].pointBackgroundColor = [];
    chart.update();
  }
}

/**
 * Update chart annotation bands when target ranges change.
 * @param {Object} ranges - { knee: [min, max], hip: [min, max], ... }
 */
export function updateChartRanges(ranges) {
  for (const [key, [targetMin, targetMax]] of Object.entries(ranges)) {
    const config = CHART_CONFIGS[key];
    if (!config) continue;
    config.targetMin = targetMin;
    config.targetMax = targetMax;

    const chart = charts[key];
    if (!chart) continue;

    const ann = chart.options.plugins.annotation.annotations;
    ann.redLow.yMax = targetMin - config.margin;
    ann.yellowLow.yMin = targetMin - config.margin;
    ann.yellowLow.yMax = targetMin;
    ann.green.yMin = targetMin;
    ann.green.yMax = targetMax;
    ann.yellowHigh.yMin = targetMax;
    ann.yellowHigh.yMax = targetMax + config.margin;
    ann.redHigh.yMin = targetMax + config.margin;

    // Recolor existing data points
    const ds = chart.data.datasets[0];
    ds.pointBackgroundColor = ds.data.map((v) =>
      getPointColor(v, targetMin, targetMax, config.margin)
    );

    chart.update();
  }
}
