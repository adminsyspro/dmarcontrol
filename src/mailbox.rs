use std::env;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use chrono::{Duration, Utc};
use mailparse::body::Body;
use mailparse::{parse_mail, DispositionType, MailHeaderMap, ParsedMail};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::importer::{is_supported_report_filename, parse_payload};
use crate::store::Store;

#[derive(Debug, Clone)]
pub struct MailboxConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub mailbox: String,
    pub unseen_only: bool,
    pub mark_seen: bool,
    pub max_messages: usize,
    pub since_hours: u32,
}

impl MailboxConfig {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            host: required_env("DMARCONTROL_IMAP_HOST")?,
            port: env::var("DMARCONTROL_IMAP_PORT")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(993),
            username: required_env("DMARCONTROL_IMAP_USERNAME")?,
            password: required_env("DMARCONTROL_IMAP_PASSWORD")?,
            mailbox: env::var("DMARCONTROL_IMAP_MAILBOX").unwrap_or_else(|_| "INBOX".to_string()),
            unseen_only: env_bool("DMARCONTROL_IMAP_UNSEEN_ONLY", true),
            mark_seen: env_bool("DMARCONTROL_IMAP_MARK_SEEN", false),
            max_messages: env::var("DMARCONTROL_IMAP_MAX_MESSAGES")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(500),
            since_hours: env::var("DMARCONTROL_IMAP_SINCE_HOURS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(24),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailboxSettings {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub mailbox: String,
    #[serde(default = "default_unseen_only")]
    pub unseen_only: bool,
    #[serde(default)]
    pub mark_seen: bool,
    #[serde(default = "default_max_messages")]
    pub max_messages: usize,
    #[serde(default = "default_since_hours")]
    pub since_hours: u32,
    #[serde(default)]
    pub scheduler_enabled: bool,
    #[serde(default = "default_scheduler_interval_minutes")]
    pub scheduler_interval_minutes: u32,
}

impl MailboxSettings {
    pub fn validate(&self) -> Result<()> {
        if self.host.trim().is_empty() {
            return Err(AppError::Mailbox("IMAP host is required".to_string()));
        }
        if self.username.trim().is_empty() {
            return Err(AppError::Mailbox("IMAP username is required".to_string()));
        }
        if self.password.is_empty() {
            return Err(AppError::Mailbox("IMAP password is required".to_string()));
        }
        if self.mailbox.trim().is_empty() {
            return Err(AppError::Mailbox("IMAP mailbox is required".to_string()));
        }
        if self.scheduler_enabled && self.scheduler_interval_minutes < 5 {
            return Err(AppError::Mailbox(
                "Scheduled sync interval must be at least 5 minutes".to_string(),
            ));
        }
        Ok(())
    }

    pub fn to_config(&self) -> Result<MailboxConfig> {
        self.validate()?;
        Ok(MailboxConfig {
            host: self.host.trim().to_string(),
            port: if self.port == 0 { 993 } else { self.port },
            username: self.username.trim().to_string(),
            password: self.password.clone(),
            mailbox: self.mailbox.trim().to_string(),
            unseen_only: self.unseen_only,
            mark_seen: self.mark_seen,
            max_messages: if self.max_messages == 0 {
                500
            } else {
                self.max_messages
            },
            since_hours: self.since_hours,
        })
    }

