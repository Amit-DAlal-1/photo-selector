/**
 * Photo Selector — Main Application Logic
 * A fast keyboard-driven photo shortlisting tool built with Tauri.
 * Performance optimised: Rust-side thumbnail caching, recycled virtual thumbnails,
 * byte-budgeted adjacent preload, and debounced atomic selection persistence.
 */

const { invoke } = window.__TAURI__.core;
const { open: dialogOpen } = window.__TAURI__.dialog;
const { convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ============================================================
// APPLICATION STATE
// ============================================================
const state = {
  images: [],           // Array of { filename, full_path, selected, src? }
  pathToIndex: new Map(), // full_path -> index in state.images
  filteredImages: [],   // Derived cache for current filter
  selectedImages: [],   // Derived selected image objects
  selectedFilenames: [], // Derived selected image filenames
  selectedCount: 0,     // Derived selected image count
  currentIndex: -1,     // Index into filtered view
  filter: 'all',        // 'all' | 'selected' | 'unselected'
  sourceDir: null,
  destDir: null,
  // Thumbnail virtual list state
  THUMB_ITEM_HEIGHT: 151, // px per thumbnail item (calibrated at runtime)
  THUMB_OVERSCAN: 6,
  VIRTUAL_WINDOW: 24,
  PRELOAD_MAX_BYTES: 64 * 1024 * 1024,
  PRELOAD_LOOKAROUND: 1,
};

// Derived: filteredImages based on current filter
function getFilteredImages() {
  return state.filteredImages;
}

function recomputeDerivedState() {
  const filtered = [];
  const selectedImages = [];
  const selectedFilenames = [];
  let selectedCount = 0;

  for (const img of state.images) {
    if (img.selected) {
      selectedCount += 1;
      selectedImages.push(img);
      selectedFilenames.push(img.filename);
    }

    if (state.filter === 'all') {
      filtered.push(img);
    } else if (state.filter === 'selected') {
      if (img.selected) filtered.push(img);
    } else if (!img.selected) {
      filtered.push(img);
    }
  }

  state.filteredImages = filtered;
  state.selectedImages = selectedImages;
  state.selectedFilenames = selectedFilenames;
  state.selectedCount = selectedCount;
}

function ensureFullImageSrc(img) {
  if (!img.fullSrc) img.fullSrc = convertFileSrc(img.full_path);
  return img.fullSrc;
}

// ============================================================
// DOM REFERENCES
// ============================================================
const els = {
  btnSourceDir: document.getElementById('btnSourceDir'),
  btnDestDir: document.getElementById('btnDestDir'),
  sourceDirLabel: document.getElementById('sourceDirLabel'),
  destDirLabel: document.getElementById('destDirLabel'),
  btnComplete: document.getElementById('btnComplete'),
  filterBtns: document.querySelectorAll('.filter-btn'),
  welcomeState: document.getElementById('welcomeState'),
  viewerState: document.getElementById('viewerState'),
  btnWelcomeSource: document.getElementById('btnWelcomeSource'),
  thumbnailList: document.getElementById('thumbnailList'),
  stripCount: document.getElementById('stripCount'),
  mainImage: document.getElementById('mainImage'),
  selectedOverlay: document.getElementById('selectedOverlay'),
  statusFilename: document.getElementById('statusFilename'),
  statusCounter: document.getElementById('statusCounter'),
  statusSelection: document.getElementById('statusSelection'),
  statusSelectedCount: document.getElementById('statusSelectedCount'),
  btnPrev: document.getElementById('btnPrev'),
  btnNext: document.getElementById('btnNext'),  // Modal — result panel
  modalOverlay: document.getElementById('modalOverlay'),
  modalIcon: document.getElementById('modalIcon'),
  modalTitle: document.getElementById('modalTitle'),
  modalMessage: document.getElementById('modalMessage'),
  modalClose: document.getElementById('modalClose'),
  copyResultPanel: document.getElementById('copyResultPanel'),

  // Modal — progress panel
  copyProgressPanel: document.getElementById('copyProgressPanel'),
  copyProgressFile: document.getElementById('copyProgressFile'),
  copyProgressFill: document.getElementById('copyProgressFill'),
  copyProgressCounter: document.getElementById('copyProgressCounter'),

  // Toast
  toast: document.getElementById('toast'),
};

// ============================================================
// PERFORMANCE: THUMBNAIL + PRELOADER CACHE
// ============================================================
const thumbnailPathCache = new Map();
const thumbnailRequestCache = new Map();
const thumbnailFailures = new Set();

const preloadCache = new Map();
const preloadFailures = new Set();
let preloadCacheBytes = 0;

async function ensureThumbnailSrc(img) {
  const key = img.full_path;

  if (img.thumbSrc) return img.thumbSrc;
  if (thumbnailFailures.has(key)) return ensureFullImageSrc(img);

  const cachedSrc = thumbnailPathCache.get(key);
  if (cachedSrc) {
    img.thumbSrc = cachedSrc;
    return cachedSrc;
  }

  let pendingRequest = thumbnailRequestCache.get(key);
  if (!pendingRequest) {
    pendingRequest = invoke('get_thumbnail', { path: key })
      .then((thumbPath) => convertFileSrc(thumbPath))
      .then((thumbSrc) => {
        thumbnailPathCache.set(key, thumbSrc);
        img.thumbSrc = thumbSrc;
        return thumbSrc;
      })
      .catch(() => {
        thumbnailFailures.add(key);
        const fallbackSrc = ensureFullImageSrc(img);
        img.thumbSrc = fallbackSrc;
        return fallbackSrc;
      })
      .finally(() => {
        thumbnailRequestCache.delete(key);
      });

    thumbnailRequestCache.set(key, pendingRequest);
  }

  return pendingRequest;
}

function bindThumbnailImage(imgEl, img) {
  const path = img.full_path;
  imgEl.dataset.path = path;
  imgEl.alt = img.filename;

  const cachedSrc = img.thumbSrc || thumbnailPathCache.get(path);
  if (cachedSrc) {
    img.thumbSrc = cachedSrc;
    if (imgEl.src !== cachedSrc) imgEl.src = cachedSrc;
    return;
  }

  imgEl.removeAttribute('src');
  void ensureThumbnailSrc(img).then((src) => {
    if (imgEl.dataset.path === path && imgEl.src !== src) {
      imgEl.src = src;
    }
  });
}

function touchPreloadCache(key, entry) {
  if (preloadCache.has(key)) preloadCache.delete(key);
  preloadCache.set(key, entry);
}

function evictPreloadCache(requiredBytes = 0) {
  while (preloadCacheBytes + requiredBytes > state.PRELOAD_MAX_BYTES && preloadCache.size > 0) {
    const [oldestKey, oldestEntry] = preloadCache.entries().next().value;
    preloadCache.delete(oldestKey);
    preloadCacheBytes -= oldestEntry.bytes;
    oldestEntry.imageEl.src = '';
  }
}

function clearTransientCaches() {
  for (const entry of preloadCache.values()) {
    entry.imageEl.src = '';
  }

  preloadCache.clear();
  preloadFailures.clear();
  preloadCacheBytes = 0;

  thumbnailPathCache.clear();
  thumbnailRequestCache.clear();
  thumbnailFailures.clear();
}

function preloadImage(img) {
  if (!img) return;

  const key = img.full_path;
  if (preloadFailures.has(key)) return;

  if (preloadCache.has(key)) {
    touchPreloadCache(key, preloadCache.get(key));
    return;
  }

  const bytes = Math.max(1, Number(img.file_size) || 0);
  if (bytes > state.PRELOAD_MAX_BYTES) return;

  evictPreloadCache(bytes);

  const el = new Image();
  el.decoding = 'async';
  el.onerror = () => {
    preloadFailures.add(key);
    const entry = preloadCache.get(key);
    if (entry) {
      preloadCacheBytes -= entry.bytes;
      preloadCache.delete(key);
    }
  };
  el.src = ensureFullImageSrc(img);

  const entry = { imageEl: el, bytes };
  preloadCacheBytes += bytes;
  touchPreloadCache(key, entry);
}

function preloadAdjacent(filteredIdx) {
  const filtered = getFilteredImages();
  for (let d = -state.PRELOAD_LOOKAROUND; d <= state.PRELOAD_LOOKAROUND; d++) {
    if (d === 0) continue;
    const i = filteredIdx + d;
    if (i >= 0 && i < filtered.length) preloadImage(filtered[i]);
  }
}

// ============================================================
// DIRECTORY SELECTION
// ============================================================
async function pickSourceDir() {
  try {
    const selected = await dialogOpen({ directory: true, multiple: false, title: 'Select Source Image Folder' });
    if (!selected) return;
    state.sourceDir = selected;
    els.sourceDirLabel.textContent = getBasename(selected);
    els.btnSourceDir.classList.add('selected');
    await loadImages();
  } catch (e) {
    showToast('Failed to open source folder: ' + e, 'error');
  }
}

async function pickDestDir() {
  try {
    const selected = await dialogOpen({ directory: true, multiple: false, title: 'Select Destination Folder' });
    if (!selected) return;
    state.destDir = selected;
    els.destDirLabel.textContent = getBasename(selected);
    els.btnDestDir.classList.add('selected');
    updateCompleteButton();
    showToast('Destination folder set');
  } catch (e) {
    showToast('Failed to open destination folder: ' + e, 'error');
  }
}

// ============================================================
// IMAGE LOADING
// ============================================================
async function loadImages() {
  if (!state.sourceDir) return;

  try {
    const rawImages = await invoke('list_images', { dir: state.sourceDir });

    // Restore previous selection
    let previousSelection = [];
    try { previousSelection = await invoke('load_selection', { dir: state.sourceDir }); } catch (_) { }
    const prevSet = new Set(previousSelection);

    // Keep source URLs lazy to reduce initial load cost on large folders
    state.images = rawImages.map(img => ({
      ...img,
      selected: prevSet.has(img.filename),
      fullSrc: null,
      thumbSrc: null,
    }));
    state.pathToIndex.clear();
    state.images.forEach((img, idx) => state.pathToIndex.set(img.full_path, idx));

    clearTransientCaches();
    state.filter = 'all';
    recomputeDerivedState();
    state.currentIndex = 0;
    updateFilterButtons();
    els.thumbnailList.scrollTop = 0;
    rotationState.clear();
    applyRotationForPath(null);

    els.welcomeState.classList.add('hidden');
    els.viewerState.classList.remove('hidden');

    renderThumbnailStrip();
    displayImage(0);
    updateCompleteButton();
    updateStripCount();

    // Kick off background preload of first few images
    const filtered = getFilteredImages();
    for (let i = 0; i < Math.min(3, filtered.length); i++) preloadImage(filtered[i]);

  } catch (e) {
    showModal('error', 'No Images Found', String(e));
  }
}

// ============================================================
// VIRTUAL THUMBNAIL STRIP
// ============================================================
let _stripScrollHandler = null;
let _thumbCalibrateRaf = null;
let _activeThumbEl = null;
let _thumbScrollRaf = null;
let _thumbContentEl = null;
let _thumbPool = [];
let _thumbFirstRenderedIndex = -1;

function updateVirtualWindowSize() {
  if (!els.thumbnailList || state.THUMB_ITEM_HEIGHT <= 0) return;

  const listHeight = els.thumbnailList.clientHeight;
  if (listHeight <= 0) return;

  const visibleRows = Math.max(1, Math.ceil(listHeight / state.THUMB_ITEM_HEIGHT));
  const desiredWindow = Math.max(visibleRows + (state.THUMB_OVERSCAN * 2), 12);
  state.VIRTUAL_WINDOW = desiredWindow;
}

function scheduleThumbHeightCalibration() {
  if (_thumbCalibrateRaf) cancelAnimationFrame(_thumbCalibrateRaf);

  _thumbCalibrateRaf = requestAnimationFrame(() => {
    _thumbCalibrateRaf = null;
    const firstItem = els.thumbnailList.querySelector('.thumbnail-item');
    if (!firstItem) return;

    const style = window.getComputedStyle(els.thumbnailList);
    const gap = parseFloat(style.rowGap || style.gap || '0') || 0;
    const measured = Math.ceil(firstItem.getBoundingClientRect().height + gap);
    const previousHeight = state.THUMB_ITEM_HEIGHT;

    if (measured > 0) state.THUMB_ITEM_HEIGHT = measured;
    updateVirtualWindowSize();

    if (measured > 0 && previousHeight !== state.THUMB_ITEM_HEIGHT) {
      renderThumbnailStrip();
      return;
    }

    renderVisibleThumbnailPool(true);
  });
}

function clearThumbnailStrip() {
  if (_stripScrollHandler) {
    els.thumbnailList.removeEventListener('scroll', _stripScrollHandler);
    _stripScrollHandler = null;
  }

  if (_thumbScrollRaf) {
    cancelAnimationFrame(_thumbScrollRaf);
    _thumbScrollRaf = null;
  }

  _activeThumbEl = null;
  _thumbFirstRenderedIndex = -1;
  _thumbContentEl = null;
  _thumbPool = [];
  els.thumbnailList.innerHTML = '';
}

function createThumbnailPoolItem() {
  const item = document.createElement('div');
  item.className = 'thumbnail-item';

  const thumbImg = document.createElement('img');
  thumbImg.loading = 'lazy';
  thumbImg.decoding = 'async';

  const badge = document.createElement('div');
  badge.className = 'thumb-badge';
  badge.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`;

  const nameEl = document.createElement('div');
  nameEl.className = 'thumb-name';

  item.appendChild(thumbImg);
  item.appendChild(badge);
  item.appendChild(nameEl);

  return item;
}

function ensureThumbContent() {
  if (_thumbContentEl) return _thumbContentEl;

  const content = document.createElement('div');
  content.className = 'thumbnail-strip-content';
  els.thumbnailList.appendChild(content);
  _thumbContentEl = content;
  return content;
}

function ensureThumbPoolSize(size) {
  const content = ensureThumbContent();

  while (_thumbPool.length < size) {
    const item = createThumbnailPoolItem();
    _thumbPool.push(item);
    content.appendChild(item);
  }

  while (_thumbPool.length > size) {
    const item = _thumbPool.pop();
    item.remove();
  }
}

function bindThumbnailPoolItem(item, filteredIdx, img) {
  item.style.display = '';
  item.style.top = `${filteredIdx * state.THUMB_ITEM_HEIGHT}px`;
  item.dataset.filteredIdx = String(filteredIdx);
  item.classList.toggle('selected', img.selected);
  item.classList.toggle('active', filteredIdx === state.currentIndex);

  item.querySelector('.thumb-name').textContent = img.filename;
  bindThumbnailImage(item.querySelector('img'), img);
}

function renderVisibleThumbnailPool(force = false) {
  const filtered = getFilteredImages();
  if (!_thumbContentEl || filtered.length === 0) return;

  const maxStart = Math.max(0, filtered.length - _thumbPool.length);
  const nextStart = Math.min(
    maxStart,
    Math.max(0, Math.floor(els.thumbnailList.scrollTop / state.THUMB_ITEM_HEIGHT) - state.THUMB_OVERSCAN),
  );

  if (!force && nextStart === _thumbFirstRenderedIndex) {
    highlightActiveThumbnail();
    return;
  }

  _thumbFirstRenderedIndex = nextStart;

  for (let poolIdx = 0; poolIdx < _thumbPool.length; poolIdx += 1) {
    const filteredIdx = nextStart + poolIdx;
    const item = _thumbPool[poolIdx];

    if (filteredIdx >= filtered.length) {
      item.style.display = 'none';
      item.dataset.filteredIdx = '';
      continue;
    }

    bindThumbnailPoolItem(item, filteredIdx, filtered[filteredIdx]);
  }

  highlightActiveThumbnail();
}

function renderThumbnailStrip() {
  clearThumbnailStrip();
  const filtered = getFilteredImages();

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'thumb-empty';
    empty.textContent = 'No images match this filter.';
    els.thumbnailList.appendChild(empty);
    return;
  }

  updateVirtualWindowSize();
  ensureThumbPoolSize(Math.min(filtered.length, state.VIRTUAL_WINDOW));
  _thumbContentEl.style.height = `${filtered.length * state.THUMB_ITEM_HEIGHT}px`;
  renderVisibleThumbnailPool(true);
  scheduleThumbHeightCalibration();

  _stripScrollHandler = () => {
    if (_thumbScrollRaf) return;
    _thumbScrollRaf = requestAnimationFrame(() => {
      _thumbScrollRaf = null;
      renderVisibleThumbnailPool();
    });
  };
  els.thumbnailList.addEventListener('scroll', _stripScrollHandler, { passive: true });
}

function highlightActiveThumbnail() {
  let nextActive = null;

  for (const item of _thumbPool) {
    const isActive = Number(item.dataset.filteredIdx) === state.currentIndex;
    item.classList.toggle('active', isActive);
    if (isActive) nextActive = item;
  }

  if (_activeThumbEl && _activeThumbEl !== nextActive) {
    _activeThumbEl.classList.remove('active');
  }

  _activeThumbEl = nextActive;
}

function scrollThumbnailIntoView(filteredIdx, source = 'programmatic') {
  if (source === 'toggle') return;

  const filtered = getFilteredImages();
  if (filtered.length === 0) return;

  const H = state.THUMB_ITEM_HEIGHT;
  const listEl = els.thumbnailList;
  const itemTop = filteredIdx * H;
  const itemBottom = itemTop + H;
  const viewTop = listEl.scrollTop;
  const viewBottom = viewTop + listEl.clientHeight;
  const margin = source === 'keyboard' ? H * 1.5 : H * 0.75;

  let targetScrollTop = null;
  if (itemTop < viewTop + margin) {
    targetScrollTop = Math.max(0, itemTop - margin);
  } else if (itemBottom > viewBottom - margin) {
    targetScrollTop = Math.max(0, itemBottom - listEl.clientHeight + margin);
  }

  if (targetScrollTop === null) return;

  listEl.scrollTop = targetScrollTop;
  renderVisibleThumbnailPool(true);
}

function updateStripCount() {
  const filtered = getFilteredImages();
  const total = state.images.length;
  els.stripCount.textContent = `${filtered.length} of ${total} · ${state.selectedCount} selected`;
}

function updateThumbnailSelectedState(filteredIdx) {
  const img = getFilteredImages()[filteredIdx];
  if (!img) return;

  for (const item of _thumbPool) {
    if (Number(item.dataset.filteredIdx) === filteredIdx) {
      item.classList.toggle('selected', img.selected);
      return;
    }
  }
}

// ============================================================
// IMAGE DISPLAY
// ============================================================
let _preloadTimer = null;
let _selectionSaveTimer = null;
let _selectionSaveChain = Promise.resolve();
const rotationState = new Map();

function getRotation(path) {
  if (!path) return 0;
  return rotationState.get(path) || 0;
}

function applyRotationForPath(path) {
  els.mainImage.style.setProperty('--viewer-rotation', `${getRotation(path)}deg`);
}

function rotateCurrentImageAntiClockwise() {
  const currentImg = getFilteredImages()[state.currentIndex];
  if (!currentImg) return;

  const currentRotation = getRotation(currentImg.full_path);
  const nextRotation = (currentRotation + 270) % 360;

  if (nextRotation === 0) {
    rotationState.delete(currentImg.full_path);
  } else {
    rotationState.set(currentImg.full_path, nextRotation);
  }

  applyRotationForPath(currentImg.full_path);
}

function scheduleAdjacentPreload(filteredIdx) {
  if (_preloadTimer) clearTimeout(_preloadTimer);
  _preloadTimer = setTimeout(() => {
    _preloadTimer = null;
    preloadAdjacent(filteredIdx);
  }, 45);
}

function enqueueSelectionSave(selectedFilenames) {
  _selectionSaveChain = _selectionSaveChain
    .then(() => invoke('save_selection', { dir: state.sourceDir, filenames: selectedFilenames }))
    .catch(() => { });
}

function queueSelectionSave() {
  if (!state.sourceDir) return;

  if (_selectionSaveTimer) clearTimeout(_selectionSaveTimer);
  _selectionSaveTimer = setTimeout(() => {
    _selectionSaveTimer = null;

    enqueueSelectionSave(state.selectedFilenames.slice());
  }, 1500);
}

async function flushSelectionSave() {
  if (_selectionSaveTimer) {
    clearTimeout(_selectionSaveTimer);
    _selectionSaveTimer = null;

    enqueueSelectionSave(state.selectedFilenames.slice());
  }

  await _selectionSaveChain;
}

function displayImage(filteredIdx, source = 'programmatic') {
  const filtered = getFilteredImages();

  if (filtered.length === 0) {
    els.mainImage.src = '';
    applyRotationForPath(null);
    els.statusFilename.textContent = '—';
    els.statusCounter.textContent = '— / —';
    els.statusSelection.textContent = '—';
    els.statusSelection.className = 'status-selection';
    els.selectedOverlay.classList.remove('visible');
    return;
  }

  filteredIdx = Math.max(0, Math.min(filteredIdx, filtered.length - 1));
  state.currentIndex = filteredIdx;

  const img = filtered[filteredIdx];
  const src = ensureFullImageSrc(img);

  if (els.mainImage.src !== src) {
    els.mainImage.classList.add('loading');
    els.mainImage.onload = () => els.mainImage.classList.remove('loading');
    els.mainImage.onerror = () => {
      els.mainImage.classList.remove('loading');
      showToast('Failed to load: ' + img.filename);
    };
    els.mainImage.src = src;
  }

  applyRotationForPath(img.full_path);

  scheduleAdjacentPreload(filteredIdx);

  // Status bar
  els.statusFilename.textContent = img.filename;
  els.statusCounter.textContent = `${filteredIdx + 1} / ${filtered.length}`;

  if (img.selected) {
    els.statusSelection.textContent = '✓ SELECTED';
    els.statusSelection.className = 'status-selection selected';
    els.selectedOverlay.classList.add('visible');
  } else {
    els.statusSelection.textContent = 'Not Selected';
    els.statusSelection.className = 'status-selection not-selected';
    els.selectedOverlay.classList.remove('visible');
  }

  els.statusSelectedCount.textContent = state.selectedCount > 0 ? `(${state.selectedCount} total selected)` : '';

  els.btnPrev.disabled = filteredIdx === 0;
  els.btnNext.disabled = filteredIdx === filtered.length - 1;

  highlightActiveThumbnail();
  scrollThumbnailIntoView(filteredIdx, source);
}

// ============================================================
// NAVIGATION
// ============================================================
function navigate(delta, source = 'programmatic') {
  const filtered = getFilteredImages();
  if (filtered.length === 0) return;
  const newIdx = Math.max(0, Math.min(state.currentIndex + delta, filtered.length - 1));
  displayImage(newIdx, source);
}

function navigateToFilteredIndex(idx, source = 'pointer') {
  displayImage(idx, source);
}

// ============================================================
// SELECTION TOGGLE
// ============================================================
async function toggleSelect() {
  const filtered = getFilteredImages();
  if (filtered.length === 0) return;

  const currentImg = filtered[state.currentIndex];
  if (!currentImg) return;

  const masterIdx = state.pathToIndex.get(currentImg.full_path);
  if (masterIdx === undefined) return;

  const preservedPath = currentImg.full_path;
  state.images[masterIdx].selected = !state.images[masterIdx].selected;
  currentImg.selected = state.images[masterIdx].selected;

  recomputeDerivedState();

  if (state.filter === 'all') {
    displayImage(state.currentIndex, 'toggle');
    updateThumbnailSelectedState(state.currentIndex);
  } else {
    const newFiltered = getFilteredImages();
    let nextIndex = newFiltered.findIndex(img => img.full_path === preservedPath);
    if (nextIndex === -1) {
      nextIndex = Math.min(state.currentIndex, Math.max(0, newFiltered.length - 1));
    }
    state.currentIndex = nextIndex;
    renderThumbnailStrip();
    displayImage(state.currentIndex);
  }

  updateStripCount();
  updateCompleteButton();

  showToast(currentImg.selected ? `✓ ${currentImg.filename} selected` : `✗ ${currentImg.filename} deselected`);

  queueSelectionSave();
}

// ============================================================
// FILTER
// ============================================================
function setFilter(mode) {
  state.filter = mode;
  recomputeDerivedState();
  state.currentIndex = 0;
  els.thumbnailList.scrollTop = 0;
  updateFilterButtons();
  renderThumbnailStrip();
  updateStripCount();
  const filtered = getFilteredImages();
  displayImage(filtered.length > 0 ? 0 : -1);
}

function updateFilterButtons() {
  els.filterBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === state.filter);
  });
}

// ============================================================
// COMPLETE SELECTION
// ============================================================
async function completeSelection() {
  await flushSelectionSave();

  const selected = state.selectedImages.slice();

  if (selected.length === 0) {
    showModal('error', 'No Images Selected', 'Please select at least one image before completing the selection.');
    return;
  }
  if (!state.destDir) {
    showModal('error', 'No Destination', 'Please select a destination folder first.');
    return;
  }

  els.btnComplete.disabled = true;

  // Show the progress panel immediately
  showCopyProgress(0, selected.length, 'Preparing…');

  // Subscribe to per-file progress events from Rust
  const unlisten = await listen('copy-progress', (event) => {
    const { current, total, filename } = event.payload;
    showCopyProgress(current, total, filename);
  });

  try {
    const filePaths = selected.map(img => img.full_path);
    const result = await invoke('copy_files', { files: filePaths, dest: state.destDir });

    let message = `Successfully copied <strong>${result.copied}</strong> image${result.copied !== 1 ? 's' : ''} to:<br><code style="color:var(--accent);font-size:11px;">${state.destDir}</code>`;
    if (result.skipped > 0) message += `<br><br>${result.skipped} file(s) skipped.`;
    if (result.errors.length > 0) message += `<br><br>Errors:<br>${result.errors.join('<br>')}`;

    showModal('success', 'Selection Complete!', message);
  } catch (e) {
    showModal('error', 'Copy Failed', String(e));
  } finally {
    unlisten(); // stop listening
    updateCompleteButton();
  }
}

/** Shows the copy-in-progress panel inside the modal */
function showCopyProgress(current, total, filename) {
  els.modalOverlay.classList.remove('hidden');
  els.copyProgressPanel.classList.remove('hidden');
  els.copyResultPanel.classList.add('hidden');

  const pct = total > 0 ? (current / total) * 100 : 0;
  els.copyProgressFill.style.width = pct + '%';
  els.copyProgressCounter.textContent = `${current} / ${total}`;
  els.copyProgressFile.textContent = filename;
}

function updateCompleteButton() {
  const hasImages = state.images.length > 0;
  const hasDest = !!state.destDir;
  els.btnComplete.disabled = !(hasImages && hasDest && state.selectedCount > 0);

  els.btnComplete.innerHTML = state.selectedCount > 0
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Complete (${state.selectedCount})`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Complete Selection`;
}

// ============================================================
// MODAL
// ============================================================
function showModal(type, title, message) {
  // Switch to result panel (hide progress panel)
  els.copyProgressPanel.classList.add('hidden');
  els.copyResultPanel.classList.remove('hidden');

  const isSuccess = type === 'success';
  els.modalIcon.className = 'modal-icon' + (isSuccess ? '' : ' error');
  els.modalIcon.innerHTML = isSuccess
    ? `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`
    : `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
  els.modalTitle.textContent = title;
  els.modalMessage.innerHTML = message;
  els.modalOverlay.classList.remove('hidden');
}

function closeModal() {
  els.modalOverlay.classList.add('hidden');
  // Reset for next use
  els.copyProgressPanel.classList.add('hidden');
  els.copyResultPanel.classList.remove('hidden');
}

// ============================================================
// TOAST
// ============================================================
let toastTimeout = null;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => els.toast.classList.remove('show'), 2000);
}

