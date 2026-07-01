use std::sync::Arc;

use axum::extract::{Multipart, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{middleware, Json, Router};
use serde::Serialize;

use crate::app::{AppState, Statistics};
use crate::auth::{
    self, LoginRequest, OidcCallbackQuery, OidcSettingsInput, OidcSettingsResponse,
    ProvidersResponse, SessionResponse,
};
use crate::dmarc::Report;
use crate::error::{AppError, Result};
use crate::importer::Importer;
use crate::insights;
use crate::mailbox::{
    test_connection, MailboxConfig, MailboxImportSummary, MailboxImporter, MailboxSettings,
    MailboxSettingsResponse, MailboxTestResult,
};

const INDEX_HTML: &str = include_str!("../static/index.html");
const LOGIN_HTML: &str = include_str!("../static/login.html");
const BRAND_LOGO: &str = include_str!("../static/brand/dmarcontrol-logo.svg");
const BRAND_LOGO_DARK: &str = include_str!("../static/brand/dmarcontrol-logo-dark.svg");
const HOPE_UI_CSS: &str = include_str!("../static/vendor/hope-ui/hope-ui.min.css");
const HOPE_UI_JS: &str = include_str!("../static/vendor/hope-ui/hope-ui.js");
const LEAFLET_CSS: &str = include_str!("../static/vendor/leaflet/leaflet.css");
const LEAFLET_JS: &str = include_str!("../static/vendor/leaflet/leaflet.js");
const LEAFLET_LAYERS_PNG: &[u8] = include_bytes!("../static/vendor/leaflet/images/layers.png");
const LEAFLET_LAYERS_2X_PNG: &[u8] =
    include_bytes!("../static/vendor/leaflet/images/layers-2x.png");
const LEAFLET_MARKER_ICON_PNG: &[u8] =
    include_bytes!("../static/vendor/leaflet/images/marker-icon.png");
const LEAFLET_MARKER_ICON_2X_PNG: &[u8] =
    include_bytes!("../static/vendor/leaflet/images/marker-icon-2x.png");
const LEAFLET_MARKER_SHADOW_PNG: &[u8] =
    include_bytes!("../static/vendor/leaflet/images/marker-shadow.png");
const APP_CSS: &str = include_str!("../static/app.css");
const APP_JS: &str = include_str!("../static/app.js");

pub fn router(state: AppState) -> Router {
    let state = Arc::new(state);
    Router::new()
        .route("/", get(index))
        .route("/login", get(login_page))
        .route("/assets/brand/dmarcontrol-logo.svg", get(brand_logo))
        .route(
            "/assets/brand/dmarcontrol-logo-dark.svg",
            get(brand_logo_dark),
        )
        .route("/assets/vendor/hope-ui/hope-ui.min.css", get(hope_ui_css))
        .route("/assets/vendor/hope-ui/hope-ui.js", get(hope_ui_js))
        .route("/assets/vendor/leaflet/leaflet.css", get(leaflet_css))
        .route("/assets/vendor/leaflet/leaflet.js", get(leaflet_js))
        .route(
            "/assets/vendor/leaflet/images/layers.png",
            get(leaflet_layers_png),
        )
        .route(
            "/assets/vendor/leaflet/images/layers-2x.png",
            get(leaflet_layers_2x_png),
        )
        .route(
            "/assets/vendor/leaflet/images/marker-icon.png",
            get(leaflet_marker_icon_png),
        )
        .route(
            "/assets/vendor/leaflet/images/marker-icon-2x.png",
            get(leaflet_marker_icon_2x_png),
        )
        .route(
            "/assets/vendor/leaflet/images/marker-shadow.png",
            get(leaflet_marker_shadow_png),
        )
        .route("/assets/app.css", get(css))
        .route("/assets/app.js", get(js))
        .route("/healthz", get(healthz))
        .route("/api/auth/login", post(login).delete(logout))
        .route("/api/auth/session", get(session))
        .route("/api/auth/providers", get(providers))
        .route("/api/auth/oidc/login", get(oidc_login))
        .route("/api/auth/oidc/callback", get(oidc_callback))
        .route("/api/statistics", get(statistics))
        .route("/api/overview", get(overview))
        .route("/api/domains", get(domains))
        .route("/api/domains/:domain", get(domain_detail))
        .route("/api/action-items", get(action_items))
        .route("/api/timeline", get(timeline))
        .route("/api/geo-sources", get(geo_sources))
        .route("/api/reports", get(reports))
        .route("/api/reports/:id", get(report))
        .route("/api/top-sources", get(top_sources))
        .route("/api/export/reports.csv", get(export_reports_csv))
        .route("/api/import", post(import_report))
        .route("/api/mailbox/import", post(import_mailbox))
        .route(
            "/api/mailbox/scheduler/status",
            get(mailbox_scheduler_status),
        )
        .route(
            "/api/settings/mailbox",
            get(get_mailbox_settings).put(save_mailbox_settings),
        )
        .route("/api/settings/mailbox/test", post(test_mailbox_settings))
        .route(
            "/api/settings/oidc",
            get(get_oidc_settings).put(save_oidc_settings),
        )
        .layer(middleware::from_fn_with_state(state.clone(), auth_guard))
        .with_state(state)
}

async fn index() -> Response {
    static_response(INDEX_HTML, "text/html; charset=utf-8")
}

async fn login_page() -> Response {
    static_response(LOGIN_HTML, "text/html; charset=utf-8")
}

async fn brand_logo() -> Response {
    static_response(BRAND_LOGO, "image/svg+xml; charset=utf-8")
}

async fn brand_logo_dark() -> Response {
    static_response(BRAND_LOGO_DARK, "image/svg+xml; charset=utf-8")
}

async fn hope_ui_css() -> Response {
    static_response(HOPE_UI_CSS, "text/css; charset=utf-8")
}

async fn hope_ui_js() -> Response {
    static_response(HOPE_UI_JS, "text/javascript; charset=utf-8")
}

async fn leaflet_css() -> Response {
    static_response(LEAFLET_CSS, "text/css; charset=utf-8")
}

async fn leaflet_js() -> Response {
    static_response(LEAFLET_JS, "text/javascript; charset=utf-8")
}

async fn leaflet_layers_png() -> Response {
    static_bytes_response(LEAFLET_LAYERS_PNG, "image/png")
}

async fn leaflet_layers_2x_png() -> Response {
    static_bytes_response(LEAFLET_LAYERS_2X_PNG, "image/png")
}

async fn leaflet_marker_icon_png() -> Response {
    static_bytes_response(LEAFLET_MARKER_ICON_PNG, "image/png")
}

async fn leaflet_marker_icon_2x_png() -> Response {
    static_bytes_response(LEAFLET_MARKER_ICON_2X_PNG, "image/png")
}

async fn leaflet_marker_shadow_png() -> Response {
    static_bytes_response(LEAFLET_MARKER_SHADOW_PNG, "image/png")
}

async fn css() -> Response {
    static_response(APP_CSS, "text/css; charset=utf-8")
}

async fn js() -> Response {
    static_response(APP_JS, "text/javascript; charset=utf-8")
}

async fn healthz() -> &'static str {
    "ok"
}

