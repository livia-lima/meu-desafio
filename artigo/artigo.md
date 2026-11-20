# Reutilizar conexões e reunir consultas ao banco reduziu o p95 da API e aumentou o número de requisições atendidas por segundo

## 1. Resumo

A API da loja demorava a responder a pedidos simultâneos. Ela abria uma conexão com o banco a cada consulta e buscava separadamente os itens e produtos de cada pedido. A aplicação passou a reutilizar conexões e a buscar esses dados em conjunto. Nos três testes por versão, o tempo em que 95% das requisições recebiam resposta (p95) caiu, na mediana, de 43.626,3 para 17.214,4 ms. A API passou de 1,55 para 2,61 requisições por segundo. A busca por cliente pelo identificador ficou mais lenta enquanto aguardava uma conexão disponível, e o uso de CPU do banco permaneceu elevado. [Medições](../experimentos.md)

## 2. Contexto e diagnóstico

Na versão original, buscar um cliente pelo identificador era mais rápido do que listar seus pedidos ([linha de base](../resultados/20261117-102533-00-linha-de-base-controlada/resumo.txt)). Para descobrir onde a aplicação perdia tempo, cada operação foi dividida em etapas, conforme o *Time Division Method* ([Gregg, 2025](https://www.brendangregg.com/methodology.html)). A duração de cada etapa foi medida com `performance.now()` ([Node.js](https://nodejs.org/download/release/v20.18.0/docs/api/perf_hooks.html#performancenow)).

A aplicação abria e encerrava uma conexão a cada consulta. Com `SELECT 1`, que apenas devolve o número 1, essas duas etapas consumiram a maior parte do tempo ([diagnóstico isolado](<../diagnostico/h1-medir-conexao-consultar() - Página1.csv>)). A hipótese **H1** foi que reutilizar conexões reduziria o tempo de resposta. Com essas conexões reunidas em um conjunto compartilhado (*pool*), **H2** avaliou se ampliar o conjunto reduziria o p95 geral e se delegar à biblioteca a retirada e a devolução das conexões preservaria o desempenho ([experimentos](../experimentos.md)).

Na busca de pedidos, predominou a espera pelos dados ([medição da rota](<../diagnostico/h1-medicao-rota-pedidos - Página1.csv>)). A aplicação buscava os itens de cada pedido e, depois, o produto de cada item. Para dois clientes, isso exigiu 17 e 27 consultas ([contagem das chamadas](../diagnostico/h2-antes-join.csv)). A hipótese **H3** foi que reunir esses dados em uma consulta com `JOIN` reduziria o p95 da rota.

Após a adoção do pool, a busca por identificador ficou mais lenta. Na versão final, ela aguardava uma conexão enquanto consultas de pedidos e relatórios permaneciam em andamento, sustentando **H4** ([diagnóstico sob carga](../experimentos.md#ocupação-do-pool-e-atividade-do-banco)). O banco já apresentava uso elevado de CPU ([medição inicial](../resultados/20261117-102533-00-linha-de-base-controlada/recursos.txt)). Investigar quais consultas mais contribuíam para esse consumo ficou como teste futuro (**H5**).

## 3. Estado da arte

### 3.1 Reutilização e dimensionamento de conexões

Quando a aplicação abre uma conexão, o PostgreSQL cria um processo para atendê-la ([PostgreSQL, seção 52.2](https://www.postgresql.org/docs/16/connect-estab.html)). Antes da primeira consulta, a aplicação e o banco trocam mensagens para identificar o usuário, verificar o acesso e iniciar a sessão ([PostgreSQL, seção 55.2.1](https://www.postgresql.org/docs/16/protocol-flow.html#PROTOCOL-FLOW-START-UP)).

Manter um conjunto de conexões abertas, chamado *pool*, permite reutilizá-las sem repetir essas etapas a cada consulta ([node-postgres](https://node-postgres.com/features/pooling)). Se todas as conexões estiverem em uso e o conjunto atingir seu limite, a próxima solicitação aguardará uma liberação ([node-postgres, API do pool](https://node-postgres.com/apis/pool#poolconnect)). Nos testes de Moreira, o efeito de aumentar esse limite variou conforme a carga e a configuração do banco ([Moreira, 2026, seção 5.8](https://repositorio.ufu.br/handle/123456789/49993)). Por isso, o tamanho do pool precisa ser avaliado nas condições da aplicação.

### 3.2 Redução de consultas repetidas

Buscar os pedidos de um cliente e depois fazer uma nova consulta para cada pedido é um exemplo do problema *N+1*: uma busca inicial gera tantas consultas adicionais quantos forem os pedidos encontrados ([Sentry](https://docs.sentry.io/product/issues/issue-details/performance-issues/n-one-queries/)). Uma alternativa é usar `JOIN`, operação que combina dados de tabelas relacionadas na mesma consulta ([PostgreSQL, seção 7.2](https://www.postgresql.org/docs/16/queries-table-expressions.html#QUERIES-JOIN)).

Também é preciso avaliar quanto trabalho essa consulta exige. Na OpenAI, uma consulta com várias junções consumiu CPU suficiente para prejudicar outras requisições ([Zhang, 2026](https://openai.com/index/scaling-postgresql/)). No PostgreSQL, `EXPLAIN ANALYZE` permite examinar esse trabalho ao mostrar quantas linhas cada etapa processou e quanto tempo levou ([PostgreSQL, seção 14.1](https://www.postgresql.org/docs/16/using-explain.html)).

### 3.3 Cache de resultados

Um cache guarda temporariamente o resultado de uma busca para atender pedidos iguais sem consultar o banco novamente. O benefício depende de o mesmo resultado ser solicitado enquanto ainda estiver armazenado e atualizado ([Microsoft](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside)).

No caso da OpenAI, quando vários pedidos simultâneos procuram o mesmo dado ausente do cache, apenas um deles consulta o banco e os demais aguardam o resultado ([Zhang, 2026](https://openai.com/index/scaling-postgresql/)). Para a API da loja, a primeira questão seria verificar com que frequência um mesmo relatório é solicitado antes que os dados de vendas mudem.

## 4. Alternativas consideradas

Foram comparadas quatro alternativas. As duas primeiras permitem reutilizar conexões com o banco. A terceira reduz o número de consultas necessárias para montar uma resposta. A quarta permite reaproveitar a própria resposta quando a mesma busca se repete. O esforço indicado na tabela é uma estimativa para esta API e considera as alterações no código, os testes e a manutenção de cada solução.

| Alternativa | Custo | Desempenho esperado | Risco | Esforço |
|---|---|---|---|---|
| Reutilizar conexões na aplicação (`pg.Pool`) | Mantém conexões abertas e aproveita a biblioteca `pg`, já usada pela API. | Evita abrir uma conexão a cada consulta ([node-postgres](https://node-postgres.com/features/pooling)). | Quando todas as conexões do pool estão em uso e o limite foi atingido, a próxima solicitação espera ([node-postgres, API do pool](https://node-postgres.com/apis/pool#poolconnect)). | Baixo. A alteração se concentra na função `consultar()`. |
| Gerenciar conexões em um serviço separado (PgBouncer) | Acrescenta um serviço para executar e manter. | No modo por transação, a conexão volta a ficar disponível para outro cliente ao término de cada transação ([PgBouncer](https://www.pgbouncer.org/features.html)). | Nesse modo, a aplicação pode receber outra conexão na transação seguinte, o que limita o uso de configurações que dependem da mesma sessão ([PgBouncer](https://www.pgbouncer.org/features.html)). | Médio. Exige integrar o serviço e verificar a compatibilidade com a API. |
| Buscar dados relacionados em uma consulta (`JOIN`) | O banco combina as tabelas e a API agrupa as linhas para montar a resposta. | Evita uma nova consulta para cada pedido ou item encontrado ([Sentry](https://docs.sentry.io/product/issues/issue-details/performance-issues/n-one-queries/)). | A escolha da junção pode excluir pedidos sem itens. Um `LEFT JOIN` permite preservá-los ([PostgreSQL, seção 7.2](https://www.postgresql.org/docs/16/queries-table-expressions.html#QUERIES-JOIN)). | Médio. Exige reescrever a consulta e conferir os campos, os valores e a ordem da resposta. |
| Guardar resultados temporariamente (cache) | Consome memória para armazenar respostas. | Uma busca repetida pode ser atendida sem consultar o banco ([Microsoft](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside)). | O resultado armazenado pode ficar desatualizado quando os dados mudam ([Microsoft](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside)). | Médio. Exige identificar buscas equivalentes e definir quando atualizar ou descartar cada resposta. |

O limite de conexões foi tratado como uma escolha experimental porque o efeito de aumentá-lo variou conforme a carga e a configuração nos testes de Moreira ([Moreira, 2026, seção 5.8](https://repositorio.ufu.br/handle/123456789/49993)). Para o cache, a decisão depende de uma informação ainda não medida: com que frequência o mesmo relatório é solicitado enquanto seu resultado continua válido. Essa investigação ficou para os testes futuros.

## 5. Solução escolhida e por quê

A API passou a reutilizar conexões com o banco por meio do `pg.Pool`, recurso da biblioteca que a aplicação já usava ([node-postgres](https://node-postgres.com/apis/pool)). O PgBouncer exigiria manter outro serviço. O cache ficou para um teste futuro porque ainda falta verificar com que frequência um mesmo relatório é solicitado enquanto seus dados continuam válidos.

Os testes orientaram a escolha do limite de dez conexões, com a aplicação devolvendo cada conexão após a consulta. Ao elevar o limite para vinte, a API atendeu menos requisições por segundo e houve falhas. Em outro teste, `pool.query()` deixou a biblioteca cuidar da retirada e da devolução das conexões. A API também atendeu menos requisições por segundo, e o p95 geral aumentou ([experimentos](../experimentos.md)).

Na busca de pedidos por cliente, o primeiro JOIN reuniu pedidos e itens. O segundo incluiu os produtos, eliminando uma consulta por item. Essa última mudança foi mantida porque reduziu o p95 da rota, objetivo do teste. Em relação à etapa anterior, porém, a API atendeu menos requisições por segundo e o tempo mediano de resposta aumentou ([experimentos](../experimentos.md)).

## 6. Experimento e resultado
As medições utilizaram `scripts/medir.sh`, com 20 usuários virtuais, duração de 60 segundos, aquecimento de 15 segundos e semente 42. Cada configuração foi medida três vezes. A tabela apresenta as medianas dos p95 e das vazões das três execuções. Para CPU e memória, apresenta a mediana das médias por contêiner registradas em cada execução, sendo 100% de CPU equivalente a uma CPU inteira. A verificação após cada medição confirmou a manutenção das 42 respostas do contrato.

| Mudança | Hipótese | p95 antes → depois | req/s antes → depois | CPU/memória | Pastas de resultados | Conclusão |
|---|---|---|---|---|---|---|
| **01 — Pooling com dez conexões** | **H1** — Reutilizar conexões deve reduzir a latência e aumentar a vazão. | Geral **43.626,3 → 40.351,4 ms** | **1,55 → 1,90** | CPU da API **6,3% → 6,1%**<br>CPU do banco **99,7% → 100,1%**<br>Memória da API **37,8 → 73,8 MiB**<br>Memória do banco **218,5 → 214,8 MiB** | Antes [1](../resultados/20261117-102533-00-linha-de-base-controlada/), [2](../resultados/20261117-102957-00-linha-de-base-controlada/), [3](../resultados/20261117-103554-00-linha-de-base-controlada/)<br>Depois [1](../resultados/20261116-132408-01-aplicacao-pooling/), [2](../resultados/20261116-132612-01-aplicacao-pooling/), [3](../resultados/20261116-132810-01-aplicacao-pooling/) | Aplicada e medida |
| **02 — Aumento do pool para vinte conexões** | **H2** — Mais conexões disponíveis devem reduzir o p95 geral. | Geral **40.351,4 → 37.296,8 ms** | **1,90 → 1,69** | CPU da API **6,1% → 5,8%**<br>CPU do banco **100,1% → 100,1%**<br>Memória da API **73,8 → 27,2 MiB**<br>Memória do banco **214,8 → 246,1 MiB** | Antes [1](../resultados/20261116-132408-01-aplicacao-pooling/), [2](../resultados/20261116-132612-01-aplicacao-pooling/), [3](../resultados/20261116-132810-01-aplicacao-pooling/)<br>Depois [1](../resultados/20261117-115340-02-pooling-max20/), [2](../resultados/20261117-115620-02-pooling-max20/), [3](../resultados/20261117-115839-02-pooling-max20/) | Aplicada, sem ganho |
| **03 — Uso de `pool.query()`** | **H2** — Delegar aquisição e liberação ao driver deve preservar o contrato e manter o p95 próximo ao da versão 01. | Geral **40.351,4 → 43.895,4 ms** | **1,90 → 1,71** | CPU da API **6,1% → 5,8%**<br>CPU do banco **100,1% → 100,7%**<br>Memória da API **73,8 → 55,2 MiB**<br>Memória do banco **214,8 → 203,5 MiB** | Antes [1](../resultados/20261116-132408-01-aplicacao-pooling/), [2](../resultados/20261116-132612-01-aplicacao-pooling/), [3](../resultados/20261116-132810-01-aplicacao-pooling/)<br>Depois [1](../resultados/20261117-123420-03-pool-query/), [2](../resultados/20261117-123711-03-pool-query/), [3](../resultados/20261117-124156-03-pool-query/) | Aplicada, sem ganho |
| **04 — JOIN entre pedidos e itens** | **H3** — Eliminar uma consulta por pedido deve reduzir o p95 da rota de pedidos por cliente. | Geral **40.351,4 → 23.794,0 ms**<br>Pedidos por cliente **48.664,3 → 31.865,5 ms** | **1,90 → 2,69** | CPU da API **6,1% → 7,7%**<br>CPU do banco **100,1% → 100,1%**<br>Memória da API **73,8 → 72,2 MiB**<br>Memória do banco **214,8 → 222,3 MiB** | Antes [1](../resultados/20261116-132408-01-aplicacao-pooling/), [2](../resultados/20261116-132612-01-aplicacao-pooling/), [3](../resultados/20261116-132810-01-aplicacao-pooling/)<br>Depois [1](../resultados/20261117-221243-04-join-pedidos-itens/), [2](../resultados/20261117-222101-04-join-pedidos-itens/), [3](../resultados/20261117-222352-04-join-pedidos-itens/) | Aplicada e medida |
| **05 — Inclusão de produtos no JOIN** | **H3** — Eliminar a consulta de produto por item deve reduzir novamente o p95 da rota de pedidos por cliente. | Geral **23.794,0 → 17.214,4 ms**<br>Pedidos por cliente **31.865,5 → 18.061,1 ms** | **2,69 → 2,61** | CPU da API **7,7% → 6,5%**<br>CPU do banco **100,1% → 99,8%**<br>Memória da API **72,2 → 29,7 MiB**<br>Memória do banco **222,3 → 231,5 MiB** | Antes [1](../resultados/20261117-221243-04-join-pedidos-itens/), [2](../resultados/20261117-222101-04-join-pedidos-itens/), [3](../resultados/20261117-222352-04-join-pedidos-itens/)<br>Depois [1](../resultados/20261118-140651-05-join-produtos/), [2](../resultados/20261118-140838-05-join-produtos/), [3](../resultados/20261118-141036-05-join-produtos/) | Aplicada e medida |

No experimento 02, a redução do p95 foi acompanhada de menor vazão e timeout na única requisição a `top-produtos` de cada rodada. A mediana da taxa geral de erros passou de 0,00% para 0,76%. No experimento 03, houve 0,73% de erros na terceira rodada. Esses resultados contribuíram para manter a configuração do experimento 01 como referência para as mudanças seguintes.

## 7. Limites e testes futuros

A API passou a reutilizar conexões e a buscar os pedidos de um cliente com menos consultas separadas. A principal limitação foi que, mesmo com essas mudanças, o uso de CPU do banco continuou elevado ([resultados dos experimentos](../experimentos.md)). Na versão final, consultas de pedidos e relatórios ocupavam as conexões por vários segundos. Enquanto isso, a busca de um cliente pelo identificador passava mais tempo esperando uma conexão livre do que consultando os dados ([diagnóstico sob carga](../experimentos.md#ocupação-do-pool-e-atividade-do-banco)). Se essa busca continuar lenta mesmo quando conseguir uma conexão rapidamente, será preciso investigar onde mais o tempo se acumula.

Ainda falta identificar quais consultas mais exigem processamento do banco. O primeiro passo é examinar como ele executa cada consulta. O comando `EXPLAIN ANALYZE` mostra quanto tempo cada etapa levou e quantas linhas processou ([PostgreSQL](https://www.postgresql.org/docs/16/using-explain.html)). A partir dessa análise, será possível testar se vale a pena reescrever a consulta ou criar um índice para localizar os dados. Para relatórios solicitados várias vezes, outra possibilidade é guardar temporariamente o resultado. O ganho esperado e a forma de avaliar cada alternativa estão descritos em [Próximos testes](../proximos-testes.md).

## 8. Referências

1. MICROSOFT. *Cache-Aside pattern*. Azure Architecture Center, s.d. Disponível em [Microsoft Learn](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside). Acesso em 20 nov. 2026.

2. MOREIRA, Jean Souto Galvão. *Connection pooling em PostgreSQL: caracterização empírica do ponto de equilíbrio entre sobrecarga e contenção*. 2026. 63 f. Trabalho de Conclusão de Curso em Ciência da Computação — Universidade Federal de Uberlândia, Uberlândia, 2026. Disponível no [Repositório Institucional da UFU](https://repositorio.ufu.br/handle/123456789/49993). Acesso em 15 nov. 2026.

3. NODE.JS. *Performance measurement APIs*. Documentação do Node.js v20.18.0, s.d. Disponível na [documentação do Node.js](https://nodejs.org/download/release/v20.18.0/docs/api/perf_hooks.html). Acesso em 15 nov. 2026.

4. NODE-POSTGRES. *Connection Pooling*. Documentação do node-postgres, s.d. Disponível na [documentação de pooling](https://node-postgres.com/features/pooling). Acesso em 20 nov. 2026.

5. NODE-POSTGRES. *pg.Pool*. Documentação da API do node-postgres, s.d. Disponível na [documentação de pg.Pool](https://node-postgres.com/apis/pool). Acesso em 20 nov. 2026.

6. PGBOUNCER. *Features*. Documentação do PgBouncer, s.d. Disponível na [documentação de funcionalidades](https://www.pgbouncer.org/features.html). Acesso em 20 nov. 2026.

7. POSTGRESQL GLOBAL DEVELOPMENT GROUP. *How Connections Are Established*. Documentação do PostgreSQL 16, seção 52.2, s.d. Disponível na [documentação de estabelecimento de conexões](https://www.postgresql.org/docs/16/connect-estab.html). Acesso em 20 nov. 2026.

8. POSTGRESQL GLOBAL DEVELOPMENT GROUP. *Message Flow*. Documentação do PostgreSQL 16, seção 55.2, s.d. Disponível na [documentação do fluxo de mensagens](https://www.postgresql.org/docs/16/protocol-flow.html). Acesso em 20 nov. 2026.

9. POSTGRESQL GLOBAL DEVELOPMENT GROUP. *Table Expressions*. Documentação do PostgreSQL 16, seção 7.2, s.d. Disponível na [documentação de expressões de tabela e JOINs](https://www.postgresql.org/docs/16/queries-table-expressions.html). Acesso em 20 nov. 2026.

10. POSTGRESQL GLOBAL DEVELOPMENT GROUP. *Using EXPLAIN*. Documentação do PostgreSQL 16, seção 14.1, s.d. Disponível na [documentação de EXPLAIN](https://www.postgresql.org/docs/16/using-explain.html). Acesso em 13 nov. 2026.

11. SENTRY. *N+1 Queries*. Documentação da Sentry, s.d. Disponível na [documentação sobre consultas N+1](https://docs.sentry.io/product/issues/issue-details/performance-issues/n-one-queries/). Acesso em 17 nov. 2026.

12. ZHANG, Bohan. *Scaling PostgreSQL to power 800 million ChatGPT users*. OpenAI, 22 jan. 2026. Disponível no [relato de engenharia da OpenAI](https://openai.com/index/scaling-postgresql/). Acesso em 15 nov. 2026.

13. GREGG, Brendan. *Performance Analysis Methodology*. Atualizado em 23 jan. 2025. Disponível em [Brendan Gregg](https://www.brendangregg.com/methodology.html). Acesso em 13 nov. 2026.

## 9. Uso de IA

O ChatGPT (modelo GPT-6.1 Sol) apoiou a pesquisa, a discussão das hipóteses e a redação do artigo, além de auxiliar na implementação, nos scripts de diagnóstico, nos commits e na organização dos resultados.  
As citações foram conferidas nas fontes originais, os números foram comparados com as medições do repositório e as respostas da API foram verificadas pelo teste de contrato após cada alteração.