SELECT
    statement_timestamp() AS observado_em,
    pid,
    application_name,
    state,
    CASE
        WHEN state = 'active'
        THEN statement_timestamp() - query_start
    END AS duracao_consulta,
    statement_timestamp() - state_change AS tempo_no_estado,
    wait_event_type,
    wait_event,
    query
FROM pg_stat_activity
WHERE datname = current_database()
  AND backend_type = 'client backend'
  AND application_name = 'api-diagnostico-cliente-id'
ORDER BY pid;

\watch interval=1 count=120