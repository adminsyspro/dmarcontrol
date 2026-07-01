use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;

use crate::app::Statistics;
use crate::dmarc::{Record, Report};
use crate::geoip::{fallback_location, GeoIpResolver, GeoLocation};

#[derive(Debug, Serialize)]
pub struct Overview {
    pub statistics: Statistics,
    pub grade: String,
    pub score: u8,
    pub posture: String,
    pub enforcement_stage: String,
    pub policy_mix: Vec<PolicySlice>,
    pub protocols: Vec<ProtocolStatus>,
}

#[derive(Debug, Serialize)]
pub struct PolicySlice {
    pub policy: String,
    pub messages: u64,
}

#[derive(Debug, Serialize)]
pub struct ProtocolStatus {
    pub name: String,
    pub status: String,
    pub detail: String,
    pub score: u8,
    pub summary: String,
    pub metrics: Vec<ProtocolMetric>,
    pub evidence: Vec<String>,
    pub recommendation: String,
}

#[derive(Debug, Serialize)]
pub struct ProtocolMetric {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
pub struct DomainSummary {
    pub domain: String,
    pub policy: String,
    pub score: u8,
    pub grade: String,
    pub messages: u64,
    pub aligned: u64,
    pub sources: usize,
    pub last_report: Option<DateTime<Utc>>,
    pub next_step: String,
}

#[derive(Debug, Serialize)]
pub struct SourceInsight {
    pub source_ip: String,
    pub sender: String,
    pub messages: u64,
    pub aligned: u64,
    pub alignment_rate: f64,
    pub rejected: u64,
    pub quarantined: u64,
    pub domains: Vec<String>,
    pub risk: String,
}

#[derive(Debug, Serialize)]
pub struct ActionItem {
    pub severity: String,
    pub title: String,
    pub domain: String,
    pub detail: String,
    pub recommendation: String,
}

#[derive(Debug, Serialize)]
pub struct TimelinePoint {
    pub date: NaiveDate,
    pub messages: u64,
    pub aligned: u64,
    pub rejected: u64,
    pub quarantined: u64,
}

#[derive(Debug, Serialize)]
pub struct GeoSourcePoint {
    pub source_ip: String,
    pub sender: String,
    pub provider: String,
    pub country: String,
    pub country_code: Option<String>,
    pub city: String,
    pub continent: Option<String>,
    pub continent_code: Option<String>,
    pub asn_number: Option<u64>,
    pub asn_organization: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
    pub messages: u64,
    pub aligned: u64,
    pub alignment_rate: f64,
    pub risk: String,
}

#[derive(Debug, Serialize)]
pub struct GeoSources {
    pub provider: String,
    pub database_loaded: bool,
    pub points: Vec<GeoSourcePoint>,
    pub unresolved_sources: usize,
}

#[derive(Debug, Serialize)]
pub struct DomainDetail {
    pub summary: DomainSummary,
    pub policy: DomainPolicyDetail,
    pub sources: Vec<DomainDetailSource>,
    pub recent_reports: Vec<DomainDetailReport>,
}

#[derive(Debug, Serialize)]
pub struct DomainPolicyDetail {
    pub domain: String,
    pub adkim: String,
    pub aspf: String,
    pub policy: String,
    pub subdomain_policy: String,
    pub pct: u8,
}

#[derive(Debug, Serialize)]
pub struct DomainDetailSource {
    pub source_ip: String,
    pub sender: String,
    pub messages: u64,
    pub aligned: u64,
    pub dkim_aligned: u64,
    pub spf_aligned: u64,
    pub alignment_rate: f64,
    pub rejected: u64,
    pub quarantined: u64,
    pub risk: String,
    pub provider: Option<String>,
    pub country: Option<String>,
    pub country_code: Option<String>,
    pub region: Option<String>,
    pub continent: Option<String>,
    pub continent_code: Option<String>,
    pub asn_number: Option<u64>,
    pub asn_organization: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct DomainDetailReport {
    pub id: String,
    pub org_name: String,
    pub report_id: String,
    pub begin: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub messages: u64,
    pub aligned: u64,
    pub sources: usize,
}

pub fn overview(reports: &[Report]) -> Overview {
    let statistics = Statistics::from_reports(reports);
    let score = score(
        statistics.compliance_rate,
        policy_strength(reports),
        reports.len(),
    );
    let grade = grade(score);
    let posture = match score {
        90..=100 => "Ready for p=reject",
        75..=89 => "Close to enforcement",
        55..=74 => "Monitoring and remediation",
        _ => "Exposed",
    }
    .to_string();
    let enforcement_stage = enforcement_stage(reports).to_string();
    let policy_mix = policy_mix(reports);
    let protocols = protocol_statuses(reports, &statistics);

    Overview {
        statistics,
        grade,
        score,
        posture,
        enforcement_stage,
        policy_mix,
        protocols,
    }
}

pub fn domains(reports: &[Report]) -> Vec<DomainSummary> {
    let mut rows: BTreeMap<String, DomainAccumulator> = BTreeMap::new();

    for report in reports {
        let entry = rows
            .entry(report.policy.domain.clone())
            .or_insert_with(|| DomainAccumulator {
                policy: report.policy.policy.clone(),
                messages: 0,
                aligned: 0,
                sources: BTreeSet::new(),
                last_report: None,
            });

        entry.policy = strongest_policy(&entry.policy, &report.policy.policy).to_string();
        entry.last_report = Some(
            entry
                .last_report
                .map_or(report.end, |last| last.max(report.end)),
        );

        for record in &report.records {
            entry.messages += record.count;
            if record.dkim_aligned || record.spf_aligned {
                entry.aligned += record.count;
            }
            entry.sources.insert(record.source_ip.clone());
        }
    }

    rows.into_iter()
        .map(|(domain, row)| {
            let compliance = percent(row.aligned, row.messages);
            let score = score(compliance, single_policy_strength(&row.policy), 1);
            DomainSummary {
                domain,
                policy: row.policy.clone(),
                score,
                grade: grade(score),
                messages: row.messages,
                aligned: row.aligned,
                sources: row.sources.len(),
                last_report: row.last_report,
                next_step: next_step(&row.policy, compliance).to_string(),
            }
        })
        .collect()
}

pub fn source_insights(reports: &[Report]) -> Vec<SourceInsight> {
    let mut rows: BTreeMap<String, SourceAccumulator> = BTreeMap::new();

    for report in reports {
        for record in &report.records {
            let entry = rows
                .entry(record.source_ip.clone())
                .or_insert_with(|| SourceAccumulator {
                    messages: 0,
                    aligned: 0,
                    rejected: 0,
                    quarantined: 0,
                    domains: BTreeSet::new(),
                    sender_hints: BTreeSet::new(),
                });

            entry.messages += record.count;
            if record.dkim_aligned || record.spf_aligned {
                entry.aligned += record.count;
            }
            if record.disposition == "reject" {
                entry.rejected += record.count;
            }
            if record.disposition == "quarantine" {
                entry.quarantined += record.count;
            }
            if !record.header_from.is_empty() {
                entry.domains.insert(record.header_from.clone());
            }
            collect_sender_hints(record, &mut entry.sender_hints);
        }
    }

    let mut rows: Vec<_> = rows
        .into_iter()
        .map(|(source_ip, row)| {
            let alignment_rate = percent(row.aligned, row.messages);
            SourceInsight {
                sender: sender_name(&row.sender_hints),
                source_ip,
                messages: row.messages,
                aligned: row.aligned,
                alignment_rate,
                rejected: row.rejected,
                quarantined: row.quarantined,
                domains: row.domains.into_iter().collect(),
                risk: risk_label(alignment_rate, row.messages).to_string(),
            }
        })
        .collect();

    rows.sort_by(|left, right| right.messages.cmp(&left.messages));
    rows.truncate(100);
    rows
}

pub fn action_items(reports: &[Report]) -> Vec<ActionItem> {
    let mut items = Vec::new();

    for domain in domains(reports) {
        let compliance = percent(domain.aligned, domain.messages);
        if domain.policy == "none" && compliance >= 98.0 && domain.messages > 0 {
            items.push(ActionItem {
                severity: "medium".to_string(),
                title: "Advance policy from monitoring".to_string(),
                domain: domain.domain.clone(),
                detail: format!(
                    "{} has {:.1}% alignment while still using p=none.",
                    domain.domain, compliance
                ),
                recommendation: "Move to p=quarantine with pct=25, then increase gradually after reviewing rejected samples.".to_string(),
            });
        } else if domain.policy == "none" {
            items.push(ActionItem {
                severity: "high".to_string(),
                title: "Resolve failures before enforcement".to_string(),
                domain: domain.domain.clone(),
                detail: format!(
                    "{} alignment is {:.1}% across {} messages.",
                    domain.domain, compliance, domain.messages
                ),
                recommendation: "Fix SPF or DKIM alignment for legitimate senders before changing the DMARC policy.".to_string(),
            });
        }
    }

    for source in source_insights(reports) {
        if source.alignment_rate < 90.0 && source.messages > 0 {
            items.push(ActionItem {
                severity: if source.alignment_rate < 50.0 {
                    "critical".to_string()
                } else {
                    "high".to_string()
                },
                title: "Investigate unauthenticated source".to_string(),
                domain: source.domains.first().cloned().unwrap_or_else(|| "unknown".to_string()),
                detail: format!(
                    "{} sent {} messages with {:.1}% alignment.",
                    source.sender, source.messages, source.alignment_rate
                ),
                recommendation: "Confirm whether this sender is legitimate. If yes, configure DKIM signing or SPF alignment; otherwise keep it blocked during enforcement.".to_string(),
            });
        }
    }

    if items.is_empty() && !reports.is_empty() {
        items.push(ActionItem {
            severity: "low".to_string(),
            title: "Maintain enforcement posture".to_string(),
            domain: "all domains".to_string(),
            detail: "No high-risk alignment issues were found in the imported reports.".to_string(),
            recommendation: "Continue importing aggregate reports and watch for new senders or sudden alignment drops.".to_string(),
        });
    }

    items.truncate(20);
    items
}

pub fn timeline(reports: &[Report]) -> Vec<TimelinePoint> {
    let mut rows: BTreeMap<NaiveDate, TimelinePoint> = BTreeMap::new();

    for report in reports {
        let date = report.begin.date_naive();
        let point = rows.entry(date).or_insert(TimelinePoint {
            date,
            messages: 0,
            aligned: 0,
            rejected: 0,
            quarantined: 0,
        });

        for record in &report.records {
            point.messages += record.count;
            if record.dkim_aligned || record.spf_aligned {
                point.aligned += record.count;
            }
            if record.disposition == "reject" {
                point.rejected += record.count;
            }
            if record.disposition == "quarantine" {
                point.quarantined += record.count;
            }
        }
    }

    rows.into_values().collect()
}

pub fn geo_sources(reports: &[Report], geoip: Option<&GeoIpResolver>) -> GeoSources {
    let sources = source_insights(reports);
    let mut unresolved_sources = 0;
    let mut points = Vec::new();

    for source in sources {
        if let Some(location) = geoip
            .and_then(|resolver| resolver.lookup(&source.source_ip))
            .or_else(|| estimate_location(&source.source_ip, &source.sender))
        {
            points.push(GeoSourcePoint {
                source_ip: source.source_ip,
                sender: source.sender,
                provider: location.provider.to_string(),
                country: location.country,
                country_code: location.country_code,
                city: location.region,
                continent: location.continent,
                continent_code: location.continent_code,
                asn_number: location.asn_number,
                asn_organization: location.asn_organization,
                latitude: location.latitude,
                longitude: location.longitude,
                messages: source.messages,
                aligned: source.aligned,
                alignment_rate: source.alignment_rate,
                risk: source.risk,
            });
        } else {
            unresolved_sources += 1;
        }
    }

    points.sort_by(|left, right| right.messages.cmp(&left.messages));
    GeoSources {
        provider: if geoip.is_some() {
            "IP66 MMDB".to_string()
        } else {
            "local fallback".to_string()
        },
        database_loaded: geoip.is_some(),
        points,
        unresolved_sources,
    }
}

pub fn domain_detail(
    reports: &[Report],
    domain: &str,
    geoip: Option<&GeoIpResolver>,
) -> Option<DomainDetail> {
    let domain_reports: Vec<&Report> = reports
        .iter()
        .filter(|report| report.policy.domain.eq_ignore_ascii_case(domain))
        .collect();

    if domain_reports.is_empty() {
        return None;
    }

    let summary = domains(
        &domain_reports
            .iter()
            .map(|report| (*report).clone())
            .collect::<Vec<_>>(),
    )
    .into_iter()
    .next()?;

    let mut policy = DomainPolicyDetail {
        domain: domain_reports[0].policy.domain.clone(),
        adkim: domain_reports[0].policy.adkim.clone(),
        aspf: domain_reports[0].policy.aspf.clone(),
        policy: domain_reports[0].policy.policy.clone(),
        subdomain_policy: domain_reports[0].policy.subdomain_policy.clone(),
        pct: domain_reports[0].policy.pct,
    };

    let mut source_rows: BTreeMap<String, DomainSourceAccumulator> = BTreeMap::new();
    let mut report_rows = Vec::new();

    for report in domain_reports {
        policy.policy = strongest_policy(&policy.policy, &report.policy.policy).to_string();
        if single_policy_strength(&report.policy.subdomain_policy)
            > single_policy_strength(&policy.subdomain_policy)
        {
            policy.subdomain_policy = report.policy.subdomain_policy.clone();
        }
        policy.pct = policy.pct.min(report.policy.pct);

        let mut report_messages = 0;
        let mut report_aligned = 0;
        let mut report_sources = BTreeSet::new();

        for record in &report.records {
            report_messages += record.count;
            if record.dkim_aligned || record.spf_aligned {
                report_aligned += record.count;
            }
            report_sources.insert(record.source_ip.clone());

            let entry = source_rows
                .entry(record.source_ip.clone())
                .or_insert_with(|| DomainSourceAccumulator {
                    messages: 0,
                    aligned: 0,
                    dkim_aligned: 0,
                    spf_aligned: 0,
                    rejected: 0,
                    quarantined: 0,
                    sender_hints: BTreeSet::new(),
                });

            entry.messages += record.count;
            if record.dkim_aligned || record.spf_aligned {
                entry.aligned += record.count;
            }
            if record.dkim_aligned {
                entry.dkim_aligned += record.count;
            }
            if record.spf_aligned {
                entry.spf_aligned += record.count;
            }
            if record.disposition == "reject" {
                entry.rejected += record.count;
            }
            if record.disposition == "quarantine" {
                entry.quarantined += record.count;
            }
            collect_sender_hints(record, &mut entry.sender_hints);
        }

        report_rows.push(DomainDetailReport {
            id: report.id.clone(),
            org_name: report.org_name.clone(),
            report_id: report.report_id.clone(),
            begin: report.begin,
            end: report.end,
            messages: report_messages,
            aligned: report_aligned,
            sources: report_sources.len(),
        });
    }

    let mut sources: Vec<_> = source_rows
        .into_iter()
        .map(|(source_ip, row)| {
            let sender = sender_name(&row.sender_hints);
            let alignment_rate = percent(row.aligned, row.messages);
            let location = geoip
                .and_then(|resolver| resolver.lookup(&source_ip))
                .or_else(|| estimate_location(&source_ip, &sender));
            let (
                provider,
                country,
                country_code,
                region,
                continent,
                continent_code,
                asn_number,
                asn_organization,
                latitude,
                longitude,
            ) = match location {
                Some(location) => (
                    Some(location.provider.to_string()),
                    Some(location.country),
                    location.country_code,
                    Some(location.region),
                    location.continent,
                    location.continent_code,
                    location.asn_number,
                    location.asn_organization,
                    Some(location.latitude),
                    Some(location.longitude),
                ),
                None => (None, None, None, None, None, None, None, None, None, None),
            };

            DomainDetailSource {
                source_ip,
                sender,
                messages: row.messages,
                aligned: row.aligned,
                dkim_aligned: row.dkim_aligned,
                spf_aligned: row.spf_aligned,
                alignment_rate,
                rejected: row.rejected,
                quarantined: row.quarantined,
                risk: risk_label(alignment_rate, row.messages).to_string(),
                provider,
                country,
                country_code,
                region,
                continent,
                continent_code,
                asn_number,
                asn_organization,
                latitude,
                longitude,
            }
        })
        .collect();

    sources.sort_by(|left, right| right.messages.cmp(&left.messages));
    report_rows.sort_by(|left, right| right.begin.cmp(&left.begin));
    report_rows.truncate(12);

    Some(DomainDetail {
        summary,
        policy,
        sources,
        recent_reports: report_rows,
    })
}

fn estimate_location(source_ip: &str, sender: &str) -> Option<GeoLocation> {
    let sender = sender.to_lowercase();

    if source_ip.starts_with("149.72.")
        || source_ip.starts_with("167.89.")
        || source_ip.starts_with("168.245.")
        || source_ip.starts_with("134.128.")
        || source_ip.starts_with("159.183.")
        || source_ip.starts_with("50.31.")
        || sender.contains("sendgrid")
    {
        return Some(fallback_location(
            "United States",
            "US",
            "Denver",
            39.7392,
            -104.9903,
        ));
    }

    if source_ip.starts_with("185.189.")
        || source_ip.starts_with("185.250.")
        || source_ip.starts_with("87.253.")
        || sender.contains("mailjet")
    {
        return Some(fallback_location("France", "FR", "Paris", 48.8566, 2.3522));
    }

    if source_ip.starts_with("2a01:111:") || sender.contains("microsoft 365") {
        return Some(fallback_location(
            "Ireland", "IE", "Dublin", 53.3498, -6.2603,
        ));
    }

    if source_ip.starts_with("104.245.209.") {
        return Some(fallback_location(
            "United States",
            "US",
            "Atlanta",
            33.749,
            -84.388,
        ));
    }

    if source_ip.starts_with("209.85.") || sender.contains("google workspace") {
        return Some(fallback_location(
            "United States",
            "US",
            "Mountain View",
            37.3861,
            -122.0839,
        ));
    }

    None
}

pub fn reports_csv(reports: &[Report]) -> String {
    let mut csv = String::from("report_id,org_name,domain,begin,end,source_ip,messages,dkim,spf,disposition,header_from,envelope_from\n");
    for report in reports {
        for record in &report.records {
            csv.push_str(&format!(
                "{},{},{},{},{},{},{},{},{},{},{},{}\n",
                csv_cell(&report.report_id),
                csv_cell(&report.org_name),
                csv_cell(&report.policy.domain),
                csv_cell(&report.begin.to_rfc3339()),
                csv_cell(&report.end.to_rfc3339()),
                csv_cell(&record.source_ip),
                record.count,
                csv_cell(&record.dkim),
                csv_cell(&record.spf),
                csv_cell(&record.disposition),
                csv_cell(&record.header_from),
                csv_cell(&record.envelope_from),
            ));
        }
    }
    csv
}

fn policy_mix(reports: &[Report]) -> Vec<PolicySlice> {
    let mut rows: BTreeMap<String, u64> = BTreeMap::new();
    for report in reports {
        for record in &report.records {
            *rows.entry(report.policy.policy.clone()).or_default() += record.count;
        }
    }
    rows.into_iter()
        .map(|(policy, messages)| PolicySlice { policy, messages })
        .collect()
}

fn protocol_statuses(reports: &[Report], statistics: &Statistics) -> Vec<ProtocolStatus> {
    let has_reports = !reports.is_empty();
    let mut dkim_aligned = 0;
    let mut spf_aligned = 0;
    let mut source_ips = BTreeSet::new();
    let mut enforced_domains = BTreeSet::new();
    let mut quarantine_domains = BTreeSet::new();
    let mut reject_domains = BTreeSet::new();

    for report in reports {
        if report.policy.policy == "quarantine" || report.policy.policy == "reject" {
            enforced_domains.insert(report.policy.domain.clone());
        }
        if report.policy.policy == "quarantine" {
            quarantine_domains.insert(report.policy.domain.clone());
        }
        if report.policy.policy == "reject" {
            reject_domains.insert(report.policy.domain.clone());
        }

        for record in &report.records {
            source_ips.insert(record.source_ip.clone());
            if record.dkim_aligned {
                dkim_aligned += record.count;
            }
            if record.spf_aligned {
                spf_aligned += record.count;
            }
        }
    }

    let dkim_rate = percent(dkim_aligned, statistics.messages);
    let spf_rate = percent(spf_aligned, statistics.messages);
    let dmarc_score = if has_reports {
        statistics.compliance_rate.round() as u8
    } else {
        0
    };
    let dkim_score = dkim_rate.round() as u8;
    let spf_score = spf_rate.round() as u8;
    let enforcement_score = if statistics.domains == 0 {
        0
    } else {
        ((enforced_domains.len() as f64 / statistics.domains as f64) * 100.0).round() as u8
    };
    let strongest = enforcement_stage(reports);

    vec![
        ProtocolStatus {
            name: "DMARC".to_string(),
            status: if has_reports { "active" } else { "missing" }.to_string(),
            detail: if has_reports {
                format!("{} aggregate reports imported", statistics.reports)
            } else {
                "Import XML reports to start monitoring".to_string()
            },
            score: dmarc_score,
            summary: "DMARC alignment inferred from aggregate report policy evaluation.".to_string(),
            metrics: vec![
                protocol_metric("Reports", statistics.reports.to_string()),
                protocol_metric("Domains", statistics.domains.to_string()),
                protocol_metric("Messages", statistics.messages.to_string()),
                protocol_metric("Alignment", format!("{:.1}%", statistics.compliance_rate)),
            ],
            evidence: vec![
                format!("{} messages aligned through SPF or DKIM.", statistics.aligned),
                format!("{} distinct source IPs observed.", source_ips.len()),
            ],
            recommendation: if has_reports {
                "Keep collecting reports and review sources with low alignment before tightening policy.".to_string()
            } else {
                "Configure rua reporting on each domain and import aggregate XML reports.".to_string()
            },
        },
        ProtocolStatus {
            name: "SPF".to_string(),
            status: rate_status(spf_rate).to_string(),
            detail: format!("{:.1}% of messages SPF-aligned", spf_rate),
            score: spf_score,
            summary: "SPF coverage based on aligned SPF pass results in DMARC records.".to_string(),
            metrics: vec![
                protocol_metric("SPF aligned", spf_aligned.to_string()),
                protocol_metric("SPF rate", format!("{:.1}%", spf_rate)),
                protocol_metric(
                    "SPF failures",
                    statistics.messages.saturating_sub(spf_aligned).to_string(),
                ),
                protocol_metric("Source IPs", source_ips.len().to_string()),
            ],
            evidence: vec![
                format!("{} messages passed SPF alignment.", spf_aligned),
                "SPF alone can fail when mail is forwarded; DKIM alignment should also be reviewed.".to_string(),
            ],
            recommendation: if spf_rate >= 98.0 {
                "Maintain SPF records and monitor newly observed sources.".to_string()
            } else {
                "Validate legitimate senders and add or correct SPF includes where alignment is expected.".to_string()
            },
        },
        ProtocolStatus {
            name: "DKIM".to_string(),
            status: rate_status(dkim_rate).to_string(),
            detail: format!("{:.1}% of messages DKIM-aligned", dkim_rate),
            score: dkim_score,
            summary: "DKIM coverage based on aligned DKIM pass results in DMARC records.".to_string(),
            metrics: vec![
                protocol_metric("DKIM aligned", dkim_aligned.to_string()),
                protocol_metric("DKIM rate", format!("{:.1}%", dkim_rate)),
                protocol_metric(
                    "DKIM failures",
                    statistics.messages.saturating_sub(dkim_aligned).to_string(),
                ),
                protocol_metric("Messages", statistics.messages.to_string()),
            ],
            evidence: vec![
                format!("{} messages passed DKIM alignment.", dkim_aligned),
                "DKIM is the preferred path for durable alignment across forwarding.".to_string(),
            ],
            recommendation: if dkim_rate >= 98.0 {
                "Keep DKIM selectors monitored and rotate keys according to policy.".to_string()
            } else {
                "Enable aligned DKIM signing for legitimate platforms that currently fail.".to_string()
            },
        },
        ProtocolStatus {
            name: "Enforcement".to_string(),
            status: if !reject_domains.is_empty() {
                "enabled"
            } else if !quarantine_domains.is_empty() {
                "validating"
            } else {
                "monitoring"
            }
            .to_string(),
            detail: format!("{} of {} domains enforce quarantine or reject", enforced_domains.len(), statistics.domains),
            score: enforcement_score,
            summary: "Policy coverage inferred from published DMARC policy in imported reports.".to_string(),
            metrics: vec![
                protocol_metric("Stage", strongest.to_string()),
                protocol_metric("Enforced domains", enforced_domains.len().to_string()),
                protocol_metric("Rejected", statistics.rejected.to_string()),
                protocol_metric("Quarantined", statistics.quarantined.to_string()),
            ],
            evidence: vec![
                format!("{} domains use p=quarantine.", quarantine_domains.len()),
                format!("{} domains use p=reject.", reject_domains.len()),
            ],
            recommendation: if !reject_domains.is_empty() {
                "Monitor drift and keep new sending sources under review.".to_string()
            } else if !quarantine_domains.is_empty() {
                "Move high-alignment domains toward p=reject after reviewing failed sources.".to_string()
            } else {
                "Start with p=quarantine on domains that have consistently high alignment.".to_string()
            },
        },
    ]
}

fn protocol_metric(label: impl Into<String>, value: impl Into<String>) -> ProtocolMetric {
    ProtocolMetric {
        label: label.into(),
        value: value.into(),
    }
}

fn rate_status(rate: f64) -> &'static str {
    if rate >= 98.0 {
        "passing"
    } else if rate >= 90.0 {
        "partial"
    } else {
        "needs review"
    }
}

fn collect_sender_hints(record: &Record, hints: &mut BTreeSet<String>) {
    for dkim in &record.auth_results.dkim {
        if !dkim.domain.is_empty() {
            hints.insert(dkim.domain.clone());
        }
    }
    for spf in &record.auth_results.spf {
        if !spf.domain.is_empty() {
            hints.insert(spf.domain.clone());
        }
    }
    if !record.envelope_from.is_empty() {
        hints.insert(record.envelope_from.clone());
    }
}

fn sender_name(hints: &BTreeSet<String>) -> String {
    let text = hints
        .iter()
        .cloned()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let known = [
        ("google", "Google Workspace"),
        ("_spf.google", "Google Workspace"),
        ("outlook", "Microsoft 365"),
        ("protection.outlook", "Microsoft 365"),
        ("sendgrid", "SendGrid"),
        ("mailchimp", "Mailchimp"),
        ("amazonses", "Amazon SES"),
        ("amazonaws", "Amazon SES"),
        ("zendesk", "Zendesk"),
        ("salesforce", "Salesforce"),
        ("hubspot", "HubSpot"),
        ("mailgun", "Mailgun"),
        ("postmark", "Postmark"),
        ("brevo", "Brevo"),
        ("sendinblue", "Brevo"),
    ];

    known
        .iter()
        .find_map(|(needle, name)| text.contains(needle).then_some((*name).to_string()))
        .or_else(|| hints.iter().next().cloned())
        .unwrap_or_else(|| "Unknown sender".to_string())
}

fn score(compliance_rate: f64, policy_strength: u8, report_count: usize) -> u8 {
    if report_count == 0 {
        return 0;
    }
    let alignment_points = (compliance_rate * 0.72).round() as u8;
    let policy_points = policy_strength * 10;
    (alignment_points + policy_points).min(100)
}

fn grade(score: u8) -> String {
    match score {
        90..=100 => "A",
        80..=89 => "B",
        70..=79 => "C",
        60..=69 => "D",
        _ => "F",
    }
    .to_string()
}

fn policy_strength(reports: &[Report]) -> u8 {
    reports
        .iter()
        .map(|report| single_policy_strength(&report.policy.policy))
        .max()
        .unwrap_or(0)
}

fn single_policy_strength(policy: &str) -> u8 {
    match policy {
        "reject" => 3,
        "quarantine" => 2,
        "none" => 1,
        _ => 0,
    }
}

fn enforcement_stage(reports: &[Report]) -> &'static str {
    let strength = policy_strength(reports);
    match strength {
        3 => "Enforce",
        2 => "Validate",
        1 => "Discover",
        _ => "Onboard",
    }
}

