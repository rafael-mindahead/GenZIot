import {Elysia} from "elysia";

const urlMetricasRust = "http://127.0.0.1:9091/internal/metrics";

export const metricas = new Elysia({name: "metricas"}).get(
    "/api/v1/metricas/ingestao",
    async ({set, status}) => {
        set.headers["cache-control"] = "no-store";

        try {
            const resposta = await fetch(urlMetricasRust,{
                signal: AbortSignal.timeout(1000),
            });
            if (!resposta.ok){
                return status(502, {erro: "falha_ao_obter_metricas"});
            }
            return await resposta.json();
        } catch (erro){
            console.error("Falha ao consultar métricas do Rust", erro);
            return status(503, {erro: "metricas_de_ingestao_indisponiveis"});
        }
    },
);