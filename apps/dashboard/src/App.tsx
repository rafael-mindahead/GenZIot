import { useEffect, useState } from "react";

type Metricas = {
  rps: number;
  latencia_p95_ms: number | null;
  conexoes_ativas: number;
};

const formatar = new Intl.NumberFormat("pt-BR", {
  maximumFractionDigits: 2,
});

export default function App() {
  const [metricas, setMetricas] = useState<Metricas | null>(null);
  const [erro, setErro] = useState(false);

  useEffect(() => {
  const controller = new AbortController();
  let timer: number | undefined;

  async function carregarMetricas() {
    try {
      const resposta = await fetch("/api/v1/metricas/ingestao", {
        signal: controller.signal,
      });

      if (!resposta.ok) {
        throw new Error(`HTTP ${resposta.status}`);
      }

      const dados: Metricas = await resposta.json();
      if (controller.signal.aborted) return;

      setMetricas(dados);
      setErro(false);
    } catch {
      if (controller.signal.aborted) return;

      setMetricas(null);
      setErro(true);
    } finally {
      if (!controller.signal.aborted) {
        timer = window.setTimeout(() => void carregarMetricas(), 3_000);
      }
    }
  }

  void carregarMetricas();

  return () => {
    controller.abort();
    window.clearTimeout(timer);
  };
}, []);

  return (
    <main>
      <h1>Métricas de ingestão</h1>

      {erro && <p role="alert">Métricas indisponíveis. Recarregue Tentando reconectar</p>}
      {!erro && !metricas && <p role="status">Carregando métricas…</p>}

      {metricas && (
        <dl>
          <dt>Requisições por segundo</dt>
          <dd>{formatar.format(metricas.rps)}</dd>

          <dt>Latência p95</dt>
          <dd>
            {metricas.latencia_p95_ms === null
              ? "Sem amostras"
              : `${formatar.format(metricas.latencia_p95_ms)} ms`}
          </dd>

          <dt>Conexões ativas do pool MySQL</dt>
          <dd>{metricas.conexoes_ativas}</dd>
        </dl>
      )}
    </main>
  );
}