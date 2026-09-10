// Intercetta console.error/console.warn per tenere un buffer in memoria
// degli ultimi eventi — usato dal widget "Recent issues" nella Dashboard.
// Non richiede il socket Docker (rimosso deliberatamente da questo
// progetto): cattura solo quello che il NOSTRO processo webui registra,
// non i log degli altri container (acexy, engine, ecc.) — comunque la
// maggior parte dei problemi rilevanti (EPG fallito, traduzione fallita,
// import fallito) passano tutti da qui.
const MAX_ENTRIES = 50;
const entries = [];

function record(level, args) {
  const message = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
  entries.unshift({ level, message, at: Date.now() });
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
}

function install() {
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args) => {
    record('error', args);
    origError(...args);
  };
  console.warn = (...args) => {
    record('warn', args);
    origWarn(...args);
  };
}

function getRecent(limit = 20) {
  return entries.slice(0, limit);
}

module.exports = { install, getRecent };