// ============================================================
// UTILITY
// ============================================================
function getBasename(path) {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

// Debounce helper — coalesces rapid calls into one at the trailing edge
function _debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================
let _navFramePending = false;
let _pendingNavDelta = 0;

function queueKeyboardNavigation(delta) {
  _pendingNavDelta = delta;
  if (_navFramePending) return;

  _navFramePending = true;
  requestAnimationFrame(() => {
    _navFramePending = false;
    const deltaToApply = _pendingNavDelta;
    _pendingNavDelta = 0;
    if (deltaToApply !== 0) navigate(deltaToApply, 'keyboard');
  });
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.key === 'Escape') {
    e.preventDefault();
    if (!els.modalOverlay.classList.contains('hidden')) closeModal();
    return;
  }

  if (state.images.length === 0 || !els.modalOverlay.classList.contains('hidden')) return;

  if (['ArrowRight', 'ArrowLeft', 's', 'S', 'r', 'R'].includes(e.key)) {
    e.preventDefault();
    if (e.key === 'ArrowRight') queueKeyboardNavigation(1);
    if (e.key === 'ArrowLeft') queueKeyboardNavigation(-1);
    if ((e.key === 's' || e.key === 'S') && !e.repeat) toggleSelect();
    if ((e.key === 'r' || e.key === 'R') && !e.repeat) rotateCurrentImageAntiClockwise();
  }
});

