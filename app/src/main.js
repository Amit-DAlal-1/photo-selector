/**
 * Photo Selector — Main Application Logic
 * A fast keyboard-driven photo shortlisting tool built with Tauri.
 */

const { invoke } = window.__TAURI__.core;
const { open: dialogOpen } = window.__TAURI__.dialog;

// ============================================================
// APPLICATION STATE
// ============================================================
const state = {
  images: [],           // Array of { filename, full_path, selected }
  currentIndex: -1,     // Index into state.images (filtered view index)
  filter: 'all',        // 'all' | 'selected' | 'unselected'
  sourceDir: null,
  destDir: null,
};

// Derived: filteredImages based on current filter
function getFilteredImages() {
  switch (state.filter) {
    case 'selected':
      return state.images.filter(img => img.selected);
    case 'unselected':
      return state.images.filter(img => !img.selected);
    default:
      return state.images;
  }
}

// ============================================================
// DOM REFERENCES
// ============================================================
const els = {
  // Toolbar
  btnSourceDir: document.getElementById('btnSourceDir'),
  btnDestDir: document.getElementById('btnDestDir'),
  sourceDirLabel: document.getElementById('sourceDirLabel'),
  destDirLabel: document.getElementById('destDirLabel'),
  btnComplete: document.getElementById('btnComplete'),
  filterBtns: document.querySelectorAll('.filter-btn'),

  // States
  welcomeState: document.getElementById('welcomeState'),
  viewerState: document.getElementById('viewerState'),
  btnWelcomeSource: document.getElementById('btnWelcomeSource'),

  // Viewer
  thumbnailList: document.getElementById('thumbnailList'),
  stripCount: document.getElementById('stripCount'),
  mainImage: document.getElementById('mainImage'),
  selectedOverlay: document.getElementById('selectedOverlay'),

  // Status bar
  statusFilename: document.getElementById('statusFilename'),
  statusCounter: document.getElementById('statusCounter'),
  statusSelection: document.getElementById('statusSelection'),
  statusSelectedCount: document.getElementById('statusSelectedCount'),
  btnPrev: document.getElementById('btnPrev'),
  btnNext: document.getElementById('btnNext'),

  // Modal
  modalOverlay: document.getElementById('modalOverlay'),
  modalIcon: document.getElementById('modalIcon'),
  modalTitle: document.getElementById('modalTitle'),
  modalMessage: document.getElementById('modalMessage'),
  modalClose: document.getElementById('modalClose'),

  // Toast
  toast: document.getElementById('toast'),
};

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

    // Attempt to restore previous selection from selection.json
    let previousSelection = [];
    try {
      previousSelection = await invoke('load_selection', { dir: state.sourceDir });
    } catch (_) {}
    const prevSet = new Set(previousSelection);

    state.images = rawImages.map(img => ({
      ...img,
      selected: prevSet.has(img.filename),
    }));

    state.currentIndex = 0;
    state.filter = 'all';
    updateFilterButtons();

    // Switch to viewer state
    els.welcomeState.classList.add('hidden');
    els.viewerState.classList.remove('hidden');

    renderThumbnailStrip();
    displayImage(0);
    updateCompleteButton();
    updateStripCount();
  } catch (e) {
    showModal('error', 'No Images Found', String(e));
  }
}

