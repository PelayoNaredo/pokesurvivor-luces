// Puente entre el menú de la extensión y la página. lighting.js vive en la página (para poder
// engancharse al canvas del juego) y no tiene acceso a chrome.storage; este script sí, y le pasa
// los ajustes por postMessage. Si el jugador cambia de modo con la tecla L, lo guarda aquí.
const DEFAULTS = { mode: 'noche', variantes: true, deco: true, maqueta: false };
const send = s => window.postMessage({ psLuz: s }, location.origin);

window.addEventListener('message', e => {
  if (e.source !== window || !e.data) return;
  if (e.data.psLuzListo) chrome.storage.sync.get(DEFAULTS, send);
  if (e.data.psLuzEstado && typeof e.data.psLuzEstado.mode === 'string')
    chrome.storage.sync.set({ mode: e.data.psLuzEstado.mode });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  const s = {};
  for (const k in changes) if (k in DEFAULTS) s[k] = changes[k].newValue;
  send(s);
});
