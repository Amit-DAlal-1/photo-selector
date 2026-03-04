
# Photo Shortlisting App — Requirements Document

## 1. Overview

The Photo Shortlisting App is a **cross-platform desktop application built using Tauri** that helps users quickly review and shortlist photos for album selection.

The application allows users to browse images from a source directory and mark selected photos using keyboard shortcuts. After review, the selected images are copied to a specified destination directory.

The app is designed for **fast keyboard-driven workflows similar to gallery apps used by photographers.**

---

# 2. Technology Stack

**Framework**

* Tauri (latest stable version)

**Frontend**

* HTML
* CSS
* JavaScript / TypeScript
* Optional UI framework: React or Vanilla JS

**Backend**

* Rust (Tauri core)

**Platforms**

* macOS
* Windows

---

# 3. Core Features

## 3.1 Directory Selection

When the application starts, the user must select two directories.

### Directory 1 — Source Images

Contains all images to be reviewed.

Supported formats:

* JPG / JPEG
* PNG
* HEIC (optional)
* WEBP (optional)

Images from this directory will be loaded and displayed in the viewer.

---

### Directory 2 — Selected Images

Destination folder where shortlisted images will be copied when selection is complete.

---

# 4. Image Viewer

Images should be displayed **similar to a gallery application**.

### Viewer Behaviour

* Display **one image at a time**
* Fit image to screen
* Maintain aspect ratio
* Dark background

---

### Navigation

Keyboard navigation should be supported.

| Key           | Action                 |
| ------------- | ---------------------- |
| → Right Arrow | Next Image             |
| ← Left Arrow  | Previous Image         |
| S             | Toggle Select Image    |
| Esc           | Exit viewer (optional) |

---

# 5. Selection System

When a user presses:

**Key: `S`**

The currently displayed image should be:

* Marked as **Selected**
* Image filename stored in an **internal selection list**

Pressing **S again** should **toggle selection off**.

---

### Visual Feedback

When an image is selected:

Display a visual indicator:

* Green checkmark overlay
  or
* "SELECTED" label

---

# 6. Image Indexing

When source directory is loaded:

* Scan directory
* Load all supported image files
* Sort images alphabetically or by creation date

Internal structure:

```
image_list = [
  {
    filename
    full_path
    selected: true/false
  }
]
```

---

# 7. Review Filters (Optional for user to review their selection or directly save)

After browsing all images, user may choose to review images using filters.

### Filter Options

1. **All Images**
2. **Selected Images Only**
3. **Unselected Images Only**

This allows the user to quickly verify their selections.

---

# 8. Complete Selection

When the user clicks:

**"Complete Selection"**

The application will:

1. Take the list of selected images
2. Copy those files
3. Paste them into the **Selected Images Directory**

---

### Copy Rules

* Preserve original filename
* Do not delete source images
* If file exists:

  * Option A: overwrite
  * Option B: skip
  * Option C: rename (recommended)

---

# 9. UI Layout

## Main Window Layout

```
---------------------------------------------------
| Select Source Folder                            |
| Select Destination Folder                       |
---------------------------------------------------

                IMAGE VIEWER

---------------------------------------------------
| Image Name                                      |
| Image Counter (23 / 540)                        |
| Selection Status                                |
---------------------------------------------------

Keyboard Shortcuts:
← Previous | → Next | S Select
```

---

# 10. Performance Requirements

App should support large datasets.

Target:

* 5,000+ images
* Smooth navigation
* Lazy image loading
* Preload next/previous images

---

# 11. Data Storage

Selections should be temporarily stored in memory.

Optional:

Also save to:

```
selection.json
```

Example:

```json
{
  "selected_images": [
    "IMG_0001.jpg",
    "IMG_0024.jpg",
    "IMG_0099.jpg"
  ]
}
```

This allows recovery if the app crashes.

---

# 12. Error Handling

Handle the following:

* Empty directory
* No supported images found
* Destination folder not writable
* Duplicate filenames

---

# 13. Future Features (Optional)

Possible future upgrades:

* Zoom image
* Delete image
* Rate images (1–5 stars)
* Compare two photos side-by-side
* Auto-advance after selection
* Slideshow mode
* Thumbnail strip

---

# 14. Expected User Workflow

1. Open app
2. Select **Source Image Folder**
3. Select **Destination Folder**
4. Start reviewing images
5. Use **arrow keys** to navigate
6. Press **S** to select photos
7. Optionally filter selected/unselected images
8. Click **Complete Selection**
9. Selected images are copied to destination folder

---
# Layout:
* Filter and selected folder at the top of the window
* left scrollable image thumbnail strip
* right main image viewer
* Bottom image name and selection status.
* Selection status should also appear on the thumbnail strip.

---


# 15. Non-Functional Requirements

| Requirement     | Description         |
| --------------- | ------------------- |
| Cross Platform  | macOS + Windows     |
| Offline         | Fully offline       |
| Lightweight     | < 50MB              |
| Fast Navigation | <100ms image switch |

---