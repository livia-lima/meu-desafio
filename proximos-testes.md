## 1. Reescrever as consultas mais demoradas

**Status:** Pesquisada, teste futuro.

**Origem da proposta:** O diagnóstico identificou consultas de pedidos e relatórios em andamento enquanto buscas por ID aguardavam uma conexão. Segundo a [documentação do PostgreSQL sobre EXPLAIN](https://www.postgresql.org/docs/16/using-explain.html), os planos permitem examinar operações de leitura, junção, ordenação e agregação. Com `EXPLAIN ANALYZE`, também são obtidos tempos e quantidades observados durante a execução.

**Hipótese:** Reescrever uma consulta para reduzir o trabalho realizado pelo banco deve diminuir o p95 da rota correspondente. A liberação antecipada das conexões também pode reduzir a espera de outras rotas.

**Ganho esperado:** Menor latência e maior vazão com os mesmos limites de recursos. A CPU média deverá ser interpretada juntamente com a vazão, pois o banco pode continuar ocupado enquanto atende mais requisições.

**Como testar:** Examinar as consultas de `top-produtos`, `pedidos-por-status`, `vendas-por-dia` e `pedidos-do-cliente`, começando por uma delas. Salvar os planos e identificar uma operação que justifique uma reescrita. Alterar somente essa consulta e executar o ciclo oficial de validação e medição. Comparar a rota alterada, os resultados gerais e a espera por conexões.

**Pré-requisitos e custos:** Aprender a interpretar os planos e preservar campos, valores e ordem das respostas. Um plano diferente ou uma consulta mais curta não garantem menor custo.

**Evidência contrária à hipótese:** A reescrita não reduzir a latência sob carga ou introduzir regressões que inviabilizem sua adoção. Se a consulta melhorar, mas a espera no pool permanecer, seu custo não será suficiente para explicar a fila observada.

## 2. Avaliar índices conforme os planos

**Status:** Pesquisada, teste futuro.

**Origem da proposta:** A [documentação do PostgreSQL sobre índices](https://www.postgresql.org/docs/16/indexes.html) explica que eles podem acelerar a recuperação de linhas, mas acrescentam custos ao banco.

**Hipótese:** Um índice compatível com os filtros, junções ou ordenações de uma consulta pode reduzir seu trabalho e o p95 da rota correspondente.

**Ganho esperado:** Menor tempo de consulta e menor ocupação das conexões.

**Como testar:** Conferir os índices existentes e os planos antes de propor um novo índice. Escolher um candidato fundamentado nas operações observadas e aplicá-lo separadamente de qualquer reescrita. Comparar os planos e executar as medições oficiais antes e depois.

**Pré-requisitos e custos:** Registrar a mudança em um arquivo SQL novo e seguir o procedimento de recriação do banco descrito no README. Considerar espaço de armazenamento, tempo de criação e manutenção em operações de escrita. O benefício para escritas não será avaliado pela carga atual.

**Evidência contrária à hipótese:** O índice não melhorar o atendimento sob carga ou apresentar custo incompatível com o benefício. Sua utilização pelo plano, isoladamente, não comprovará ganho.

## 3. Avaliar cache temporário de resultados

**Status:** Pesquisada, teste futuro.

**Origem da proposta:** O [padrão cache-aside da Microsoft](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside) descreve a reutilização de dados armazenados em cache e a necessidade de controlar sua atualização.

**Hipótese:** Armazenar temporariamente resultados consultados repetidamente pode reduzir o trabalho do banco, desde que exista reutilização suficiente e sejam preservadas as respostas exigidas.

**Ganho esperado:** Menos consultas ao PostgreSQL e menor latência para resultados encontrados no cache.

**Como testar:** Primeiro, verificar a repetição dos mesmos parâmetros na carga existente. Escolher uma rota com reutilização demonstrável e definir chave, limite de armazenamento, expiração e invalidação. Comparar cache vazio, cache aquecido e expiração, sem alterar a carga oficial para favorecer acertos. Registrar acertos e faltas como diagnóstico e avaliar os resultados oficiais.

**Pré-requisitos e custos:** Definir como evitar respostas desatualizadas. Um prazo de expiração, sozinho, não garante essa preservação. Considerar a memória consumida e, caso seja necessário outro serviço, seus custos de operação e recursos.

**Evidência contrária à hipótese:** Baixa reutilização, respostas desatualizadas, ausência de ganho ou aumento de consumo incompatível com o benefício.

## 4. Avaliar o PgBouncer entre a API e o banco

**Status:** Pesquisada, teste futuro.

**Origem da proposta:** No modo por transação, o PgBouncer pode devolver uma conexão do banco ao conjunto disponível assim que a transação termina, mesmo que a aplicação continue conectada ao PgBouncer ([documentação oficial](https://www.pgbouncer.org/features.html)).

**Hipótese:** Se houver intervalos suficientes entre as consultas, o PgBouncer poderá atender a mesma carga com menos conexões abertas no PostgreSQL.

**Ganho esperado:** Reduzir o número de conexões mantidas pelo banco, preservando a vazão e o p95 da busca por cliente pelo identificador.

**Como testar:** Comparar a versão final com uma cópia em que a API se conecta ao banco pelo PgBouncer. Manter o limite de dez conexões na API e o mesmo teto de dez conexões ao banco para o usuário e a base do teste. Verificar o contrato e fazer três rodadas por configuração com os mesmos parâmetros. Contar as conexões abertas no PostgreSQL durante a carga e comparar as medianas de vazão, p95 e erros. Registrar CPU e memória de cada serviço, incluindo o PgBouncer.

**Pré-requisitos e custos:** Configurar o novo serviço no Docker Compose e verificar se a API depende de configurações que precisam permanecer na mesma conexão entre transações. O serviço acrescenta consumo de recursos e trabalho de manutenção.

**Evidência contrária à hipótese:** Se as dez conexões continuarem ocupadas durante a carga, haverá pouca oportunidade de compartilhamento. Se a fila apenas passar da API para o PgBouncer e a busca por ID continuar lenta, o serviço adicional não terá resolvido a espera observada.
