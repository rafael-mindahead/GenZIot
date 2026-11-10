use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderValue, StatusCode, header::RETRY_AFTER},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, mysql::MySqlDatabaseError};
use std::time::Instant;
use uuid::Uuid;

use crate::AppState;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/movimentacao", post(registrar))
        .layer(DefaultBodyLimit::max(512))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Movimentacao {
    evento_id: Uuid,
    dispositivo_id: u32,
    codigo_barras: String,
    quantidade_delta: i16,
}

impl Movimentacao {
    fn valida(&self) -> bool {
        !self.evento_id.is_nil()
            && self.dispositivo_id > 0
            && matches!(self.codigo_barras.len(), 8 | 12..=14)
            && self.codigo_barras.bytes().all(|byte| byte.is_ascii_digit())
            && self.quantidade_delta != 0
            && (-1000..=1000).contains(&self.quantidade_delta)
    }
}

#[derive(Serialize)]
struct ErroBody {
    erro: &'static str,
}

struct ApiError(StatusCode, &'static str);
impl ApiError {
    fn ocupado(causa: &'static str) -> Self {
        Self(StatusCode::SERVICE_UNAVAILABLE, causa)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let indisponivel = self.0 == StatusCode::SERVICE_UNAVAILABLE;
        let erro = if indisponivel {
            "ingestao_ocupada"
        } else {
            self.1
        };
        let mut response = (self.0, Json(ErroBody { erro })).into_response();

        if indisponivel {
            let headers = response.headers_mut();
            headers.insert(RETRY_AFTER, HeaderValue::from_static("1"));
            headers.insert("x-genziot-503-cause", HeaderValue::from_static(self.1));
        }

        response
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        let mysql_number = error
            .as_database_error()
            .and_then(|error| error.try_downcast_ref::<MySqlDatabaseError>())
            .map(MySqlDatabaseError::number);

        match (&error, mysql_number) {
            (sqlx::Error::PoolTimedOut, _) => Self::ocupado("pool_timeout"),
            (sqlx::Error::PoolClosed, _) => Self::ocupado("pool_fechado"),
            (_, Some(1205)) => Self::ocupado("lock_timeout"),
            (_, Some(1213)) => Self::ocupado("deadlock"),
            _ => {
                eprintln!("Falha na persistência da movimentação: {error}");
                Self(StatusCode::INTERNAL_SERVER_ERROR, "erro_de_persistencia")
            }
        }
    }
}

async fn registrar(
    State(state): State<AppState>,
    Json(evento): Json<Movimentacao>,
) -> Result<StatusCode, ApiError> {
    if !evento.valida() {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "payload_invalido",
        ));
    }

    // Admissão limitada para evitar uma fila ilimitada à frente do MySQL.
    let _permit = state
        .admission
        .try_acquire()
        .map_err(|_| ApiError::ocupado("admissao"))?;
    let evento_id = &evento.evento_id.as_bytes()[..];
    let inicio_aquisicao = Instant::now();
    let conexao = state.pool.acquire().await;
    state
        .metrics
        .registrar_aquisicao(inicio_aquisicao.elapsed());
    let mut conexao = conexao?;
    let mut tx = conexao.begin().await?;

    // O lock serializa alterações no saldo do mesmo produto até o commit.
    let produto: Option<(u32, u32)> =
        sqlx::query_as("SELECT id, saldo FROM produtos WHERE codigo_barras = ? FOR UPDATE")
            .bind(&evento.codigo_barras)
            .fetch_optional(&mut *tx)
            .await?;

    let Some((produto_id, saldo)) = produto else {
        tx.rollback().await?;
        return Err(ApiError(StatusCode::NOT_FOUND, "produto_nao_encontrado"));
    };

    let insercao = sqlx::query(
        "INSERT INTO movimentacoes_estoque
         (evento_id, produto_id, dispositivo_id, quantidade_delta) VALUES (?, ?, ?, ?)",
    )
    .bind(evento_id)
    .bind(produto_id)
    .bind(evento.dispositivo_id)
    .bind(evento.quantidade_delta)
    .execute(&mut *tx)
    .await;

    if let Err(error) = insercao {
        if !error
            .as_database_error()
            .is_some_and(|error| error.is_unique_violation())
        {
            return Err(error.into());
        }

        // Libera o lock e devolve a conexão antes de consultar o evento já confirmado.
        tx.rollback().await?;
        drop(conexao);
        let original: (u32, u32, i16) = sqlx::query_as(
            "SELECT produto_id, dispositivo_id, quantidade_delta
             FROM movimentacoes_estoque WHERE evento_id = ?",
        )
        .bind(evento_id)
        .fetch_one(&state.pool)
        .await?;

        if original == (produto_id, evento.dispositivo_id, evento.quantidade_delta) {
            return Ok(StatusCode::OK);
        }

        return Err(ApiError(StatusCode::CONFLICT, "evento_id_reutilizado"));
    }

    let novo_saldo = i64::from(saldo) + i64::from(evento.quantidade_delta);
    let Ok(novo_saldo) = u32::try_from(novo_saldo) else {
        tx.rollback().await?;
        return Err(ApiError(StatusCode::CONFLICT, "saldo_fora_do_intervalo"));
    };

    sqlx::query("UPDATE produtos SET saldo = ? WHERE id = ?")
        .bind(novo_saldo)
        .bind(produto_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(StatusCode::CREATED)
}
