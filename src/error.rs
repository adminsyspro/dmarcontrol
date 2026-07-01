use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("date/time parse error: {0}")]
    Chrono(#[from] chrono::ParseError),
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("XML error: {0}")]
    Xml(#[from] quick_xml::DeError),
    #[error("ZIP error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("IMAP error: {0}")]
    Imap(#[from] imap::Error),
    #[error("TLS error: {0}")]
    Tls(#[from] native_tls::Error),
    #[error("crypto error: {0}")]
    Crypto(#[from] openssl::error::ErrorStack),
    #[error("email parse error: {0}")]
    MailParse(#[from] mailparse::MailParseError),
    #[error("invalid report: {0}")]
    InvalidReport(String),
    #[error("mailbox error: {0}")]
    Mailbox(String),
    #[error("authentication error: {0}")]
    Auth(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("HTTP error: {0}")]
    Http(#[from] axum::http::Error),
    #[error("multipart error: {0}")]
    Multipart(#[from] axum::extract::multipart::MultipartError),
    #[error("background task failed: {0}")]
    Join(#[from] tokio::task::JoinError),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match self {
            AppError::InvalidReport(_) => StatusCode::BAD_REQUEST,
            AppError::Mailbox(_) => StatusCode::BAD_REQUEST,
            AppError::Auth(_) => StatusCode::BAD_REQUEST,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::Multipart(_) => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };

        let body = serde_json::json!({
            "error": self.to_string(),
        });

        (status, axum::Json(body)).into_response()
    }
}
