import { SQL } from "bun";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl){
    throw new Error("Defina DATABASE_URL no arquivo .env");
}
const destino = new URL(databaseUrl);
if (destino.protocol !== "mysql:"){
    throw new Error("DATABASE_URL deve usar msyql://");
}

export const db = new SQL(databaseUrl, {
    max: 4,
    connectionTimeout: 5,
    allowPublicKeyRetrieval: ["127.0.0.1", "localhost"].includes(destino.hostname),
});