async fn auth_guard(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let path = request.uri().path().to_string();
    if is_public_path(&path) {
        return next.run(request).await;
    }

    let authenticated = current_user_from_headers(&state, request.headers())
        .await
        .ok()
        .flatten()
        .is_some();
    if authenticated {
        return next.run(request).await;
    }

    if path.starts_with("/api/") {
        auth::unauthorized_api()
    } else {
        Redirect::to("/login").into_response()
    }
}

fn is_public_path(path: &str) -> bool {
    path == "/login"
        || path == "/healthz"
        || path.starts_with("/assets/")
        || path == "/api/auth/login"
        || path == "/api/auth/providers"
        || path == "/api/auth/oidc/login"
        || path == "/api/auth/oidc/callback"
}

async fn current_user_from_headers(
    state: &Arc<AppState>,
    headers: &HeaderMap,
) -> Result<Option<auth::AuthUser>> {
    let Some(token) = auth::cookie_value(headers, auth::SESSION_COOKIE) else {
        return Ok(None);
    };
    state
        .store
        .user_by_session_hash(&auth::token_hash(&token))
        .await
}

async fn login(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<LoginRequest>,
) -> Result<Response> {
    let username = payload.username.trim();
    if username.is_empty() || payload.password.is_empty() {
        return Err(AppError::Auth(
            "username and password are required".to_string(),
        ));
    }

    let Some(local_user) = state.store.find_local_user(username).await? else {
        return Err(AppError::Auth("invalid username or password".to_string()));
    };
    if !auth::verify_password(&payload.password, &local_user.password_hash)? {
        return Err(AppError::Auth("invalid username or password".to_string()));
    }

    let token = auth::generate_token()?;
    state
        .store
        .create_session(
            &auth::token_hash(&token),
            &local_user.user.id,
            auth::session_expires_at(),
        )
        .await?;
    Ok(auth::response_with_session_cookie(
        &token,
        Json(SessionResponse {
            user: local_user.user,
        }),
    ))
}

