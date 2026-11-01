// Menú de la extensión: lee y guarda los ajustes en chrome.storage.sync; bridge.js los pasa al
// juego en cuanto cambian, sin recargar la página.
const DEFAULTS = { mode: 'noche', variantes: true, deco: true, maqueta: false };
const GAME = 'https://pokesurvivor.com/';

chrome.storage.sync.get(DEFAULTS, s => {
  const r = document.querySelector(`input[name="mode"][value="${s.mode}"]`);
  if (r) r.checked = true;
  document.getElementById('variantes').checked = s.variantes;
  document.getElementById('deco').checked = s.deco;
  document.getElementById('maqueta').checked = s.maqueta;
});

document.querySelectorAll('input[name="mode"]').forEach(r =>
  r.addEventListener('change', () => chrome.storage.sync.set({ mode: r.value })));
for (const id of ['variantes', 'deco', 'maqueta'])
  document.getElementById(id).addEventListener('change', e => chrome.storage.sync.set({ [id]: e.target.checked }));

// ¿Está el juego en esta pestaña? (activeTab deja leer su dirección al abrir el menú)
const status = document.getElementById('status'), text = document.getElementById('status-text'), open = document.getElementById('open');
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  const here = !!tab && /^https:\/\/(www\.)?pokesurvivor\.com\//.test(tab.url || '');
  status.dataset.state = here ? 'on' : 'off';
  text.textContent = here ? 'Activo en esta pestaña' : 'Funciona en pokesurvivor.com';
  open.hidden = here;
});
open.addEventListener('click', () => { chrome.tabs.create({ url: GAME }); window.close(); });
