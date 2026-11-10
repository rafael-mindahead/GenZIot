import { sleep } from 'k6';
import crypto from 'k6/crypto';
import exec from 'k6/execution';
import http from 'k6/http';
import {  Counter,Trend } from 'k6/metrics';


const falhas503 = new Counter('falhas_http_503');
const falhas503PorCausa = new Map([
  ['admissao', new Counter('falhas_503_admissao')],
  ['pool_timeout', new Counter('falhas_503_pool_timeout')],
  ['pool_fechado', new Counter('falhas_503_pool_fechado')],
  ['lock_timeout', new Counter('falhas_503_lock_timeout')],
  ['deadlock', new Counter('falhas_503_deadlock')],
]);
const falhas503SemCausa = new Counter('falhas_503_sem_causa');
const falhasTransporte = new Counter('falhas_transporte');
const falhasOutrosHttp = new Counter('falhas_outros_http');

function inteiroEnv(nome, padrao, minimo, maximo) {
  const valor = Number(__ENV[nome] ?? padrao);
  if (!Number.isSafeInteger(valor) || valor < minimo || valor > maximo) {
    throw new Error(`${nome} deve ser inteiro entre ${minimo} e ${maximo}`);
  }
  return valor;
}

const baseUrl = (__ENV.BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const totalVus = inteiroEnv('TARGET_VUS', 50, 1, 10000);
const totalSkus = inteiroEnv('SKU_COUNT', 1000, 1, 1000);
const skuQuentePct = inteiroEnv('HOT_SKU_PCT', 0, 0, 100);
const pausaMs = inteiroEnv('PACE_MS', 500, 0, 60000);
const esperaRajadaMs = inteiroEnv('BURST_DELAY_MS', 10000, 1000, 60000);

const modo = __ENV.MODE || 'ramp';
if (modo !== 'ramp' && modo !== 'burst') {
  throw new Error('MODE deve ser ramp ou burst');
}

const rajada = modo === 'burst';
const aquecimentoMs = 20_000;
const subidaMs = 40_000;
const patamarMs = 60_000;
const inicioPicoMs = aquecimentoMs + subidaMs;
const fimPicoMs = inicioPicoMs + patamarMs;

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    ingestao: rajada
      ? {
          executor: 'per-vu-iterations',
          vus: totalVus,
          iterations: 1,
          maxDuration: '2m',
          gracefulStop: '5s',
        }
      : {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: `${aquecimentoMs}ms`, target: Math.ceil(totalVus * 0.05) },
            { duration: `${subidaMs}ms`, target: totalVus },
            { duration: `${patamarMs}ms`, target: totalVus },
            { duration: '20s', target: 0 },
          ],
          gracefulRampDown: '5s',
          gracefulStop: '5s',
        },
  },
  thresholds: rajada
    ? {
        http_reqs: [`count>=${totalVus}`],
        http_req_failed: ['rate<0.01'],
        http_req_duration: ['p(95)<500', 'p(99)<1000'],
      }
    : {
        'http_reqs{fase:pico}': ['count>0'],
        'http_req_failed{fase:pico}': ['rate<0.01'],
        'http_req_duration{fase:pico}': ['p(95)<500', 'p(99)<1000'],
      },
};

const statusEsperado = http.expectedStatuses(201);
const atrasoDisparo = new Trend('atraso_disparo_ms', true);
const hex = '0123456789abcdef';

function uuidV4() {
  const bytes = new Uint8Array(crypto.randomBytes(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let texto = '';
  for (const byte of bytes) {
    texto += hex[byte >> 4] + hex[byte & 0x0f];
  }

  return [
    texto.slice(0, 8),
    texto.slice(8, 12),
    texto.slice(12, 16),
    texto.slice(16, 20),
    texto.slice(20),
  ].join('-');
}

export function setup() {
  return { dispararEm: rajada ? Date.now() + esperaRajadaMs : 0 };
}

export default function ({ dispararEm }) {
  const sku = Math.random() * 100 < skuQuentePct
    ? 1
    : 1 + Math.floor(Math.random() * totalSkus);

  const quantidade = 1 + Math.floor(Math.random() * 3);
  const payload = JSON.stringify({
    evento_id: uuidV4(),
    dispositivo_id: exec.vu.idInTest,
    codigo_barras: `7900000${String(sku).padStart(6, '0')}`,
    quantidade_delta: Math.random() < 0.5 ? quantidade : -quantidade,
  });

  if (rajada) {
    const esperaMs = dispararEm - Date.now();
    if (esperaMs > 0) sleep(esperaMs / 1000);
    atrasoDisparo.add(Math.max(0, Date.now() - dispararEm));
  }

  const decorridoMs = Date.now() - exec.scenario.startTime;
  const noPico = decorridoMs >= inicioPicoMs && decorridoMs < fimPicoMs;
  const fase = rajada ? 'rajada' : noPico ? 'pico' : 'transicao';

  const resposta = http.post(`${baseUrl}/api/v1/movimentacao`, payload, {
    headers: { 'Content-Type': 'application/json' },
    redirects: 0,
    responseCallback: statusEsperado,
    tags: { name: 'POST /api/v1/movimentacao', fase },
    timeout: '4s',
  });
  if (!rajada && pausaMs > 0) {
    if (resposta.status === 503) {
        falhas503.add(1);
        const causa = Object.entries(resposta.headers)
        .find(([nome]) => nome.toLowerCase() === 'x-genziot-503-cause')?.[1];
        const contador = falhas503PorCausa.get(causa) ?? falhas503SemCausa;
        contador.add(1);
    } else if (resposta.status === 0) {
        falhasTransporte.add(1);
    } else if (resposta.status !== 201) {
        falhasOutrosHttp.add(1);
    }   
    sleep((pausaMs * (0.5 + Math.random())) / 1000);
  }
}