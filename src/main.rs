mod app;
mod auth;
mod dmarc;
mod error;
mod geoip;
mod importer;
mod insights;
mod mailbox;
mod scheduler;
mod store;
mod web;

use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use app::AppState;
use error::Result;
use geoip::GeoIpResolver;
use importer::Importer;
use mailbox::{MailboxConfig, MailboxImporter};
use store::Store;
use tracing_subscriber::EnvFilter;

const BUNDLED_GEOIP_DB_PATH: &str = "/usr/local/share/dmarcontrol/ip66.mmdb";

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let config = Config::from_env();
    let store = Arc::new(Store::open(config.data_dir.join("dmarcontrol.sqlite")).await?);
    seed_admin_user(&store).await?;
    let geoip = load_geoip(&config.geoip_db_paths);
    let state = AppState::new(store.clone(), geoip);
    scheduler::spawn_mailbox_scheduler(state.clone());

    if let Some(path) = config.import_path {
        let summary = Importer::new(store).import_path(&path).await?;
        println!(
            "Imported {} report(s), skipped {} duplicate(s)",
            summary.imported, summary.duplicates
        );
        return Ok(());
    }

    if config.import_mailbox {
        let mailbox = MailboxConfig::from_env()?;
        let summary = MailboxImporter::new(store).import(mailbox).await?;
        println!(
            "Scanned {} of {} matched message(s), found {} attachment(s), imported {} report(s), skipped {} duplicate(s)",
            summary.messages_scanned,
            summary.messages_matched,
            summary.attachments_found,
            summary.imported,
            summary.duplicates
        );
        if !summary.failed_attachments.is_empty() {
            eprintln!(
                "Failed attachment(s): {}",
                summary.failed_attachments.join(", ")
            );
        }
        return Ok(());
    }

    let listener = tokio::net::TcpListener::bind(config.addr).await?;
    tracing::info!("listening on http://{}", listener.local_addr()?);
    axum::serve(listener, web::router(state)).await?;
    Ok(())
}

fn load_geoip(paths: &[PathBuf]) -> Option<Arc<GeoIpResolver>> {
    let mut errors = Vec::new();
    for path in paths {
        match GeoIpResolver::open(path) {
            Ok(resolver) => {
                tracing::info!("loaded IP66 GeoIP database from {:?}", path);
                return Some(Arc::new(resolver));
            }
            Err(err) => errors.push(format!("{:?}: {}", path, err)),
        }
    }

    tracing::warn!(
        "IP66 GeoIP database not loaded; attempted {}",
        errors.join("; ")
    );
    None
}

async fn seed_admin_user(store: &Store) -> Result<()> {
    if store.has_users().await? {
        return Ok(());
    }
    let username = env::var("DMARCONTROL_ADMIN_USERNAME").unwrap_or_else(|_| "admin".to_string());
    let password = env::var("DMARCONTROL_ADMIN_PASSWORD").unwrap_or_else(|_| {
        tracing::warn!(
            "DMARCONTROL_ADMIN_PASSWORD is not set; seeded local admin password defaults to 'admin'"
        );
        "admin".to_string()
    });
    let password_hash = auth::hash_password(&password)?;
    let user_id = auth::random_id()?;
    if store
        .ensure_admin_user(&user_id, &username, &password_hash)
        .await?
    {
        tracing::info!("seeded local admin user '{}'", username);
    }
    Ok(())
}

struct Config {
    addr: SocketAddr,
    data_dir: PathBuf,
    geoip_db_paths: Vec<PathBuf>,
    import_path: Option<PathBuf>,
    import_mailbox: bool,
}

impl Config {
    fn from_env() -> Self {
        let mut addr = env::var("ADDR").unwrap_or_else(|_| "127.0.0.1:8080".to_string());
        let mut data_dir =
            PathBuf::from(env::var("DATA_DIR").unwrap_or_else(|_| "data".to_string()));
        let geoip_db_from_env = env::var("DMARCONTROL_GEOIP_DB").ok().map(PathBuf::from);
        let mut geoip_db_paths = geoip_paths(&data_dir, geoip_db_from_env.clone());
        let mut geoip_db_explicit = geoip_db_from_env.is_some();
        let mut import_path = None;
        let mut import_mailbox = false;

        let mut args = env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--addr" => {
                    if let Some(value) = args.next() {
                        addr = value;
                    }
                }
                "--data-dir" => {
                    if let Some(value) = args.next() {
                        data_dir = PathBuf::from(value);
                        if !geoip_db_explicit {
                            geoip_db_paths = geoip_paths(&data_dir, None);
                        }
                    }
                }
                "--geoip-db" => {
                    if let Some(value) = args.next() {
                        geoip_db_paths = geoip_paths(&data_dir, Some(PathBuf::from(value)));
                        geoip_db_explicit = true;
                    }
                }
                "--import" => {
                    if let Some(value) = args.next() {
                        import_path = Some(PathBuf::from(value));
                    }
                }
                "--import-mailbox" => {
                    import_mailbox = true;
                }
                "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                _ => {}
            }
        }

        let addr = addr
            .parse()
            .unwrap_or_else(|_| panic!("invalid listen address: {addr}"));

        Self {
            addr,
            data_dir,
            geoip_db_paths,
            import_path,
            import_mailbox,
        }
    }
}

fn geoip_paths(data_dir: &std::path::Path, explicit: Option<PathBuf>) -> Vec<PathBuf> {
    if let Some(path) = explicit {
        vec![path]
    } else {
        vec![
            data_dir.join("ip66.mmdb"),
            PathBuf::from(BUNDLED_GEOIP_DB_PATH),
        ]
    }
}

fn print_help() {
    println!(
        "dmarcontrol\n\nUsage:\n  dmarcontrol [--addr 127.0.0.1:8080] [--data-dir data] [--geoip-db data/ip66.mmdb]\n  dmarcontrol --import ./reports [--data-dir data]\n  dmarcontrol --import-mailbox [--data-dir data]\n"
    );
}
