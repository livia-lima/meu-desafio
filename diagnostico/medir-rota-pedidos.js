const express = require('express');
const pg = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');
const { once } = require('node:events');
const { performance: relogio } = require('node:perf_hooks');

const medicaoPorRequisicao = new AsyncLocalStorage();
const ClientOriginal = pg.Client;

// O db.js captura este Client ao carregar neste processo.
pg.Client = class ClientMedido extends ClientOriginal {
  constructor(config) {
    const inicio = relogio.now();
    super(config);
    this.criacaoMs = relogio.now() - inicio;
  }

  async connect() {
    const inicio = relogio.now();
    await super.connect();
    this.conexaoMs = relogio.now() - inicio;
  }

  async query(sql, parametros) {
    const inicio = relogio.now();
    const resultado = await super.query(sql, parametros);
    this.consultaMs = relogio.now() - inicio;
    return resultado;
  }

  async end() {
    const inicio = relogio.now();
    await super.end();
    const encerramentoMs = relogio.now() - inicio;
    const medicao = medicaoPorRequisicao.getStore();

    if (medicao && this.consultaMs !== undefined) {
      medicao.chamadas += 1;
      medicao.conexoesMs += this.criacaoMs + this.conexaoMs + encerramentoMs;
      medicao.consultasMs += this.consultaMs;
    }
  }
};

const rotas = require('./src/rotas');
pg.Client = ClientOriginal;

async function main() {
  const id = Number(process.argv[2]);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('Informe o ID de um cliente existente.');
  }

  const app = express();
  let resultadoDaRota;

  app.use((req, res, next) => {
    const inicio = relogio.now();
    const medicao = { chamadas: 0, conexoesMs: 0, consultasMs: 0 };
    const enviarJson = res.json.bind(res);

    res.json = (corpo) => {
      const rotaMs = relogio.now() - inicio;
      resultadoDaRota = { ...medicao, rotaMs };
      return enviarJson(corpo);
    };

    medicaoPorRequisicao.run(medicao, next);
  });

  app.use(rotas);

  const servidor = app.listen(0, '127.0.0.1');
  try {
    await once(servidor, 'listening');
    const { port } = servidor.address();
    const resposta = await fetch(`http://127.0.0.1:${port}/clientes/${id}/pedidos`);

    if (!resposta.ok) {
      await resposta.text();
      throw new Error(`A rota retornou HTTP ${resposta.status}.`);
    }

    const pedidos = await resposta.json();
    const itens = pedidos.reduce((soma, pedido) => soma + pedido.itens.length, 0);
    if (!resultadoDaRota || resultadoDaRota.chamadas !== 2 + pedidos.length + itens) {
      throw new Error('A contagem de consultas divergiu da resposta da rota.');
    }

    const { chamadas, conexoesMs, consultasMs, rotaMs } = resultadoDaRota;
    console.log('cliente_id,chamadas,conexoes_ms,consultas_ms,rota_ms');
    console.log([id, chamadas, conexoesMs, consultasMs, rotaMs].join(','));
  } finally {
    servidor.close();
  }
}

main().catch((erro) => {
  console.error(erro.message);
  process.exitCode = 1;
});