    pub fn redacted(&self) -> MailboxSettingsResponse {
        MailboxSettingsResponse {
            configured: true,
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            mailbox: self.mailbox.clone(),
            unseen_only: self.unseen_only,
            mark_seen: self.mark_seen,
            max_messages: if self.max_messages == 0 {
                500
            } else {
                self.max_messages
            },
            since_hours: self.since_hours,
            scheduler_enabled: self.scheduler_enabled,
            scheduler_interval_minutes: if self.scheduler_interval_minutes == 0 {
                default_scheduler_interval_minutes()
            } else {
                self.scheduler_interval_minutes
            },
            has_password: !self.password.is_empty(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct MailboxSettingsResponse {
    pub configured: bool,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub mailbox: String,
    pub unseen_only: bool,
    pub mark_seen: bool,
    pub max_messages: usize,
    pub since_hours: u32,
    pub scheduler_enabled: bool,
    pub scheduler_interval_minutes: u32,
    pub has_password: bool,
}

impl MailboxSettingsResponse {
    pub fn empty() -> Self {
        Self {
            configured: false,
            host: String::new(),
            port: 993,
            username: String::new(),
            mailbox: "INBOX".to_string(),
            unseen_only: true,
            mark_seen: false,
            max_messages: 500,
            since_hours: 24,
            scheduler_enabled: false,
            scheduler_interval_minutes: default_scheduler_interval_minutes(),
            has_password: false,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct MailboxSchedulerStatus {
    pub enabled: bool,
    pub running: bool,
    pub interval_minutes: u32,
    pub next_run_at: Option<chrono::DateTime<Utc>>,
    pub last_started_at: Option<chrono::DateTime<Utc>>,
    pub last_finished_at: Option<chrono::DateTime<Utc>>,
    pub last_success: Option<bool>,
    pub last_error: Option<String>,
    pub last_summary: Option<MailboxImportSummary>,
}

pub struct MailboxImporter {
    store: Arc<Store>,
}

pub async fn test_connection(config: MailboxConfig) -> Result<MailboxTestResult> {
    tokio::task::spawn_blocking(move || test_connection_blocking(config)).await?
}

#[derive(Debug, Serialize)]
pub struct MailboxTestResult {
    pub ok: bool,
    pub mailbox: String,
    pub message_count: u32,
    pub unseen_count: Option<u32>,
    pub matched_count: usize,
    pub max_messages: usize,
    pub would_scan: usize,
}

fn test_connection_blocking(config: MailboxConfig) -> Result<MailboxTestResult> {
    let tls = native_tls::TlsConnector::builder().build()?;
    let client = imap::connect((config.host.as_str(), config.port), &config.host, &tls)?;
    let mut session = client
        .login(&config.username, &config.password)
        .map_err(|(err, _)| AppError::Mailbox(format!("IMAP login failed: {err}")))?;
    let mailbox = session.select(&config.mailbox)?;
    let matched_count = session.search(imap_search_query(&config))?.len();
    session.logout()?;
    Ok(MailboxTestResult {
        ok: true,
        mailbox: config.mailbox,
        message_count: mailbox.exists,
        unseen_count: mailbox.unseen,
        matched_count,
        max_messages: config.max_messages,
        would_scan: matched_count.min(config.max_messages.max(1)),
    })
}

impl MailboxImporter {
    pub fn new(store: Arc<Store>) -> Self {
        Self { store }
    }

    pub async fn import(&self, config: MailboxConfig) -> Result<MailboxImportSummary> {
        let fetched = tokio::task::spawn_blocking(move || fetch_attachments(config)).await??;

        let mut reports = Vec::new();
        let mut failed_attachments = fetched.failed_attachments;

        for attachment in fetched.attachments {
            match parse_payload(&attachment.filename, &attachment.bytes) {
                Ok(parsed) => reports.extend(parsed),
                Err(err) => failed_attachments.push(format!("{}: {}", attachment.filename, err)),
            }
        }

        let insert = self.store.insert_many(reports).await?;
        Ok(MailboxImportSummary {
            messages_scanned: fetched.messages_scanned,
            messages_matched: fetched.messages_matched,
            attachments_found: fetched.attachments_found,
            imported: insert.imported,
            duplicates: insert.duplicates,
            failed_attachments,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MailboxImportSummary {
    pub messages_scanned: usize,
    pub messages_matched: usize,
    pub attachments_found: usize,
    pub imported: usize,
    pub duplicates: usize,
    pub failed_attachments: Vec<String>,
}

struct FetchedMailbox {
    messages_scanned: usize,
    messages_matched: usize,
    attachments_found: usize,
    attachments: Vec<MailboxAttachment>,
    failed_attachments: Vec<String>,
}

struct MailboxAttachment {
    filename: String,
    bytes: Vec<u8>,
}

fn fetch_attachments(config: MailboxConfig) -> Result<FetchedMailbox> {
    let tls = native_tls::TlsConnector::builder().build()?;
    let client = imap::connect((config.host.as_str(), config.port), &config.host, &tls)?;
    let mut session = client
        .login(&config.username, &config.password)
        .map_err(|(err, _)| AppError::Mailbox(format!("IMAP login failed: {err}")))?;

    session.select(&config.mailbox)?;
    let query = imap_search_query(&config);
    let mut matched_ids = session.search(query)?.into_iter().collect::<Vec<_>>();
    matched_ids.sort_unstable();

    if matched_ids.is_empty() {
        session.logout()?;
        return Ok(FetchedMailbox {
            messages_scanned: 0,
            messages_matched: 0,
            attachments_found: 0,
            attachments: Vec::new(),
            failed_attachments: Vec::new(),
        });
    }

    let mut ids = matched_ids.clone();
    ids.reverse();
    ids.truncate(config.max_messages.max(1));
    let mut attachments = Vec::new();
    let mut failed_attachments = Vec::new();

    for chunk in ids.chunks(50) {
        let sequence_set = chunk
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let messages = session.fetch(&sequence_set, "RFC822")?;
        for message in messages.iter() {
            if let Some(body) = message.body() {
                match parse_mail(body) {
                    Ok(parsed) => {
                        collect_attachments(&parsed, &mut attachments, &mut failed_attachments)?
                    }
                    Err(err) => failed_attachments.push(format!(
                        "message {}: email parse error: {}",
                        message.message, err
                    )),
                }
            }
        }
    }

    if config.mark_seen {
        let sequence_set = ids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        session.store(&sequence_set, "+FLAGS (\\Seen)")?;
    }

    session.logout()?;
    let attachments_found = attachments.len();
    Ok(FetchedMailbox {
        messages_scanned: ids.len(),
        messages_matched: matched_ids.len(),
        attachments_found,
        attachments,
        failed_attachments,
    })
}

fn imap_search_query(config: &MailboxConfig) -> String {
    let mut parts = Vec::new();
    parts.push(if config.unseen_only { "UNSEEN" } else { "ALL" }.to_string());

    if config.since_hours > 0 {
        let since = Utc::now() - Duration::hours(config.since_hours as i64);
        parts.push(format!("SINCE {}", since.format("%d-%b-%Y")));
    }

    parts.join(" ")
}

fn collect_attachments(
    message: &ParsedMail<'_>,
    attachments: &mut Vec<MailboxAttachment>,
    failed_attachments: &mut Vec<String>,
) -> Result<()> {
    if message.subparts.is_empty() {
        if let Some(filename) = attachment_filename(message, attachments.len() + 1) {
            if is_supported_report_filename(&filename)
                || is_supported_mimetype(&message.ctype.mimetype)
            {
                match attachment_body_bytes(message, &filename) {
                    Ok(bytes) => attachments.push(MailboxAttachment { filename, bytes }),
                    Err(err) => failed_attachments.push(format!("{}: {}", filename, err)),
                }
            }
        }
        return Ok(());
    }

    for part in &message.subparts {
        collect_attachments(part, attachments, failed_attachments)?;
    }

    Ok(())
}

fn attachment_body_bytes(message: &ParsedMail<'_>, filename: &str) -> Result<Vec<u8>> {
    match message.get_body_encoded() {
        Body::Base64(body) => match body.get_decoded() {
            Ok(bytes) => Ok(bytes),
            Err(strict_err) => decode_lenient_base64(body.get_raw()).map_err(|fallback_err| {
                AppError::Mailbox(format!(
                    "could not decode base64 body for {filename} ({strict_err}; fallback failed: {fallback_err})"
                ))
            }),
        },
        Body::QuotedPrintable(body) => Ok(body.get_decoded()?),
        Body::SevenBit(body) | Body::EightBit(body) => Ok(body.get_raw().to_vec()),
        Body::Binary(body) => Ok(body.get_raw().to_vec()),
    }
}

fn decode_lenient_base64(raw: &[u8]) -> std::result::Result<Vec<u8>, base64::DecodeError> {
    let mut cleaned = raw
        .iter()
        .filter_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => Some(*byte),
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            _ => None,
        })
        .collect::<Vec<_>>();

    let padding = (4 - cleaned.len() % 4) % 4;
    cleaned.extend(std::iter::repeat_n(b'=', padding));

    BASE64_STANDARD.decode(cleaned)
}

fn attachment_filename(message: &ParsedMail<'_>, index: usize) -> Option<String> {
    let disposition = message.get_content_disposition();
    let filename = disposition
        .params
        .get("filename")
        .or_else(|| message.ctype.params.get("name"))
        .cloned();

    if filename.is_some() {
        return filename;
    }

    let looks_like_attachment = matches!(disposition.disposition, DispositionType::Attachment)
        || is_supported_mimetype(&message.ctype.mimetype)
        || message
            .headers
            .get_first_value("Content-Description")
            .map(|value| value.to_lowercase().contains("dmarc"))
            .unwrap_or(false);

    if looks_like_attachment {
        Some(format!(
            "dmarc-attachment-{}.{}",
            index,
            extension_for_mimetype(&message.ctype.mimetype)
        ))
    } else {
        None
    }
}

fn is_supported_mimetype(mimetype: &str) -> bool {
    matches!(
        mimetype.to_lowercase().as_str(),
        "application/zip"
            | "application/gzip"
            | "application/x-gzip"
            | "application/xml"
            | "text/xml"
            | "application/octet-stream"
    )
}

fn extension_for_mimetype(mimetype: &str) -> &'static str {
    match mimetype.to_lowercase().as_str() {
        "application/zip" => "zip",
        "application/gzip" | "application/x-gzip" => "gz",
        _ => "xml",
    }
}

fn required_env(key: &str) -> Result<String> {
    env::var(key)
        .map(|value| value.trim().to_string())
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Mailbox(format!("{key} is required")))
}

fn env_bool(key: &str, default: bool) -> bool {
    env::var(key)
        .map(|value| matches!(value.to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(default)
}

fn default_unseen_only() -> bool {
    true
}

fn default_max_messages() -> usize {
    500
}

fn default_since_hours() -> u32 {
    24
}

fn default_scheduler_interval_minutes() -> u32 {
    60
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_xml_gzip_attachment_from_message() {
        let raw = b"From: reports@example.test\r\nSubject: DMARC\r\nContent-Type: multipart/mixed; boundary=\"x\"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nreport attached\r\n--x\r\nContent-Type: application/gzip; name=\"report.xml.gz\"\r\nContent-Disposition: attachment; filename=\"report.xml.gz\"\r\nContent-Transfer-Encoding: base64\r\n\r\nH4sIAAAAAAAA/wMAAAAAAAAAAAA=\r\n--x--\r\n";
        let parsed = parse_mail(raw).expect("parse mail");
        let mut attachments = Vec::new();
        let mut failed_attachments = Vec::new();
        collect_attachments(&parsed, &mut attachments, &mut failed_attachments)
            .expect("collect attachments");

        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].filename, "report.xml.gz");
        assert!(failed_attachments.is_empty());
    }

    #[test]
    fn decodes_base64_attachment_with_invalid_symbol() {
        let raw = b"From: reports@example.test\r\nSubject: DMARC\r\nContent-Type: multipart/mixed; boundary=\"x\"\r\n\r\n--x\r\nContent-Type: application/xml; name=\"report.xml\"\r\nContent-Disposition: attachment; filename=\"report.xml\"\r\nContent-Transfer-Encoding: base64\r\n\r\nPGZv#bz48L2Zvbz4=\r\n--x--\r\n";
        let parsed = parse_mail(raw).expect("parse mail");
        let mut attachments = Vec::new();
        let mut failed_attachments = Vec::new();
        collect_attachments(&parsed, &mut attachments, &mut failed_attachments)
            .expect("collect attachments");

        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].bytes, b"<foo></foo>");
        assert!(failed_attachments.is_empty());
    }

    #[test]
    fn reports_unrecoverable_base64_attachment_without_failing_collection() {
        let raw = b"From: reports@example.test\r\nSubject: DMARC\r\nContent-Type: multipart/mixed; boundary=\"x\"\r\n\r\n--x\r\nContent-Type: application/xml; name=\"report.xml\"\r\nContent-Disposition: attachment; filename=\"report.xml\"\r\nContent-Transfer-Encoding: base64\r\n\r\nA\r\n--x--\r\n";
        let parsed = parse_mail(raw).expect("parse mail");
        let mut attachments = Vec::new();
        let mut failed_attachments = Vec::new();
        collect_attachments(&parsed, &mut attachments, &mut failed_attachments)
            .expect("collect attachments");

        assert!(attachments.is_empty());
        assert_eq!(failed_attachments.len(), 1);
        assert!(failed_attachments[0].contains("report.xml"));
    }
}
