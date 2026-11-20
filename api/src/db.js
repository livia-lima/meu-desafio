const { Pool } = require('pg');
const { performance: cronometro } = require('node:perf_hooks');

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'loja',
  database: process.env.DB_NAME || 'loja',
  application_name: 'api-diagnostico-cliente-id',
};

const pool = new Pool(config);

pool.on('error', (erro) => {
  console.error('Erro em conexão ociosa do PostgreSQL:', erro);
});

const observadorPool = setInterval(() => {
  console.log(JSON.stringify({
    tipo: 'diagnostico_pool',
    instante: new Date().toISOString(),
    total: pool.totalCount,
    disponiveis: pool.idleCount,
    esperando: pool.waitingCount,
  }));
}, 1000);

observadorPool.unref();

async function consultar(sql, parametros = [], tempos = null) {
  const t0 = cronometro.now();
  const cliente = await pool.connect();
  const t1 = cronometro.now();

  let resultado;
  let t2;
  let t3;
  let t4;
  let t5;

  try {
    t2 = cronometro.now();
    resultado = await cliente.query(sql, parametros);
    t3 = cronometro.now();
  } finally {
    t4 = cronometro.now();
    cliente.release();
    t5 = cronometro.now();
  }

  if (tempos !== null) {
    tempos.aquisicao_ms = t1 - t0;
    tempos.consulta_ms = t3 - t2;
    tempos.liberacao_ms = t5 - t4;
    tempos.consultar_ms = t5 - t0;
  }

  return resultado.rows;
}

module.exports = { consultar };
