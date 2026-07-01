use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};

use crate::auth::{self, AuthUser, LocalUser, ManagedUser, OidcSettings};
use crate::dmarc::{PublishedPolicy, Report};
use crate::error::{AppError, Result};
use crate::mailbox::MailboxSettings;

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub async fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY,
                org_name TEXT NOT NULL,
                report_id TEXT NOT NULL,
                begin_at TEXT NOT NULL,
                end_at TEXT NOT NULL,
                domain TEXT NOT NULL,
                policy_json TEXT NOT NULL,
                records_json TEXT NOT NULL,
                inserted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_reports_domain ON reports(domain);
            CREATE INDEX IF NOT EXISTS idx_reports_begin_at ON reports(begin_at);

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                email TEXT NOT NULL DEFAULT '',
                display_name TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL DEFAULT 'Administrator',
                active INTEGER NOT NULL DEFAULT 1,
                password_hash TEXT,
                auth_type TEXT NOT NULL DEFAULT 'local',
                oidc_subject TEXT UNIQUE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
            CREATE INDEX IF NOT EXISTS idx_users_oidc_subject ON users(oidc_subject);

            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
            "#,
        )?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub async fn list(&self) -> Vec<Report> {
        self.try_list().unwrap_or_default()
    }

    pub async fn get(&self, id: &str) -> Option<Report> {
        self.try_get(id).ok().flatten()
    }

    pub async fn insert_many(&self, reports: Vec<Report>) -> Result<InsertSummary> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        let tx = conn.transaction()?;
        let mut imported = 0;
        let mut duplicates = 0;

        for report in reports {
            let affected = tx.execute(
                r#"
                INSERT OR IGNORE INTO reports
                    (id, org_name, report_id, begin_at, end_at, domain, policy_json, records_json)
                VALUES
                    (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                "#,
                params![
                    report.id,
                    report.org_name,
                    report.report_id,
                    report.begin.to_rfc3339(),
                    report.end.to_rfc3339(),
                    report.policy.domain,
                    serde_json::to_string(&report.policy)?,
                    serde_json::to_string(&report.records)?,
                ],
            )?;

            if affected == 0 {
                duplicates += 1;
            } else {
                imported += 1;
            }
        }

        tx.commit()?;
        Ok(InsertSummary {
            imported,
            duplicates,
        })
    }

    pub async fn mailbox_settings(&self) -> Result<Option<MailboxSettings>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'mailbox'",
                [],
                |row| row.get(0),
            )
            .optional()?;

        raw.map(|value| serde_json::from_str(&value).map_err(AppError::from))
            .transpose()
    }

    pub async fn save_mailbox_settings(&self, settings: &MailboxSettings) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        conn.execute(
            r#"
            INSERT INTO settings (key, value, updated_at)
            VALUES ('mailbox', ?1, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = CURRENT_TIMESTAMP
            "#,
            params![serde_json::to_string(settings)?],
        )?;
        Ok(())
    }

    pub async fn ensure_admin_user(
        &self,
        id: &str,
        username: &str,
        password_hash: &str,
    ) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?;
        if count > 0 {
            return Ok(false);
        }
        let email = format!("{username}@local");
        conn.execute(
            r#"
            INSERT INTO users
                (id, username, email, display_name, role, active, password_hash, auth_type)
            VALUES
                (?1, ?2, ?3, ?4, 'Administrator', 1, ?5, 'local')
            "#,
            params![id, username, email, username, password_hash],
        )?;
        Ok(true)
    }

    pub async fn has_users(&self) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?;
        Ok(count > 0)
    }

    pub async fn list_users(&self) -> Result<Vec<ManagedUser>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, username, email, display_name, role, auth_type, active
            FROM users
            ORDER BY active DESC, username COLLATE NOCASE ASC
            "#,
        )?;
        let rows = stmt.query_map([], row_to_managed_user)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(AppError::from)
    }

    pub async fn user_by_id(&self, id: &str) -> Result<Option<ManagedUser>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        conn.query_row(
            r#"
            SELECT id, username, email, display_name, role, auth_type, active
            FROM users
            WHERE id = ?1
            "#,
            params![id],
            row_to_managed_user,
        )
        .optional()
        .map_err(AppError::from)
    }

    pub async fn username_exists(&self, username: &str) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM users WHERE username = ?1",
            params![username],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub async fn active_user_count(&self) -> Result<usize> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM users WHERE active = 1", [], |row| {
                row.get(0)
            })?;
        Ok(count.max(0) as usize)
    }

    pub async fn create_local_user(
        &self,
        id: &str,
        username: &str,
        email: &str,
        display_name: &str,
        role: &str,
        active: bool,
        password_hash: &str,
    ) -> Result<ManagedUser> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        conn.execute(
            r#"
            INSERT INTO users
                (id, username, email, display_name, role, active, password_hash, auth_type)
            VALUES
                (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'local')
            "#,
            params![
                id,
                username,
                email,
                display_name,
                role,
                if active { 1 } else { 0 },
                password_hash
            ],
        )?;
        Ok(ManagedUser {
            id: id.to_string(),
            username: username.to_string(),
            email: email.to_string(),
            display_name: display_name.to_string(),
            role: role.to_string(),
            auth_type: "local".to_string(),
            active,
        })
    }

    pub async fn update_user(
        &self,
        id: &str,
        email: &str,
        display_name: &str,
        role: &str,
        active: bool,
    ) -> Result<Option<ManagedUser>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        let changed = conn.execute(
            r#"
            UPDATE users
            SET email = ?1,
                display_name = ?2,
                role = ?3,
                active = ?4,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?5
            "#,
            params![email, display_name, role, if active { 1 } else { 0 }, id],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        conn.query_row(
            r#"
            SELECT id, username, email, display_name, role, auth_type, active
            FROM users
            WHERE id = ?1
            "#,
            params![id],
            row_to_managed_user,
        )
        .optional()
        .map_err(AppError::from)
    }

    pub async fn delete_user(&self, id: &str) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        let changed = conn.execute("DELETE FROM users WHERE id = ?1", params![id])?;
        Ok(changed > 0)
    }

    pub async fn find_local_user(&self, username: &str) -> Result<Option<LocalUser>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        conn.query_row(
            r#"
            SELECT id, username, email, display_name, role, auth_type, password_hash
            FROM users
            WHERE username = ?1 AND active = 1 AND auth_type = 'local'
            "#,
            params![username],
            |row| {
                Ok(LocalUser {
                    user: row_to_auth_user(row)?,
                    password_hash: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(AppError::from)
    }

    pub async fn find_local_user_by_id(&self, id: &str) -> Result<Option<LocalUser>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        conn.query_row(
            r#"
            SELECT id, username, email, display_name, role, auth_type, password_hash
            FROM users
            WHERE id = ?1
              AND active = 1
              AND auth_type = 'local'
              AND password_hash IS NOT NULL
            "#,
            params![id],
            |row| {
                Ok(LocalUser {
                    user: row_to_auth_user(row)?,
                    password_hash: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(AppError::from)
    }

    pub async fn update_local_user_password_hash(
        &self,
        id: &str,
        password_hash: &str,
    ) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        let changed = conn.execute(
            r#"
            UPDATE users
            SET password_hash = ?1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?2
              AND auth_type = 'local'
            "#,
            params![password_hash, id],
        )?;
        Ok(changed > 0)
    }

    pub async fn user_by_session_hash(&self, token_hash: &str) -> Result<Option<AuthUser>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        conn.execute("DELETE FROM sessions WHERE expires_at <= unixepoch()", [])?;
        conn.query_row(
            r#"
            SELECT u.id, u.username, u.email, u.display_name, u.role, u.auth_type
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ?1
              AND s.expires_at > unixepoch()
              AND u.active = 1
            "#,
            params![token_hash],
            row_to_auth_user,
        )
        .optional()
        .map_err(AppError::from)
    }

    pub async fn create_session(
        &self,
        token_hash: &str,
        user_id: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        conn.execute(
            r#"
            INSERT INTO sessions (token_hash, user_id, expires_at)
            VALUES (?1, ?2, ?3)
            "#,
            params![token_hash, user_id, expires_at.timestamp()],
        )?;
        Ok(())
    }

    pub async fn delete_session(&self, token_hash: &str) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        conn.execute(
            "DELETE FROM sessions WHERE token_hash = ?1",
            params![token_hash],
        )?;
        Ok(())
    }

    pub async fn oidc_settings(&self) -> Result<OidcSettings> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        let raw: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = 'oidc'", [], |row| {
                row.get(0)
            })
            .optional()?;
        let mut settings: OidcSettings = raw
            .map(|value| serde_json::from_str(&value).map_err(AppError::from))
            .transpose()?
            .unwrap_or_default();
        settings.client_secret = auth::unprotect_secret(&settings.client_secret)?;
        Ok(settings)
    }

    pub async fn save_oidc_settings(&self, settings: &OidcSettings) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        let mut stored = settings.clone();
        stored.client_secret = auth::protect_secret(&stored.client_secret)?;
        conn.execute(
            r#"
            INSERT INTO settings (key, value, updated_at)
            VALUES ('oidc', ?1, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = CURRENT_TIMESTAMP
            "#,
            params![serde_json::to_string(&stored)?],
        )?;
        Ok(())
    }

    pub async fn user_by_oidc_subject(&self, subject: &str) -> Result<Option<AuthUser>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        conn.query_row(
            r#"
            SELECT id, username, email, display_name, role, auth_type
            FROM users
            WHERE oidc_subject = ?1 AND active = 1
            "#,
            params![subject],
            row_to_auth_user,
        )
        .optional()
        .map_err(AppError::from)
    }

    pub async fn user_by_email(&self, email: &str) -> Result<Option<AuthUser>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        conn.query_row(
            r#"
            SELECT id, username, email, display_name, role, auth_type
            FROM users
            WHERE email = ?1 AND active = 1
            "#,
            params![email],
            row_to_auth_user,
        )
        .optional()
        .map_err(AppError::from)
    }

    pub async fn create_oidc_user(
        &self,
        id: &str,
        username: &str,
        email: &str,
        display_name: &str,
        subject: &str,
    ) -> Result<AuthUser> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        conn.execute(
            r#"
            INSERT INTO users
                (id, username, email, display_name, role, active, password_hash, auth_type, oidc_subject)
            VALUES
                (?1, ?2, ?3, ?4, 'Administrator', 1, NULL, 'oidc', ?5)
            "#,
            params![id, username, email, display_name, subject],
        )?;
        Ok(AuthUser {
            id: id.to_string(),
            username: username.to_string(),
            email: email.to_string(),
            display_name: display_name.to_string(),
            role: "Administrator".to_string(),
            auth_type: "oidc".to_string(),
        })
    }

    pub async fn update_oidc_user(
        &self,
        id: &str,
        email: &str,
        display_name: &str,
        subject: &str,
    ) -> Result<AuthUser> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        conn.execute(
            r#"
            UPDATE users
            SET email = ?1,
                display_name = ?2,
                auth_type = 'oidc',
                oidc_subject = ?3,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?4
            "#,
            params![email, display_name, subject, id],
        )?;
        conn.query_row(
            r#"
            SELECT id, username, email, display_name, role, auth_type
            FROM users
            WHERE id = ?1
            "#,
            params![id],
            row_to_auth_user,
        )
        .map_err(AppError::from)
    }

    fn try_list(&self) -> Result<Vec<Report>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, org_name, report_id, begin_at, end_at, policy_json, records_json
            FROM reports
            ORDER BY begin_at DESC
            "#,
        )?;
        let rows = stmt.query_map([], row_to_report)?;
        let reports = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(reports)
    }

    fn try_get(&self, id: &str) -> Result<Option<Report>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::Mailbox("database lock is poisoned".to_string()))?;
        conn.query_row(
            r#"
            SELECT id, org_name, report_id, begin_at, end_at, policy_json, records_json
            FROM reports
            WHERE id = ?1
            "#,
            params![id],
            row_to_report,
        )
        .optional()
        .map_err(AppError::from)
    }
}

