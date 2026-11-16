const { Client } = require('pg');
const { performance: relogio } = require('node:perf_hooks');

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'loja',
  database: process.env.DB_NAME || 'loja',
};

const quantidadeDeCiclos = 5;
const amostras = [];

async function consultar(sql, parametros = []) {
  const t0 = relogio.now();
  const cliente = new Client(config);
  const t1 = relogio.now();

  await cliente.connect();
  const t2 = relogio.now();

  let resultado;
  let t3;
  let t4;

  try {
    resultado = await cliente.query(sql, parametros);
    t3 = relogio.now();
  } finally {
    await cliente.end();
    t4 = relogio.now();
  }

  amostras.push([
    t1 - t0, // criação
    t2 - t1, // conexão
    t3 - t2, // consulta
    t4 - t3, // encerramento
    t4 - t0, // ciclo completo
  ]);

  return resultado.rows;
}

async function main() {
  for (let i = 0; i < quantidadeDeCiclos; i += 1) {
    const linhas = await consultar('SELECT 1 AS valor');

    if (linhas.length !== 1 || linhas[0].valor !== 1) {
      throw new Error('A consulta do piloto deveria devolver uma linha com valor 1.');
    }
  }

  console.log('amostra,criacao_ms,conexao_ms,consulta_ms,encerramento_ms,total_ms');
  for (const [indice, tempos] of amostras.entries()) {
    console.log([indice + 1, ...tempos].join(','));
  }
}

main().catch((erro) => {
  console.error(erro);
  process.exitCode = 1;
});