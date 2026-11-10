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
type Faixas = [AtomicU64; NUM_FAIXAS];

fn registrar_faixa(faixas: &Faixas, duracao: Duration) {
    let micros = duracao.as_micros();
    let faixa = LIMITES_MS.partition_point(|&ms| u128::from(ms) * 1000 < micros);
    faixas[faixa].fetch_add(1, Relaxed);
}

fn delta_faixas(faixas: &Faixas, anterior: &mut [u64; NUM_FAIXAS]) -> [u64; NUM_FAIXAS] {
    std::array::from_fn(|i| {
        let atual = faixas[i].load(Relaxed);
        let delta = atual.wrapping_sub(anterior[i]);
        anterior[i] = atual;
        delta
    })
}

fn faixa_percentil(contagens: &[u64; NUM_FAIXAS], total: u64, percentil: u8) -> Option<usize> {
    if total == 0 {
        return None;
    }

    let alvo = (u128::from(total) * u128::from(percentil)).div_ceil(100) as u64;
    let mut acumulado = 0;
    contagens.iter().position(|contagem| {
        acumulado += *contagem;
        acumulado >= alvo
    })
}

#[derive(Clone, Copy, Default, Serialize)]
struct Janela {
    janela_segundos: f64,
    requisicoes_concluidas: u64,
    rps: f64,
    latencia_p95_ms: Option<u64>,
    p95_acima_de_ms: Option<u64>,
    pool_aquisicoes_concluidas: u64,
    pool_aquisicao_p95_ms: Option<u64>,
    pool_aquisicao_p99_ms: Option<u64>,
}

pub(crate) struct Metrics {
    faixas: Faixas,
    faixas_aquisicao: Faixas,
    em_andamento: AtomicU64,
    pico_em_andamento: AtomicU64,
    janela: watch::Sender<Janela>,
}

impl Metrics {
    pub(crate) fn new() -> Self {
        let (janela, _) = watch::channel(Janela::default());
        Self {
            faixas: std::array::from_fn(|_| AtomicU64::new(0)),
            faixas_aquisicao: std::array::from_fn(|_| AtomicU64::new(0)),
            em_andamento: AtomicU64::new(0),
            pico_em_andamento: AtomicU64::new(0),
            janela,
        }
    }

    pub(crate) fn registrar_aquisicao(&self, duracao: Duration) {
        registrar_faixa(&self.faixas_aquisicao, duracao);
    }

    pub(crate) async fn coletar(self: Arc<Self>) {
        let mut anterior = [0; NUM_FAIXAS];
        let mut anterior_aquisicao = [0; NUM_FAIXAS];
        let mut inicio = Instant::now();

        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            let agora = Instant::now();
            let segundos = agora.duration_since(inicio).as_secs_f64();
            inicio = agora;

            let contagens = delta_faixas(&self.faixas, &mut anterior);
            let total: u64 = contagens.iter().sum();
            let faixa_p95 = faixa_percentil(&contagens, total, 95);

            let aquisicoes = delta_faixas(&self.faixas_aquisicao, &mut anterior_aquisicao);
            let total_aquisicoes: u64 = aquisicoes.iter().sum();
            let percentil_aquisicao = |p| {
                faixa_percentil(&aquisicoes, total_aquisicoes, p)
                    .and_then(|i| LIMITES_MS.get(i).copied())
            };

            self.janela.send_replace(Janela {
                janela_segundos: segundos,
                requisicoes_concluidas: total,
                rps: total as f64 / segundos,
                latencia_p95_ms: faixa_p95.and_then(|i| LIMITES_MS.get(i).copied()),
                p95_acima_de_ms: faixa_p95
                    .filter(|&i| i == LIMITES_MS.len())
                    .and_then(|_| LIMITES_MS.last().copied()),
                pool_aquisicoes_concluidas: total_aquisicoes,
                pool_aquisicao_p95_ms: percentil_aquisicao(95),
                pool_aquisicao_p99_ms: percentil_aquisicao(99),
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
    registrar_faixa(&metrics.faixas, inicio.elapsed());

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
