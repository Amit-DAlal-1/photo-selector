use anyhow::{Context, Result};
use image::imageops::FilterType;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

const THUMB_SIZE: u32 = 240;

fn cache_key(path: &Path) -> String {
    let meta = std::fs::metadata(path).ok();
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    mtime.hash(&mut hasher);
    format!("{:x}.jpg", hasher.finish())
}

pub async fn get_or_create_thumbnail(original: &Path, cache_dir: &Path) -> Result<PathBuf> {
    let thumb_path = cache_dir.join(cache_key(original));

    if thumb_path.exists() {
        return Ok(thumb_path);
    }

    let original = original.to_path_buf();
    let thumb_path_clone = thumb_path.clone();

    tokio::task::spawn_blocking(move || -> Result<()> {
        let img = image::open(&original)
            .with_context(|| format!("Failed to decode image: {}", original.display()))?;
        let thumb = img.resize(THUMB_SIZE, THUMB_SIZE, FilterType::Triangle);

        thumb
            .save_with_format(&thumb_path_clone, image::ImageFormat::Jpeg)
            .with_context(|| format!("Failed to save thumbnail: {}", thumb_path_clone.display()))?;

        Ok(())
    })
    .await
    .context("Thumbnail task failed")??;

    Ok(thumb_path)
}
