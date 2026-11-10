-- Catálogo sintético usado pelo k6. Reexecutar preserva os saldos existentes.
INSERT INTO produtos (codigo_barras, nome, preco_centavos, saldo)
WITH RECURSIVE catalogo (n) AS (
    SELECT 1
    UNION ALL
    SELECT n + 1 FROM catalogo WHERE n < 1000
)
SELECT CONCAT('7900000', LPAD(n, 6, '0')),
       CONCAT('Produto de carga ', n),
       1000,
       10000000
FROM catalogo
ON DUPLICATE KEY UPDATE saldo = produtos.saldo;
