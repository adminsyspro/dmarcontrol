use chrono::{Duration as ChronoDuration, Utc};
use tokio::time::{self, Duration, MissedTickBehavior};

use crate::app::AppState;
use crate::mailbox::{MailboxImporter, MailboxSchedulerStatus};

const CONFIG_POLL_SECONDS: u64 = 30;
const MIN_INTERVAL_MINUTES: u32 = 5;

pub fn spawn_mailbox_scheduler(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = time::interval(Duration::from_secs(CONFIG_POLL_SECONDS));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut next_run_at = None;

        loop {
            ticker.tick().await;

            let settings = match state.store.mailbox_settings().await {
                Ok(Some(settings)) => settings,
                Ok(None) => {
                    next_run_at = None;
                    set_status(&state, MailboxSchedulerStatus::default()).await;
                    continue;
                }
                Err(err) => {
                    tracing::warn!("mailbox scheduler could not read settings: {err}");
                    continue;
                }
            };

            if !settings.scheduler_enabled {
                next_run_at = None;
                set_status(
                    &state,
                    MailboxSchedulerStatus {
                        enabled: false,
                        interval_minutes: interval_minutes(settings.scheduler_interval_minutes),
                        ..current_status(&state).await
                    },
                )
                .await;
                continue;
            }

            let interval = interval_minutes(settings.scheduler_interval_minutes);
            let now = Utc::now();
            let due_at = next_run_at.unwrap_or(now);
            let is_due = now >= due_at;

            if !is_due {
                update_schedule(&state, true, false, interval, Some(due_at)).await;
                continue;
            }

            next_run_at = Some(now + ChronoDuration::minutes(interval as i64));

            let Ok(_guard) = state.mailbox_sync_lock.try_lock() else {
                tracing::warn!("mailbox scheduler skipped run because another sync is active");
                update_schedule(&state, true, false, interval, next_run_at).await;
                continue;
            };

            let started_at = Utc::now();
            let mut status = current_status(&state).await;
            status.enabled = true;
            status.running = true;
            status.interval_minutes = interval;
            status.next_run_at = next_run_at;
            status.last_started_at = Some(started_at);
            status.last_error = None;
            set_status(&state, status).await;

            let config = match settings.to_config() {
                Ok(config) => config,
                Err(err) => {
                    finish_with_error(&state, interval, next_run_at, err.to_string()).await;
                    continue;
                }
            };

            tracing::info!("mailbox scheduler sync started");
            match MailboxImporter::new(state.store.clone())
                .import(config)
                .await
            {
                Ok(summary) => {
                    tracing::info!(
                        "mailbox scheduler sync finished: scanned={} matched={} attachments={} imported={} duplicates={}",
                        summary.messages_scanned,
                        summary.messages_matched,
                        summary.attachments_found,
                        summary.imported,
                        summary.duplicates
                    );
                    let mut status = current_status(&state).await;
                    status.enabled = true;
                    status.running = false;
                    status.interval_minutes = interval;
                    status.next_run_at = next_run_at;
                    status.last_finished_at = Some(Utc::now());
                    status.last_success = Some(true);
                    status.last_error = None;
                    status.last_summary = Some(summary);
                    set_status(&state, status).await;
                }
                Err(err) => {
                    tracing::warn!("mailbox scheduler sync failed: {err}");
                    finish_with_error(&state, interval, next_run_at, err.to_string()).await;
                }
            }
        }
    });
}

async fn current_status(state: &AppState) -> MailboxSchedulerStatus {
    state.mailbox_scheduler_status.read().await.clone()
}

async fn set_status(state: &AppState, status: MailboxSchedulerStatus) {
    *state.mailbox_scheduler_status.write().await = status;
}

async fn update_schedule(
    state: &AppState,
    enabled: bool,
    running: bool,
    interval_minutes: u32,
    next_run_at: Option<chrono::DateTime<Utc>>,
) {
    let mut status = current_status(state).await;
    status.enabled = enabled;
    status.running = running;
    status.interval_minutes = interval_minutes;
    status.next_run_at = next_run_at;
    set_status(state, status).await;
}

async fn finish_with_error(
    state: &AppState,
    interval_minutes: u32,
    next_run_at: Option<chrono::DateTime<Utc>>,
    error: String,
) {
    let mut status = current_status(state).await;
    status.enabled = true;
    status.running = false;
    status.interval_minutes = interval_minutes;
    status.next_run_at = next_run_at;
    status.last_finished_at = Some(Utc::now());
    status.last_success = Some(false);
    status.last_error = Some(error);
    status.last_summary = None;
    set_status(state, status).await;
}

fn interval_minutes(value: u32) -> u32 {
    value.max(MIN_INTERVAL_MINUTES)
}
