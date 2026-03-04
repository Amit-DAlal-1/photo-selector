use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageInfo {
    pub filename: String,
    pub full_path: String,
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

#[tauri::command]
pub fn list_images(dir: String) -> Result<Vec<ImageInfo>, String> {
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
        })
        .collect();

    if images.is_empty() {
        return Err("No supported images found in directory".to_string());
    }

    // Sort alphabetically by filename
    images.sort_by(|a, b| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()));

    Ok(images)
}

#[tauri::command]
pub fn copy_files(files: Vec<String>, dest: String) -> Result<CopyResult, String> {
    let dest_path = Path::new(&dest);

    if !dest_path.exists() {
        fs::create_dir_all(&dest_path)
            .map_err(|e| format!("Cannot create destination directory: {}", e))?;
    }

    // Check writable by trying to write a temp file
    let test_file = dest_path.join(".write_test");
    fs::write(&test_file, "").map_err(|_| "Destination directory is not writable".to_string())?;
    let _ = fs::remove_file(&test_file);

    let mut result = CopyResult {
        copied: 0,
        skipped: 0,
        errors: vec![],
    };

    for src_path_str in &files {
        let src_path = Path::new(src_path_str);
        if !src_path.exists() {
            result.errors.push(format!("Source not found: {}", src_path_str));
            continue;
        }

        let filename = match src_path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => {
                result.errors.push(format!("Invalid filename: {}", src_path_str));
                continue;
            }
        };

        // Determine destination path, rename on conflict
        let mut dest_file = dest_path.join(&filename);
        if dest_file.exists() {
            let stem = src_path.file_stem().unwrap_or_default().to_string_lossy();
            let ext = src_path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
            let mut counter = 1u32;
            loop {
                let new_name = format!("{}_{}{}", stem, counter, ext);
                dest_file = dest_path.join(&new_name);
                if !dest_file.exists() {
                    break;
                }
                counter += 1;
            }
        }

        match fs::copy(src_path, &dest_file) {
            Ok(_) => result.copied += 1,
            Err(e) => result.errors.push(format!("Failed to copy {}: {}", filename, e)),
        }
    }

    Ok(result)
}

#[tauri::command]
pub fn save_selection(dir: String, filenames: Vec<String>) -> Result<(), String> {
    let selection = SelectionFile {
        selected_images: filenames,
    };
    let json = serde_json::to_string_pretty(&selection)
        .map_err(|e| format!("Serialization error: {}", e))?;
    let path = Path::new(&dir).join("selection.json");
    fs::write(&path, json).map_err(|e| format!("Failed to write selection.json: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn load_selection(dir: String) -> Result<Vec<String>, String> {
    let path = Path::new(&dir).join("selection.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read selection.json: {}", e))?;
    let selection: SelectionFile = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse selection.json: {}", e))?;
    Ok(selection.selected_images)
}
