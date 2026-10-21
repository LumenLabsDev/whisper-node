'use strict';

function squaredDistance(a, b) {
  let distance = 0;
  for (let d = 0; d < a.length; d++) distance += (a[d] - b[d]) ** 2;
  return distance;
}

/** Bounded Lloyd k-means with deterministic, farthest-point initialization. */
function kmeans(points, k, { maxIterations = 100 } = {}) {
  if (!Array.isArray(points) || !points.length) throw new Error('k-means requires at least one point');
  if (!Number.isInteger(k) || k < 1) throw new Error('k must be a positive integer');
  if (!Number.isInteger(maxIterations) || maxIterations < 1) throw new Error('maxIterations must be a positive integer');
  const dimensions = points[0].length;
  if (!dimensions || points.some(point => point.length !== dimensions || point.some(value => !Number.isFinite(value)))) {
    throw new Error('k-means requires finite points of equal dimensions');
  }
  k = Math.min(k, points.length);
  const centroids = [points[0].slice()];
  const distances = new Array(points.length).fill(Infinity);
  while (centroids.length < k) {
    const latest = centroids[centroids.length - 1];
    let farthest = 0;
    for (let i = 0; i < points.length; i++) {
      distances[i] = Math.min(distances[i], squaredDistance(points[i], latest));
      if (distances[i] > distances[farthest]) farthest = i;
    }
    if (distances[farthest] === 0) break;
    centroids.push(points[farthest].slice());
  }
  const clusters = new Array(points.length).fill(-1);
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let changed = false;
    const sums = centroids.map(() => new Array(dimensions).fill(0));
    const counts = centroids.map(() => 0);
    for (let i = 0; i < points.length; i++) {
      let closest = 0;
      let distance = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const candidate = squaredDistance(points[i], centroids[c]);
        if (candidate < distance) { closest = c; distance = candidate; }
      }
      changed ||= clusters[i] !== closest;
      clusters[i] = closest;
      counts[closest]++;
      for (let d = 0; d < dimensions; d++) sums[closest][d] += points[i][d];
    }
    for (let c = 0; c < centroids.length; c++) {
      if (counts[c]) centroids[c] = sums[c].map(value => value / counts[c]);
    }
    if (!changed) break;
  }
  return { clusters, centroids };
}

module.exports = { kmeans };
