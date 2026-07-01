use std::sync::Arc;

use serde::Serialize;
use tokio::sync::{Mutex, RwLock};

use crate::dmarc::Report;
use crate::geoip::GeoIpResolver;
use crate::mailbox::MailboxSchedulerStatus;
use crate::store::Store;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub geoip: Option<Arc<GeoIpResolver>>,
    pub mailbox_sync_lock: Arc<Mutex<()>>,
    pub mailbox_scheduler_status: Arc<RwLock<MailboxSchedulerStatus>>,
}

impl AppState {
    pub fn new(store: Arc<Store>, geoip: Option<Arc<GeoIpResolver>>) -> Self {
        Self {
            store,
            geoip,
            mailbox_sync_lock: Arc::new(Mutex::new(())),
            mailbox_scheduler_status: Arc::new(RwLock::new(MailboxSchedulerStatus::default())),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Statistics {
    pub reports: usize,
    pub domains: usize,
    pub messages: u64,
    pub aligned: u64,
    pub rejected: u64,
    pub quarantined: u64,
    pub compliance_rate: f64,
}

impl Statistics {
    pub fn from_reports(reports: &[Report]) -> Self {
        let mut domains = std::collections::BTreeSet::new();
        let mut messages = 0;
        let mut aligned = 0;
        let mut rejected = 0;
        let mut quarantined = 0;

        for report in reports {
            domains.insert(report.policy.domain.clone());
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
        }

        let compliance_rate = if messages == 0 {
            0.0
        } else {
            (aligned as f64 / messages as f64) * 100.0
        };

        Self {
            reports: reports.len(),
            domains: domains.len(),
            messages,
            aligned,
            rejected,
            quarantined,
            compliance_rate,
        }
    }
}