async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Response> {
    if let Some(token) = auth::cookie_value(&headers, auth::SESSION_COOKIE) {
        state
            .store
            .delete_session(&auth::token_hash(&token))
            .await?;
    }
    let mut response = Json(serde_json::json!({ "success": true })).into_response();
    if let Ok(value) = HeaderValue::from_str(&auth::clear_session_cookie()) {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    Ok(response)
}

async fn session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<SessionResponse>> {
    let user = current_user_from_headers(&state, &headers)
        .await?
        .ok_or_else(|| AppError::Auth("authentication required".to_string()))?;
    Ok(Json(SessionResponse { user }))
}

async fn providers(State(state): State<Arc<AppState>>) -> Result<Json<ProvidersResponse>> {
    let settings = state.store.oidc_settings().await?;
    Ok(Json(ProvidersResponse {
        local: true,
        oidc: (&settings).into(),
    }))
}

async fn oidc_login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Response> {
    let settings = state.store.oidc_settings().await?;
    let origin = auth::request_origin(&headers, &uri);
    let start =
        tokio::task::spawn_blocking(move || auth::build_oidc_authorization(&settings, &origin))
            .await??;
    Ok(auth::redirect_with_cookie(
        &start.auth_url,
        &[
            auth::flow_cookie(auth::oidc_state_cookie(), &start.state),
            auth::flow_cookie(auth::oidc_verifier_cookie(), &start.verifier),
            auth::flow_cookie(auth::oidc_nonce_cookie(), &start.nonce),
        ],
    ))
}

async fn oidc_callback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Response> {
    let origin = auth::request_origin(&headers, &uri);
    let query: OidcCallbackQuery = serde_urlencoded::from_str(uri.query().unwrap_or_default())
        .unwrap_or(OidcCallbackQuery {
            code: None,
            state: None,
            error: None,
        });
    if query.error.is_some() {
        return Ok(redirect_login_error("oidc_error"));
    }

    let expected_state = auth::cookie_value(&headers, auth::oidc_state_cookie());
    let verifier = auth::cookie_value(&headers, auth::oidc_verifier_cookie());
    if expected_state.is_none()
        || verifier.is_none()
        || query.state.as_deref() != expected_state.as_deref()
    {
        return Ok(redirect_login_error("oidc_state"));
    }

    let settings = state.store.oidc_settings().await?;
    let code = query
        .code
        .ok_or_else(|| AppError::Auth("OIDC callback is missing code".to_string()))?;
    let verifier = verifier.unwrap_or_default();
    let userinfo = tokio::task::spawn_blocking(move || {
        auth::exchange_oidc_code(&settings, &origin, &code, &verifier)
    })
    .await??;

    let subject = userinfo
        .get("sub")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| AppError::Auth("OIDC userinfo is missing sub".to_string()))?;
    let email = userinfo
        .get("email")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if email.is_empty() {
        return Ok(redirect_login_error("oidc_no_email"));
    }
    let display_name = userinfo
        .get("name")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&email)
        .trim()
        .to_string();

    let user = if let Some(existing) = state.store.user_by_oidc_subject(&subject).await? {
        state
            .store
            .update_oidc_user(&existing.id, &email, &display_name, &subject)
            .await?
    } else if let Some(existing) = state.store.user_by_email(&email).await? {
        if existing.auth_type != "oidc" {
            return Ok(redirect_login_error("email_conflict"));
        }
        state
            .store
            .update_oidc_user(&existing.id, &email, &display_name, &subject)
            .await?
    } else {
        let settings = state.store.oidc_settings().await?;
        if !settings.auto_provision {
            return Ok(redirect_login_error("user_not_provisioned"));
        }
        let username = oidc_username(&userinfo, &email, &subject);
        state
            .store
            .create_oidc_user(
                &auth::random_id()?,
                &username,
                &email,
                &display_name,
                &subject,
            )
            .await?
    };

    let token = auth::generate_token()?;
    state
        .store
        .create_session(
            &auth::token_hash(&token),
            &user.id,
            auth::session_expires_at(),
        )
        .await?;
    let mut cookies = auth::clear_flow_cookies();
    cookies.push(auth::session_cookie(&token));
    Ok(auth::redirect_with_cookie("/", &cookies))
}

fn redirect_login_error(code: &str) -> Response {
    auth::redirect_with_cookie(&format!("/login?error={code}"), &auth::clear_flow_cookies())
}

