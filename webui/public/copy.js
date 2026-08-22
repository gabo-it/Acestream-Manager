// navigator.clipboard richiede un "contesto sicuro" (HTTPS o localhost):
// su un IP di rete locale servito in HTTP semplice (es. http://192.168.x.x:4000)
// è undefined, e chiamare .writeText() lancia un'eccezione silenziosa — il
// pulsante "Copia link" sembra non fare nulla. Questo helper prova prima
// l'API moderna, poi ripiega su un textarea temporaneo + execCommand, che
// funziona anche in contesti non sicuri.
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise(function (resolve, reject) {
    try {
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (ok) resolve();
      else reject(new Error('execCommand copy fallito'));
    } catch (err) {
      reject(err);
    }
  });
}