// ============================================================
// THUMBNAIL STRIP
// ============================================================
function renderThumbnailStrip() {
  els.thumbnailList.innerHTML = '';
  const filtered = getFilteredImages();

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:20px;text-align:center;color:var(--text-muted);font-size:12px;';
    empty.textContent = 'No images match this filter.';
    els.thumbnailList.appendChild(empty);
    return;
  }

  filtered.forEach((img, filteredIdx) => {
    const item = document.createElement('div');
    item.className = 'thumbnail-item' + (img.selected ? ' selected' : '');
    item.dataset.fullPath = img.full_path;
    item.dataset.filteredIdx = filteredIdx;

    // Thumbnail image using convertFileSrc for local file protocol
    const thumbImg = document.createElement('img');
    thumbImg.loading = 'lazy';
    thumbImg.src = window.__TAURI__.core.convertFileSrc(img.full_path);
    thumbImg.alt = img.filename;

    // Selected badge
    const badge = document.createElement('div');
    badge.className = 'thumb-badge';
    badge.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`;

    // Name tooltip
    const nameEl = document.createElement('div');
    nameEl.className = 'thumb-name';
    nameEl.textContent = img.filename;

    item.appendChild(thumbImg);
    item.appendChild(badge);
    item.appendChild(nameEl);

    item.addEventListener('click', () => {
      navigateToFilteredIndex(filteredIdx);
    });

    els.thumbnailList.appendChild(item);
  });

  highlightActiveThumbnail();
}

function highlightActiveThumbnail() {
  const items = els.thumbnailList.querySelectorAll('.thumbnail-item');
  items.forEach((item, i) => {
    item.classList.toggle('active', i === state.currentIndex);
  });

  // Scroll active thumbnail into view
  const activeItem = els.thumbnailList.children[state.currentIndex];
  if (activeItem) {
    activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function updateStripCount() {
  const filtered = getFilteredImages();
  const total = state.images.length;
  const selectedCount = state.images.filter(i => i.selected).length;
  els.stripCount.textContent = `${filtered.length} of ${total} · ${selectedCount} selected`;
}

function updateThumbnailSelectedState(filteredIdx) {
  const items = els.thumbnailList.querySelectorAll('.thumbnail-item');
  const item = items[filteredIdx];
  if (!item) return;
  const img = getFilteredImages()[filteredIdx];
  if (!img) return;
  item.classList.toggle('selected', img.selected);
}

// ============================================================
// IMAGE DISPLAY
// ============================================================
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

  // Clamp index
  filteredIdx = Math.max(0, Math.min(filteredIdx, filtered.length - 1));
  state.currentIndex = filteredIdx;

  const img = filtered[filteredIdx];

  // Load image
  els.mainImage.classList.add('loading');
  const newSrc = window.__TAURI__.core.convertFileSrc(img.full_path);
  els.mainImage.onload = () => els.mainImage.classList.remove('loading');
  els.mainImage.onerror = () => {
    els.mainImage.classList.remove('loading');
    showToast('Failed to load image: ' + img.filename);
  };
  els.mainImage.src = newSrc;

  // Update status bar
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

  // Selected count
  const selectedCount = state.images.filter(i => i.selected).length;
  els.statusSelectedCount.textContent = selectedCount > 0 ? `(${selectedCount} total selected)` : '';

  // Nav buttons
  els.btnPrev.disabled = filteredIdx === 0;
  els.btnNext.disabled = filteredIdx === filtered.length - 1;

  highlightActiveThumbnail();
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

  // Find in master images array and toggle
  const masterIdx = state.images.findIndex(img => img.full_path === currentImg.full_path);
  if (masterIdx === -1) return;

  state.images[masterIdx].selected = !state.images[masterIdx].selected;

  // Update the filtered image reference
  currentImg.selected = state.images[masterIdx].selected;

  // Update UI
  displayImage(state.currentIndex);
  updateThumbnailSelectedState(state.currentIndex);
  updateStripCount();
  updateCompleteButton();

  // Show brief feedback
  showToast(currentImg.selected ? `✓ ${currentImg.filename} selected` : `✗ ${currentImg.filename} deselected`);

  // Auto-save selection to disk for crash recovery
  try {
    const selectedFilenames = state.images.filter(i => i.selected).map(i => i.filename);
    await invoke('save_selection', { dir: state.sourceDir, filenames: selectedFilenames });
  } catch (_) {
    // Non-critical, ignore
  }

  // If filter is active, re-render strip after a short delay
  if (state.filter !== 'all') {
    // Re-render strip for filtered views since item might need to hide/show
    setTimeout(() => {
      renderThumbnailStrip();
      updateStripCount();
      // Adjust index if necessary
      const newFiltered = getFilteredImages();
      if (state.currentIndex >= newFiltered.length) {
        state.currentIndex = Math.max(0, newFiltered.length - 1);
      }
      if (newFiltered.length > 0) {
        displayImage(state.currentIndex);
      }
    }, 300);
  }
}

// ============================================================
// FILTER
// ============================================================
function setFilter(mode) {
  state.filter = mode;
  state.currentIndex = 0;
  updateFilterButtons();
  renderThumbnailStrip();
  updateStripCount();
  const filtered = getFilteredImages();
  if (filtered.length > 0) {
    displayImage(0);
  } else {
    displayImage(-1);
  }
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
  els.btnComplete.textContent = 'Copying…';

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
    updateCompleteButton();
  }
}

function updateCompleteButton() {
  const selectedCount = state.images.filter(img => img.selected).length;
  const hasImages = state.images.length > 0;
  const hasDest = !!state.destDir;
  els.btnComplete.disabled = !(hasImages && hasDest && selectedCount > 0);

  // Update label
  if (selectedCount > 0) {
    els.btnComplete.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      Complete (${selectedCount})
    `;
  } else {
    els.btnComplete.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      Complete Selection
    `;
  }
}

// ============================================================
// MODAL
// ============================================================
function showModal(type, title, message) {
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

// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================
document.addEventListener('keydown', (e) => {
  // Don't intercept when typing in inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (state.images.length === 0) return;

  switch (e.key) {
    case 'ArrowRight':
      e.preventDefault();
      navigate(1);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      navigate(-1);
      break;
    case 's':
    case 'S':
      e.preventDefault();
      toggleSelect();
      break;
    case 'Escape':
      e.preventDefault();
      if (!els.modalOverlay.classList.contains('hidden')) {
        closeModal();
      }
      break;
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
els.modalOverlay.addEventListener('click', (e) => {
  if (e.target === els.modalOverlay) closeModal();
});

els.btnPrev.addEventListener('click', () => navigate(-1));
els.btnNext.addEventListener('click', () => navigate(1));

els.filterBtns.forEach(btn => {
  btn.addEventListener('click', () => setFilter(btn.dataset.filter));
});

// ============================================================
// INIT
// ============================================================
// Show welcome state on startup
els.welcomeState.classList.remove('hidden');
els.viewerState.classList.add('hidden');