fn row_to_auth_user(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuthUser> {
    Ok(AuthUser {
        id: row.get(0)?,
        username: row.get(1)?,
        email: row.get(2)?,
        display_name: row.get(3)?,
        role: row.get(4)?,
        auth_type: row.get(5)?,
    })
}

fn row_to_managed_user(row: &rusqlite::Row<'_>) -> rusqlite::Result<ManagedUser> {
    let active: i64 = row.get(6)?;
    Ok(ManagedUser {
        id: row.get(0)?,
        username: row.get(1)?,
        email: row.get(2)?,
        display_name: row.get(3)?,
        role: row.get(4)?,
        auth_type: row.get(5)?,
        active: active != 0,
    })
}

fn row_to_report(row: &rusqlite::Row<'_>) -> rusqlite::Result<Report> {
    let id: String = row.get(0)?;
    let org_name: String = row.get(1)?;
    let report_id: String = row.get(2)?;
    let begin_raw: String = row.get(3)?;
    let end_raw: String = row.get(4)?;
    let policy_raw: String = row.get(5)?;
    let records_raw: String = row.get(6)?;

    let begin = DateTime::parse_from_rfc3339(&begin_raw)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(err))
        })?;
    let end = DateTime::parse_from_rfc3339(&end_raw)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(err))
        })?;
    let policy: PublishedPolicy = serde_json::from_str(&policy_raw).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(err))
    })?;
    let records = serde_json::from_str(&records_raw).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(err))
    })?;

    Ok(Report {
        id,
        org_name,
        report_id,
        begin,
        end,
        policy,
        records,
    })
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct InsertSummary {
    pub imported: usize,
    pub duplicates: usize,
}
