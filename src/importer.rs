use std::ffi::OsStr;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use flate2::read::GzDecoder;
use zip::ZipArchive;

use crate::dmarc::{parse_report, Report};
use crate::error::{AppError, Result};
use crate::store::{InsertSummary, Store};

pub struct Importer {
    store: Arc<Store>,
}

impl Importer {
    pub fn new(store: Arc<Store>) -> Self {
        Self { store }
    }

    pub async fn import_path(&self, path: &Path) -> Result<InsertSummary> {
        let mut reports = Vec::new();
        for file in collect_files(path)? {
            let bytes = tokio::fs::read(&file).await?;
            reports.extend(parse_payload(&file.to_string_lossy(), &bytes)?);
        }
        self.store.insert_many(reports).await
    }

    pub async fn import_upload(&self, filename: &str, bytes: &[u8]) -> Result<InsertSummary> {
        let reports = parse_payload(filename, bytes)?;
        self.store.insert_many(reports).await
    }
}

fn collect_files(path: &Path) -> Result<Vec<PathBuf>> {
    if path.is_file() {
        return Ok(vec![path.to_path_buf()]);
    }
    if !path.is_dir() {
        return Err(AppError::InvalidReport(format!(
            "path does not exist: {}",
            path.display()
        )));
    }

    let mut files = Vec::new();
    let mut dirs = vec![path.to_path_buf()];

    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
            } else if is_supported_report_path(&path) {
                files.push(path);
            }
        }
    }

    Ok(files)
}

fn is_supported_report_path(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_lowercase();
    is_supported_report_filename(&name)
}

pub fn is_supported_report_filename(name: &str) -> bool {
    let name = name.to_lowercase();
    name.ends_with(".xml")
        || name.ends_with(".xml.gz")
        || name.ends_with(".gz")
        || name.ends_with(".zip")
}

pub fn parse_payload(filename: &str, bytes: &[u8]) -> Result<Vec<Report>> {
    let lower = filename.to_lowercase();
    if lower.ends_with(".zip") {
        parse_zip(bytes)
    } else if lower.ends_with(".gz") {
        parse_gzip(bytes)
    } else {
        parse_xml(bytes)
    }
}

fn parse_zip(bytes: &[u8]) -> Result<Vec<Report>> {
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)?;
    let mut reports = Vec::new();

    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().to_string();
        if !name.to_lowercase().ends_with(".xml") && !name.to_lowercase().ends_with(".xml.gz") {
            continue;
        }
        let mut payload = Vec::new();
        file.read_to_end(&mut payload)?;
        reports.extend(parse_payload(&name, &payload)?);
    }

    Ok(reports)
}

fn parse_gzip(bytes: &[u8]) -> Result<Vec<Report>> {
    let mut decoder = GzDecoder::new(bytes);
    let mut payload = Vec::new();
    decoder.read_to_end(&mut payload)?;
    parse_xml(&payload)
}

fn parse_xml(bytes: &[u8]) -> Result<Vec<Report>> {
    let xml = std::str::from_utf8(bytes)
        .map_err(|err| AppError::InvalidReport(format!("report is not valid UTF-8: {err}")))?;
    Ok(vec![parse_report(xml)?])
}
