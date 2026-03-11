import { performance } from 'node:perf_hooks';

const DATASET_SIZES = [1000, 5000, 10000];

const LIMITS = {
  deriveP95Ms: 35,
  toggleP95Ms: 50,
  filterSwitchP95Ms: 40,
};

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function derive(images, filter) {
  const filtered = [];
  let selectedCount = 0;

  for (const img of images) {
    if (img.selected) selectedCount += 1;

    if (filter === 'all') {
      filtered.push(img);
    } else if (filter === 'selected') {
      if (img.selected) filtered.push(img);
    } else if (!img.selected) {
      filtered.push(img);
    }
  }

  return { filtered, selectedCount };
}

function runScenario(size) {
  const images = Array.from({ length: size }, (_, i) => ({
    filename: `IMG_${String(i).padStart(6, '0')}.jpg`,
    full_path: `/tmp/IMG_${String(i).padStart(6, '0')}.jpg`,
    selected: i % 5 === 0,
  }));

  const deriveSamples = [];
  const toggleSamples = [];
  const filterSamples = [];

  for (let i = 0; i < 120; i += 1) {
    const t0 = performance.now();
    derive(images, 'all');
    deriveSamples.push(performance.now() - t0);
  }

  for (let i = 0; i < 120; i += 1) {
    const idx = (i * 37) % images.length;
    const t0 = performance.now();
    images[idx].selected = !images[idx].selected;
    derive(images, 'selected');
    toggleSamples.push(performance.now() - t0);
  }

  for (let i = 0; i < 120; i += 1) {
    const mode = i % 3 === 0 ? 'all' : i % 3 === 1 ? 'selected' : 'unselected';
    const t0 = performance.now();
    derive(images, mode);
    filterSamples.push(performance.now() - t0);
  }

  return {
    size,
    deriveP95: percentile(deriveSamples, 95),
    toggleP95: percentile(toggleSamples, 95),
    filterP95: percentile(filterSamples, 95),
  };
}

function printRow(result) {
  return `${String(result.size).padEnd(6)} | ${result.deriveP95.toFixed(2).padStart(9)} | ${result.toggleP95
    .toFixed(2)
    .padStart(10)} | ${result.filterP95.toFixed(2).padStart(10)}`;
}

function main() {
  const results = DATASET_SIZES.map(runScenario);

  console.log('Dataset | derive p95 | toggle p95 | filter p95');
  console.log('------- | ---------- | ---------- | ----------');
  for (const result of results) console.log(printRow(result));

  const failures = [];
  for (const result of results) {
    if (result.deriveP95 > LIMITS.deriveP95Ms) failures.push(`${result.size}: derive p95 > ${LIMITS.deriveP95Ms}ms`);
    if (result.toggleP95 > LIMITS.toggleP95Ms) failures.push(`${result.size}: toggle p95 > ${LIMITS.toggleP95Ms}ms`);
    if (result.filterP95 > LIMITS.filterSwitchP95Ms) failures.push(`${result.size}: filter p95 > ${LIMITS.filterSwitchP95Ms}ms`);
  }

  if (failures.length > 0) {
    console.error('\nPerf guard failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log('\nPerf guard passed.');
}

main();
