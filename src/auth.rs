use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;

use axum::http::header;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect, Response};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use native_tls::TlsConnector;
use openssl::hash::MessageDigest;
use openssl::pkcs5::pbkdf2_hmac;
use openssl::rand::rand_bytes;
use openssl::sha::sha256;
use openssl::symm::{decrypt_aead, encrypt_aead, Cipher};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

pub const SESSION_COOKIE: &str = "dmarcontrol-session";
const OIDC_STATE_COOKIE: &str = "dmarcontrol-oidc-state";
const OIDC_VERIFIER_COOKIE: &str = "dmarcontrol-oidc-verifier";
const OIDC_NONCE_COOKIE: &str = "dmarcontrol-oidc-nonce";
const SESSION_HOURS: i64 = 24;
const FLOW_SECONDS: i64 = 300;
const PBKDF2_ITERATIONS: usize = 210_000;

#[derive(Debug, Clone, Serialize)]
pub struct AuthUser {
    pub id: String,
    pub username: String,
    pub email: String,
    pub display_name: String,
    pub role: String,
    pub auth_type: String,
}

#[derive(Debug, Clone)]
pub struct LocalUser {
    pub user: AuthUser,
    pub password_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OidcSettings {
    pub enabled: bool,
    pub provider_name: String,
    pub issuer_url: String,
    pub client_id: String,
    pub client_secret: String,
    pub scopes: String,
    pub auto_provision: bool,
    pub show_local_login: bool,
    pub force_sso_redirect: bool,
    pub app_base_url: String,
}

impl Default for OidcSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider_name: "SSO".to_string(),
            issuer_url: String::new(),
            client_id: String::new(),
            client_secret: String::new(),
            scopes: "openid profile email".to_string(),
            auto_provision: true,
            show_local_login: true,
            force_sso_redirect: false,
            app_base_url: String::new(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct PublicOidcSettings {
    pub enabled: bool,
    pub provider_name: String,
    pub show_local_login: bool,
    pub force_sso_redirect: bool,
}

impl From<&OidcSettings> for PublicOidcSettings {
    fn from(settings: &OidcSettings) -> Self {
        Self {
            enabled: settings.enabled,
            provider_name: if settings.provider_name.trim().is_empty() {
                "SSO".to_string()
            } else {
                settings.provider_name.clone()
            },
            show_local_login: !settings.enabled || settings.show_local_login,
            force_sso_redirect: settings.enabled && settings.force_sso_redirect,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct OidcSettingsResponse {
    pub enabled: bool,
    pub provider_name: String,
    pub issuer_url: String,
    pub client_id: String,
    pub scopes: String,
    pub auto_provision: bool,
    pub show_local_login: bool,
    pub force_sso_redirect: bool,
    pub app_base_url: String,
    pub has_client_secret: bool,
    pub callback_url: String,
}

impl OidcSettingsResponse {
    pub fn new(settings: &OidcSettings, request_origin: &str) -> Self {
        Self {
            enabled: settings.enabled,
            provider_name: settings.provider_name.clone(),
            issuer_url: settings.issuer_url.clone(),
            client_id: settings.client_id.clone(),
            scopes: settings.scopes.clone(),
            auto_provision: settings.auto_provision,
            show_local_login: settings.show_local_login,
            force_sso_redirect: settings.force_sso_redirect,
            app_base_url: settings.app_base_url.clone(),
            has_client_secret: !settings.client_secret.is_empty(),
            callback_url: format!(
                "{}/api/auth/oidc/callback",
                public_origin(settings, request_origin)
            ),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct OidcSettingsInput {
    pub enabled: bool,
    #[serde(default)]
    pub provider_name: String,
    #[serde(default)]
    pub issuer_url: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    #[serde(default)]
    pub scopes: String,
    #[serde(default)]
    pub auto_provision: bool,
    #[serde(default)]
    pub show_local_login: bool,
    #[serde(default)]
    pub force_sso_redirect: bool,
    #[serde(default)]
    pub app_base_url: String,
}

impl OidcSettingsInput {
    pub fn into_settings(self, existing: OidcSettings) -> Result<OidcSettings> {
        let issuer_url = self.issuer_url.trim().trim_end_matches('/').to_string();
        let client_id = self.client_id.trim().to_string();
        if self.enabled && (issuer_url.is_empty() || client_id.is_empty()) {
            return Err(AppError::Auth(
                "issuer_url and client_id are required when OIDC is enabled".to_string(),
            ));
        }

        let app_base_url = normalize_origin(&self.app_base_url)?;
        let enabled = self.enabled;
        Ok(OidcSettings {
            enabled,
            provider_name: non_empty(self.provider_name, "SSO"),
            issuer_url,
            client_id,
            client_secret: if self.client_secret.is_empty() {
                existing.client_secret
            } else {
                self.client_secret
            },
            scopes: non_empty(self.scopes, "openid profile email"),
            auto_provision: self.auto_provision,
            show_local_login: if enabled { self.show_local_login } else { true },
            force_sso_redirect: if enabled {
                self.force_sso_redirect
            } else {
                false
            },
            app_base_url,
        })
    }
}

#[derive(Debug, Serialize)]
pub struct SessionResponse {
    pub user: AuthUser,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct ProvidersResponse {
    pub local: bool,
    pub oidc: PublicOidcSettings,
}

#[derive(Debug, Deserialize)]
pub struct OidcCallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DiscoveryDocument {
    authorization_endpoint: String,
    token_endpoint: String,
    userinfo_endpoint: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
}

pub fn hash_password(password: &str) -> Result<String> {
    let mut salt = [0_u8; 16];
    rand_bytes(&mut salt)?;
    let mut hash = [0_u8; 64];
    pbkdf2_hmac(
        password.as_bytes(),
        &salt,
        PBKDF2_ITERATIONS,
        MessageDigest::sha256(),
        &mut hash,
    )?;
    Ok(format!(
        "pbkdf2$sha256${}${}${}",
        PBKDF2_ITERATIONS,
        hex(&salt),
        hex(&hash)
    ))
}

pub fn verify_password(password: &str, stored_hash: &str) -> Result<bool> {
    let parts: Vec<&str> = stored_hash.split('$').collect();
    if parts.len() != 5 || parts[0] != "pbkdf2" || parts[1] != "sha256" {
        return Ok(false);
    }
    let iterations = parts[2].parse::<usize>().unwrap_or(PBKDF2_ITERATIONS);
    let salt = unhex(parts[3])?;
    let expected = unhex(parts[4])?;
    let mut actual = vec![0_u8; expected.len()];
    pbkdf2_hmac(
        password.as_bytes(),
        &salt,
        iterations,
        MessageDigest::sha256(),
        &mut actual,
    )?;
    Ok(constant_time_eq(&actual, &expected))
}

pub fn protect_secret(value: &str) -> Result<String> {
    if value.is_empty() || value.starts_with("enc:v1:") {
        return Ok(value.to_string());
    }
    let mut nonce = [0_u8; 12];
    rand_bytes(&mut nonce)?;
    let mut tag = [0_u8; 16];
    let ciphertext = encrypt_aead(
        Cipher::aes_256_gcm(),
        &secret_key(),
        Some(&nonce),
        b"dmarcontrol-oidc",
        value.as_bytes(),
        &mut tag,
    )?;
    Ok(format!(
        "enc:v1:{}:{}:{}",
        hex(&nonce),
        hex(&tag),
        hex(&ciphertext)
    ))
}

pub fn unprotect_secret(value: &str) -> Result<String> {
    let Some(rest) = value.strip_prefix("enc:v1:") else {
        return Ok(value.to_string());
    };
    let parts: Vec<&str> = rest.split(':').collect();
    if parts.len() != 3 {
        return Err(AppError::Auth(
            "invalid encrypted secret format".to_string(),
        ));
    }
    let nonce = unhex(parts[0])?;
    let tag = unhex(parts[1])?;
    let ciphertext = unhex(parts[2])?;
    let plaintext = decrypt_aead(
        Cipher::aes_256_gcm(),
        &secret_key(),
        Some(&nonce),
        b"dmarcontrol-oidc",
        &ciphertext,
        &tag,
    )?;
    String::from_utf8(plaintext).map_err(|err| AppError::Auth(err.to_string()))
}

pub fn session_expires_at() -> DateTime<Utc> {
    Utc::now() + Duration::hours(SESSION_HOURS)
}

pub fn generate_token() -> Result<String> {
    random_hex(32)
}

pub fn random_id() -> Result<String> {
    random_hex(16)
}

pub fn token_hash(token: &str) -> String {
    hex(&sha256(token.as_bytes()))
}

pub fn session_cookie(token: &str) -> String {
    format!(
        "{SESSION_COOKIE}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={};{}",
        SESSION_HOURS * 3600,
        secure_cookie_suffix()
    )
}

pub fn clear_session_cookie() -> String {
    format!("{SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0")
}

pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key == name).then(|| value.to_string())
    })
}

pub fn response_with_session_cookie<T: IntoResponse>(token: &str, body: T) -> Response {
    let mut response = body.into_response();
    if let Ok(value) = HeaderValue::from_str(&session_cookie(token)) {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    response
}

pub fn redirect_with_cookie(target: &str, cookies: &[String]) -> Response {
    let mut response = Redirect::to(target).into_response();
    for cookie in cookies {
        if let Ok(value) = HeaderValue::from_str(cookie) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }
    response
}

pub fn unauthorized_api() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        axum::Json(serde_json::json!({ "error": "authentication required" })),
    )
        .into_response()
}

pub fn public_origin(settings: &OidcSettings, request_origin: &str) -> String {
    if !settings.app_base_url.is_empty() {
        return settings.app_base_url.clone();
    }
    std::env::var("DMARCONTROL_PUBLIC_BASE_URL")
        .ok()
        .and_then(|value| normalize_origin(&value).ok())
        .unwrap_or_else(|| request_origin.trim_end_matches('/').to_string())
}

pub fn request_origin(headers: &HeaderMap, uri: &Uri) -> String {
    if let Some(origin) = headers
        .get("x-forwarded-host")
        .and_then(|v| v.to_str().ok())
    {
        let proto = headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("http");
        return format!("{proto}://{origin}");
    }
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("127.0.0.1:8080");
    let scheme = uri.scheme_str().unwrap_or("http");
    format!("{scheme}://{host}")
}

pub fn build_oidc_authorization(
    settings: &OidcSettings,
    request_origin: &str,
) -> Result<OidcStart> {
    if !settings.enabled || settings.issuer_url.is_empty() || settings.client_id.is_empty() {
        return Err(AppError::Auth("OIDC is not configured".to_string()));
    }
    let discovery = discover(settings)?;
    let verifier = random_code_value(32)?;
    let state = random_code_value(24)?;
    let nonce = random_code_value(24)?;
    let challenge = URL_SAFE_NO_PAD.encode(sha256(verifier.as_bytes()));
    let redirect_uri = format!(
        "{}/api/auth/oidc/callback",
        public_origin(settings, request_origin)
    );
    let auth_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}&nonce={}",
        discovery.authorization_endpoint,
        enc(&settings.client_id),
        enc(&redirect_uri),
        enc(&settings.scopes),
        enc(&challenge),
        enc(&state),
        enc(&nonce)
    );

    Ok(OidcStart {
        auth_url,
        state,
        verifier,
        nonce,
    })
}

pub fn flow_cookie(name: &str, value: &str) -> String {
    format!(
        "{name}={value}; HttpOnly; SameSite=Lax; Path=/; Max-Age={FLOW_SECONDS};{}",
        secure_cookie_suffix()
    )
}

pub fn clear_flow_cookies() -> Vec<String> {
    [OIDC_STATE_COOKIE, OIDC_VERIFIER_COOKIE, OIDC_NONCE_COOKIE]
        .iter()
        .map(|name| format!("{name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"))
        .collect()
}

pub fn oidc_state_cookie() -> &'static str {
    OIDC_STATE_COOKIE
}

pub fn oidc_verifier_cookie() -> &'static str {
    OIDC_VERIFIER_COOKIE
}

