import { Elysia, t } from "elysia";
import { db } from "../../db";

type Produto = {
  id: number;
  codigo_barras: string;
  nome: string;
  preco_centavos: number;
  saldo: number;
};

export const produtos = new Elysia({ name: "produtos" }).get(
  "/api/v1/produtos",
  async ({ query, status }) => {
    const cursor = Number(query.cursor ?? "0");
    const limite = Number(query.limite ?? "20");

    if (cursor > 4_294_967_295 || limite < 1 || limite > 100) {
      return status(422, { erro: "paginacao_invalida" });
    }

    // A linha extra indica se ainda existe uma próxima página.
    const linhas = await db<Produto[]>`
      SELECT id, codigo_barras, nome, preco_centavos, saldo
      FROM produtos
      WHERE id > ${cursor}
      ORDER BY id
      LIMIT ${limite + 1}
    `;

    const itens = linhas.slice(0, limite);
    const proximoCursor =
      linhas.length > limite ? (itens.at(-1)?.id ?? null) : null;

    return { itens, proximo_cursor: proximoCursor };
  },
  {
    query: t.Object({
      cursor: t.Optional(t.String({ pattern: "^[0-9]{1,10}$" })),
      limite: t.Optional(t.String({ pattern: "^[0-9]{1,3}$" })),
    }),
  },
);