fn oidc_username(
    userinfo: &std::collections::HashMap<String, serde_json::Value>,
    email: &str,
    subject: &str,
) -> String {
    let preferred = userinfo
        .get("preferred_username")
        .and_then(|value| value.as_str())
        .unwrap_or_else(|| email.split('@').next().unwrap_or("user"));
    let cleaned = preferred
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let base = if cleaned.is_empty() {
        "user".to_string()
    } else {
        cleaned
    };
    format!("{}-{}", base, subject.chars().take(6).collect::<String>())
}

async fn get_oidc_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<OidcSettingsResponse>> {
    let settings = state.store.oidc_settings().await?;
    let origin = auth::request_origin(&headers, &uri);
    Ok(Json(OidcSettingsResponse::new(&settings, &origin)))
}

async fn save_oidc_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    uri: Uri,
    Json(payload): Json<OidcSettingsInput>,
) -> Result<Json<OidcSettingsResponse>> {
    let existing = state.store.oidc_settings().await?;
    let settings = payload.into_settings(existing)?;
    state.store.save_oidc_settings(&settings).await?;
    let origin = auth::request_origin(&headers, &uri);
    Ok(Json(OidcSettingsResponse::new(&settings, &origin)))
}

async fn statistics(State(state): State<Arc<AppState>>) -> Json<Statistics> {
    let reports = state.store.list().await;
    Json(Statistics::from_reports(&reports))
}

async fn overview(State(state): State<Arc<AppState>>) -> Json<insights::Overview> {
    let reports = state.store.list().await;
    Json(insights::overview(&reports))
}

async fn domains(State(state): State<Arc<AppState>>) -> Json<Vec<insights::DomainSummary>> {
    let reports = state.store.list().await;
    Json(insights::domains(&reports))
}

async fn domain_detail(
    State(state): State<Arc<AppState>>,
    Path(domain): Path<String>,
) -> Result<Json<insights::DomainDetail>> {
    let reports = state.store.list().await;
    insights::domain_detail(&reports, &domain, state.geoip.as_deref())
        .map(Json)
        .ok_or_else(|| AppError::NotFound(format!("domain not found: {domain}")))
}

async fn action_items(State(state): State<Arc<AppState>>) -> Json<Vec<insights::ActionItem>> {
    let reports = state.store.list().await;
    Json(insights::action_items(&reports))
}

async fn timeline(State(state): State<Arc<AppState>>) -> Json<Vec<insights::TimelinePoint>> {
    let reports = state.store.list().await;
    Json(insights::timeline(&reports))
}

async fn geo_sources(State(state): State<Arc<AppState>>) -> Json<insights::GeoSources> {
    let reports = state.store.list().await;
    Json(insights::geo_sources(&reports, state.geoip.as_deref()))
}

async fn reports(State(state): State<Arc<AppState>>) -> Json<Vec<ReportSummary>> {
    let reports = state.store.list().await;
    Json(reports.iter().map(ReportSummary::from).collect())
}

async fn report(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Report>> {
    state
        .store
        .get(&id)
        .await
        .map(Json)
        .ok_or_else(|| AppError::NotFound(format!("report not found: {id}")))
}

async fn top_sources(State(state): State<Arc<AppState>>) -> Json<Vec<insights::SourceInsight>> {
    let reports = state.store.list().await;
    Json(insights::source_insights(&reports))
}

async fn export_reports_csv(State(state): State<Arc<AppState>>) -> Response {
    let reports = state.store.list().await;
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/csv; charset=utf-8"),
            ),
            (
                header::CONTENT_DISPOSITION,
                HeaderValue::from_static("attachment; filename=\"dmarcontrol-reports.csv\""),
            ),
        ],
        insights::reports_csv(&reports),
    )
        .into_response()
}

