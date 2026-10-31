/*
 * PokéSurvivor · iluminación (post-proceso WebGL, sin tocar el juego)
 *
 * El juego pinta cada frame en #game en tres tramos:
 *   suelo (profundidad de save() = 1) → entidades (profundidad 2) → HUD (transformación sin cámara).
 * Este script escucha esas transiciones en el contexto 2D y hace dos fotos por frame:
 *   G = sólo el suelo, W = el mundo entero. Después borra #game, que se queda con el HUD
 *   y se ve por encima de un canvas WebGL donde se pinta el mundo iluminado.
 *
 * Con W y G salen gratis:
 *   - oclusores: lo que hay en W y no en G (Pokémon, árboles, rocas...) → proyectan sombra
 *   - emisores:  lo que W aclara sobre G en los tres canales (los halos aditivos del juego)
 *                + los píxeles muy brillantes y saturados (fuego, lava, proyectiles)
 *
 * Y con eso:
 *   - iluminación global 2D: cada emisor lanza luz que rebota por el suelo y la tapan los
 *     oclusores (una bola de fuego hace que los árboles proyecten sombra), con acumulación temporal
 *   - luna con sombras suaves + antorcha del jugador con sombras radiales
 *   - niebla volumétrica anclada al mundo, iluminada, con haces de luz entre los árboles
 *   - luz de contorno en los sprites, oclusión ambiental, motas de polvo, bloom en 3 escalas,
 *     gradación de color, grano y aberración cromática
 *
 * Tecla L: noche → atardecer → día → apagado.   ?luz=0 en la URL: arranca apagado.
 * Ajustes desde fuera (la extensión): window.postMessage({ psLuz: { mode, variantes, deco } }).
 * Sólo con window.PS_LUZ_DEBUG = true antes de cargar: window.PS_LUZ para pruebas
 * (PS_LUZ.debug = 1 oclusores · 2 sombras · 3 emisión · 4 luz global · 5 niebla · 6 alturas).
 */
