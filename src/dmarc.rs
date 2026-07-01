use chrono::{DateTime, TimeZone, Utc};
use quick_xml::de::from_str;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    pub id: String,
    pub org_name: String,
    pub report_id: String,
    pub begin: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub policy: PublishedPolicy,
    pub records: Vec<Record>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishedPolicy {
    pub domain: String,
    pub adkim: String,
    pub aspf: String,
    pub policy: String,
    pub subdomain_policy: String,
    pub pct: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    pub source_ip: String,
    pub count: u64,
    pub disposition: String,
    pub dkim: String,
    pub spf: String,
    pub header_from: String,
    pub envelope_from: String,
    pub dkim_aligned: bool,
    pub spf_aligned: bool,
    pub identifiers: Identifiers,
    pub auth_results: AuthResults,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Identifiers {
    pub header_from: String,
    pub envelope_from: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AuthResults {
    pub dkim: Vec<DkimAuth>,
    pub spf: Vec<SpfAuth>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DkimAuth {
    pub domain: String,
    pub selector: String,
    pub result: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SpfAuth {
    pub domain: String,
    pub scope: String,
    pub result: String,
}

pub fn parse_report(xml: &str) -> Result<Report> {
    let feedback: Feedback = from_str(xml)?;
    let report_id = feedback.report_metadata.report_id.trim().to_string();
    let org_name = feedback.report_metadata.org_name.trim().to_string();
    let begin = unix_ts(feedback.report_metadata.date_range.begin)?;
    let end = unix_ts(feedback.report_metadata.date_range.end)?;
    let policy = PublishedPolicy {
        domain: feedback.policy_published.domain.trim().to_lowercase(),
        adkim: fallback(feedback.policy_published.adkim, "r"),
        aspf: fallback(feedback.policy_published.aspf, "r"),
        policy: fallback(feedback.policy_published.p, "none"),
        subdomain_policy: fallback(feedback.policy_published.sp, ""),
        pct: feedback.policy_published.pct.unwrap_or(100),
    };

    if report_id.is_empty() || policy.domain.is_empty() {
        return Err(AppError::InvalidReport(
            "report_id and policy_published.domain are required".to_string(),
        ));
    }

    let records = feedback
        .records
        .into_iter()
        .map(|record| {
            let identifiers = Identifiers {
                header_from: record.identifiers.header_from.unwrap_or_default(),
                envelope_from: record.identifiers.envelope_from.unwrap_or_default(),
            };
            let auth_results = AuthResults {
                dkim: record
                    .auth_results
                    .dkim
                    .into_iter()
                    .map(|dkim| DkimAuth {
                        domain: dkim.domain.unwrap_or_default(),
                        selector: dkim.selector.unwrap_or_default(),
                        result: dkim.result.unwrap_or_default(),
                    })
                    .collect(),
                spf: record
                    .auth_results
                    .spf
                    .into_iter()
                    .map(|spf| SpfAuth {
                        domain: spf.domain.unwrap_or_default(),
                        scope: spf.scope.unwrap_or_default(),
                        result: spf.result.unwrap_or_default(),
                    })
                    .collect(),
            };
            let dkim = fallback(record.row.policy_evaluated.dkim, "fail");
            let spf = fallback(record.row.policy_evaluated.spf, "fail");
            Record {
                source_ip: record.row.source_ip,
                count: record.row.count.unwrap_or(0),
                disposition: fallback(record.row.policy_evaluated.disposition, "none"),
                dkim_aligned: dkim == "pass",
                spf_aligned: spf == "pass",
                dkim,
                spf,
                header_from: identifiers.header_from.clone(),
                envelope_from: identifiers.envelope_from.clone(),
                identifiers,
                auth_results,
            }
        })
        .collect();

    let id = stable_id(&[
        &org_name,
        &report_id,
        &policy.domain,
        &begin.timestamp().to_string(),
    ]);

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

fn unix_ts(value: i64) -> Result<DateTime<Utc>> {
    Utc.timestamp_opt(value, 0)
        .single()
        .ok_or_else(|| AppError::InvalidReport(format!("invalid unix timestamp: {value}")))
}

fn fallback(value: Option<String>, default: &str) -> String {
    value
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn stable_id(parts: &[&str]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for part in parts {
        for byte in part.as_bytes() {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("{hash:016x}")
}

#[derive(Debug, Deserialize)]
struct Feedback {
    report_metadata: ReportMetadata,
    policy_published: PolicyPublished,
    #[serde(rename = "record", default)]
    records: Vec<RawRecord>,
}

#[derive(Debug, Deserialize)]
struct ReportMetadata {
    org_name: String,
    report_id: String,
    date_range: DateRange,
}

#[derive(Debug, Deserialize)]
struct DateRange {
    begin: i64,
    end: i64,
}

#[derive(Debug, Deserialize)]
struct PolicyPublished {
    domain: String,
    adkim: Option<String>,
    aspf: Option<String>,
    p: Option<String>,
    sp: Option<String>,
    pct: Option<u8>,
}

#[derive(Debug, Deserialize)]
struct RawRecord {
    row: Row,
    identifiers: RawIdentifiers,
    #[serde(default)]
    auth_results: RawAuthResults,
}

#[derive(Debug, Deserialize)]
struct Row {
    source_ip: String,
    count: Option<u64>,
    policy_evaluated: PolicyEvaluated,
}

#[derive(Debug, Deserialize)]
struct PolicyEvaluated {
    disposition: Option<String>,
    dkim: Option<String>,
    spf: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawIdentifiers {
    header_from: Option<String>,
    envelope_from: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct RawAuthResults {
    #[serde(rename = "dkim", default)]
    dkim: Vec<RawDkimAuth>,
    #[serde(rename = "spf", default)]
    spf: Vec<RawSpfAuth>,
}

#[derive(Debug, Deserialize)]
struct RawDkimAuth {
    domain: Option<String>,
    selector: Option<String>,
    result: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawSpfAuth {
    domain: Option<String>,
    scope: Option<String>,
    result: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_dmarc_report() {
        let xml = r#"
        <feedback>
          <report_metadata>
            <org_name>Example ISP</org_name>
            <report_id>abc-123</report_id>
            <date_range><begin>1717200000</begin><end>1717286399</end></date_range>
          </report_metadata>
          <policy_published>
            <domain>example.com</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><pct>100</pct>
          </policy_published>
          <record>
            <row>
              <source_ip>203.0.113.10</source_ip>
              <count>42</count>
              <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated>
            </row>
            <identifiers><header_from>example.com</header_from></identifiers>
            <auth_results>
              <dkim><domain>example.com</domain><selector>s1</selector><result>pass</result></dkim>
              <spf><domain>mail.example.com</domain><scope>mfrom</scope><result>pass</result></spf>
            </auth_results>
          </record>
        </feedback>
        "#;

        let report = parse_report(xml).expect("parse report");
        assert_eq!(report.policy.domain, "example.com");
        assert_eq!(report.records[0].count, 42);
        assert!(report.records[0].dkim_aligned);
    }
}