fn strongest_policy<'a>(left: &'a str, right: &'a str) -> &'a str {
    if single_policy_strength(right) > single_policy_strength(left) {
        right
    } else {
        left
    }
}

fn next_step(policy: &str, compliance: f64) -> &'static str {
    match (policy, compliance) {
        ("reject", _) => "Keep monitoring for new senders and alignment drift",
        ("quarantine", rate) if rate >= 98.0 => {
            "Ready to switch from quarantine to reject enforcement"
        }
        ("quarantine", _) => "Fix DMARC alignment failures before moving to reject",
        ("none", rate) if rate >= 98.0 => "Start a low-risk quarantine pilot for this domain",
        ("none", _) => "Identify legitimate senders and fix SPF/DKIM alignment",
        _ => "Import more reports before deciding the next policy change",
    }
}

fn risk_label(alignment_rate: f64, messages: u64) -> &'static str {
    if messages == 0 {
        "unknown"
    } else if alignment_rate < 50.0 {
        "critical"
    } else if alignment_rate < 90.0 {
        "high"
    } else if alignment_rate < 98.0 {
        "medium"
    } else {
        "low"
    }
}

fn percent(numerator: u64, denominator: u64) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        (numerator as f64 / denominator as f64) * 100.0
    }
}

fn csv_cell(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

struct DomainAccumulator {
    policy: String,
    messages: u64,
    aligned: u64,
    sources: BTreeSet<String>,
    last_report: Option<DateTime<Utc>>,
}

struct SourceAccumulator {
    messages: u64,
    aligned: u64,
    rejected: u64,
    quarantined: u64,
    domains: BTreeSet<String>,
    sender_hints: BTreeSet<String>,
}

struct DomainSourceAccumulator {
    messages: u64,
    aligned: u64,
    dkim_aligned: u64,
    spf_aligned: u64,
    rejected: u64,
    quarantined: u64,
    sender_hints: BTreeSet<String>,
}
