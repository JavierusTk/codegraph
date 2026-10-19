---
depends_on:
- codegraph:T-MBEP
effort: medium
id: T-J7AE
origin: sesión 2026-10-19, pregunta del usuario sobre cuándo arranca el daemon
priority: media
proposal: Volver a probar el watcher reescrito de upstream con CODEGRAPH_NO_WATCH=0
  sobre W:\ cuando el sync sea barato; si no vale, sync programado más frecuente
risk: med
scope: CODEGRAPH_NO_WATCH en los wrappers de W:/bin y watcher del motor upstream sobre
  W:\
type: idea
value: med
verification: Un fichero editado aparece en el grafo en minutos (no al día siguiente)
  sin bucles de re-sync en daemon.log ni carga sostenida de CPU
---
# Frescura del índice: con el watcher apagado, un daemon que vive todo el día no refresca el grafo

## Contexto

- Los wrappers `W:/bin/codegraph` y `codegraph.cmd` fijan `CODEGRAPH_NO_WATCH=1` desde los tiempos del fork viejo, porque el watcher recursivo sobre la raíz de disco `W:\` entraba en un bucle de re-sync y bloqueaba el daemon. El motivo está detallado en los comentarios de `W:/bin/codegraph`.
- Sin watcher, el grafo solo se refresca en el catch-up de cada arranque del daemon y en la tarea programada `codegraph-sync` (04:20 → `W:/bin/codegraph-sync.bat`).

## Por qué ahora importa más

- Con upstream, el daemon **ya no muere por pasar 30 minutos sin consultas si alguna sesión sigue viva**: el backstop solo actúa sobre clientes fantasma (`backstopShouldExit`, `src/mcp/daemon.ts:577`). Solo sale a los 5 minutos de quedarse sin clientes (`DEFAULT_IDLE_TIMEOUT_MS`, `src/mcp/daemon.ts:69`). Con varias sesiones abiertas a la vez, como trabaja el usuario, el daemon puede vivir todo el día y **el grafo se queda congelado desde su arranque hasta las 04:20**.
- El motor viejo se reiniciaba mucho: 1.315 arranques en `C:/Users/Javier/dev/codegraph-migration/daemon-1.0.1.log` (sin fechas, unos 10 al día si cubre desde junio), con 482 paradas por inactividad de 30 minutos y 362 muertes por el guardián. Eso disimulaba el problema.
- Las instrucciones del MCP dicen «the index lags writes by ~1s through the file watcher», lo que es falso con esta configuración. Ya está anotado en `W:/bin/codegraph`.

## Propuesta

1. Upstream reescribió el watcher: sincroniza solo las rutas cambiadas, ignora los eventos NTFS de simple lectura y sincroniza solas las carpetas enlazadas. Volver a probarlo con `CODEGRAPH_NO_WATCH=0` sobre `W:\` y vigilar `daemon.log` por si vuelve el bucle de re-sync, por ejemplo con el symlink `delphi-12-rtl-vcl-source-readonly`, cuyas fechas no cuadraban.
2. **Depende de `codegraph:T-MBEP`:** mientras cada `sync` que toca un `.pas` cueste de 3 a 5 minutos de resíntesis completa, un watcher activo la dispararía continuamente.
3. Si el watcher no sirve: una tarea programada de `codegraph sync W:/` más frecuente, por ejemplo cada hora, o un refresco manual documentado.