pub fn oidc_nonce_cookie() -> &'static str {
    OIDC_NONCE_COOKIE
}

pub fn exchange_oidc_code(
    settings: &OidcSettings,
    request_origin: &str,
    code: &str,
    verifier: &str,
) -> Result<HashMap<String, serde_json::Value>> {
    let discovery = discover(settings)?;
    let userinfo_endpoint = discovery.userinfo_endpoint.ok_or_else(|| {
        AppError::Auth("OIDC discovery document does not expose userinfo_endpoint".to_string())
    })?;
    let redirect_uri = format!(
        "{}/api/auth/oidc/callback",
        public_origin(settings, request_origin)
    );
    let mut form = vec![
        ("grant_type".to_string(), "authorization_code".to_string()),
        ("code".to_string(), code.to_string()),
        ("redirect_uri".to_string(), redirect_uri),
        ("code_verifier".to_string(), verifier.to_string()),
    ];
    let basic_auth = if settings.client_secret.is_empty() {
        form.push(("client_id".to_string(), settings.client_id.clone()));
        None
    } else {
        Some(format!(
            "Basic {}",
            STANDARD.encode(format!("{}:{}", settings.client_id, settings.client_secret))
        ))
    };
    let token_body = form_urlencoded(&form);
    let token_raw = http_request(
        "POST",
        &discovery.token_endpoint,
        Some(token_body.as_bytes()),
        Some("application/x-www-form-urlencoded"),
        basic_auth.as_deref(),
    )?;
    let token: TokenResponse = serde_json::from_str(&token_raw)?;
    let userinfo_raw = http_request(
        "GET",
        &userinfo_endpoint,
        None,
        None,
        Some(&format!("Bearer {}", token.access_token)),
    )?;
    serde_json::from_str(&userinfo_raw).map_err(AppError::from)
}

