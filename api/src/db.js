const { Pool } = require('pg');

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'loja',
  database: process.env.DB_NAME || 'loja',
};

const pool = new Pool({ ...config, max: 20});

pool.on('error', (erro) => {
  console.error('Erro em conexão ociosa do PostgreSQL:', erro);
});

async function consultar(sql, parametros = []) {
  const cliente = await pool.connect();

  try {
    const resultado = await cliente.query(sql, parametros);
    return resultado.rows;
  } finally {
    cliente.release();
  }
}

module.exports = { consultar };
