mod config;
mod domain;
mod error;
mod history_admission;
mod identity;
mod ingest;
mod protocol;
mod search;
mod startup;
mod storage;
mod sync;
mod sync_wire;
mod watcher;

use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    net::IpAddr,
    sync::{atomic::AtomicU64, Arc},
    time::Instant,
};

use anyhow::{Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use clap::Parser;
use fs2::FileExt;
use rand::RngCore;
use tokio::{net::TcpListener, sync::Mutex};
use tokio_util::sync::CancellationToken;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};
use uuid::Uuid;

use crate::{
    config::{Cli, ServiceConfig, PROTOCOL_VERSION, SCHEMA_VERSION},
    identity::IdentityResolver,
    ingest::Reconciler,
    protocol::{AppState, ReadyHandshake},
    search::SearchRuntime,
    storage::{now_ms, Database},
    watcher::WatcherRuntime,
};

struct InstanceLock {
    file: File,
}

impl InstanceLock {
    fn acquire(config: &ServiceConfig, instance_id: Uuid) -> Result<Self> {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&config.lock_path)
            .with_context(|| format!("failed to open lock file {}", config.lock_path.display()))?;

        file.try_lock_exclusive().with_context(|| {
            format!(
                "another VCP-CDS instance already owns AppData {}",
                config.app_data.display()
            )
        })?;

        file.set_len(0)?;
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "instanceId": instance_id,
                "pid": std::process::id(),
                "appData": config.app_data,
                "startedAt": now_ms()
            })
        )?;
        file.sync_data()?;
        Ok(Self { file })
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[tokio::main]
async fn main() {
    init_tracing();
    if let Err(error) = run().await {
        tracing::error!(error = ?error, "VCP-CDS terminated with an error");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    if std::env::args_os().any(|arg| arg == "--history-authority-probe") {
        return history_authority_probe();
    }
    let startup_started = Instant::now();
    let cli = Cli::parse();
    let config = Arc::new(ServiceConfig::from_cli(cli)?);
    fs::create_dir_all(&config.agents_dir)?;
    fs::create_dir_all(&config.groups_dir)?;
    fs::create_dir_all(&config.user_data_dir)?;

    let instance_id = Uuid::new_v4();
    let _instance_lock = InstanceLock::acquire(&config, instance_id)?;
    let auth_token = generate_auth_token();

    let database_open_started = Instant::now();
    startup::progress("database_open");
    let database = Database::open(&config.database_path)?;
    startup::progress("database_ready");
    let database_open_ms = database_open_started.elapsed().as_millis();
    let startup_state = database.startup_state();
    tracing::info!(
        database = %database.path().display(),
        schema_version = SCHEMA_VERSION,
        database_open_ms,
        previous_clean_shutdown = startup_state.previous_clean_shutdown,
        filesystem_dirty = startup_state.filesystem_dirty,
        schema_migrated = startup_state.schema_migrated,
        integrity_checked = startup_state.integrity_checked,
        "database is ready"
    );

    let admission = history_admission::HistoryAdmission::new(&config.app_data, instance_id)?;
    let reconciler = Reconciler::new(config.clone(), database.clone(), admission.clone());

    // MobileSync only needs the durable SQLite mirror. Tantivy, its 50 MB
    // writer, reader and Jieba dictionary are opened by the first search call.
    let search = config
        .tantivy_enabled
        .then(|| SearchRuntime::new(config.index_dir.clone(), database.clone()));

    let cancellation = CancellationToken::new();
    let reconcile_lock = Arc::new(Mutex::new(()));
    startup::progress("watcher_start");
    let watcher_started = Instant::now();
    let watcher_runtime = if config.notify_enabled {
        Some(WatcherRuntime::start(
            reconciler.clone(),
            search.clone(),
            cancellation.clone(),
            reconcile_lock.clone(),
        )?)
    } else {
        None
    };
    let watcher_start_ms = watcher_started.elapsed().as_millis();
    startup::progress("watcher_ready");
    let watcher_metrics = watcher_runtime
        .as_ref()
        .map(|runtime| runtime.metrics.clone());

    let state = AppState {
        instance_id,
        auth_token: Arc::from(auth_token.clone()),
        started_at: now_ms(),
        reconciler: reconciler.clone(),
        search,
        identity: IdentityResolver::new(database.clone()),
        cancellation: cancellation.clone(),
        watcher_metrics,
        reconcile_lock,
        pending_index: Arc::new(AtomicU64::new(0)),
    };

    let bind_ip: IpAddr = config
        .host
        .parse()
        .or_else(|_| {
            if config.host == "localhost" {
                Ok::<IpAddr, std::net::AddrParseError>(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST))
            } else {
                config.host.parse()
            }
        })
        .context("invalid bind address")?;
    if !bind_ip.is_loopback() {
        anyhow::bail!("refusing to bind VCP-CDS to a non-loopback address");
    }

    let listener = TcpListener::bind((bind_ip, config.port))
        .await
        .context("failed to bind local HTTP listener")?;
    let address = listener.local_addr()?;

    // stdout is reserved for the initial handshake and private authority ACKs.
    println!(
        "{}",
        serde_json::to_string(&ReadyHandshake {
            message_type: "ready",
            protocol_version: PROTOCOL_VERSION,
            schema_version: SCHEMA_VERSION,
            port: address.port(),
            instance_id,
            auth_token,
            authority_protocol: 1,
            history_admission: "unknown",
            root_identity: admission.root_identity(),
        })?
    );
    std::io::stdout().flush()?;

    let control_admission = admission.clone();
    let parent_pipe_cancellation = cancellation.clone();
    let managed_parent_pipe = std::env::var("VCP_CDS_MANAGED_PARENT_PIPE").as_deref() == Ok("1");
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut input = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = input.next_line().await {
            let value = serde_json::from_str(&line).unwrap_or(serde_json::Value::Null);
            let ack = control_admission.control(value).await;
            let mut output = std::io::stdout().lock();
            if writeln!(output, "{}", ack)
                .and_then(|()| output.flush())
                .is_err()
            {
                break;
            }
        }
        control_admission.disconnect().await;
        // The managed CDS must release its instance lock if Electron crashes.
        // Standalone callers retain their existing behavior on stdin EOF.
        if managed_parent_pipe {
            parent_pipe_cancellation.cancel();
        }
    });

    tracing::info!(
        address = %address,
        instance_id = %instance_id,
        protocol_version = PROTOCOL_VERSION,
        database_open_ms,
        watcher_start_ms,
        ready_total_ms = startup_started.elapsed().as_millis(),
        search_initialized = false,
        startup_reconcile_required = startup_state.requires_startup_reconcile(),
        "VCP-CDS is ready"
    );

    // A clean, current durable mirror can be reused directly. New databases,
    // schema upgrades, unclean exits and persisted filesystem dirtiness retain
    // the conservative full recovery pass.
    if startup_state.requires_startup_reconcile() {
        let startup_reconciler = reconciler.clone();
        let startup_search = state.search.clone();
        let startup_reconcile_lock = state.reconcile_lock.clone();
        let startup_watcher_metrics = state.watcher_metrics.clone();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let _guard = startup_reconcile_lock.lock().await;
            if let Some(metrics) = &startup_watcher_metrics {
                metrics
                    .reconcile_required
                    .swap(false, std::sync::atomic::Ordering::AcqRel);
            }
            match startup_reconciler.reconcile().await {
                Ok(stats) => {
                    tracing::info!(?stats, "background startup reconcile completed");
                    if let Some(index) = startup_search {
                        if let Err(error) = index.reconcile_revisions_if_initialized() {
                            tracing::error!(error = ?error, "background startup index reconcile failed");
                            if let Some(metrics) = startup_watcher_metrics {
                                metrics
                                    .reconcile_required
                                    .store(true, std::sync::atomic::Ordering::Release);
                            }
                        }
                    }
                }
                Err(error) => {
                    tracing::error!(error = ?error, "background startup reconcile failed");
                    if let Some(metrics) = startup_watcher_metrics {
                        metrics
                            .reconcile_required
                            .store(true, std::sync::atomic::Ordering::Release);
                    }
                }
            }
        });
    } else {
        tracing::info!("startup reconcile skipped; durable mirror is clean");
    }

    let signal_cancellation = cancellation.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal_cancellation.cancel();
        }
    });

    let shutdown = cancellation.clone();
    axum::serve(listener, protocol::router(state.clone()))
        .with_graceful_shutdown(async move {
            shutdown.cancelled().await;
        })
        .await
        .context("HTTP server failed")?;

    cancellation.cancel();
    if let Some(runtime) = watcher_runtime {
        runtime.shutdown().await;
    }

    // If filesystem notifications occurred after the last committed reconcile,
    // perform one final pass after the watcher has stopped. This guarantees the
    // next launch can take the fast path without losing a queued final write.
    if database.filesystem_dirty()? {
        let final_reconcile_started = Instant::now();
        let _guard = state.reconcile_lock.lock().await;
        let stats = reconciler.reconcile().await?;
        if let Some(search) = &state.search {
            search.reconcile_revisions_if_initialized()?;
        }
        tracing::info!(
            ?stats,
            duration_ms = final_reconcile_started.elapsed().as_millis(),
            "shutdown reconcile completed"
        );
    }
    if !admission.pending() {
        database.mark_clean_shutdown()?;
    } else {
        database.mark_filesystem_dirty()?;
    }
    database.checkpoint()?;
    tracing::info!("VCP-CDS shutdown completed");
    Ok(())
}

