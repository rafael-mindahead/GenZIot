import {Elysia} from "elysia";
import {db} from "./db";
import {produtos} from "./modulos/produtos/routes";

await db`SELECT id FROM produtos LIMIT 0`;

new Elysia({serve: {hostname: "127.0.0.1"}})
.use(produtos)
.listen(3001)

console.log("catalogo disponivel em http://127.0.0.1:3001")
