import { sleep } from 'k6';
import crypto from 'k6/crypto';
import exec from 'k6/execution';
import http from 'k6/http';
import { Trend } from 'k6/metrics';

function integerEnv(name, fallback, min, max) {
  const value = Number(__ENV[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} deve ser inteiro entre ${min} e ${max}`);
  }
  return value;
}

const baseUrl = (__ENV.BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const targetVus = integerEnv('TARGET_VUS', 50, 1, 10000);
const skuCount = integerEnv('SKU_COUNT', 1000, 1, 1000);
const hotSkuPercent = integerEnv('HOT_SKU_PCT', 0, 0, 100);
const paceMs = integerEnv('PACE_MS', 500, 0, 60000);
const burstDelayMs = integerEnv('BURST_DELAY_MS', 10000, 1000, 60000);
const mode = __ENV.MODE || 'ramp';
if (mode !== 'ramp' && mode !== 'burst') {
  throw new Error('MODE deve ser ramp ou burst');
}
const burst = mode === 'burst';
const aquecimentoMs = 20_000;
const subidaMs = 40_000;
const patamarMs = 60_000;
const picoInicioMs = aquecimentoMs + subidaMs;
const picoFimMs = picoInicioMs + patamarMs;

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    ingestao: burst
      ? {
          executor: 'per-vu-iterations',
          vus: targetVus,
          iterations: 1,
          maxDuration: '2m',
          gracefulStop: '5s',
        }
      : {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: `${aquecimentoMs}ms`, target: Math.ceil(targetVus * 0.05) },
            { duration: `${subidaMs}ms`, target: targetVus },
            { duration: `${patamarMs}ms`, target: targetVus },
            { duration: '20s', target: 0 },
          ],
          gracefulRampDown: '5s',
          gracefulStop: '5s',
        },
  },
  // Critérios iniciais. Uma resposta 503 sob saturação conta como falha.
  thresholds: burst
    ? {
        http_reqs: [`count>=${targetVus}`],
        http_req_failed: ['rate<0.01'],
        http_req_duration: ['p(95)<500', 'p(99)<1000'],
      }
    : {
        'http_reqs{fase:pico}': ['count>0'],
        'http_req_failed{fase:pico}': ['rate<0.01'],
        'http_req_duration{fase:pico}': ['p(95)<500', 'p(99)<1000'],
      },
};

const accepted = http.expectedStatuses(201);
const dispatchDelay = new Trend('atraso_disparo_ms', true);
const hex = '0123456789abcdef';

function uuidV4() {
  const bytes = new Uint8Array(crypto.randomBytes(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let encoded = '';
  for (const byte of bytes) encoded += hex[byte >> 4] + hex[byte & 0x0f];
  return `${encoded.slice(0, 8)}-${encoded.slice(8, 12)}-${encoded.slice(12, 16)}-${encoded.slice(16, 20)}-${encoded.slice(20)}`;
}

export function setup() {
  return { releaseAt: burst ? Date.now() + burstDelayMs : 0 };
}

export default function (data) {
  const sku = Math.random() * 100 < hotSkuPercent ? 1 : 1 + Math.floor(Math.random() * skuCount);
  const magnitude = 1 + Math.floor(Math.random() * 3);
  const payload = JSON.stringify({
    evento_id: uuidV4(),
    dispositivo_id: exec.vu.idInTest,
    codigo_barras: `7900000${String(sku).padStart(6, '0')}`,
    quantidade_delta: Math.random() < 0.5 ? magnitude : -magnitude,
  });

  // O horário compartilhado aproxima o disparo. O atraso mede o desvio no gerador.
  if (burst) {
    const waitMs = data.releaseAt - Date.now();
    if (waitMs > 0) sleep(waitMs / 1000);
    dispatchDelay.add(Math.max(0, Date.now() - data.releaseAt));
  }

  const elapsedMs = Date.now() - exec.scenario.startTime;
  const phase = !burst && elapsedMs >= picoInicioMs && elapsedMs < picoFimMs ? 'pico' : 'transicao';
  http.post(`${baseUrl}/api/v1/movimentacao`, payload, {
    headers: { 'Content-Type': 'application/json' },
    redirects: 0,
    responseCallback: accepted,
    tags: { name: 'POST /api/v1/movimentacao', fase: burst ? 'rajada' : phase },
    timeout: '4s',
  });

  if (!burst && paceMs > 0) {
    sleep((paceMs * (0.5 + Math.random())) / 1000);
  }
}