async fn import_report(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<ImportResponse>> {
    let importer = Importer::new(state.store.clone());
    let mut imported = 0;
    let mut duplicates = 0;
    let mut files = 0;

    while let Some(field) = multipart.next_field().await? {
        let filename = field
            .file_name()
            .map(ToString::to_string)
            .unwrap_or_else(|| "upload.xml".to_string());
        let bytes = field.bytes().await?;
        let summary = importer.import_upload(&filename, &bytes).await?;
        imported += summary.imported;
        duplicates += summary.duplicates;
        files += 1;
    }

    Ok(Json(ImportResponse {
        files,
        imported,
        duplicates,
    }))
}

async fn import_mailbox(State(state): State<Arc<AppState>>) -> Result<Json<MailboxImportSummary>> {
    let _guard = state
        .mailbox_sync_lock
        .try_lock()
        .map_err(|_| AppError::Conflict("mailbox sync already running".to_string()))?;
    let config = mailbox_config_for_state(&state).await?;
    let summary = MailboxImporter::new(state.store.clone())
        .import(config)
        .await?;
    Ok(Json(summary))
}

async fn mailbox_scheduler_status(
    State(state): State<Arc<AppState>>,
) -> Json<crate::mailbox::MailboxSchedulerStatus> {
    Json(state.mailbox_scheduler_status.read().await.clone())
}

async fn get_mailbox_settings(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MailboxSettingsResponse>> {
    let settings = state.store.mailbox_settings().await?;
    Ok(Json(
        settings
            .map(|settings| settings.redacted())
            .unwrap_or_else(MailboxSettingsResponse::empty),
    ))
}

async fn save_mailbox_settings(
    State(state): State<Arc<AppState>>,
    Json(mut settings): Json<MailboxSettings>,
) -> Result<Json<MailboxSettingsResponse>> {
    if settings.port == 0 {
        settings.port = 993;
    }

    if settings.password == "__KEEP__" {
        if let Some(existing) = state.store.mailbox_settings().await? {
            settings.password = existing.password;
        }
    }

    settings.validate()?;
    state.store.save_mailbox_settings(&settings).await?;
    update_scheduler_status_from_settings(&state, &settings).await;
    Ok(Json(settings.redacted()))
}

async fn update_scheduler_status_from_settings(state: &Arc<AppState>, settings: &MailboxSettings) {
    let mut status = state.mailbox_scheduler_status.write().await;
    status.enabled = settings.scheduler_enabled;
    status.interval_minutes = settings.scheduler_interval_minutes.max(5);
    if settings.scheduler_enabled {
        if status.next_run_at.is_none() {
            status.next_run_at = Some(chrono::Utc::now() + chrono::Duration::seconds(30));
        }
    } else {
        status.running = false;
        status.next_run_at = None;
    }
}

async fn test_mailbox_settings(
    State(state): State<Arc<AppState>>,
    payload: Option<Json<MailboxSettings>>,
) -> Result<Json<MailboxTestResult>> {
    let config = match payload {
        Some(Json(mut settings)) => {
            if settings.password == "__KEEP__" {
                if let Some(existing) = state.store.mailbox_settings().await? {
                    settings.password = existing.password;
                }
            }
            settings.to_config()?
        }
        None => mailbox_config_for_state(&state).await?,
    };
    Ok(Json(test_connection(config).await?))
}

async fn mailbox_config_for_state(state: &Arc<AppState>) -> Result<MailboxConfig> {
    if let Some(settings) = state.store.mailbox_settings().await? {
        settings.to_config()
    } else {
        MailboxConfig::from_env()
    }
}

fn static_response(body: &'static str, content_type: &'static str) -> Response {
    (
        [(header::CONTENT_TYPE, HeaderValue::from_static(content_type))],
        body,
    )
        .into_response()
}

fn static_bytes_response(body: &'static [u8], content_type: &'static str) -> Response {
    (
        [(header::CONTENT_TYPE, HeaderValue::from_static(content_type))],
        body,
    )
        .into_response()
}

#[derive(Debug, Serialize)]
struct ReportSummary {
    id: String,
    org_name: String,
    report_id: String,
    domain: String,
    begin: chrono::DateTime<chrono::Utc>,
    end: chrono::DateTime<chrono::Utc>,
    messages: u64,
    aligned: u64,
    rejected: u64,
    quarantined: u64,
}

impl From<&Report> for ReportSummary {
    fn from(report: &Report) -> Self {
        let mut messages = 0;
        let mut aligned = 0;
        let mut rejected = 0;
        let mut quarantined = 0;

        for record in &report.records {
            messages += record.count;
            if record.dkim_aligned || record.spf_aligned {
                aligned += record.count;
            }
            if record.disposition == "reject" {
                rejected += record.count;
            }
            if record.disposition == "quarantine" {
                quarantined += record.count;
            }
        }

        Self {
            id: report.id.clone(),
            org_name: report.org_name.clone(),
            report_id: report.report_id.clone(),
            domain: report.policy.domain.clone(),
            begin: report.begin,
            end: report.end,
            messages,
            aligned,
            rejected,
            quarantined,
        }
    }
}

#[derive(Debug, Serialize)]
struct ImportResponse {
    files: usize,
    imported: usize,
    duplicates: usize,
}