// ============================================================
// EVENT LISTENERS
// ============================================================
els.btnSourceDir.addEventListener('click', pickSourceDir);
els.btnDestDir.addEventListener('click', pickDestDir);
els.btnWelcomeSource.addEventListener('click', pickSourceDir);
els.btnComplete.addEventListener('click', completeSelection);
els.modalClose.addEventListener('click', closeModal);
els.modalOverlay.addEventListener('click', (e) => { if (e.target === els.modalOverlay) closeModal(); });
els.btnPrev.addEventListener('click', () => navigate(-1, 'pointer'));
els.btnNext.addEventListener('click', () => navigate(1, 'pointer'));
els.filterBtns.forEach(btn => btn.addEventListener('click', () => setFilter(btn.dataset.filter)));
els.thumbnailList.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const item = target.closest('.thumbnail-item');
  if (!item || !els.thumbnailList.contains(item)) return;

  const idx = Number(item.dataset.filteredIdx);
  if (!Number.isNaN(idx)) navigateToFilteredIndex(idx, 'pointer');
});

window.addEventListener('resize', _debounce(() => {
  scheduleThumbHeightCalibration();
  requestAnimationFrame(() => renderVisibleThumbnailPool(true));
}, 120));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    void flushSelectionSave();
  }
});

window.addEventListener('pagehide', () => {
  void flushSelectionSave();
});

window.addEventListener('beforeunload', () => {
  void flushSelectionSave();
});

// Theme toggle
const themeToggleBtn = document.getElementById('themeToggle');
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('cherrypic-theme', theme);
}
themeToggleBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
  scheduleThumbHeightCalibration();
});

// ============================================================
// INIT
// ============================================================

// Restore saved theme (default = light)
const savedTheme = localStorage.getItem('cherrypic-theme') || 'light';
applyTheme(savedTheme);

// Show welcome
els.welcomeState.classList.remove('hidden');
els.viewerState.classList.add('hidden');

// Splash screen (auto-dismiss after 2.2s)
const splash = document.getElementById('splashScreen');
if (splash) {
  setTimeout(() => {
    splash.classList.add('splash-hiding');
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
  }, 2000);
}

