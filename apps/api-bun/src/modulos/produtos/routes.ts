import { Elysia, t } from "elysia";
import { db } from "../../db";
import { SQL } from "bun";

const codigoBarras = t.String({pattern: "^(?:[0-9]{8}|[0-9]{12,14})$",});


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
).get(
   "/api/v1/produtos/:codigo_barras",
  async ({ params, status }) => {
    const [produto] = await db<Produto[]>`
      SELECT id, codigo_barras, nome, preco_centavos, saldo
      FROM produtos
      WHERE codigo_barras = ${params.codigo_barras}
    `;
    if (!produto) {
      return status(404, { erro: "produto_nao_encontrado" });
    }
    return produto;
  },
  {
    params: t.Object({
      codigo_barras: codigoBarras,
    }),
  },
).post(
  "/api/v1/produtos",
  async ({ body, set, status }) => {
    const { codigo_barras, preco_centavos } = body;
    const nome = body.nome.trim();

    if (!nome) {
      return status(422, { erro: "nome_invalido" });
    }
    try {
      const resultado = await db`
        INSERT INTO produtos (codigo_barras, nome, preco_centavos)
        VALUES (${codigo_barras}, ${nome}, ${preco_centavos})
      `;
      set.headers.location = `/api/v1/produtos/${codigo_barras}`;
      return status(201, {
        id: Number(resultado.lastInsertRowid),
        codigo_barras,
        nome,
        preco_centavos,
        saldo: 0,
      });
    } catch (erro) {
      if (erro instanceof SQL.MySQLError && erro.errno === 1062) {
        return status(409, { erro: "codigo_barras_duplicado" });
      }
      throw erro;
    }
  },
  {
    body: t.Object({
      codigo_barras: codigoBarras,
      nome: t.String({ minLength: 1, maxLength: 160 }),
      preco_centavos: t.Integer({ minimum: 0, maximum: 4_294_967_295 }),
    }),
  },
)
.patch(
  "/api/v1/produtos/:id",
  async ({ params, body, status }) => {
    const id = Number(params.id);
    if (id > 4_294_967_295) {
      return status(422, { erro: "id_invalido" });
    }
    const nome = body.nome?.trim();
    const precoCentavos = body.preco_centavos;

    if (nome === "") {
      return status(422, { erro: "nome_invalido" });
    }
    if (nome === undefined && precoCentavos === undefined) {
      return status(422, { erro: "nenhum_campo_para_atualizar" });
    }
    const encontrado = await db.begin(async (tx) => {
      const [produto] = await tx<{ id: number }[]>`
      SELECT id
      FROM produtos
      WHERE id = ${id}
      FOR UPDATE
      `;
      if (!produto) return false;

      await tx`
      UPDATE produtos
      SET nome = COALESCE(${nome ?? null}, nome),
          preco_centavos = COALESCE(${precoCentavos ?? null}, preco_centavos)
      WHERE id = ${id}
      `;
      return true;
    });
    if (!encontrado) {
      return status(404, { erro: "produto_nao_encontrado" });
    }
    return new Response(null, {status: 204});
  },
  {
    params: t.Object({
      id: t.String({pattern: "^[1-9][0-9]{0,9}$" }),
    }),
    body: t.Object({
      nome: t.Optional(t.String({minLength: 1, maxLength: 160})),
      preco_centavos: t.Optional(
        t.Integer({minimum: 0, maximum: 4_294_967_295}),
      ),
    }),
  },
);