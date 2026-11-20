const { Pool } = require('pg');
const { performance: cronometro } = require('node:perf_hooks');

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'loja',
  database: process.env.DB_NAME || 'loja',
};

// No comando `node - 7 1`, os argumentos são o ID e o número da rodada.
const clienteId = Number(process.argv[2] || 7);
const rodada = Number(process.argv[3] || 1);
const quantidadeDeCiclos = 5;
const amostras = [];

const pool = new Pool(config);

pool.on('error', (erro) => {
  console.error('Erro em conexão ociosa do PostgreSQL:', erro);
});

async function consultar(sql, parametros = []) {
  const t0 = cronometro.now();
  const cliente = await pool.connect();
  const t1 = cronometro.now();

  const t2 = cronometro.now();
  let resultado;
  let t3;
  let t4;
  let t5;

  try {
    resultado = await cliente.query(sql, parametros);
    t3 = cronometro.now();
  } finally {
    t4 = cronometro.now();
    cliente.release();
    t5 = cronometro.now();
  }

  // Guardamos os tempos na memória e imprimimos depois das cinco consultas.
  amostras.push([t1 - t0, t3 - t2, t5 - t4, t5 - t0]);

  return resultado.rows;
}

async function main() {
  try {
    if (!Number.isSafeInteger(clienteId) || clienteId <= 0) {
      throw new Error('O ID do cliente deve ser um inteiro positivo.');
    }

    if (!Number.isSafeInteger(rodada) || rodada <= 0) {
      throw new Error('A rodada deve ser um inteiro positivo.');
    }

    for (let ciclo = 0; ciclo < quantidadeDeCiclos; ciclo += 1) {
      const linhas = await consultar(
        'SELECT * FROM clientes WHERE id = $1',
        [clienteId],
      );

      if (linhas.length !== 1 || linhas[0].id !== clienteId) {
        throw new Error(`A consulta deveria devolver o cliente de ID ${clienteId}.`);
      }
    }

    console.log('rodada,amostra,cliente_id,aquisicao_ms,consulta_ms,liberacao_ms,total_ms');
    for (const [indice, tempos] of amostras.entries()) {
      console.log([rodada, indice + 1, clienteId, ...tempos].join(','));
    }
  } finally {
    await pool.end();
  }
}

main().catch((erro) => {
  console.error(erro);
  process.exitCode = 1;
});
