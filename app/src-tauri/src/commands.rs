use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};
use tempfile::NamedTempFile;
use walkdir::WalkDir;

use crate::thumbnail;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageInfo {
    pub filename: String,
    pub full_path: String,
    pub file_size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CopyResult {
    pub copied: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SelectionFile {
    pub selected_images: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CopyProgress {
    pub current: usize,
    pub total: usize,
    pub filename: String,
}

fn is_supported_image(path: &Path) -> bool {
    if let Some(ext) = path.extension() {
        let ext = ext.to_string_lossy().to_lowercase();
        matches!(
            ext.as_str(),
            "jpg" | "jpeg" | "png" | "webp" | "heic" | "gif" | "bmp" | "tiff" | "tif"
        )
    } else {
        false
    }
}

fn reserve_dest_name(filename: &str, used_names: &mut HashSet<String>) -> String {
    if used_names.insert(filename.to_string()) {
        return filename.to_string();
    }

    let name_path = Path::new(filename);
    let stem = name_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = name_path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    let mut counter = 1u32;
    loop {
        let candidate = format!("{}_{}{}", stem, counter, ext);
        if used_names.insert(candidate.clone()) {
            return candidate;
        }
        counter += 1;
    }
}

/// Scans a directory for supported images.
/// Runs the blocking walkdir scan on a dedicated thread pool via spawn_blocking
/// so it never stalls the async Tauri runtime (important for 5000+ image folders).
#[tauri::command]
pub async fn list_images(dir: String) -> Result<Vec<ImageInfo>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<ImageInfo>, String> {
        let dir_path = Path::new(&dir);
        if !dir_path.exists() {
            return Err(format!("Directory does not exist: {}", dir));
        }
        if !dir_path.is_dir() {
            return Err(format!("Path is not a directory: {}", dir));
        }

        let mut images: Vec<ImageInfo> = WalkDir::new(&dir)
            .min_depth(1)
            .max_depth(1)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file() && is_supported_image(e.path()))
            .map(|e| ImageInfo {
                filename: e.file_name().to_string_lossy().to_string(),
                full_path: e.path().to_string_lossy().to_string(),
                file_size: e.metadata().map(|m| m.len()).unwrap_or(0),
            })
            .collect();

        if images.is_empty() {
            return Err("No supported images found in directory".to_string());
        }

        images.sort_by_cached_key(|img| img.filename.to_ascii_lowercase());
        Ok(images)
    })
    .await
    .map_err(|e| format!("Scan error: {}", e))?
}

#[tauri::command]
pub async fn get_thumbnail(path: String, app: AppHandle) -> Result<String, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache directory: {}", e))?
        .join("thumbs");

    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("Failed to create thumbnail cache directory: {}", e))?;

    thumbnail::get_or_create_thumbnail(Path::new(&path), &cache_dir)
        .await
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// Copies selected files to the destination directory.
/// Runs on a thread pool (spawn_blocking) and emits a `copy-progress` Tauri event
/// after each file so the frontend can display a real-time progress bar.
#[tauri::command]
pub async fn copy_files(
    app: AppHandle,
    files: Vec<String>,
    dest: String,
) -> Result<CopyResult, String> {
    tokio::task::spawn_blocking(move || -> Result<CopyResult, String> {
        let dest_path = Path::new(&dest);

        if !dest_path.exists() {
            fs::create_dir_all(dest_path)
                .map_err(|e| format!("Cannot create destination directory: {}", e))?;
        }

        // Check writable
        let test_file = dest_path.join(".write_test");
        fs::write(&test_file, "")
            .map_err(|_| "Destination directory is not writable".to_string())?;
        let _ = fs::remove_file(&test_file);

        let total = files.len();
        let mut result = CopyResult {
            copied: 0,
            skipped: 0,
            errors: vec![],
        };

        let mut used_names: HashSet<String> = HashSet::new();
        if let Ok(entries) = fs::read_dir(dest_path) {
            for entry in entries.flatten() {
                let file_name = entry.file_name();
                if let Some(name) = file_name.to_str() {
                    used_names.insert(name.to_string());
                }
            }
        }

        for (i, src_path_str) in files.iter().enumerate() {
            let src_path = Path::new(src_path_str);

            let filename = match src_path.file_name() {
                Some(n) => n.to_string_lossy().to_string(),
                None => {
                    result.errors.push(format!("Invalid filename: {}", src_path_str));
                    continue;
                }
            };

            // Emit progress event BEFORE copying so the UI updates immediately
            let _ = app.emit(
                "copy-progress",
                CopyProgress {
                    current: i + 1,
                    total,
                    filename: filename.clone(),
                },
            );

            if !src_path.exists() {
                result.errors.push(format!("Source not found: {}", src_path_str));
                continue;
            }

            let reserved_name = reserve_dest_name(&filename, &mut used_names);
            let dest_file = dest_path.join(&reserved_name);

            match fs::copy(src_path, &dest_file) {
                Ok(_) => result.copied += 1,
                Err(e) => result
                    .errors
                    .push(format!("Failed to copy {}: {}", filename, e)),
            }
        }

        Ok(result)
    })
    .await
    .map_err(|e| format!("Copy error: {}", e))?
}

#[tauri::command]
pub async fn save_selection(dir: String, filenames: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let selection = SelectionFile {
            selected_images: filenames,
        };
        let path = Path::new(&dir).join("selection.json");
        let parent = path
            .parent()
            .ok_or_else(|| "Failed to resolve selection.json parent directory".to_string())?;
        let json = serde_json::to_string_pretty(&selection)
            .map_err(|e| format!("Serialization error: {}", e))?;

        let mut temp_file = NamedTempFile::new_in(parent)
            .map_err(|e| format!("Failed to create temporary selection file: {}", e))?;
        temp_file
            .write_all(json.as_bytes())
            .map_err(|e| format!("Failed to write temporary selection file: {}", e))?;
        temp_file
            .flush()
            .map_err(|e| format!("Failed to flush temporary selection file: {}", e))?;
        temp_file
            .persist(&path)
            .map_err(|e| format!("Failed to persist selection.json: {}", e.error))?;

        Ok(())
    })
    .await
    .map_err(|e| format!("Save selection task failed: {}", e))?
}

#[tauri::command]
pub async fn load_selection(dir: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&dir).join("selection.json");
        if !path.exists() {
            return Ok(vec![]);
        }
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read selection.json: {}", e))?;
        let selection: SelectionFile = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse selection.json: {}", e))?;
        Ok(selection.selected_images)
    })
    .await
    .map_err(|e| format!("Load selection task failed: {}", e))?
}