pub struct OidcStart {
    pub auth_url: String,
    pub state: String,
    pub verifier: String,
    pub nonce: String,
}

fn discover(settings: &OidcSettings) -> Result<DiscoveryDocument> {
    let url = format!(
        "{}/.well-known/openid-configuration",
        settings.issuer_url.trim_end_matches('/')
    );
    let body = http_request("GET", &url, None, None, None)?;
    serde_json::from_str(&body).map_err(AppError::from)
}

fn http_request(
    method: &str,
    url: &str,
    body: Option<&[u8]>,
    content_type: Option<&str>,
    authorization: Option<&str>,
) -> Result<String> {
    let parsed = SimpleUrl::parse(url)?;
    let stream = TcpStream::connect((&*parsed.host, parsed.port))?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(20)))?;
    stream.set_write_timeout(Some(std::time::Duration::from_secs(20)))?;

    let mut connection: Box<dyn ReadWrite> = if parsed.scheme == "https" {
        Box::new(
            TlsConnector::new()?
                .connect(&parsed.host, stream)
                .map_err(|err| AppError::Auth(format!("OIDC TLS handshake failed: {err}")))?,
        )
    } else {
        Box::new(stream)
    };

    let body_len = body.map_or(0, |b| b.len());
    let mut request = format!(
        "{method} {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: dmarcontrol/0.1\r\nAccept: application/json\r\nConnection: close\r\nContent-Length: {body_len}\r\n",
        parsed.path_query, parsed.host
    );
    if let Some(content_type) = content_type {
        request.push_str(&format!("Content-Type: {content_type}\r\n"));
    }
    if let Some(authorization) = authorization {
        request.push_str(&format!("Authorization: {authorization}\r\n"));
    }
    request.push_str("\r\n");
    connection.write_all(request.as_bytes())?;
    if let Some(body) = body {
        connection.write_all(body)?;
    }

    let mut response = Vec::new();
    connection.read_to_end(&mut response)?;
    parse_http_response(&response)
}