(function start() {
  'use strict';
  if (window.__psLuzActivo) return; // ya cargado (p. ej. el script de la página y la extensión)
  const game = document.getElementById('game');
  if (!game) {
    // Como extensión entra antes de que exista el canvas: se espera a que aparezca
    if (!start.waiting) {
      start.waiting = true;
      const mo = new MutationObserver(() => { if (document.getElementById('game')) { mo.disconnect(); start(); } });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      // en las páginas sin juego (guía, pokédex...) se deja de esperar al terminar de cargar
      document.addEventListener('DOMContentLoaded', () => { if (!document.getElementById('game')) mo.disconnect(); });
    }
    return;
  }
  window.__psLuzActivo = true;

  const PRESETS = {
    noche: {
      ambient: [0.31, 0.33, 0.43], moon: [0.38, 0.42, 0.53], moonDir: [-0.55, 0.83],
      torch: [0.82, 0.5, 0.27], torchR: 0.4, gi: 1.0, bloom: 0.6, shadow: 0.85,
      relief: 0.5, exposure: 1.35, vignette: 0.62, sat: 1.06,
      fog: 0.36, fogCol: [0.09, 0.10, 0.14], shafts: 0.8, motes: 1.0, ao: 0.5, rim: 1.4,
      lowTint: [0.93, 0.98, 1.07], highTint: [1.1, 1.00, 0.88], shadowHue: [0.84, 0.87, 1.06]
    },
    atardecer: {
      ambient: [0.46, 0.38, 0.46], moon: [0.85, 0.56, 0.40], moonDir: [-0.92, 0.38],
      torch: [0.57, 0.37, 0.2], torchR: 0.32, gi: 0.8, bloom: 0.55, shadow: 0.8,
      relief: 0.55, exposure: 1.2, vignette: 0.5, sat: 1.04,
      fog: 0.26, fogCol: [0.30, 0.17, 0.16], shafts: 0.65, motes: 0.7, ao: 0.42, rim: 1.2,
      lowTint: [0.9, 0.88, 1.1], highTint: [1.08, 0.99, 0.9], shadowHue: [0.84, 0.78, 1.08]
    },
    dia: {
      ambient: [0.61, 0.63, 0.72], moon: [0.72, 0.64, 0.48], moonDir: [-0.62, 0.78],
      torch: [0.18, 0.13, 0.08], torchR: 0.28, gi: 0.55, bloom: 0.4, shadow: 0.7,
      relief: 0.45, exposure: 1.05, vignette: 0.3, sat: 1.14,
      fog: 0.13, fogCol: [0.58, 0.62, 0.66], shafts: 0.3, motes: 0.35, ao: 0.4, rim: 0.6,
      lowTint: [0.94, 1.00, 1.08], highTint: [1.06, 1.02, 0.94], shadowHue: [0.84, 0.88, 1.06]
    }
  };
  const MODES = ['noche', 'atardecer', 'dia', 'off'];

  // ---------- el toque de cada escenario ----------
  // floor y liq son los colores exactos del propio juego (su lista de biomas): el escenario se
  // reconoce por el suelo que está pintando, sin depender del idioma del HUD.
  //   tint/fogCol/fogMul/moonMul: ambiente · canopy: luz de luna a manchas bajo las copas
  //   lightning: relámpagos lejanos · flicker: emisores que parpadean como velas · emit: brillo de cristales
  //   liq*: brillo propio, cáusticas, burbujas y destellos del líquido · mote*: partículas
  const BIOMES = [
    { id: 'bosque-umbrio', floor: ['#3e7a39', '#44813d', '#397134'], liq: ['#3b7fc6', '#2c64a6'], liqFx: [.55, .8, 1],
      tint: [.95, 1.05, .95], fogCol: [.08, .15, .12], fogMul: .9, moonMul: 1, canopy: .8, lightning: 0, flicker: 0, emit: 1,
      liqGlow: 0, caustic: 1, bubbles: 0, spec: 1,
      moteCol: [.85, 1, .4], moteDen: .55, moteRise: .03, moteBlink: 1, moteSize: 1 },          // luciérnagas
    { id: 'cueva-cristal', floor: ['#4d5778', '#535e81', '#47506f'], liq: ['#2a9cab', '#1d7c8a'], liqFx: [.4, .95, 1],
      tint: [.85, .92, 1.15], fogCol: [.05, .08, .16], fogMul: .6, moonMul: .15, canopy: 0, lightning: 0, flicker: 0, emit: 1.8,
      liqGlow: .3, caustic: 1.3, bubbles: 0, spec: 1.2,
      moteCol: [.6, .95, 1], moteDen: .6, moteRise: -.02, moteBlink: .8, moteSize: .6 },          // destellos de cristal
    { id: 'volcan', floor: ['#5b4537', '#644c3c', '#533f32'], liq: ['#e45a1f', '#b9401a'], liqFx: [1, .45, .15],
      tint: [1.02, .96, .94], fogCol: [.1, .07, .07], fogMul: .9, moonMul: .75, canopy: 0, lightning: 0, flicker: .5, emit: 1,
      liqGlow: .9, caustic: .6, bubbles: .6, spec: .2,
      moteCol: [.55, .5, .48], moteDen: .5, moteRise: -.06, moteBlink: 0, moteSize: .7 },        // ceniza que cae
    { id: 'huerto', floor: ['#2f3a26', '#34402a', '#2a3322'], liq: ['#3e5a2a', '#2c4220'], liqFx: [.55, .85, .3],
      tint: [1.08, 1, .9], fogCol: [.09, .12, .06], fogMul: 1, moonMul: 1, canopy: 0, lightning: 0, flicker: 1, emit: 1,
      liqGlow: .15, caustic: 0, bubbles: 1, spec: .3,
      moteCol: [1, .55, .2], moteDen: .4, moteRise: .12, moteBlink: .3, moteSize: .8 },          // brasas
    { id: 'cementerio', floor: ['#34303f', '#393446', '#2f2b39'], liq: ['#3a3a6a', '#2a2a52'], liqFx: [.6, .6, 1],
      tint: [.96, .97, 1.03], fogCol: [.12, .13, .16], fogMul: 1.35, moonMul: 1.1, canopy: 0, lightning: 1, flicker: 0, emit: 1,
      liqGlow: .1, caustic: .5, bubbles: 0, spec: 1,
      moteCol: [.65, .85, 1], moteDen: .3, moteRise: .05, moteBlink: 0, moteSize: 2.2 },         // fuegos fatuos
    { id: 'bosque-tenebroso', floor: ['#1f2a2a', '#233030'], liq: ['#6a3a8a', '#6a3a8a'], liqFx: [.75, .35, 1],
      tint: [.95, .9, 1.08], fogCol: [.11, .06, .15], fogMul: .9, moonMul: .8, canopy: .5, lightning: 0, flicker: 0, emit: 1,
      liqGlow: .8, caustic: 0, bubbles: 1, spec: .3,
      moteCol: [.8, .45, 1], moteDen: .5, moteRise: .1, moteBlink: .4, moteSize: .9 }            // esporas
  ];
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

  // ---------- grietas (arenas de los legendarios) ----------
  // El juego las genera de ARENA_THEMES: un color base de suelo y de líquido por tipo, y de ahí
  // saca los tonos con su función de aclarar/oscurecer (+5 %, −6 % el suelo; −22 % el líquido
  // hondo). Se calculan igual aquí para reconocerlas por el suelo, como los escenarios normales.
  const tone = (h, a) => '#' + [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
    .map(c => Math.round(a >= 0 ? c + (255 - c) * a : c * (1 + a)).toString(16).padStart(2, '0')).join('');
  const LIQ_FX = {
    water: { liqGlow: 0, caustic: 1, bubbles: 0, spec: 1 },
    swamp: { liqGlow: .15, caustic: 0, bubbles: 1, spec: .3 },
    lava: { liqGlow: .9, caustic: .6, bubbles: .6, spec: .2 },
    poison: { liqGlow: .8, caustic: 0, bubbles: 1, spec: .3 },
    spark: { liqGlow: .9, caustic: .8, bubbles: 0, spec: 1 },
    ice: { liqGlow: 0, caustic: .3, bubbles: 0, spec: 1.5 }
  };
  const MOTES = {
    luciernagas: { moteCol: [.85, 1, .4], moteDen: .55, moteRise: .03, moteBlink: 1, moteSize: 1 },
    brasas: { moteCol: [1, .55, .2], moteDen: .45, moteRise: .12, moteBlink: .3, moteSize: .8 },
    burbujas: { moteCol: [.6, .85, 1], moteDen: .35, moteRise: .08, moteBlink: 0, moteSize: 1.2 },
    chispas: { moteCol: [1, .9, .35], moteDen: .4, moteRise: .02, moteBlink: 1, moteSize: .6 },
    nieve: { moteCol: [.9, .95, 1], moteDen: .7, moteRise: -.09, moteBlink: 0, moteSize: .8 },
    esporas: { moteCol: [.8, .45, 1], moteDen: .5, moteRise: .1, moteBlink: .4, moteSize: .9 },
    polvo: { moteCol: [.8, .7, .5], moteDen: .45, moteRise: .01, moteBlink: 0, moteSize: .9 },
    plumas: { moteCol: [.95, .95, 1], moteDen: .3, moteRise: -.03, moteBlink: 0, moteSize: 1.3 },
    destellos: { moteCol: [1, .6, .9], moteDen: .5, moteRise: .02, moteBlink: 1, moteSize: .6 },
    fatuos: { moteCol: [.65, .85, 1], moteDen: .3, moteRise: .05, moteBlink: 0, moteSize: 2.2 },
    ceniza: { moteCol: [.55, .5, .48], moteDen: .5, moteRise: -.06, moteBlink: 0, moteSize: .7 }
  };
  // [tipo, suelo, líquido, tipo de líquido, partículas, ajustes]
  const ARENAS = [
    ['normal', '#6f8a4f', '#4f8fd0', 'water', 'luciernagas', { tint: [1, 1.03, .95], canopy: .4 }],
    ['fire', '#5b3a2e', '#e45a1f', 'lava', 'brasas', { tint: [1.12, .95, .82], fogCol: [.13, .06, .04], moonMul: .6, flicker: .6 }],
    ['water', '#3c6a80', '#2f86d6', 'water', 'burbujas', { tint: [.88, .98, 1.12], fogCol: [.05, .1, .16], caustic: 1.4 }],
    ['grass', '#3a7a32', '#4f6b2a', 'swamp', 'luciernagas', { tint: [.95, 1.06, .92], canopy: .8 }],
    ['electric', '#4a4840', '#e8c020', 'spark', 'chispas', { tint: [1.02, 1, .92], lightning: .7 }],
    ['ice', '#b8cfe0', '#9fd8f0', 'ice', 'nieve', { tint: [.8, .9, 1.12], fogCol: [.1, .14, .22], fogMul: .7 }],
    ['poison', '#46384f', '#9a4fc0', 'poison', 'esporas', { tint: [.96, .9, 1.08], fogCol: [.1, .05, .14] }],
    ['ground', '#b08a52', '#9a7a48', 'swamp', 'polvo', { tint: [1.06, .98, .86], fogCol: [.18, .13, .08], fogMul: 1 }],
    ['flying', '#9fb8d8', '#7fb8ff', 'water', 'plumas', { tint: [.92, .98, 1.1], fogCol: [.12, .15, .22], fogMul: .8, canopy: .35 }],
    ['psychic', '#5e4470', '#8a5ad0', 'water', 'destellos', { tint: [1.02, .92, 1.1], fogCol: [.12, .06, .16], liqGlow: .4 }],
    ['bug', '#5a6a2a', '#6a7a2a', 'swamp', 'luciernagas', { tint: [1, 1.04, .9], canopy: .6 }],
    ['rock', '#7a6a58', '#4f8fd0', 'water', 'polvo', { tint: [1.04, .98, .9], fogCol: [.15, .12, .09], fogMul: 1.2 }],
    ['ghost', '#383447', '#3a3a6a', 'water', 'fatuos', { tint: [.96, .97, 1.03], fogCol: [.12, .13, .16], fogMul: 1.35, lightning: 1 }],
    ['dragon', '#363a5e', '#7b5cff', 'lava', 'brasas', { tint: [.98, .92, 1.1], fogCol: [.08, .06, .16], moteCol: [.7, .5, 1] }],
    ['dark', '#2c282e', '#2a2a3a', 'water', 'ceniza', { tint: [.88, .88, .95], moonMul: .5, fogCol: [.06, .05, .08] }],
    ['steel', '#6d7888', '#4f8fd0', 'water', 'chispas', { tint: [.94, .98, 1.06], spec: 1.4, moteDen: .2 }],
    ['fairy', '#4f7f5a', null, 'water', 'destellos', { tint: [1.04, .96, 1.04] }],
    ['judgment', '#4a4240', '#e8a82a', 'lava', 'brasas', { tint: [1.06, 1, .9], moteCol: [1, .8, .35], flicker: .3 }]
  ];
  for (const [tipo, floor, liq, ltype, motes, extra] of ARENAS) {
    BIOMES.push(Object.assign({
      id: 'grieta-' + tipo, floor: [floor, tone(floor, .05), tone(floor, -.06)],
      liq: liq ? [liq, tone(liq, -.22)] : ['#000001', '#000001'],
      liqFx: liq ? hex(tone(liq, .35)) : [0, 0, 0],
      tint: [1, 1, 1], fogCol: [.08, .08, .1], fogMul: 1, moonMul: 1, canopy: 0, lightning: 0, flicker: 0, emit: 1
    }, LIQ_FX[ltype], MOTES[motes], extra));
  }
  const FLOOR_RGB = BIOMES.map(b => b.floor.map(h => { const [r, g, bb] = hex(h); return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(bb * 255); }));
  const NEUTRAL = { tint: [1, 1, 1], fogCol: [0, 0, 0], fogMul: 1, moonMul: 1, canopy: 0, lightning: 0, flicker: 0, emit: 1,
    liqGlow: 0, caustic: 0, bubbles: 0, spec: 0, moteCol: [.05, .08, .04], moteDen: .56, moteRise: .15, moteBlink: 0, moteSize: 1,
    heat: 0, glitter: 0, vignetteMul: 1, flashCol: [.55, .6, .85], gLow: [1, 1, 1], gHigh: [1, 1, 1] };
  // Firma de cada sitio: gradación (tinte de sombras / de luces), aire que tiembla, escarcha,
  // color del relámpago y viñeta. Lo que no aparece aquí queda neutro.
  const SIGNATURE = {
    'bosque-umbrio': { gLow: [.9, 1.05, .95], gHigh: [1.08, 1.04, .88] },                          // sombra verde, luz dorada
    'cueva-cristal': { gLow: [.85, 1, 1.12], gHigh: [.95, 1.06, 1.1], glitter: .8, vignetteMul: 1.25 }, // turquesa
    'volcan': { gLow: [1.02, .9, .98], gHigh: [1.06, 1, .9], heat: 1 },                             // ceniza fría / brasa
    'huerto': { gLow: [.95, .88, 1.1], gHigh: [1.12, .98, .82] },                                    // violeta / calabaza
    'cementerio': { gLow: [.94, .97, 1.06], gHigh: [.97, 1.04, 1], flashCol: [.6, .7, 1], vignetteMul: 1.2 }, // azul / verde pálido
    'bosque-tenebroso': { gLow: [.95, .85, 1.12], gHigh: [.9, 1.05, 1.02], vignetteMul: 1.25 },      // violeta / verde agua
    'grieta-normal': { gHigh: [1.06, 1.04, .92] },
    'grieta-fire': { gLow: [1.1, .86, .82], gHigh: [1.14, 1, .78], heat: 1.2 },
    'grieta-water': { gLow: [.84, .98, 1.15], gHigh: [.92, 1.04, 1.1] },
    'grieta-grass': { gLow: [.88, 1.06, .92], gHigh: [1.04, 1.06, .88] },
    'grieta-electric': { gLow: [.95, .95, 1.05], gHigh: [1.1, 1.06, .8], flashCol: [1, .95, .5] },
    'grieta-ice': { gLow: [.85, .95, 1.15], gHigh: [.96, 1.02, 1.08], glitter: 1.2 },
    'grieta-poison': { gLow: [1, .85, 1.12], gHigh: [.95, 1.06, .95], heat: .3 },
    'grieta-ground': { gLow: [1.04, .95, .85], gHigh: [1.1, 1.02, .85], heat: .6 },
    'grieta-flying': { gLow: [.9, .96, 1.12], gHigh: [1.04, 1.04, 1.02] },
    'grieta-psychic': { gLow: [1, .86, 1.12], gHigh: [1.08, .96, 1.06], glitter: .5 },
    'grieta-bug': { gLow: [.95, 1.04, .88], gHigh: [1.08, 1.06, .85] },
    'grieta-rock': { gLow: [1, .95, .9], gHigh: [1.06, 1.02, .9], heat: .3 },
    'grieta-ghost': { gLow: [.94, .96, 1.06], gHigh: [.97, 1.04, 1], flashCol: [.6, .7, 1], vignetteMul: 1.2 },
    'grieta-dragon': { gLow: [.95, .85, 1.15], gHigh: [1.08, .95, 1.08], heat: .8 },
    'grieta-dark': { gLow: [.9, .88, 1], gHigh: [1, .98, .95], vignetteMul: 1.5 },
    'grieta-steel': { gLow: [.9, .96, 1.08], gHigh: [1.02, 1.03, 1.06], glitter: .6 },
    'grieta-fairy': { gLow: [1.02, .9, 1.06], gHigh: [1.08, 1, 1.06], glitter: 1 },
    'grieta-judgment': { gLow: [1.04, .92, .85], gHigh: [1.12, 1.04, .82], heat: .8 }
  };
  for (const b of BIOMES) {
    Object.assign(b, SIGNATURE[b.id] || {});
    for (const k in NEUTRAL) if (!(k in b)) b[k] = NEUTRAL[k];
  }
  const bioW = new Float32Array(BIOMES.length); // peso de cada escenario (fundido de 2,5 s al cambiar)
  let bioNow = -1, decoFade = 0;
  // con «reducir movimiento» activado en el sistema: sin relámpagos, sin aire que tiembla y sin
  // vórtice en las grietas (se sigue viendo todo lo demás)
  const calmQuery = matchMedia('(prefers-reduced-motion: reduce)');
  let calm = calmQuery.matches;
  calmQuery.addEventListener && calmQuery.addEventListener('change', e => { calm = e.matches; });
  const urlOff = /[?&]luz=0/.test(location.search);
  let mode = 'noche';
  try { mode = urlOff ? 'off' : (localStorage.getItem('ps-luz') || 'noche'); } catch (e) {}
  if (!MODES.includes(mode)) mode = 'noche';

  // ---------- canvas WebGL debajo de #game ----------
  const cv = document.createElement('canvas');
  cv.id = 'game-light';
  cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;display:block';
  game.parentNode.insertBefore(cv, game);
  const gl = cv.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
  // la composición final lee 11 texturas a la vez; WebGL sólo garantiza 8 (móviles muy viejos)
  if (!gl || gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) < 11) { cv.remove(); return; }
  // Si el navegador pierde el contexto (móvil en segundo plano, poca memoria) ya no se puede
  // pintar encima: se deja de tocar el canvas del juego y se ve el original, en vez de un
  // mundo en negro con sólo el HUD.
  let alive = true;
  cv.addEventListener('webglcontextlost', e => { e.preventDefault(); alive = false; cv.style.visibility = 'hidden'; console.warn('[luz] contexto WebGL perdido: se muestra el juego sin luces'); });
  const lit = () => alive && mode !== 'off' && !gl.isContextLost();
  // Cualquier error nuestro (un canvas contaminado, un driver raro) apaga las luces y deja el
  // juego tal cual: nunca debe llegar al bucle del juego.
  function fail(e) { if (alive) console.warn('[luz] desactivado por un error:', e); alive = false; cv.style.visibility = 'hidden'; }

  const VS = 'attribute vec2 p;varying vec2 uv;void main(){uv=p*.5+.5;gl_Position=vec4(p,0.,1.);}';
  const HEAD = `precision highp float;varying vec2 uv;
    float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
    float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
    float lum(vec3 c){return dot(c,vec3(.299,.587,.114));}`;

  // 1) oclusores (a) + emisión (rgb), a media resolución
  const FS_PREP = HEAD + `
    uniform sampler2D W,G,FX,ATK; uniform vec2 o; uniform float emitBoost,groundEmit;
    float occOf(vec2 p,out vec3 em){
      vec3 w=texture2D(W,p).rgb, g=texture2D(G,p).rgb, d=w-g;
      float diff=max(max(abs(d.r),abs(d.g)),abs(d.b));
      // Aclarado suave en los 3 canales = halo aditivo del juego. Un sprite claro sobre
      // suelo oscuro también aclara los 3, pero de golpe: por eso se corta por amplitud.
      float add=smoothstep(.0,.05,min(min(d.r,d.g),d.b))*(1.-smoothstep(.22,.4,diff));
      float mx=max(max(w.r,w.g),w.b), mn=min(min(w.r,w.g),w.b);
      // Brilla lo muy claro y saturado (fuego, calabazas, monedas). La hierba azul clara de la
      // Cueva Cristal (#8ab8ee) se quedaba justo por encima del corte anterior y lavaba la escena.
      vec3 hot=w*smoothstep(.72,.95,mx)*smoothstep(.4,.65,mx-mn);
      // El suelo (lo que no cambia entre la foto del suelo y la del mundo) sólo emite si el
      // líquido del escenario brilla de verdad (lava, chispas, veneno): el agua azul clara de la
      // Gruta Marina contaba como fuente de luz y llenaba la escena de neblina.
      hot*=mix(1.,groundEmit,1.-smoothstep(.02,.08,diff));
      // los cristales (cian claro: verde y azul altos, rojo por debajo) brillan en su escenario;
      // sólo sus reflejos más claros y poco, porque son sprites enormes y llenaban la cueva de luz
      hot+=w*smoothstep(.85,.97,w.g)*step(.85,w.b)*step(w.r,w.g*.9)*(emitBoost-1.)*.18;
      // La hierba alta también aclara el suelo, pero se queda oscura: sólo cuenta el halo que brilla.
      // Y sólo si el aclarado tiene color: la Cueva Cristal pinta encima rectángulos blancos al 18 %
      // (sus haces de luz) que, contados como emisores, llenaban toda la cueva de neblina.
      vec3 dp=max(d,0.); float dmx=max(max(dp.r,dp.g),dp.b);
      float tinted=smoothstep(.3,.5,(dmx-min(min(dp.r,dp.g),dp.b))/(dmx+1e-3));
      em=hot+dp*add*1.4*smoothstep(.38,.62,mx)*tinted;
      // lo que el juego pintó con transparencia (zonas de ataque, avisos, brillos, sombritas)
      // es efecto, no objeto: no proyecta sombra
      // (máscara ensanchada un píxel de arte: está a media resolución y dejaba el contorno)
      float fxm=max(max(texture2D(FX,p).a,texture2D(FX,p+vec2(o.x,0)).a),max(texture2D(FX,p-vec2(o.x,0)).a,
                max(texture2D(FX,p+vec2(0,o.y)).a,texture2D(FX,p-vec2(0,o.y)).a)));
      return smoothstep(.035,.13,diff)*(1.-add)*(1.-smoothstep(.05,.4,fxm));
    }
    void main(){
      vec3 em,e2;
      float occ=occOf(uv,em);
      // dilatación en cruz: tapa los huecos de los sprites cuyo interior se parece al suelo
      occ=max(occ,.85*min(min(occOf(uv+vec2(o.x,0),e2),occOf(uv-vec2(o.x,0),e2)),
                          max(occOf(uv+vec2(0,o.y),e2),occOf(uv-vec2(0,o.y),e2))));
      // los ataques emiten un poco de luz de su propio color
      vec4 ak=texture2D(ATK,uv);
      em+=ak.rgb*ak.a*.45;
      gl_FragColor=vec4(em,occ);
    }`;

  // 2a) altura de cada oclusor sobre su base: cuántos píxeles hay hasta el pie del sprite.
  // Con esto la sombra nace de los pies del árbol o del Pokémon, no de su silueta en pantalla
  // (la técnica de las sombras oblicuas con mapa de altura de los juegos top-down).
  const FS_HEIGHT = HEAD + `
    uniform sampler2D M; uniform vec2 res;
    // ¿sigue el objeto en p? Se toleran huecos (y se mira un poco a los lados): la máscara tiene
    // agujeros donde el sprite se parece al suelo, y las ramas de un árbol van en diagonal al tronco
    float body(vec2 p,float dir){
      float a=max(texture2D(M,p/res).a,max(texture2D(M,(p+vec2(0.,2.*dir))/res).a,texture2D(M,(p+vec2(0.,4.*dir))/res).a));
      return max(a,max(texture2D(M,(p+vec2(3.,dir))/res).a,texture2D(M,(p+vec2(-3.,dir))/res).a));
    }
    void main(){
      vec2 px=uv*res;
      if(texture2D(M,uv).a<.4){gl_FragColor=vec4(0.);return;}
      // hacia abajo (en GL la y sube) hasta el pie
      float h=0.;
      for(int i=1;i<=48;i++){
        vec2 p=px-vec2(0.,float(i)*2.);
        // el pie queda por debajo de la pantalla: altura desconocida, no proyecta sombra
        if(p.y<1.){gl_FragColor=vec4(0.);return;}
        float a=body(p,-1.);
        // el pie exacto entre dos pasos: con la cámara moviéndose en fracciones de píxel, una
        // altura que salta de 2 en 2 hace que la sombra aparezca y desaparezca
        if(a<.4){h+=2.*smoothstep(0.,.4,a);break;}
        h=float(i)*2.;
      }
      // hacia arriba hasta la copa: si el objeto se sale por el borde de arriba no se sabe lo
      // alto que es, y su sombra entra con un fundido según asoma la copa (en vez de una sombra
      // que crece o encoge mientras subes)
      float gap=0.;
      for(int i=1;i<=48;i++){
        vec2 p=px+vec2(0.,float(i)*2.);
        if(p.y>res.y-1.){gap=0.;break;}
        if(body(p,1.)<.4){gap=res.y-p.y;break;}
      }
      gl_FragColor=vec4(h/128.,smoothstep(2.,36.,gap),0.,1.);
    }`;

  // 2b) visibilidad: luna (r) y antorcha del jugador (g). Para cada píxel del suelo se prueba
  // cada altura posible: ¿hay un oclusor justo a esa altura sobre el punto del que vendría la sombra?
  const FS_SHADOW = HEAD + `
    uniform sampler2D M,HT; uniform vec2 res,moonDir,center,cam; uniform float art,frame,jmode;
    float hit(vec2 base,float h,float tol){
      // Sólo cuenta lo que se ve. Fuera de la pantalla la textura repite su última fila, y
      // suponer que un árbol cortado por arriba sigue subiendo daba sombras larguísimas que
      // encogían según el árbol iba entrando al subir. La parte que aún no se ve no da sombra.
      vec2 q=base+vec2(0.,h);
      if(base.x<0.||base.x>res.x||base.y<0.||q.y>res.y-.5)return 0.;
      float o=texture2D(M,q/res).a;
      vec2 ht=texture2D(HT,q/res).rg;
      return o*ht.g*(1.-smoothstep(0.,tol,abs(ht.r*128.-h)));
    }
    void main(){
      vec2 px=uv*res;
      float self=texture2D(M,uv).a;
      // ruido por píxel que cambia cada frame: la acumulación temporal lo promedia. Fijo en
      // pantalla, el mundo se desliza por debajo del patrón y las sombras titilan.
      vec2 wpx=vec2(px.x*2.-cam.x,(res.y-px.y)*2.-cam.y)*.5;
      float j=jmode<.5?hash(floor(px)):jmode<1.5?hash(floor(px)+fract(frame*.61803)*97.):hash(floor(wpx));
      vec2 ds=-normalize(moonDir);           // la sombra de la luna cae hacia abajo-derecha
      vec2 perp=vec2(-ds.y,ds.x);
      vec2 c=center*res; vec2 fromC=px-c; float dP=length(fromC);
      vec2 dt=fromC/(dP+1e-4);
      float Ht=150.;                         // altura de la antorcha sobre el suelo
      float s=0.,tt=0.;
      for(int i=0;i<24;i++){
        float h=(float(i)+j)*4.+2.;
        float tol=6.+h*.15;
        // luna baja: sombra de 0,9 veces la altura, con penumbra que se abre con la altura
        vec2 bm=px-ds*h*.9+perp*(j-.5)*h*.12;
        s=max(s,hit(bm,h,tol)*(1.-h/140.));
        // antorcha: cuanto más lejos del jugador, más larga la sombra (con tope)
        float st=min(h*dP/(Ht+h),h*.9);
        vec2 bt=px-dt*st;
        float notPlayer=smoothstep(9.*art,13.*art,length(bt+vec2(0.,h)-c));
        tt=max(tt,hit(bt,h,tol)*notPlayer*(1.-h/120.));
      }
      // los oclusores casi no reciben sombra proyectada (su cara iluminada la da la luz de contorno)
      gl_FragColor=vec4(1.-s*(1.-self*.8),1.-tt*(1.-self*.8),0.,1.);
    }`;

  // 3) iluminación global 2D: rayos desde cada píxel que recogen la emisión que ven
  const FS_GI = HEAD + `
    uniform sampler2D S; uniform vec2 res; uniform float frame,rays;
    void main(){
      vec2 px=uv*res;
      float self=texture2D(S,uv).a;
      float rnd=hash(px+fract(frame*.61803)*97.);
      vec3 acc=vec3(0.);
      for(int r=0;r<16;r++){
        if(float(r)>=rays)break;
        float a=(float(r)+rnd)/rays*6.2831853;
        vec2 dir=vec2(cos(a),sin(a));
        // cada rayo muestrea en un punto al azar de cada tramo: sin esto salen anillos concéntricos
        float jr=hash(px*1.31+float(r)*3.7+frame);
        float T=1., st=1., t=.5;
        for(int i=0;i<18;i++){
          vec2 p=px+dir*(t+st*jr);
          if(p.x<0.||p.y<0.||p.x>res.x||p.y>res.y)break;
          vec4 s=texture2D(S,p/res);
          acc+=s.rgb*T*st;
          // dentro del propio sprite no se tapa a sí mismo: así se ilumina la cara que mira a la luz
          float o=s.a*(t<3.?1.-self:1.);
          T*=1.-o*.92;
          if(T<.03)break;
          t+=st; st*=1.24;
        }
      }
      gl_FragColor=vec4(acc/max(rays,1.)*.55,1.);
    }`;

  // 4) acumulación temporal con reproyección por el movimiento de la cámara
  const FS_TEMPORAL = HEAD + `
    uniform sampler2D C,H; uniform vec2 shift,texel; uniform float blend,clampK;
    void main(){
      vec3 c=texture2D(C,uv).rgb;
      vec2 p=uv+shift;
      vec3 h=texture2D(H,p).rgb;
      // recorte del historial al rango de los vecinos actuales: sin estelas detrás de lo que se mueve
      if(clampK>0.){
        vec3 a=texture2D(C,uv+vec2(texel.x,0)).rgb,b=texture2D(C,uv-vec2(texel.x,0)).rgb;
        vec3 d=texture2D(C,uv+vec2(0,texel.y)).rgb,e=texture2D(C,uv-vec2(0,texel.y)).rgb;
        vec3 lo=min(c,min(min(a,b),min(d,e)))-clampK, hi=max(c,max(max(a,b),max(d,e)))+clampK;
        h=clamp(h,lo,hi);
      }
      float k=(p.x<0.||p.y<0.||p.x>1.||p.y>1.)?1.:blend;
      gl_FragColor=vec4(mix(h,c,k),1.);
    }`;

  // 5) reducción + desenfoque separable (rgb y alfa)
  // 4b) brillo medio de la escena (1×1): 64 muestras del mundo sin iluminar, para la exposición automática
  const FS_AVG = HEAD + `uniform sampler2D W;
    void main(){float s=0.;
      for(int y=0;y<8;y++)for(int x=0;x<8;x++)s+=lum(texture2D(W,(vec2(float(x),float(y))+.5)/8.).rgb);
      gl_FragColor=vec4(vec3(s/64.),1.);}`;

  // 4c) color del compañero (1×1): muestras del sprite del jugador, pesadas por lo saturadas que son
  // (sólo cuenta lo que es distinto del suelo de debajo: alrededor del sprite hay mucha hierba)
  const FS_PCOL = HEAD + `uniform sampler2D W,M,G; uniform vec2 center,box;
    void main(){vec3 s=vec3(0.);float n=0.;
      for(int y=0;y<7;y++)for(int x=0;x<7;x++){
        vec2 q=center+(vec2(float(x),float(y))/6.-.5)*2.*box+vec2(0.,box.y*.4);
        vec3 c=texture2D(W,q).rgb; float mx=max(max(c.r,c.g),c.b), mn=min(min(c.r,c.g),c.b);
        float w=smoothstep(.6,.95,texture2D(M,q).a)*smoothstep(.12,.3,distance(c,texture2D(G,q).rgb))*(mx-mn)*smoothstep(.15,.4,mx);
        s+=c*w; n+=w;}
      gl_FragColor=vec4(n>.01?s/n:vec3(1.),clamp(n,0.,1.));}`;

  const FS_DOWN = HEAD + `uniform sampler2D T;uniform vec2 px;
    void main(){gl_FragColor=(texture2D(T,uv+px*vec2(-1,-1))+texture2D(T,uv+px*vec2(1,-1))+texture2D(T,uv+px*vec2(-1,1))+texture2D(T,uv+px*vec2(1,1)))*.25;}`;
  const FS_BLUR = HEAD + `uniform sampler2D T;uniform vec2 dir;
    void main(){vec4 a=texture2D(T,uv)*.227;
      a+=(texture2D(T,uv+dir*1.385)+texture2D(T,uv-dir*1.385))*.316;
      a+=(texture2D(T,uv+dir*3.231)+texture2D(T,uv-dir*3.231))*.070;
      gl_FragColor=a;}`;

  // 6) composición final a resolución completa
  const FS_COMP = HEAD + `
    uniform sampler2D W,S,M,GI,B1,B2,B3,HT,EXPO;
    uniform vec2 res,cam,moonDir,center; uniform float art,aspect,time,dbg,quality;
    uniform vec3 ambient,moon,torch,fogCol,lowTint,highTint,shadowHue;
    uniform float torchR,gi,bloom,shadowK,relief,exposure,vignette,sat,fog,shafts,motes,ao,rim;
    // toque de cada escenario (ver BIOMES en el JS)
    uniform vec3 liqA,liqB,liqFx,moteCol,flashCol; uniform vec4 bFx,bFx2,bLiq,moteP; uniform float flash;
    uniform vec4 rift; uniform float riftA; // grieta: centro y semiejes en píxeles (y de GL), opacidad
    vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
    float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.03+17.1;a*=.5;}return v;}
    // Decoración de suelo: sprites de 8×8 píxeles de arte del atlas DECO, uno como mucho por
    // celda de 14×14, anclados al mundo. El color sale del suelo que hay debajo, así que encaja
    // en cualquier mapa; sólo se pone en hierba y en tierra (nunca en agua, lava ni paredes).
    uniform sampler2D G,DECO; uniform float decoOn,grassRatio;
    // 2 = hierba del mapa · 1 = tierra · 0 = nada (pantano, agua, lava, paredes...)
    float terrain(vec3 c){
      float grass=step(c.b*1.1,c.g)*step(c.r*1.02,c.g)*step(.08,c.g)*step(c.g,c.r*grassRatio*1.12);
      float dirt=step(c.g,c.r)*step(c.b,c.g)*step(.05,c.r-c.b)*step(.08,c.r)*step(c.r,.55)*step((c.r-c.b)/c.r,.55);
      return grass>.5?2.:dirt>.5?1.:0.;
    }
    vec4 deco(vec2 ap){
      if(decoOn<.002||quality<.5)return vec4(0.); // en la calidad más baja, sin adornos
      vec2 cell=floor(ap/14.);
      float h1=hash(cell+.31),h2=hash(cell+7.7),h3=hash(cell+3.3),h4=hash(cell+11.1),h5=hash(cell+5.9);
      vec2 org=cell*14.+floor(vec2(h2,h3)*6.);
      vec2 lp=floor(ap)-org;
      if(lp.x<0.||lp.y<0.||lp.x>7.||lp.y>7.)return vec4(0.);
      // el terreno se mira en el centro y en 4 puntos alrededor: todos tienen que coincidir,
      // para que no salga nada en la orilla de un pantano o de una pared
      vec2 cs=(org+4.)*2.*art+cam;
      vec2 cuv=vec2(cs.x/res.x,1.-cs.y/res.y), o=vec2(5.*2.*art)/res;
      vec3 gr=texture2D(G,cuv).rgb;
      float t0=terrain(gr);
      float same=step(abs(terrain(texture2D(G,cuv).rgb)-t0),.5)*step(abs(terrain(texture2D(G,cuv+vec2(o.x,0)).rgb)-t0),.5)*step(abs(terrain(texture2D(G,cuv-vec2(o.x,0)).rgb)-t0),.5)
                *step(abs(terrain(texture2D(G,cuv+vec2(0,o.y)).rgb)-t0),.5)*step(abs(terrain(texture2D(G,cuv-vec2(0,o.y)).rgb)-t0),.5);
      // El pantano tiene píxeles sueltos casi iguales a la hierba, pero la mitad de sus píxeles
      // son de un verde más saturado. Si cualquiera de otras 9 muestras de la zona es de ese
      // verde, no se pone nada (simulado con los colores reales del Huerto: 0,005 % de fallos).
      for(int yy=-1;yy<=1;yy++)for(int xx=-1;xx<=1;xx++){
        vec3 c=texture2D(G,cuv+vec2(float(xx),float(yy))*o*.7).rgb;
        same*=1.-step(c.b*1.1,c.g)*step(c.r*grassRatio*1.12,c.g);
      }
      float grass=step(1.5,t0)*same, dirt=step(.5,t0)*step(t0,1.5)*same;
      if(h1>grass*.5+dirt*.3)return vec4(0.);
      float s;
      if(grass>.5)s=h4<.3?0.:h4<.5?1.:h4<.64?2.:h4<.74?3.:h4<.84?6.:h4<.94?4.:7.;
      else s=h4<.35?4.:h4<.6?5.:h4<.8?6.:1.;
      if(h5<.5)lp.x=7.-lp.x; // espejo
      float t=floor(texture2D(DECO,(vec2(s*8.+lp.x,lp.y)+.5)/vec2(64.,8.)).r*255.+.5);
      if(t<.5)return vec4(0.);
      float gLum=lum(gr);
      vec3 base=(s==4.||s==5.)?mix(vec3(gLum),gr,.35)*vec3(1.05,1.,1.08):gr; // piedras: grisáceas
      vec3 c=t<1.5?base*.55:t<2.5?base*.95:t<3.5?base*1.45+.03:vec3(0.);
      vec3 petal=h5<.25?vec3(.95,.93,.85):h5<.5?vec3(.98,.82,.3):h5<.75?vec3(.95,.55,.7):vec3(.7,.6,.95);
      if(t>3.5&&t<4.5)c=petal;
      if(t>4.5&&t<5.5)c=vec3(.98,.78,.25);
      if(t>5.5&&t<6.5)c=vec3(.72,.18,.14);
      if(t>6.5)c=vec3(.95,.9,.84);
      // cada adorno aparece a su ritmo dentro del fundido general, no todos a la vez
      return vec4(c,smoothstep(h5*.5,h5*.5+.5,decoOn));
    }
    float torchAtt(vec2 q){vec2 d=(q-center)*vec2(aspect,1.);float r=length(d)/torchR;return 1./(1.+r*r*4.)*(1.-smoothstep(.15,1.6,r));}
    void main(){
      // aberración cromática leve en los bordes
      vec2 cuv=uv-.5; vec2 ca=cuv*dot(cuv,cuv)*.012;
      // aire que tiembla encima de lo que quema (lava, fuego): sólo donde hay emisión cerca
      vec2 wp0=(vec2(uv.x,1.-uv.y)*res-cam)/art;
      float hm=smoothstep(.04,.25,lum(texture2D(B1,uv).rgb))*bFx2.x*(1.-bFx2.w);
      vec2 hz=(vec2(noise(wp0*.12+vec2(0.,time*2.6)),noise(wp0*.12+vec2(7.3,time*2.6)))-.5)*hm*1.6*art/res;
      // la grieta: el suelo de alrededor gira despacio hacia ella, como mirado a través de una lente
      vec2 rv=uv*res-rift.xy, rq=rv/rift.zw;
      float rd=length(rq);
      vec2 rz=vec2(0.);
      if(riftA>0.){
        float ring=smoothstep(.85,1.3,rd)*(1.-smoothstep(1.4,3.2,rd))*riftA*(1.-bFx2.w);
        float ang=ring*(.55+.2*sin(time*1.3));
        vec2 rr=vec2(rv.x*cos(ang)-rv.y*sin(ang),rv.x*sin(ang)+rv.y*cos(ang))*(1.-.12*ring);
        rz=(rr-rv)/res;
      }
      // todo lo que se pinta sobre el suelo (adornos, agua, escarcha) usa esta misma posición
      // deformada, para que gire con el vórtice y tiemble con el calor igual que la imagen del juego
      vec2 uvD=uv+hz+rz;
      vec3 alb=vec3(texture2D(W,uvD+ca).r,texture2D(W,uvD).g,texture2D(W,uvD-ca).b);
      // su núcleo oscuro (#140a26) se abre a otro sitio: nebulosa que se mueve y estrellas que titilan
      float core=0.; vec3 neb=vec3(0.);
      if(riftA>0.){
        core=(1.-smoothstep(.03,.08,distance(alb,vec3(.078,.039,.149))))*step(rd,1.15)*riftA;
        float nb=fbm(rq*vec2(2.,3.)*1.3+vec2(time*.1,time*.25));
        neb=mix(vec3(.16,.05,.34),vec3(.82,.45,1.),smoothstep(.3,.85,nb))+vec3(.55,.85,1.)*smoothstep(.75,.95,nb)*.6;
        vec2 sc=floor(uv*res/art*.5);
        neb+=step(.96,hash(sc+floor(time*.5)*3.))*(.6+.4*sin(time*7.+hash(sc)*30.));
      }
      vec4 m=texture2D(M,uv); float occ=m.a;
      // ¿hay algo pintado encima del suelo en este píxel (opaco o translúcido: un Pokémon que
      // vadea, una zona de ataque)? Ahí no se pinta nada del suelo: ni agua ni adornos.
      vec3 ddg=abs(texture2D(W,uvD).rgb-texture2D(G,uvD).rgb);
      float above=max(smoothstep(.15,.45,occ),smoothstep(.03,.1,max(max(ddg.r,ddg.g),ddg.b)));
      vec4 dc=deco((vec2(uvD.x,1.-uvD.y)*res-cam)/art*.5);
      alb=mix(alb,dc.rgb,dc.a*(1.-above));
      vec2 o=vec2(art)/res;
      vec2 wp=(vec2(uvD.x,1.-uvD.y)*res-cam)/art;
      vec2 pa=floor(wp*.5); // píxel de arte del mundo

      // líquido del escenario: se reconoce por sus colores exactos (los del propio juego)
      // Sólo coincidencias casi exactas (la hierba del Huerto está a 0,04 del pantano hondo) y
      // en al menos 2 de 5 muestras: el agua tiene espuma y motas de otros colores.
      float nl=0.;
      for(int i=0;i<5;i++){
        vec2 off=i==0?vec2(0.):i==1?vec2(2.,0.):i==2?vec2(-2.,0.):i==3?vec2(0.,2.):vec2(0.,-2.);
        vec3 gs=texture2D(G,uvD+off*o).rgb;
        nl+=1.-smoothstep(.008,.02,min(distance(gs,liqA),distance(gs,liqB)));
      }
      float liq=smoothstep(1.5,2.5,nl)*(1.-above);
      // Reflejos: desde el agua se sube hasta la orilla (dos muestras seguidas que ya no son
      // agua, por la espuma) y se lee lo que hay a la misma distancia por encima de ella. Si es
      // un objeto (árbol, roca, Pokémon), se ve invertido y ondulado en el agua.
      // (pasos de 2 píxeles de arte, hasta 64: un árbol mide unos 40, y los estanques son grandes)
      vec2 mirUv=uv; float mirOn=0.;
      if(liq>.5&&bLiq.w>.1&&quality>1.5){ // reflejos: sólo en calidad alta
        float s=-1.; vec2 st=vec2(0.,4.*o.y);
        for(int i=1;i<=32;i++){
          vec2 q=uv+st*float(i);
          vec3 a=texture2D(G,q).rgb, b2=texture2D(G,q+st*.5).rgb;
          float wa=step(min(distance(a,liqA),distance(a,liqB)),.02), wb=step(min(distance(b2,liqA),distance(b2,liqB)),.02);
          if(wa+wb<.5){s=float(i);break;}
        }
        // ondas: el reflejo tiembla en horizontal, más lejos de la orilla
        float wob=sin(wp.y*.55+time*2.2)+.5*sin(wp.y*1.3-time*3.1+wp.x*.05);
        if(s>0.){
          mirUv=uv+st*(2.*s)+vec2(wob*o.x*(.6+s*.04),0.);
          mirOn=(1.-smoothstep(6.,32.,s));
          float ro=texture2D(M,mirUv).a;
          vec3 rc=texture2D(W,mirUv).rgb;
          alb=mix(alb,rc*mix(vec3(1.),liqFx,.35)*.8,ro*.5*mirOn*min(1.,bLiq.w)*liq);
        } else {
          // lejos de cualquier orilla: se refleja lo que hay un poco más arriba, muy tenue
          mirUv=uv+vec2(wob*o.x*1.5,24.*o.y); mirOn=.35;
        }
      }
      // cáusticas: líneas de luz que se mueven por el fondo del agua, a resolución de píxel de arte
      float cv=noise(pa*.09+vec2(time*.35,time*.2))+noise(pa*.13-vec2(time*.27,-time*.31));
      alb+=liq*smoothstep(.8,.97,1.-abs(cv-1.))*bLiq.y*liqFx*.35;
      // burbujas que suben, crecen y revientan
      vec2 bc=floor(pa/10.); float bh=hash(bc+.7); float bt=fract(time*.35+bh*7.);
      vec2 bp=bc*10.+2.+floor(vec2(hash(bc+1.3),hash(bc+2.9))*6.);
      float bub=step(.55,bh)*step(abs(length(pa-bp)-bt*2.5),.6)*(1.-bt);
      alb=mix(alb,liqFx*1.1,liq*bub*bLiq.z);

      // relieve del suelo a partir de la luminancia (en los sprites manda la luz de contorno)
      float hl=lum(texture2D(W,uv-vec2(o.x,0)).rgb), hr=lum(texture2D(W,uv+vec2(o.x,0)).rgb);
      float hd=lum(texture2D(W,uv-vec2(0,o.y)).rgb), hu=lum(texture2D(W,uv+vec2(0,o.y)).rgb);
      vec3 n=normalize(vec3((hl-hr)*relief*3.,(hd-hu)*relief*3.,1.));
      float ndl=max(dot(n,normalize(vec3(moonDir,.9))),0.);

      vec2 vis=texture2D(S,uv).rg;
      float moonVis=mix(1.,vis.r,shadowK);
      // copas de los árboles: la luz de luna llega a manchas que se mecen con el viento
      moonVis*=mix(1.,.55+.45*smoothstep(.3,.7,noise(wp*.012+vec2(time*.015,time*.01))),bFx.y);
      float torchVis=mix(1.,vis.g,.88);
      vec2 dT=(uv-center)*vec2(aspect,1.);
      // escena clara (hielo, cielo, arena): menos antorcha, menos niebla y menos exposición,
      // o el suelo casi blanco se quema en crema y pierde su color
      float bk=smoothstep(.32,.62,texture2D(EXPO,vec2(.5)).r);
      float att=torchAtt(uv)*(1.-.55*bk);
      float tdl=.55+.45*max(dot(n,normalize(vec3(-dT,.35))),0.);
      // Parpadeo de vela de cada emisor, cada zona a su ritmo. Se funde entre campos de ruido
      // fijos: un ruido que se desplaza con el tiempo se ve como ráfagas de viento barriendo el suelo.
      float ft=time*5., f0=floor(ft), fk=smoothstep(0.,1.,fract(ft));
      float fn=mix(noise(wp*.008+f0*17.31),noise(wp*.008+(f0+1.)*17.31),fk);
      float flk=1.+bFx.w*(fn-.5)*.35;
      vec3 g=texture2D(GI,uv).rgb*gi*flk;
      g/=1.+lum(g)*1.4; // tope suave: un lago de lava ilumina su orilla, no tiñe toda la pantalla

      // oclusión ambiental: el suelo se oscurece al pie de lo que tiene encima
      float aoF=1.-ao*smoothstep(.05,.55,texture2D(B1,uv).a)*(1.-occ);

      // luz de contorno: borde del sprite que mira a la antorcha / a la luna
      float ex=texture2D(M,uv+vec2(o.x,0)).a-texture2D(M,uv-vec2(o.x,0)).a;
      float ey=texture2D(M,uv+vec2(0,o.y)).a-texture2D(M,uv-vec2(0,o.y)).a;
      vec2 edge=-vec2(ex,ey); float el=length(edge);
      vec2 en=edge/(el+1e-4);
      float rimT=max(dot(en,normalize(-dT+1e-4)),0.)*att;
      float rimM=max(dot(en,moonDir),0.)*.35*moonVis;
      vec3 rimL=(torch*rimT+moon*rimM+g*.6)*smoothstep(.05,.5,el)*occ*rim;

      vec3 light=ambient*aoF*(.7+.3*moonVis)
                +moon*ndl*moonVis*1.2
                +torch*att*tdl*torchVis
                +g*aoF+rimL
                +flashCol*flash*aoF // relámpago lejano (sólo un fogonazo suave)
                +vec3(.6,.35,1.)*riftA*exp(-rd*rd*.12)*(1.+.25*sin(time*3.)); // luz violeta de la grieta, que palpita
      vec3 e=m.rgb;
      float em=clamp(max(max(e.r,e.g),e.b)*2.,0.,1.);
      vec3 b=(texture2D(B1,uv).rgb*.5+texture2D(B2,uv).rgb*.32+texture2D(B3,uv).rgb*.18)*flk;
      // sombras con cambio de tono, como las pinta un pixel artist: no sólo más oscuras, más frías
      float shAmt=clamp((1.-moonVis)*1.3+(1.-torchVis)*smoothstep(.02,.3,att)+(1.-aoF)*1.5,0.,1.);
      // Suelo de luz: sombra de luna + sombra de antorcha + oclusión se multiplicaban y, donde
      // coincidían las tres, el suelo se quedaba casi negro. Nunca por debajo del 70 % del ambiente.
      light=max(light,ambient*.7);
      vec3 col=alb*light*mix(vec3(1.),shadowHue,shAmt*.8)+b*bloom*(1.-em*.8);
      // el líquido: brillo propio (veneno, pantano), que respira despacio, y destellos donde le da la luz
      col+=liq*liqFx*bLiq.x*(.3+.06*sin(time*.8+noise(pa*.05)*6.));
      float glint=step(.985,hash(pa+floor(time*3.)))*step(.5,noise(pa*.2+time*.5));
      col+=liq*glint*bLiq.w*(torch*att*1.5+moon*moonVis*.8);
      if(liq>.01&&quality>1.5){
        // toda la superficie refleja: brillo de luna y antorcha que corre con las ondas,
        // las luces cercanas (fuegos, calabazas, ataques) temblando, y un poco de cielo
        float sheen=smoothstep(.55,.95,noise(pa*vec2(.05,.16)+vec2(time*.15,time*.05)))*smoothstep(.3,.8,noise(pa*.03-time*.07));
        vec3 sky=moon*moonVis*.12+torch*att*.25;
        vec3 rl=(texture2D(B1,mirUv).rgb*.6+texture2D(B2,mirUv).rgb*.4)*mirOn;
        col+=liq*bLiq.w*(sheen*(moon*moonVis*.35+torch*att*.6)+sky+rl*1.2);
      }
      // escarcha / polvo de cristal: destellos sueltos en el suelo que se encienden y apagan
      float frost=step(.994,hash(pa*1.7+floor(time*2.5)))*(1.-liq)*(1.-above)*bFx2.y;
      col+=frost*(vec3(.45,.5,.55)+torch*att+moon*moonVis*.6);

      // niebla volumétrica anclada al mundo (se mueve con el viento, no con la cámara)
      float dens=fbm(wp*.014+vec2(time*.05,time*.018));
      dens=smoothstep(.3,1.,dens)*fog*.55*(1.-.65*bk); // rampa ancha: bordes difusos, sin manchas
      // haces: de este píxel hacia la antorcha y hacia la luna, mirando qué parte está a la sombra
      float sh=0.,sm=0.;
      if(quality>.5){
        float j=hash(uv*res+fract(time)*31.);
        for(int i=0;i<10;i++){float t=(float(i)+j)/10.;
          vec2 q=mix(uv,center,t*.9); sh+=texture2D(S,q).g*torchAtt(q);
          sm+=texture2D(S,uv+vec2(moonDir.x/aspect,moonDir.y)*t*.08).r;}
        sh/=10.; sm/=10.;
      }else{sh=torchVis*att;sm=moonVis;}
      vec3 scatter=fogCol+torch*sh*shafts*.8+moon*sm*.25*shafts+g*.6;
      col=col*(1.-dens*.6)+scatter*dens;

      // partículas del escenario (luciérnagas, destellos, brasas, fuegos fatuos, esporas),
      // iluminadas por lo que haya cerca y con su propio brillo
      vec2 mp=wp/(26.*moteP.w)+vec2(0.,time*moteP.y);
      vec2 cell=floor(mp); vec2 fp=fract(mp);
      float r1=hash(cell);
      vec2 c=vec2(hash(cell+1.7),hash(cell+4.3))*.7+.15+.1*vec2(sin(time*1.3+r1*40.),cos(time*1.1+r1*30.));
      float blink=mix(.6+.4*sin(time*3.+r1*60.),pow(max(0.,sin(time*1.7+r1*60.)),4.),moteP.z);
      float dot_=(1.-smoothstep(.0,.045,length(fp-c)))*step(1.-moteP.x*.3,r1)*blink;
      col+=dot_*motes*.55*(torch*att*1.2+g*1.5+moon*.25+moteCol*.6);

      // chispas que caen en espiral hacia la grieta, y su halo
      if(riftA>0.){
        float th=atan(rq.y,rq.x);
        vec2 pc=vec2((th/6.2832+.5)*14.+rd*2.,rd*4.+time*1.6);
        vec2 cf=fract(pc)-.5;
        float pd=step(.75,hash(floor(pc)+3.1))*(1.-smoothstep(0.,.22,length(cf)))*(1.-smoothstep(1.5,3.4,rd))*smoothstep(.7,1.2,rd);
        col+=pd*riftA*vec3(.85,.7,1.)*.8;
        col+=vec3(.45,.25,.8)*riftA*exp(-rd*rd*.4)*.22;
      }

      // tonemap, sin tonemap encima de los emisores (una calabaza no vira a amarillo)
      col=aces(col*exposure*(1.-.3*bk));
      col=mix(col,alb*(.62+.25*light),bk*.42); // en escenas claras manda más el color del juego
      col=mix(col,alb,em*.85);
      // Los sprites conservan su color: con mucha luz cálida y la curva de tonos, un Gastly morado
      // junto al jugador se quedaba rosa pálido. Se mantiene su brillo y se le devuelve el tono.
      float lc=lum(col), la=max(lum(alb),.04);
      col=mix(col,clamp(alb*(lc/la),0.,1.),smoothstep(.3,.8,occ)*.55);
      col=mix(col,neb,core); // el interior de la grieta brilla por sí mismo, no lo apaga la noche
      float l=lum(col);
      col*=mix(lowTint,highTint,smoothstep(.15,.7,l));
      col=mix(vec3(l),col,sat*(1.+.18*bk));
      // un poco más de contraste: negros algo más hondos y medios tonos que no se lavan;
      // los claros se quedan como estaban (estirarlos quemaba los blancos)
      // y los muy oscuros tampoco: ahí apretar sólo convertía las sombras en manchas negras
      vec3 cst=clamp((col-.42)*1.14+.42-.012,0.,1.);
      col=mix(cst,col,smoothstep(.55,.9,col)+1.-smoothstep(.04,.2,col));
      col*=1.-vignette*bFx2.z*dot(cuv,cuv)*1.6;
      col+=(hash(uv*res+fract(time*7.)*113.)-.5)*.03; // grano

      if(dbg>.5&&dbg<1.5)col=vec3(occ);
      if(dbg>1.5&&dbg<2.5)col=vec3(vis,0.);
      if(dbg>2.5&&dbg<3.5)col=m.rgb+b;
      if(dbg>3.5&&dbg<4.5)col=g;
      if(dbg>4.5&&dbg<5.5)col=vec3(dens)+scatter*dens;
      if(dbg>5.5)col=vec3(texture2D(HT,uv).r*1.5,occ*.3,0.);
      gl_FragColor=vec4(col,1.);
    }`;

  function compile(fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
    return { p, u };
  }

  let P;
  try {
    P = {
      prep: compile(FS_PREP), height: compile(FS_HEIGHT), shadow: compile(FS_SHADOW), gi: compile(FS_GI), temporal: compile(FS_TEMPORAL), avg: compile(FS_AVG), pcol: compile(FS_PCOL),
      down: compile(FS_DOWN), blur: compile(FS_BLUR), comp: compile(FS_COMP)
    };
  } catch (e) { console.warn('[luz] shaders:', e); cv.remove(); return; }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  function tex() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function target(w, h) {
    const t = tex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    return { t, f, w, h };
  }
  const texW = tex(), texG = tex(), texFX = tex(), texATK = tex();

  // atlas de decoración de suelo: 8 sprites de 8×8. Cada carácter es un tono que el shader
  // colorea con el suelo de debajo: d oscuro · m medio · l claro · a pétalo · b centro · r seta · w punto
  const DECO_SPRITES = [
    ['........', '...l....', '.l.m..l.', '.m.m.lm.', '.mdm.md.', '..dmdd..', '...dd...', '........'], // mata
    ['........', '........', '....l...', '..l.m.l.', '..m.md..', '..dmd...', '...d....', '........'], // mata pequeña
    ['........', '...a....', '..aba...', '...a....', '...m....', '..lm....', '...d....', '........'], // flor
    ['........', '.a......', 'aba..a..', '.a..aba.', '.m...a..', '.m...m..', '.d..dm..', '........'], // dos flores
    ['........', '........', '...ll...', '..lmmd..', '..dmd...', '.....lm.', '.....dd.', '........'], // piedrecitas
    ['........', '........', '..llm...', '.lmmmd..', '.mmmdd..', '..ddd...', '........', '........'], // piedra
    ['........', '.....l..', '....m...', '.l.m....', '..md....', '.d.m....', '...d....', '........'], // ramita
    ['........', '...rr...', '..rwrr..', '.rrrrwr.', '...ll...', '...lm...', '...dd...', '........']  // seta
  ];
  const texDeco = tex();
  {
    const T2 = { '.': 0, d: 1, m: 2, l: 3, a: 4, b: 5, r: 6, w: 7 };
    const px = new Uint8Array(64 * 8 * 4);
    DECO_SPRITES.forEach((rows, s) => rows.forEach((row, y) => [...row].forEach((ch, x) => {
      const i = (y * 64 + s * 8 + x) * 4; px[i] = T2[ch]; px[i + 3] = 255;
    })));
    gl.bindTexture(gl.TEXTURE_2D, texDeco);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // la fila 0 es la de arriba del sprite
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 8, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  }
  let decoOn = !/[?&]deco=0/.test(location.search);
  let T = null, size = '', fresh = 2;
  function ensureTargets(w, h) {
    const k = w + 'x' + h;
    if (k === size) return;
    size = k;
    fresh = 2; // los historiales nuevos están en negro: los dos primeros frames no se mezclan con ellos
    if (T) for (const r of Object.values(T)) { gl.deleteTexture(r.t); gl.deleteFramebuffer(r.f); }
    const d = n => [Math.ceil(w / n), Math.ceil(h / n)];
    T = {
      prep: target(...d(2)), height: target(...d(2)), shadow: target(...d(2)), shadowb: target(...d(2)),
      sHistA: target(...d(2)), sHistB: target(...d(2)),
      q: target(...d(4)), gi: target(...d(4)), histA: target(...d(4)), histB: target(...d(4)),
      giOut: target(...d(4)), giTmp: target(...d(4)),
      e8: target(...d(8)), e8b: target(...d(8)),
      e16: target(...d(16)), e16b: target(...d(16)),
      e32: target(...d(32)), e32b: target(...d(32)),
      avg: target(1, 1), avgA: target(1, 1), avgB: target(1, 1), pcol: target(1, 1)
    };
  }

  function pass(prog, out, binds, set) {
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.f : null);
    gl.viewport(0, 0, out ? out.w : cv.width, out ? out.h : cv.height);
    binds.forEach(([name, t], i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(prog.u[name], i); });
    if (set) set(prog.u);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function blur(src, tmp) {
    pass(P.blur, tmp, [['T', src.t]], u => gl.uniform2f(u.dir, 1.6 / src.w, 0));
    pass(P.blur, src, [['T', tmp.t]], u => gl.uniform2f(u.dir, 0, 1.6 / src.h));
  }
  function down(src, dst) {
    pass(P.down, dst, [['T', src.t]], u => gl.uniform2f(u.px, .5 / src.w, .5 / src.h));
  }

  // ---------- ajustes: fundido suave al cambiar de preset con la L ----------
  function lerpPreset(a, b, t) {
    const o = {};
    for (const k in a) o[k] = Array.isArray(a[k]) ? a[k].map((v, i) => v + (b[k][i] - v) * t) : a[k] + (b[k] - a[k]) * t;
    return o;
  }
  let shown = PRESETS[mode === 'off' ? 'noche' : mode];

  // ---------- calidad automática ----------
  // 3: GI 16 rayos · 2: GI 8 · 1: GI 4 · 0: sin GI ni haces
  let quality = matchMedia('(pointer:coarse)').matches ? 2 : 3;
  const RAYS = [0, 4, 8, 16];
  let slowSince = 0, fastSince = 0, lastT = 0, avgDt = 16;
  function adapt(now) {
    if (lastT) avgDt = avgDt * .95 + Math.min(100, now - lastT) * .05;
    lastT = now;
    if (avgDt > 21) { fastSince = 0; if (!slowSince) slowSince = now; else if (now - slowSince > 1500 && quality > 0) { quality--; slowSince = 0; } }
    else if (avgDt < 13) { slowSince = 0; if (!fastSince) fastSince = now; else if (now - fastSince > 6000 && quality < 3) { if (quality === 0) fresh = 2; quality++; fastSince = 0; } }
    else { slowSince = 0; fastSince = 0; }
  }

  let artScale = 2.5, camE = 0, camF = 0, prevE = 0, prevF = 0, debug = 0, frame = 0, histFlip = false;
  function render(now) {
    const w = game.width, h = game.height;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    ensureTargets(w, h);
    adapt(now);
    shown = lerpPreset(shown, PRESETS[mode] || shown, .04);
    frame++;
    const center = [0.5, 0.52];

    // escenario: el que más suelo pinta en este frame; fundido de ~1 s entre uno y otro
    const dt = Math.min(.1, (now - (render.last || now)) / 1000); render.last = now;
    let best = -1, bestN = 0, total = 0, second = 0;
    for (let s = 0; s < BIOMES.length; s++) {
      total += frameFloor[s];
      if (frameFloor[s] > bestN) { second = bestN; best = s; bestN = frameFloor[s]; } else second = Math.max(second, frameFloor[s]);
    }
    if (bestN <= 300) best = -1; // con tan poco suelo reconocible no se decide nada
    // con suelo de sobra en pantalla y ninguno conocido (un escenario nuevo, las arenas): ambiente neutro
    // el primero que se reconoce entra ya (al empezar no hay nada de qué fundir)
    if (best >= 0 && bioNow < 0 && !bioW.some(x => x > 0)) bioW[best] = 1;
    if (best >= 0) bioNow = best; else if (frameChunks >= 2 && binsFrame === frameId) bioNow = -1;
    // Fundido lineal de 2,5 s con curva suave en los extremos: el juego tarda en cambiar el
    // suelo y un fundido corto y exponencial se notaba como un salto.
    for (let s = 0; s < BIOMES.length; s++) bioW[s] = Math.max(0, Math.min(1, bioW[s] + (s === bioNow ? 1 : -1) * dt / 2.5));
    const ease = x => x * x * (3 - 2 * x);
    const bio = {};
    let wSum = 0; for (const v of bioW) wSum += ease(v);
    for (const key in NEUTRAL) {
      const n = NEUTRAL[key];
      let v = Array.isArray(n) ? n.slice() : n;
      for (let s = 0; s < BIOMES.length; s++) {
        const w = ease(bioW[s]);
        if (w > 1e-3) v = Array.isArray(v) ? v.map((x, i) => x + (BIOMES[s][key][i] - n[i]) * w) : v + (BIOMES[s][key] - n) * w;
      }
      bio[key] = v;
    }
    // Decoración: se apaga deprisa mientras el suelo de dos escenarios convive en pantalla y se
    // enciende despacio cuando queda uno solo (antes aparecía de golpe a mitad del cambio).
    const mixing = best >= 0 && second > bestN * .12;
    decoFade = Math.max(0, Math.min(1, decoFade + (mixing ? -dt / .5 : dt / 2.5)));
    // relámpagos lejanos: un fogonazo suave y doble cada 20-35 s (nunca un estroboscopio)
    if (bio.lightning > .01) {
      if (!render.nextFlash) render.nextFlash = now + 8000;
      if (now > render.nextFlash) { render.flashAt = now; render.nextFlash = now + 20000 + Math.random() * 15000; }
    }
    const ft = (now - (render.flashAt || -1e9)) / 1000;
    const flash = (calm ? 0 : 1) * bio.lightning * (Math.exp(-ft * 6) * (ft >= 0) + .6 * Math.exp(-Math.max(0, ft - .22) * 5) * (ft > .22)) * .35;
    const S = Object.assign({}, shown, {
      lowTint: shown.lowTint.map((v, i) => v * bio.gLow[i]),
      highTint: shown.highTint.map((v, i) => v * bio.gHigh[i]),
      ambient: shown.ambient.map((v, i) => v * bio.tint[i]),
      torch: partnerTorch(shown.torch),
      moon: shown.moon.map(v => v * bio.moonMul),
      fogCol: shown.fogCol.map((v, i) => v + (bio.fogCol[i] - v) * Math.min(1, wSum) * .7),
      fog: shown.fog * bio.fogMul
    });
    const dom = bioNow >= 0 ? BIOMES[bioNow] : null;

    pass(P.prep, T.prep, [['W', texW], ['G', texG], ['FX', texFX], ['ATK', texATK]], u => { gl.uniform2f(u.o, artScale / w, artScale / h); gl.uniform1f(u.emitBoost, bio.emit);
      // sin escenario reconocido se deja emitir al suelo como antes (no se sabe qué hay)
      gl.uniform1f(u.groundEmit, bioNow >= 0 ? Math.min(1, bio.liqGlow * 1.2) : 1); });
    pass(P.height, T.height, [['M', T.prep.t]], u => gl.uniform2f(u.res, T.prep.w, T.prep.h));
    pass(P.shadow, T.shadow, [['M', T.prep.t], ['HT', T.height.t]], u => {
      gl.uniform2f(u.res, T.prep.w, T.prep.h);
      gl.uniform2f(u.moonDir, S.moonDir[0], S.moonDir[1]);
      gl.uniform2f(u.center, center[0], center[1]);
      gl.uniform1f(u.art, artScale / 2);
      gl.uniform1f(u.frame, frame % 1000);
      gl.uniform1f(u.jmode, tune.jmode);
      gl.uniform2f(u.cam, camE, camF);
    });
    const camShift = [(prevE - camE) / w, (camF - prevF) / h];
    const sHist = histFlip ? T.sHistA : T.sHistB, sHistOut = histFlip ? T.sHistB : T.sHistA;
    if (tune.temporal) {
      pass(P.temporal, sHistOut, [['C', T.shadow.t], ['H', sHist.t]], u => {
        gl.uniform2f(u.shift, camShift[0], camShift[1]);
        gl.uniform2f(u.texel, 1 / T.shadow.w, 1 / T.shadow.h);
        gl.uniform1f(u.blend, fresh ? 1 : tune.blend);
        gl.uniform1f(u.clampK, tune.clampK);
      });
      pass(P.down, T.shadow, [['T', sHistOut.t]], u => gl.uniform2f(u.px, 0, 0));
    }
    blur(T.shadow, T.shadowb);

    // escena a 1/4 para la luz global
    down(T.prep, T.q);
    const hist = histFlip ? T.histA : T.histB, histOut = histFlip ? T.histB : T.histA;
    histFlip = !histFlip;
    if (quality > 0) {
      pass(P.gi, T.gi, [['S', T.q.t]], u => {
        gl.uniform2f(u.res, T.q.w, T.q.h);
        gl.uniform1f(u.frame, frame % 1000);
        gl.uniform1f(u.rays, RAYS[quality]);
      });
      pass(P.temporal, histOut, [['C', T.gi.t], ['H', hist.t]], u => {
        gl.uniform2f(u.shift, camShift[0], camShift[1]);
        gl.uniform2f(u.texel, 1 / T.gi.w, 1 / T.gi.h);
        gl.uniform1f(u.blend, fresh ? 1 : .22);
        gl.uniform1f(u.clampK, 0);
      });
      pass(P.down, T.giOut, [['T', histOut.t]], u => gl.uniform2f(u.px, 0, 0));
      blur(T.giOut, T.giTmp);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.giOut.f); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    }
    prevE = camE; prevF = camF;

    // bloom en tres escalas (el alfa lleva los oclusores desenfocados → oclusión ambiental)
    down(T.q, T.e8); blur(T.e8, T.e8b); blur(T.e8, T.e8b);
    down(T.e8, T.e16); blur(T.e16, T.e16b); blur(T.e16, T.e16b);
    down(T.e16, T.e32); blur(T.e32, T.e32b); blur(T.e32, T.e32b);

    pass(P.pcol, T.pcol, [['W', texW], ['M', T.prep.t], ['G', texG]], u => {
      gl.uniform2f(u.center, center[0], center[1]);
      gl.uniform2f(u.box, artScale * 14 / w, artScale * 18 / h);
    });

    // exposición automática: brillo medio del mundo, suavizado en el tiempo (~1 s), como un ojo
    pass(P.avg, T.avg, [['W', texW]]);
    const aHist = histFlip ? T.avgA : T.avgB, aOut = histFlip ? T.avgB : T.avgA;
    pass(P.temporal, aOut, [['C', T.avg.t], ['H', aHist.t]], u => {
      gl.uniform2f(u.shift, 0, 0); gl.uniform2f(u.texel, 1, 1);
      gl.uniform1f(u.blend, fresh ? 1 : Math.max(.15, Math.min(1, dt * 3))); gl.uniform1f(u.clampK, 0);
    });

    pass(P.comp, null, [['W', texW], ['S', T.shadow.t], ['M', T.prep.t], ['GI', T.giOut.t],
      ['B1', T.e8.t], ['B2', T.e16.t], ['B3', T.e32.t], ['HT', T.height.t], ['G', texG], ['DECO', texDeco], ['EXPO', aOut.t]], u => {
      gl.uniform1f(u.decoOn, decoOn ? decoFade * decoFade * (3 - 2 * decoFade) : 0);
      gl.uniform1f(u.grassRatio, grassRatio);
      gl.uniform2f(u.res, w, h);
      gl.uniform2f(u.cam, camE, camF);
      gl.uniform2f(u.center, center[0], center[1]);
      gl.uniform1f(u.art, artScale);
      gl.uniform1f(u.aspect, w / h);
      gl.uniform1f(u.time, (now / 1000) % 3600);
      gl.uniform1f(u.dbg, debug);
      gl.uniform1f(u.quality, quality);
      for (const k of ['ambient', 'moon', 'torch', 'fogCol', 'lowTint', 'highTint', 'shadowHue']) gl.uniform3fv(u[k], S[k]);
      gl.uniform2f(u.moonDir, S.moonDir[0], S.moonDir[1]);
      gl.uniform1f(u.shadowK, S.shadow);
      for (const k of ['torchR', 'gi', 'bloom', 'relief', 'sat', 'fog', 'shafts', 'motes', 'ao', 'rim'])
        gl.uniform1f(u[k], S[k]);
      gl.uniform1f(u.exposure, S.exposure * expoGain);
      gl.uniform1f(u.vignette, S.vignette * (now - gameVignetteSeen < 600 ? .4 : 1));
      const liq = dom ? dom.liq.map(hex) : [[9, 9, 9], [9, 9, 9]]; // sin escenario: ningún color coincide
      gl.uniform3fv(u.liqA, liq[0]); gl.uniform3fv(u.liqB, liq[1]);
      gl.uniform3fv(u.liqFx, dom ? dom.liqFx : [0, 0, 0]);
      gl.uniform3fv(u.moteCol, bio.moteCol);
      gl.uniform4f(u.bFx, bio.moonMul, bio.canopy, bio.lightning, bio.flicker);
      gl.uniform4f(u.bLiq, bio.liqGlow, bio.caustic, bio.bubbles, bio.spec);
      gl.uniform4f(u.bFx2, bio.heat, bio.glitter, bio.vignetteMul, calm ? 1 : 0);
      gl.uniform3fv(u.flashCol, bio.flashCol);
      const rOn = rift && rift.f === frameId;
      gl.uniform4f(u.rift, rOn ? rift.x : -1e4, rOn ? h - rift.y : -1e4, rOn ? rift.rx : 1, rOn ? rift.ry : 1);
      gl.uniform1f(u.riftA, rOn ? rift.a : 0);
      gl.uniform4f(u.moteP, bio.moteDen, bio.moteRise, bio.moteBlink, bio.moteSize);
      gl.uniform1f(u.flash, flash);
    });
    if (fresh) fresh--;
    meterExposure(now, aOut);
    if (onFrame) onFrame(gl, camE, camF);
  }

  // Exposición en bucle cerrado: dos veces por segundo se compara el brillo medio de la imagen
  // iluminada con el del mundo tal como lo pinta el juego, y se corrige poco a poco hacia un
  // objetivo (un pelín por debajo de noche, igual al atardecer, un pelín por encima de día).
  // La curva de tonos levanta los medios tonos: sin esto, una escena "de noche" salía más clara
  // que el juego sin luces (la Gruta Marina, un 24 % más).
  let expoGain = 1, lastMeter = 0;
  const partnerCol = [1, .75, .5]; // color del compañero (se aprende del sprite)
  // La luz que lleva el jugador toma un 45 % del color de su compañero, con el mismo brillo:
  // Scorbunny alumbra cálido, Mudkip azulado, Snivy verdoso.
  const lumOf = c => .299 * c[0] + .587 * c[1] + .114 * c[2];
  function partnerTorch(t) {
    const mx = Math.max(...partnerCol, .01), pc = partnerCol.map(v => v / mx);
    const k = lumOf(t) / Math.max(lumOf(pc), .05);
    return t.map((v, i) => v + (pc[i] * k - v) * .45);
  }
  const METER_TARGET = { noche: .9, atardecer: .97, dia: 1.04 };
  const meterPx = new Uint8Array(4);
  function meterExposure(now, avgTarget) {
    if (now - lastMeter < 900) return; // cada lectura frena un instante la GPU: una por segundo basta
    lastMeter = now;
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.avg.f);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, meterPx);
    const world = meterPx[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.pcol.f);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, meterPx);
    if (meterPx[3] > 20) for (let i = 0; i < 3; i++) partnerCol[i] += (meterPx[i] / 255 - partnerCol[i]) * .5;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let lit = 0;
    for (let i = 0; i < 16; i++) {
      gl.readPixels(Math.floor(((i & 3) + .5) / 4 * cv.width), Math.floor(((i >> 2) + .5) / 4 * cv.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, meterPx);
      lit += .299 * meterPx[0] + .587 * meterPx[1] + .114 * meterPx[2];
    }
    lit /= 16;
    if (world < 3 || lit < 3) return;
    const target = world * (METER_TARGET[mode] || 1);
    expoGain = Math.max(.55, Math.min(1.5, expoGain * Math.max(.88, Math.min(1.12, Math.pow(target / lit, .4)))));
  }
  let onFrame = null; // gancho de pruebas: se llama con el frame ya pintado (aún legible)
  // jmode 2: ruido anclado al mundo (no titila al mover la cámara). Medido con _test/flicker.js:
  // la mezcla temporal deja el parpadeo de las sombras en movimiento entre 2 y 4 veces más bajo.
  const tune = { jmode: 2, temporal: true, blend: .22, clampK: .2, fx: true };

  function snap(t) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, game);
  }

  // ---------- escucha del contexto 2D del juego ----------
  const ctx = game.getContext('2d');
  const C2 = CanvasRenderingContext2D.prototype;
  const _save = C2.save, _restore = C2.restore, _clear = C2.clearRect, _setT = C2.setTransform;
  let depth = 0, phase = 0; // 0 nada · 1 suelo · 2 entidades · 3 HUD
  const stats = { ok: 0, p1: 0, p2: 0, p3: 0 };

  // Las fases se siguen siempre (las variantes funcionan también con la luz apagada);
  // las fotos, el borrado y el render sólo con la luz encendida.
  let frameId = 0, rift = null;
  C2.clearRect = function (x, y, w, h) {
    if (this === ctx && depth === 0 && phase === 0) { phase = 1; frameId++; texts.length = 0; pathCmds.length = 0; }
    return _clear.call(this, x, y, w, h);
  };
  C2.save = function () {
    if (this === ctx) {
      depth++;
      // (sólo si se ha pintado suelo en este frame: un menú con paneles anidados no es el mundo)
      if (phase === 1 && depth === 2 && binsFrame === frameId && frameChunks > 0 && game.width > 1 && game.height > 1) {
        const m = this.getTransform();
        artScale = Math.abs(m.a) || artScale;
        camE = m.e; camF = m.f;
        if (lit()) { try { snap(texG); fxBegin(); } catch (e) { fail(e); } }
        phase = 2;
      }
    }
    return _save.call(this);
  };
  C2.restore = function () {
    const r = _restore.call(this);
    if (this === ctx) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && phase === 2) {
        if (lit()) {
          let okSnap = true;
          try { snap(texW); fxUpload(); } catch (e) { fail(e); okSnap = false; }
          if (okSnap) {
            _save.call(this); _setT.call(this, 1, 0, 0, 1, 0, 0); _clear.call(this, 0, 0, game.width, game.height); _restore.call(this);
          }
          replayTexts(this);
        }
        phase = 3;
      }
    }
    return r;
  };

  // ---------- textos del mundo (números de daño, nombres, "GRIETA 59 m") ----------
  // El juego los dibuja junto a los Pokémon: quedaban oscurecidos por la noche, teñidos por la
  // gradación y hasta proyectaban sombra. Se apartan mientras se pinta el mundo y se repiten,
  // tal cual y en el mismo orden, encima de la luz, justo antes del HUD.
  const _fillText = C2.fillText, _strokeText = C2.strokeText;
  const TEXT_STATE = ['font', 'fillStyle', 'strokeStyle', 'lineWidth', 'lineJoin', 'miterLimit', 'textAlign', 'textBaseline',
    'globalAlpha', 'globalCompositeOperation', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'direction'];
  const texts = [];
  function deferText(c, fn, args) {
    const st = { m: c.getTransform(), fn, args };
    for (const k of TEXT_STATE) st[k] = c[k];
    texts.push(st);
  }
  function replayTexts(c) {
    if (!texts.length) return;
    _save.call(c);
    for (const t of texts) {
      for (const k of TEXT_STATE) c[k] = t[k];
      _setT.call(c, t.m.a, t.m.b, t.m.c, t.m.d, t.m.e, t.m.f);
      t.fn.apply(c, t.args);
    }
    _restore.call(c);
    texts.length = 0;
  }
  C2.fillText = function () { if (this === ctx && phase === 2 && lit()) { deferText(this, _fillText, [...arguments]); return; } return _fillText.apply(this, arguments); };
  C2.strokeText = function () { if (this === ctx && phase === 2 && lit()) { deferText(this, _strokeText, [...arguments]); return; } return _strokeText.apply(this, arguments); };

  // El juego pinta su propia viñeta (un degradado a pantalla completa) encima del mundo: si la
  // hay, la del shader se reduce para no oscurecer los bordes dos veces.
  let gameVignetteSeen = -1e9;

  // ---------- máscara de efectos (no proyectan sombra) ----------
  // Las sombras salen de "lo que hay encima del suelo", y eso incluía las zonas de ataque, los
  // avisos en el suelo, los brillos de las gemas y hasta las sombritas negras de los Pokémon.
  // Todo lo que el juego dibuja con transparencia (o en modo de mezcla) entre el suelo y el HUD
  // se repite aquí, en blanco y a media resolución, con la misma transformación; el shader quita
  // esos píxeles de los oclusores. Los trazados se graban al construirse para poder repetirlos.
  // atk: los mismos efectos pero en su color, para que los ataques emitan un poco de su luz
  const fxCv = document.createElement('canvas'), fx = fxCv.getContext('2d');
  const atkCv = document.createElement('canvas'), atk = atkCv.getContext('2d');
  const PATH_OPS = ['moveTo', 'lineTo', 'arc', 'arcTo', 'ellipse', 'rect', 'closePath', 'quadraticCurveTo', 'bezierCurveTo', 'roundRect'];
  const pathCmds = [];
  const recording = c => c === ctx && phase === 2 && tune.fx && lit();
  function isFx(c, style) {
    if (c.globalAlpha < .9 || c.globalCompositeOperation !== 'source-over') return true;
    if (typeof style !== 'string') return true; // degradados y patrones: halos, auras
    const m = /rgba?\([^)]*,\s*([\d.]+)\s*\)/.exec(style);
    return !!m && style.startsWith('rgba') && +m[1] < .9;
  }
  const fxT = m => {
    fx.setTransform(m.a * .5, m.b * .5, m.c * .5, m.d * .5, m.e * .5, m.f * .5);
    atk.setTransform(m.a * .5, m.b * .5, m.c * .5, m.d * .5, m.e * .5, m.f * .5);
  };
  function fxBegin() {
    const w = game.width >> 1, h = game.height >> 1;
    for (const [cv2, c2] of [[fxCv, fx], [atkCv, atk]]) {
      if (cv2.width !== w || cv2.height !== h) { cv2.width = w; cv2.height = h; }
      c2.setTransform(1, 0, 0, 1, 0, 0); c2.clearRect(0, 0, w, h);
    }
    fx.fillStyle = fx.strokeStyle = '#fff';
  }
  function fxUpload() {
    gl.bindTexture(gl.TEXTURE_2D, texFX);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fxCv);
    gl.bindTexture(gl.TEXTURE_2D, texATK);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atkCv);
  }
  function fxPath(c, kind, arg) {
    const style = kind === 'fill' ? c.fillStyle : c.strokeStyle;
    atk.globalAlpha = c.globalAlpha; atk.fillStyle = atk.strokeStyle = style;
    for (const t of [fx, atk]) {
      t.beginPath();
      if (arg instanceof Path2D) { fxT(c.getTransform()); if (kind === 'stroke') t.lineWidth = c.lineWidth; t[kind](arg); continue; }
      for (const [n, a, m] of pathCmds) { fxT(m); t[n](...a); }
      if (kind === 'stroke') { fxT(c.getTransform()); t.lineWidth = c.lineWidth; }
      t[kind]();
    }
  }
  C2.beginPath = (o => function () { if (this === ctx) pathCmds.length = 0; return o.apply(this, arguments); })(C2.beginPath);
  for (const n of PATH_OPS) {
    const o = C2[n]; if (!o) continue;
    C2[n] = function () { if (recording(this) && pathCmds.length < 4096) pathCmds.push([n, [...arguments], this.getTransform()]); return o.apply(this, arguments); };
  }
  C2.fill = (o => function (a) { if (recording(this) && isFx(this, this.fillStyle)) fxPath(this, 'fill', a); return o.apply(this, arguments); })(C2.fill);
  C2.stroke = (o => function (a) { if (recording(this) && isFx(this, this.strokeStyle)) fxPath(this, 'stroke', a); return o.apply(this, arguments); })(C2.stroke);
  C2.fillRect = (o => function (x, y, w, h) {
    if (this === ctx && phase === 3 && depth === 0 && typeof this.fillStyle !== 'string' && w * h * this.getTransform().a ** 2 > game.width * game.height * .5)
      gameVignetteSeen = performance.now();
    if (recording(this) && isFx(this, this.fillStyle)) {
      fxT(this.getTransform()); fx.fillRect(x, y, w, h);
      atk.globalAlpha = this.globalAlpha; atk.fillStyle = this.fillStyle; atk.fillRect(x, y, w, h);
    }
    return o.apply(this, arguments);
  })(C2.fillRect);

  // ---------- variantes de árboles, árboles secos, cristales, rocas y hierba alta ----------
  // Las genera js/props.js con los mismos pintores del juego (sólo cambian las formas); aquí
  // se decide cuál toca a cada objeto según su posición en el mundo, para que siempre sea el
  // mismo. Sólo se sustituye un sprite que props.js ha reconocido píxel a píxel como uno de esos
  // pintores, así que no se tocan objetos para recoger, ataques ni nada que no sea decorado.
  const PROP_SIZES = new Set(['20x17', '22x17', '28x40', '30x40', '26x40']); // hierba, roca, seco, árbol, cristal
  const _draw = C2.drawImage;
  let variantsOn = !/[?&]variantes=0/.test(location.search);
  function hash2(x, y) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  // ---------- verde típico de la hierba del mapa ----------
  // El suelo llega en trozos de 256×256 ya pintados. De cada trozo nuevo se saca la proporción
  // verde/rojo de sus píxeles verdes; la mediana es la hierba del mapa. El pantano es verde
  // también, pero bastante más saturado: así la decoración no crece dentro del agua.
  // Se cuenta sólo con los trozos pintados en el frame actual: al cambiar de escenario cada
  // 4 minutos la hierba cambia de color y lo aprendido del escenario anterior no vale.
  const chunkBins = new WeakMap();                 // trozo → histograma de verde/rojo
  const frameBins = new Float64Array(160);         // verde/rojo de 0,8 a 2,4 en pasos de 0,01
  let binsFrame = -1, grassRatio = 1.25, frameChunks = 0;
  const frameFloor = new Float64Array(BIOMES.length); // píxeles de suelo de cada escenario en este frame
  function chunkRatio(img) {
    let info = chunkBins.get(img);
    if (!info) {
      info = { bins: new Uint32Array(160), floor: new Uint32Array(BIOMES.length) };
      chunkBins.set(img, info);
      let d;
      try { d = img.getContext('2d').getImageData(0, 0, img.width, img.height).data; } catch (e) { return; }
      for (let i = 0; i < d.length; i += 16) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (g > r && g > b && r > 8) { const k = Math.round((g / r - .8) * 100); if (k >= 0 && k < 160) info.bins[k]++; }
        const c = (r << 16) | (g << 8) | b;
        for (let s = 0; s < FLOOR_RGB.length; s++) if (FLOOR_RGB[s].includes(c)) { info.floor[s]++; break; }
      }
    }
    const bins = info.bins;
    if (binsFrame !== frameId) { frameBins.fill(0); frameFloor.fill(0); frameChunks = 0; binsFrame = frameId; }
    frameChunks++;
    for (let s = 0; s < BIOMES.length; s++) frameFloor[s] += info.floor[s];
    for (let k = 0; k < 160; k++) frameBins[k] += bins[k];
    let tot = 0; for (let k = 0; k < 160; k++) tot += frameBins[k];
    if (!tot) return;
    let acc = 0;
    for (let k = 0; k < 160; k++) { acc += frameBins[k]; if (acc >= tot / 2) { grassRatio = .8 + k / 100; break; } }
  }

  C2.drawImage = function (img, dx, dy, dw, dh) {
    if (this === ctx && phase === 1 && img instanceof HTMLCanvasElement && img.width === 256 && img.height === 256)
      chunkRatio(img);
    // Ataques y efectos no proyectan sombra y emiten un poco de luz de su color: los sprites
    // translúcidos o en modo de mezcla (destellos, auras, impactos) y los que el juego dibuja
    // centrados en su propio origen tras girarlos (proyectiles: dx ≈ −ancho/2, dy ≈ −alto/2).
    if (recording(this) && (this.globalAlpha < .9 || this.globalCompositeOperation !== 'source-over' ||
        (arguments.length === 5 && Math.abs(dx + dw / 2) < 1.5 && Math.abs(dy + dh / 2) < 1.5))) {
      fxT(this.getTransform()); _draw.apply(fx, arguments);
      atk.globalAlpha = Math.min(1, this.globalAlpha); _draw.apply(atk, arguments);
    }
    // la grieta: el juego pinta su sprite (propSprite 'rift', 30×46, 4 fotogramas); se apunta
    // dónde queda en pantalla para que el shader le ponga su vórtice, su núcleo y su luz
    if (this === ctx && phase === 2 && arguments.length === 5 && img instanceof HTMLCanvasElement && img.width === 30 && img.height === 46) {
      const m = this.getTransform(), cx = dx + dw / 2, cy = dy + dh / 2;
      rift = { x: m.a * cx + m.c * cy + m.e, y: m.b * cx + m.d * cy + m.f, rx: Math.abs(dw / 2 * m.a), ry: Math.abs(dh / 2 * m.d), a: this.globalAlpha, f: frameId };
    }
    if (variantsOn && this === ctx && phase === 2 && arguments.length === 5 && img instanceof HTMLCanvasElement &&
        PROP_SIZES.has(img.width + 'x' + img.height) && window.PS_PROPS) {
      const m = this.getTransform();
      const info = !m.b && !m.c && PS_PROPS.analyze(img);
      if (info) {
        const v = Math.floor(hash2(Math.round(dx), Math.round(dy)) * info.n);
        return _draw.call(this, PS_PROPS.variant(img, info, v), dx, dy, dw, dh);
      }
    }
    return _draw.apply(this, arguments);
  };

  const _raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return _raf(function (t) {
      cb(t);
      if (phase === 0) return;
      // Un frame sin el patrón suelo → entidades → HUD no se ha tocado: se ve el canvas original.
      let ok = phase === 3 && lit();
      try {
        stats[ok ? 'ok' : 'p' + phase]++;
        if (ok) render(performance.now());
      } catch (e) { fail(e); ok = false; }
      finally {
        cv.style.visibility = ok ? 'visible' : 'hidden';
        if (!ok) texts.length = 0; // 3) textos de un frame a medias: fuera
        phase = 0; depth = 0;
      }
    });
  };

  function apply() {
    cv.style.visibility = mode === 'off' ? 'hidden' : 'visible';
    fresh = 2; // al volver de apagado, los historiales no sirven
    if (!urlOff) try { localStorage.setItem('ps-luz', mode); } catch (e) {}
  }
  addEventListener('keydown', e => {
    if ((e.key === 'l' || e.key === 'L') && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName)) {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      apply();
      // aviso a la extensión (si la hay) para que su menú muestre el modo nuevo
      window.postMessage({ psLuzEstado: { mode } }, location.origin);
    }
  });
  // Ajustes que manda la extensión desde su menú (mismo origen, sólo estas tres claves)
  addEventListener('message', e => {
    if (e.source !== window || !e.data || typeof e.data.psLuz !== 'object') return;
    const a = e.data.psLuz;
    if (MODES.includes(a.mode) && a.mode !== mode) { mode = a.mode; apply(); }
    if (typeof a.variantes === 'boolean') variantsOn = a.variantes;
    if (typeof a.deco === 'boolean') decoOn = a.deco;
  });
  apply();
  window.postMessage({ psLuzListo: true }, location.origin); // la extensión responde con sus ajustes
  if (!window.PS_LUZ_DEBUG) return; // la herramienta de pruebas sólo existe en la copia local
  window.PS_LUZ = {
    get mode() { return mode; }, set mode(m) { if (MODES.includes(m)) { mode = m; apply(); } },
    get quality() { return quality; }, set quality(q) { quality = Math.max(0, Math.min(3, q | 0)); },
    get fps() { return Math.round(1000 / avgDt); },
    set debug(d) { debug = d; }, set onFrame(f) { onFrame = f; }, tune, stats,
    get variantes() { return variantsOn; }, set variantes(v) { variantsOn = !!v; },
    get deco() { return decoOn; }, set deco(v) { decoOn = !!v; }, get grassRatio() { return grassRatio; },
    get exposicion() { return +expoGain.toFixed(3); },
    get companero() { return partnerCol.map(v => Math.round(v * 255)); },
    get bioma() { return bioNow >= 0 ? BIOMES[bioNow].id : null; }, BIOMES, PRESETS
  };
})();
