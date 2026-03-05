/**
 * Photo Selector — Main Application Logic
 * A fast keyboard-driven photo shortlisting tool built with Tauri.
 * Performance optimised: URL caching, image preloading, nav debouncing, virtual thumbnail strip.
 * Async Rust commands: spawn_blocking for scan + copy with real-time progress events.
 */

const { invoke } = window.__TAURI__.core;
const { open: dialogOpen } = window.__TAURI__.dialog;
const { convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ============================================================
// APPLICATION STATE
// ============================================================
const state = {
  images: [],           // Array of { filename, full_path, selected, src }
  currentIndex: -1,     // Index into filtered view
  filter: 'all',        // 'all' | 'selected' | 'unselected'
  sourceDir: null,
  destDir: null,
  // Virtual scroll state
  virtualStart: 0,      // First rendered thumbnail index
  VIRTUAL_WINDOW: 60,   // How many thumbnails to render at once
  THUMB_ITEM_HEIGHT: 151, // px per thumbnail item: ~147px content (4/3 aspect at 196px width) + 4px gap
};

// Derived: filteredImages based on current filter
function getFilteredImages() {
  switch (state.filter) {
    case 'selected': return state.images.filter(img => img.selected);
    case 'unselected': return state.images.filter(img => !img.selected);
    default: return state.images;
  }
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
// PERFORMANCE: PRELOADER CACHE
// ============================================================
// Keyed by full_path → HTMLImageElement (warm browser cache)
const preloadCache = new Map();

function preloadImage(img) {
  if (!img || preloadCache.has(img.full_path)) return;
  const el = new Image();
  el.src = img.src;
  preloadCache.set(img.full_path, el);
}

function preloadAdjacent(filteredIdx) {
  const filtered = getFilteredImages();
  // Preload next 3 and previous 2
  for (let d = -2; d <= 3; d++) {
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

    // Pre-compute convertFileSrc for every image ONCE — avoids repeated calls per render
    state.images = rawImages.map(img => ({
      ...img,
      selected: prevSet.has(img.filename),
      src: convertFileSrc(img.full_path),  // cached URL
    }));

    preloadCache.clear();
    state.currentIndex = 0;
    state.filter = 'all';
    state.virtualStart = 0;
    updateFilterButtons();

    els.welcomeState.classList.add('hidden');
    els.viewerState.classList.remove('hidden');

    renderThumbnailStrip();
    displayImage(0);
    updateCompleteButton();
    updateStripCount();

    // Kick off background preload of first few images
    const filtered = getFilteredImages();
    for (let i = 0; i < Math.min(5, filtered.length); i++) preloadImage(filtered[i]);

  } catch (e) {
    showModal('error', 'No Images Found', String(e));
  }
}

// ============================================================
// VIRTUAL THUMBNAIL STRIP
// ============================================================
// We only render VIRTUAL_WINDOW items around the active index.
// A top/bottom spacer div pushes the scrollbar to show correct total height.

let _stripScrollHandler = null;

function renderThumbnailStrip() {
  // Remove old scroll listener
  if (_stripScrollHandler) {
    els.thumbnailList.removeEventListener('scroll', _stripScrollHandler);
    _stripScrollHandler = null;
  }

  els.thumbnailList.innerHTML = '';
  const filtered = getFilteredImages();

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'thumb-empty';
    empty.textContent = 'No images match this filter.';
    els.thumbnailList.appendChild(empty);
    return;
  }

  // For small sets render everything directly (no virtual overhead)
  if (filtered.length <= state.VIRTUAL_WINDOW) {
    renderThumbRange(filtered, 0, filtered.length);
    highlightActiveThumbnail();
    return;
  }

  // Virtual rendering
  _renderVirtualStrip(filtered);
}

function _renderVirtualStrip(filtered) {
  const total = filtered.length;
  const H = state.THUMB_ITEM_HEIGHT;

  // Compute window
  const start = Math.max(0, state.virtualStart);
  const end = Math.min(total, start + state.VIRTUAL_WINDOW);

  // Spacers
  const topSpacer = document.createElement('div');
  topSpacer.style.height = `${start * H}px`;
  topSpacer.style.flexShrink = '0';

  const bottomSpacer = document.createElement('div');
  bottomSpacer.style.height = `${(total - end) * H}px`;
  bottomSpacer.style.flexShrink = '0';

  els.thumbnailList.appendChild(topSpacer);
  renderThumbRange(filtered, start, end);
  els.thumbnailList.appendChild(bottomSpacer);

  highlightActiveThumbnail();

  // Re-attach scroll handler for virtual updates
  _stripScrollHandler = _debounce(() => {
    const scrollTop = els.thumbnailList.scrollTop;
    const newStart = Math.max(0, Math.floor(scrollTop / H) - 10);
    if (Math.abs(newStart - state.virtualStart) > 5) {
      state.virtualStart = newStart;
      _rerenderVirtualStrip();
    }
  }, 60);
  els.thumbnailList.addEventListener('scroll', _stripScrollHandler, { passive: true });
}

function _rerenderVirtualStrip() {
  const filtered = getFilteredImages();
  const total = filtered.length;
  const H = state.THUMB_ITEM_HEIGHT;
  const start = Math.max(0, state.virtualStart);
  const end = Math.min(total, start + state.VIRTUAL_WINDOW);

  // Update spacer heights and only replace middle children
  const children = els.thumbnailList.children;
  if (children.length >= 2) {
    children[0].style.height = `${start * H}px`;
    children[children.length - 1].style.height = `${(total - end) * H}px`;
  }

  // Remove old thumb items (all except first and last spacer)
  while (els.thumbnailList.children.length > 2) {
    els.thumbnailList.removeChild(els.thumbnailList.children[1]);
  }

  renderThumbRange(filtered, start, end);

  // Re-insert bottom spacer at end
  const bottomSpacer = els.thumbnailList.lastChild;
  // Move bottom spacer to end (it was before the newly inserted items)
  els.thumbnailList.appendChild(bottomSpacer);

  highlightActiveThumbnail();
}

function renderThumbRange(filtered, start, end) {
  const frag = document.createDocumentFragment();

  for (let filteredIdx = start; filteredIdx < end; filteredIdx++) {
    const img = filtered[filteredIdx];

    const item = document.createElement('div');
    item.className = 'thumbnail-item' + (img.selected ? ' selected' : '');
    item.dataset.filteredIdx = filteredIdx;

    const thumbImg = document.createElement('img');
    thumbImg.loading = 'lazy';
    thumbImg.src = img.src;  // Use pre-computed URL
    thumbImg.alt = img.filename;
    thumbImg.decoding = 'async';

    const badge = document.createElement('div');
    badge.className = 'thumb-badge';
    badge.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`;

    const nameEl = document.createElement('div');
    nameEl.className = 'thumb-name';
    nameEl.textContent = img.filename;

    item.appendChild(thumbImg);
    item.appendChild(badge);
    item.appendChild(nameEl);

    item.addEventListener('click', () => navigateToFilteredIndex(filteredIdx));
    frag.appendChild(item);
  }

  // Insert before bottom spacer if it exists, else just append
  const lastChild = els.thumbnailList.lastChild;
  const isBottomSpacer = lastChild && lastChild.dataset && lastChild.dataset.isSpacer;
  if (isBottomSpacer) {
    els.thumbnailList.insertBefore(frag, lastChild);
  } else {
    els.thumbnailList.appendChild(frag);
  }
}

function highlightActiveThumbnail() {
  const items = els.thumbnailList.querySelectorAll('.thumbnail-item');
  const filtered = getFilteredImages();
  items.forEach(item => {
    const idx = parseInt(item.dataset.filteredIdx, 10);
    item.classList.toggle('active', idx === state.currentIndex);
  });
}

function scrollThumbnailIntoView(filteredIdx) {
  const filtered = getFilteredImages();
  const total = filtered.length;
  const H = state.THUMB_ITEM_HEIGHT;
  const listEl = els.thumbnailList;

  // Always center the active thumbnail in the visible strip panel
  const targetScrollTop = Math.max(0, filteredIdx * H - (listEl.clientHeight / 2) + (H / 2));
  listEl.scrollTo({ top: targetScrollTop, behavior: 'smooth' });

  // Update virtual window if needed for large sets
  if (total > state.VIRTUAL_WINDOW) {
    const newStart = Math.max(0, filteredIdx - Math.floor(state.VIRTUAL_WINDOW / 2));
    if (newStart !== state.virtualStart) {
      state.virtualStart = newStart;
      _rerenderVirtualStrip();
    }
  }
}

function updateStripCount() {
  const filtered = getFilteredImages();
  const total = state.images.length;
  const selectedCount = state.images.filter(i => i.selected).length;
  els.stripCount.textContent = `${filtered.length} of ${total} · ${selectedCount} selected`;
}

function updateThumbnailSelectedState(filteredIdx) {
  const item = els.thumbnailList.querySelector(`[data-filtered-idx="${filteredIdx}"]`);
  if (!item) return;
  const img = getFilteredImages()[filteredIdx];
  if (!img) return;
  item.classList.toggle('selected', img.selected);
}

// ============================================================
// IMAGE DISPLAY
// ============================================================
let _displayRafId = null;

function displayImage(filteredIdx) {
  const filtered = getFilteredImages();

  if (filtered.length === 0) {
    els.mainImage.src = '';
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

  // Use pre-computed src URL — no repeated convertFileSrc calls
  if (els.mainImage.src !== img.src) {
    els.mainImage.classList.add('loading');
    els.mainImage.onload = () => els.mainImage.classList.remove('loading');
    els.mainImage.onerror = () => {
      els.mainImage.classList.remove('loading');
      showToast('Failed to load: ' + img.filename);
    };
    els.mainImage.src = img.src;
  }

  // Preload neighbours immediately after paint
  if (_displayRafId) cancelAnimationFrame(_displayRafId);
  _displayRafId = requestAnimationFrame(() => preloadAdjacent(filteredIdx));

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

  const selectedCount = state.images.filter(i => i.selected).length;
  els.statusSelectedCount.textContent = selectedCount > 0 ? `(${selectedCount} total selected)` : '';

  els.btnPrev.disabled = filteredIdx === 0;
  els.btnNext.disabled = filteredIdx === filtered.length - 1;

  highlightActiveThumbnail();
  scrollThumbnailIntoView(filteredIdx);
}

// ============================================================
// NAVIGATION
// ============================================================
function navigate(delta) {
  const filtered = getFilteredImages();
  if (filtered.length === 0) return;
  const newIdx = Math.max(0, Math.min(state.currentIndex + delta, filtered.length - 1));
  displayImage(newIdx);
}

function navigateToFilteredIndex(idx) {
  displayImage(idx);
}

// ============================================================
// SELECTION TOGGLE
// ============================================================
async function toggleSelect() {
  const filtered = getFilteredImages();
  if (filtered.length === 0) return;

  const currentImg = filtered[state.currentIndex];
  if (!currentImg) return;

  const masterIdx = state.images.findIndex(img => img.full_path === currentImg.full_path);
  if (masterIdx === -1) return;

  state.images[masterIdx].selected = !state.images[masterIdx].selected;
  currentImg.selected = state.images[masterIdx].selected;

  displayImage(state.currentIndex);
  updateThumbnailSelectedState(state.currentIndex);
  updateStripCount();
  updateCompleteButton();

  showToast(currentImg.selected ? `✓ ${currentImg.filename} selected` : `✗ ${currentImg.filename} deselected`);

  // Auto-save (non-blocking)
  try {
    const selectedFilenames = state.images.filter(i => i.selected).map(i => i.filename);
    await invoke('save_selection', { dir: state.sourceDir, filenames: selectedFilenames });
  } catch (_) { }

  if (state.filter !== 'all') {
    setTimeout(() => {
      renderThumbnailStrip();
      updateStripCount();
      const newFiltered = getFilteredImages();
      if (state.currentIndex >= newFiltered.length) {
        state.currentIndex = Math.max(0, newFiltered.length - 1);
      }
      if (newFiltered.length > 0) displayImage(state.currentIndex);
    }, 300);
  }
}

// ============================================================
// FILTER
// ============================================================
function setFilter(mode) {
  state.filter = mode;
  state.currentIndex = 0;
  state.virtualStart = 0;
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
  const selected = state.images.filter(img => img.selected);

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
  const selectedCount = state.images.filter(img => img.selected).length;
  const hasImages = state.images.length > 0;
  const hasDest = !!state.destDir;
  els.btnComplete.disabled = !(hasImages && hasDest && selectedCount > 0);

  els.btnComplete.innerHTML = selectedCount > 0
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Complete (${selectedCount})`
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
// KEYBOARD SHORTCUTS  (debounced at 80ms — fast but coalescable)
// ============================================================
const _handleKey = _debounce((e) => {
  if (state.images.length === 0) return;
  switch (e.key) {
    case 'ArrowRight': navigate(1); break;
    case 'ArrowLeft': navigate(-1); break;
    case 's': case 'S': toggleSelect(); break;
  }
}, 80);

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (state.images.length === 0) return;

  if (['ArrowRight', 'ArrowLeft', 's', 'S'].includes(e.key)) {
    e.preventDefault();
    _handleKey(e);
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    if (!els.modalOverlay.classList.contains('hidden')) closeModal();
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
els.btnPrev.addEventListener('click', () => navigate(-1));
els.btnNext.addEventListener('click', () => navigate(1));
els.filterBtns.forEach(btn => btn.addEventListener('click', () => setFilter(btn.dataset.filter)));

// Theme toggle
const themeToggleBtn = document.getElementById('themeToggle');
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('cherrypic-theme', theme);
}
themeToggleBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
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

