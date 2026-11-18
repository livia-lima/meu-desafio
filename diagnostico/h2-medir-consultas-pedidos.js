// Na raiz: docker compose exec -T -w /app api node - < diagnostico/h2-medir-consultas-pedidos.js
const express = require('express');
const { once } = require('node:events');
const { performance: relogio } = require('node:perf_hooks');
const db = require('./src/db');

const clientes = [7, 99999];
const grupos = ['clientes', 'pedidos', 'itens_pedido', 'produtos'];
const rodadas = 3;
const consultarOriginal = db.consultar;

// O servidor local recebe uma requisição por vez. Cada uma começa com contadores novos.
let medidas;

// rotas.js captura consultar ao ser carregado. O wrapper só existe neste processo.
db.consultar = async function consultarMedido(sql, parametros) {
  const tabela = /\bFROM\s+(\w+)/i.exec(sql)?.[1].toLowerCase();
  if (!grupos.includes(tabela)) {
    throw new Error(`Consulta fora dos quatro grupos da rota: ${sql}`);
  }

  const inicio = relogio.now();
  const linhas = await consultarOriginal(sql, parametros);
  const duracao = relogio.now() - inicio;
  const medida = medidas.get(tabela);
  medida.chamadas += 1;
  medida.tempoMs += duracao;
  medida.linhas += linhas.length;
  return linhas;
};

const rotas = require('./src/rotas');
db.consultar = consultarOriginal;

async function medirRequisicao(urlBase, id, rodada) {
  medidas = new Map(grupos.map(grupo => [grupo, { chamadas: 0, tempoMs: 0, linhas: 0 }]));
  const resposta = await fetch(`${urlBase}/clientes/${id}/pedidos`);
  if (!resposta.ok) {
    throw new Error(`Cliente ${id}: HTTP ${resposta.status}. ${await resposta.text()}`);
  }

  const pedidos = await resposta.json();
  const itens = pedidos.reduce((total, pedido) => total + pedido.itens.length, 0);
  return grupos.map(grupo => {
    const { chamadas, tempoMs, linhas } = medidas.get(grupo);
    return [rodada, id, pedidos.length, itens, grupo, chamadas, tempoMs, linhas].join(',');
  });
}

async function main() {
  const app = express();
  app.use(rotas);
  const servidor = app.listen(0, '127.0.0.1');
  try {
    await once(servidor, 'listening');
    const urlBase = `http://127.0.0.1:${servidor.address().port}`;
    for (const id of clientes) {
      await medirRequisicao(urlBase, id, 0);
    }

    const csv = ['rodada,cliente_id,pedidos,itens,grupo,chamadas,tempo_consultar_ms,linhas_retornadas'];
    for (let rodada = 1; rodada <= rodadas; rodada += 1) {
      for (const id of clientes) {
        csv.push(...await medirRequisicao(urlBase, id, rodada));
      }
    }
    console.log(csv.join('\n'));
  } finally {
    servidor.close();
  }
}

main().catch(erro => {
  console.error(erro.message);
  process.exitCode = 1;
});
