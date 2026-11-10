CREATE TABLE produtos (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    -- Texto ASCII preserva zeros à esquerda e mantém o índice compacto.
    codigo_barras VARCHAR(14) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    nome VARCHAR(160) NOT NULL,
    preco_centavos INT UNSIGNED NOT NULL DEFAULT 0,
    saldo INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uk_produtos_codigo_barras (codigo_barras),
    CONSTRAINT ck_produtos_codigo_barras
        CHECK (CHAR_LENGTH(codigo_barras) IN (8, 12, 13, 14)
               AND codigo_barras NOT REGEXP '[^0-9]')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE movimentacoes_estoque (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    evento_id BINARY(16) NOT NULL,
    produto_id INT UNSIGNED NOT NULL,
    dispositivo_id INT UNSIGNED NOT NULL,
    quantidade_delta SMALLINT NOT NULL,
    recebido_em DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    -- O UUID único impede que um reenvio registre o mesmo evento duas vezes.
    UNIQUE KEY uk_movimentacoes_evento_id (evento_id),
    KEY ix_movimentacoes_produto_data (produto_id, recebido_em),
    CONSTRAINT fk_movimentacoes_produto
        FOREIGN KEY (produto_id) REFERENCES produtos (id),
    CONSTRAINT ck_movimentacoes_dispositivo CHECK (dispositivo_id > 0),
    CONSTRAINT ck_movimentacoes_delta
        CHECK (quantidade_delta BETWEEN -1000 AND 1000 AND quantidade_delta <> 0)
) ENGINE=InnoDB;