/// One-shot check of the existing CDS process lock. No DB or History is opened.
/// This proves lock availability at the instant of the probe; it is not a lease.
fn history_authority_probe() -> Result<()> {
    #[derive(Parser)]
    struct ProbeCli {
        #[arg(long)]
        history_authority_probe: bool,
        #[arg(long)]
        app_data: std::path::PathBuf,
    }
    let args = ProbeCli::parse();
    let root = history_admission::RootIdentity::read(&args.app_data)?;
    let lock_path = args
        .app_data
        .canonicalize()?
        .join("databases/chat_data_service.lock");
    // Never create or truncate a missing lock to manufacture proof.
    let file = OpenOptions::new()
        .read(true)
        .open(lock_path)
        .context("HISTORY_AUTHORITY_PROBE_UNVERIFIED: existing lock unavailable")?;
    file.try_lock_exclusive()
        .context("HISTORY_AUTHORITY_PROBE_BUSY")?;
    println!(
        "{}",
        serde_json::json!({"type":"historyAuthorityProbe","authorityProtocol":1,"rootIdentity":root,"settled":true})
    );
    std::io::stdout().flush()?;
    FileExt::unlock(&file)?;
    Ok(())
}

fn init_tracing() {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("vcp_chat_data_service=info,tower_http=warn"));
    tracing_subscriber::registry()
        .with(env_filter)
        .with(
            fmt::layer()
                .json()
                .with_writer(std::io::stderr)
                .with_current_span(false),
        )
        .init();
}

fn generate_auth_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
