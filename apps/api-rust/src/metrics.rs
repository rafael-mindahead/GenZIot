use axum::{
    Json,
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use serde::Serialize;
use sqlx::MySqlPool;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering::Relaxed},
    },
    time::{Duration, Instant},
};
use tokio::sync::watch;

const LIMITES_MS: [u64; 14] = [
    1, 2, 5, 10, 20, 50, 100, 150, 250, 500, 750, 1000, 2500, 10000,
];
const NUM_FAIXAS: usize = LIMITES_MS.len() + 1;

#[derive(Clone, Copy, Default, Serialize)]
struct Janela {
    janela_segundos: f64,
    requisicoes_concluidas: u64,
    rps: f64,
    latencia_p95_ms: Option<u64>,
    p95_acima_de_ms: Option<u64>,
}

pub(crate) struct Metrics {
    faixas: [AtomicU64; NUM_FAIXAS],
    em_andamento: AtomicU64,
    pico_em_andamento: AtomicU64,
    janela: watch::Sender<Janela>,
}

impl Metrics {
    pub(crate) fn new() -> Self {
        let (janela, _) = watch::channel(Janela::default());
        Self {
            faixas: std::array::from_fn(|_| AtomicU64::new(0)),
            em_andamento: AtomicU64::new(0),
            pico_em_andamento: AtomicU64::new(0),
            janela,
        }
    }

    pub(crate) async fn coletar(self: Arc<Self>) {
        let mut anterior = [0; NUM_FAIXAS];
        let mut inicio = Instant::now();

        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            let agora = Instant::now();
            let segundos = agora.duration_since(inicio).as_secs_f64();
            inicio = agora;

            let contagens: [u64; NUM_FAIXAS] = std::array::from_fn(|i| {
                let atual = self.faixas[i].load(Relaxed);
                let delta = atual.wrapping_sub(anterior[i]);
                anterior[i] = atual;
                delta
            });

            let total: u64 = contagens.iter().sum();
            let faixa_p95 = if total == 0 {
                None
            } else {
                let alvo = total - total / 20;
                let mut acumulado = 0;
                contagens.iter().position(|contagem| {
                    acumulado += *contagem;
                    acumulado >= alvo
                })
            };

            self.janela.send_replace(Janela {
                janela_segundos: segundos,
                requisicoes_concluidas: total,
                rps: total as f64 / segundos,
                latencia_p95_ms: faixa_p95.and_then(|i| LIMITES_MS.get(i).copied()),
                p95_acima_de_ms: faixa_p95
                    .filter(|&i| i == LIMITES_MS.len())
                    .and_then(|_| LIMITES_MS.last().copied()),
            });
        }
    }
}

struct RequisicaoAtiva<'a>(&'a AtomicU64);

impl Drop for RequisicaoAtiva<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Relaxed);
    }
}

pub(crate) async fn medir(
    State(metrics): State<Arc<Metrics>>,
    request: Request,
    next: Next,
) -> Response {
    let inicio = Instant::now();
    let ativas = metrics.em_andamento.fetch_add(1, Relaxed) + 1;
    let _ativa = RequisicaoAtiva(&metrics.em_andamento);
    metrics.pico_em_andamento.fetch_max(ativas, Relaxed);

    let response = next.run(request).await;
    let micros = inicio.elapsed().as_micros();
    let faixa = LIMITES_MS.partition_point(|&ms| u128::from(ms) * 1000 < micros);
    metrics.faixas[faixa].fetch_add(1, Relaxed);

    response
}

#[derive(Serialize)]
pub(crate) struct Relatorio {
    #[serde(flatten)]
    janela: Janela,
    requisicoes_http_em_andamento: u64,
    pico_requisicoes_http_em_andamento: u64,
    conexoes_pool_total: u32,
    conexoes_ativas: u32,
}

pub(crate) async fn relatorio(
    State((pool, metrics)): State<(MySqlPool, Arc<Metrics>)>,
) -> Json<Relatorio> {
    let total = pool.size();
    let janela = *metrics.janela.borrow();
    Json(Relatorio {
        janela,
        requisicoes_http_em_andamento: metrics.em_andamento.load(Relaxed),
        pico_requisicoes_http_em_andamento: metrics.pico_em_andamento.load(Relaxed),
        conexoes_pool_total: total,
        conexoes_ativas: total.saturating_sub(pool.num_idle() as u32),
    })
}