fn parse_http_response(response: &[u8]) -> Result<String> {
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| AppError::Auth("invalid HTTP response from OIDC provider".to_string()))?;
    let header_raw = String::from_utf8_lossy(&response[..split]);
    let mut lines = header_raw.lines();
    let status_line = lines.next().unwrap_or_default();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(500);
    if !(200..300).contains(&status) {
        return Err(AppError::Auth(format!(
            "OIDC provider returned HTTP status {status}"
        )));
    }
    let chunked = lines.any(|line| line.eq_ignore_ascii_case("transfer-encoding: chunked"));
    let body = &response[split + 4..];
    let bytes = if chunked {
        decode_chunked(body)?
    } else {
        body.to_vec()
    };
    String::from_utf8(bytes).map_err(|err| AppError::Auth(err.to_string()))
}

fn decode_chunked(mut body: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = body
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| AppError::Auth("invalid chunked response".to_string()))?;
        let size_raw = std::str::from_utf8(&body[..line_end])
            .map_err(|err| AppError::Auth(err.to_string()))?
            .split(';')
            .next()
            .unwrap_or_default();
        let size = usize::from_str_radix(size_raw.trim(), 16)
            .map_err(|err| AppError::Auth(err.to_string()))?;
        body = &body[line_end + 2..];
        if size == 0 {
            break;
        }
        if body.len() < size + 2 {
            return Err(AppError::Auth("truncated chunked response".to_string()));
        }
        out.extend_from_slice(&body[..size]);
        body = &body[size + 2..];
    }
    Ok(out)
}

trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

struct SimpleUrl {
    scheme: String,
    host: String,
    port: u16,
    path_query: String,
}

impl SimpleUrl {
    fn parse(url: &str) -> Result<Self> {
        let (scheme, rest) = url
            .split_once("://")
            .ok_or_else(|| AppError::Auth(format!("invalid URL: {url}")))?;
        let slash = rest.find('/').unwrap_or(rest.len());
        let authority = &rest[..slash];
        let path_query = if slash < rest.len() {
            &rest[slash..]
        } else {
            "/"
        };
        let (host, port) = if let Some((host, port)) = authority.rsplit_once(':') {
            (
                host.to_string(),
                port.parse::<u16>().unwrap_or(default_port(scheme)?),
            )
        } else {
            (authority.to_string(), default_port(scheme)?)
        };
        if host.is_empty() || !matches!(scheme, "http" | "https") {
            return Err(AppError::Auth(format!("unsupported URL: {url}")));
        }
        Ok(Self {
            scheme: scheme.to_string(),
            host,
            port,
            path_query: path_query.to_string(),
        })
    }
}

fn default_port(scheme: &str) -> Result<u16> {
    match scheme {
        "http" => Ok(80),
        "https" => Ok(443),
        _ => Err(AppError::Auth(format!("unsupported URL scheme: {scheme}"))),
    }
}

fn normalize_origin(value: &str) -> Result<String> {
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() {
        return Ok(String::new());
    }
    let parsed = SimpleUrl::parse(value)?;
    Ok(format!(
        "{}://{}{}",
        parsed.scheme,
        parsed.host,
        if is_default_port(&parsed) {
            String::new()
        } else {
            format!(":{}", parsed.port)
        }
    ))
}

fn is_default_port(parsed: &SimpleUrl) -> bool {
    (parsed.scheme == "http" && parsed.port == 80)
        || (parsed.scheme == "https" && parsed.port == 443)
}

fn non_empty(value: String, fallback: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

fn enc(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

fn form_urlencoded(values: &[(String, String)]) -> String {
    values
        .iter()
        .map(|(key, value)| format!("{}={}", enc(key), enc(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn random_code_value(bytes: usize) -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(unhex(&random_hex(bytes)?)?))
}

fn random_hex(bytes: usize) -> Result<String> {
    let mut buffer = vec![0_u8; bytes];
    rand_bytes(&mut buffer)?;
    Ok(hex(&buffer))
}

fn secure_cookie_suffix() -> &'static str {
    if std::env::var("DMARCONTROL_FORCE_HTTPS").ok().as_deref() == Some("true") {
        " Secure"
    } else {
        ""
    }
}

fn secret_key() -> [u8; 32] {
    let secret = std::env::var("DMARCONTROL_APP_SECRET")
        .or_else(|_| std::env::var("DMARCONTROL_AUTH_SECRET"))
        .unwrap_or_else(|_| "change-me-dmarcontrol-app-secret".to_string());
    sha256(secret.as_bytes())
}

fn hex(bytes: &[u8]) -> String {
    const CHARS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(CHARS[(byte >> 4) as usize] as char);
        out.push(CHARS[(byte & 0x0f) as usize] as char);
    }
    out
}

fn unhex(value: &str) -> Result<Vec<u8>> {
    if !value.len().is_multiple_of(2) {
        return Err(AppError::Auth("invalid hex value".to_string()));
    }
    let mut out = Vec::with_capacity(value.len() / 2);
    for chunk in value.as_bytes().chunks_exact(2) {
        let raw = std::str::from_utf8(chunk).map_err(|err| AppError::Auth(err.to_string()))?;
        out.push(u8::from_str_radix(raw, 16).map_err(|err| AppError::Auth(err.to_string()))?);
    }
    Ok(out)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (a, b) in left.iter().zip(right) {
        diff |= a ^ b;
    }
    diff == 0
}
