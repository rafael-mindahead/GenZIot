mod ingestao;

mod metrics;

use axum::{Router, middleware, routing::get};

use sqlx::{MySqlPool, mysql::MySqlPoolOptions};
use std::{env, error::Error, str::FromStr, sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::Semaphore};

#[derive(Clone)]
struct AppState {
    pool: MySqlPool,
    admission: Arc<Semaphore>,
}

fn config<T: FromStr>(name: &str, default: &str) -> Result<T, Box<dyn Error>> {
    env::var(name)
        .unwrap_or_else(|_| default.to_owned())
        .parse()
        .map_err(|_| format!("valor inválido para {name}").into())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let database_url = env::var("DATABASE_URL")?;
    let address = env::var("PUBLIC_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let pool_min: u32 = config("DB_POOL_MIN", "4")?;
    let pool_max: u32 = config("DB_POOL_MAX", "32")?;
    let acquire_timeout_ms: u64 = config("DB_ACQUIRE_TIMEOUT_MS", "150")?;
    let in_flight: usize = config("INGEST_MAX_IN_FLIGHT", "64")?;

    if pool_max == 0
        || pool_min > pool_max
        || acquire_timeout_ms == 0
        || !(1..=Semaphore::MAX_PERMITS).contains(&in_flight)
    {
        return Err("configuração de concorrência inválida".into());
    }

    let pool = MySqlPoolOptions::new()
        .min_connections(pool_min)
        .max_connections(pool_max)
        .acquire_timeout(Duration::from_millis(acquire_timeout_ms))
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("SET time_zone = '+00:00', innodb_lock_wait_timeout = 1")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect(&database_url)
        .await?;

    let metrics = Arc::new(metrics::Metrics::new());

    let metrics_addr = env::var("METRICS_ADDR").unwrap_or_else(|_| "127.0.0.1:9091".into());
    let metrics_listener = TcpListener::bind(&metrics_addr).await?;

    let internal_app = Router::new()
        .route("/internal/metrics", get(metrics::relatorio))
        .with_state((pool.clone(), Arc::clone(&metrics)));

    let state = AppState {
        pool,
        admission: Arc::new(Semaphore::new(in_flight)),
    };
    let public_app = ingestao::routes()
        .route_layer(middleware::from_fn_with_state(
            Arc::clone(&metrics),
            metrics::medir,
        ))
        .with_state(state);

    let listener = TcpListener::bind(&address).await?;
    tokio::spawn(metrics.coletar());

    println!("Ingestão em http://{}", listener.local_addr()?);
    println!(
        "Métricas em http://{}/internal/metrics",
        metrics_listener.local_addr()?
    );

    tokio::select! {
        result = async {
            axum::serve(listener, public_app)
                .with_graceful_shutdown(async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await
        } => result?,
        result = async { axum::serve(metrics_listener, internal_app).await } => result?,
    }

    Ok(())
}
