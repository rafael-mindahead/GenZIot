# GenZIot

Serviço de ingestão de movimentações de estoque em Rust, Axum e MySQL. O `POST /api/v1/movimentacao` atualiza o estoque e grava o evento na mesma transação. A primeira gravação retorna `201`. Um reenvio idêntico com o mesmo UUID retorna `200`.

## Executar localmente

Pré-requisitos para o fluxo abaixo incluem Docker com Compose, Rust estável e k6. No macOS, `brew install k6` instala o gerador de carga.

Na raiz do projeto, suba o MySQL e carregue os 1.000 produtos sintéticos. O Compose expõe o banco em `127.0.0.1:3307`. Use um banco de desenvolvimento, pois o k6 grava movimentações e altera o saldo.

```bash
[ -f .env ] || cp .env.example .env
docker compose up -d --wait &&
docker compose exec -T mysql sh -c \
  'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" < /seed/benchmark.sql'
```

Suba o Rust em modo release em um terminal e deixe o processo rodando.

```bash
set -a
. ./.env
set +a
cargo run --release --locked --manifest-path apps/api-rust/Cargo.toml
```

## Testar a ingestão

Em outro terminal, também na raiz, comece com dois POSTs. Execute a rampa somente depois de confirmar que ambos retornam `201`.

```bash
k6 run -e MODE=burst -e TARGET_VUS=2 -e BURST_DELAY_MS=1000 tests/k6/ingestao.js
k6 run -e TARGET_VUS=50 tests/k6/ingestao.js
```

O modo padrão é `ramp`, com 50 VUs e um patamar de 60 segundos. Aumente a concorrência por etapas para observar onde o throughput deixa de crescer e a taxa de erros sobe. Os perfis abaixo são para testes isolados de estresse.

```bash
k6 run -e TARGET_VUS=10000 tests/k6/ingestao.js
k6 run -e MODE=burst -e TARGET_VUS=10000 tests/k6/ingestao.js
k6 run -e MODE=burst -e TARGET_VUS=100 -e HOT_SKU_PCT=90 tests/k6/ingestao.js
```

A rampa mantém clientes virtuais ativos. A rajada tenta disparar uma requisição por VU num horário comum. A rede, o escalonador e a capacidade do gerador determinam a concorrência observada no servidor. `atraso_disparo_ms` mede o desvio de disparo no cliente. `HOT_SKU_PCT` concentra parte das operações no primeiro SKU para exercitar a contenção. `BASE_URL` permite apontar para outra instância de teste. `PACE_MS` ajusta a pausa média por VU na rampa e começa em 500 ms.

Os limiares iniciais são p95 < 500 ms, p99 < 1 s e erro < 1%. Na rampa eles valem no patamar. Cada POST usa um UUID novo. O k6 espera `201` e conta `503` como falha.

Durante o teste, consulte a última janela de aproximadamente 10 segundos do Rust.

```bash
curl -fsS http://127.0.0.1:9091/internal/metrics
```

O relatório inclui RPS, p95 aproximado e conexões MySQL ocupadas. O pico de requisições em andamento acumula desde que o Rust subiu. Reinicie o processo entre perfis quando precisar comparar picos independentes.
