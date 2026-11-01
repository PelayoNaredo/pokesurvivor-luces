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
// Los sprites del juego son canvas pequeños que se pintan una vez y se dibujan muchas. La capa de
// sprites lee sus píxeles una vez para sacar silueta y normales; si el canvas vive en la GPU, cada
// lectura la hace esperar (~15 ms: tirones al ver cosas nuevas). Pedidos con willReadFrequently se
// guardan en memoria normal y leerlos es inmediato; al juego no le cuesta nada (no se repintan).
// Va antes de esperar a #game: el juego crea estos canvas desde el principio.
if (!window.__psLuzCtx) {
  window.__psLuzCtx = true;
  const getCtx = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, opts) {
    if (type === '2d' && this.id !== 'game' && this.width * this.height <= 128 * 128 && !(opts && 'willReadFrequently' in opts))
      opts = Object.assign({}, opts, { willReadFrequently: true });
    return getCtx.call(this, type, opts);
  };
}
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
    luciernagas: { moteCol: [.85, 1, .4], moteDen: .3, moteRise: .03, moteBlink: 1, moteSize: 1 },
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
    ['flying', '#9fb8d8', '#7fb8ff', 'water', 'plumas', { tint: [.9, .95, 1.06], fogCol: [.1, .12, .18], fogMul: .35, canopy: .35 }],
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
  // nubes que pasan por delante de la luna: al aire libre sí; en la cueva y en las grietas no hay cielo
  for (const b of BIOMES) if (b.clouds === undefined) b.clouds = b.id.startsWith('grieta-') || b.id === 'cueva-cristal' ? 0 : .32;
  // Muros y acantilados: el juego los pinta dentro del suelo (casillas de 16 píxeles de arte con
  // cara superior y 6 píxeles de cara frontal), así que no son sprites y no echaban sombra. Se
  // reconocen por sus colores exactos, los de cada escenario (sacados del código del juego).
  const WALLS_BY_FLOOR = {
    '#3e7a39': ['#5d6e49', '#677a50', '#566544', '#88a06e', '#3e4934', '#363f2d', '#232a1d'],
    '#4d5778': ['#5f5089', '#695996', '#56497d', '#a08ddc', '#1f1934', '#3f3463', '#382e59', '#221c3a'],
    '#5b4537': ['#3c3634', '#443d3a', '#35302e', '#141110', '#2b2624', '#25201f', '#151211'],
    '#2f3a26': ['#3d3446', '#45394f', '#362e3e', '#6a5a7a', '#140f18', '#2a2330', '#241e2a', '#130f16'],
    '#34303f': ['#4a4652', '#524e5c', '#423e49', '#7a7684', '#2e2b34', '#28252e', '#141217'],
    '#1f2a2a': ['#2e2838', '#352e40', '#282231', '#584c66', '#0e0b12', '#211c28', '#1c1823', '#0f0d13']
  };
  const ARENA_WALL = { normal: '#8a7f6a', fire: '#3a2826', water: '#2a4660', grass: '#4a6a36', electric: '#3a3a48', ice: '#7f9fc0', poison: '#33263f',
    ground: '#8a5e34', flying: '#dfe8f4', psychic: '#3e2a55', bug: '#5e4a26', rock: '#55473a', ghost: '#24202e', dragon: '#24264a',
    dark: '#1c181f', steel: '#465060', fairy: '#7a5a8a', judgment: '#2e2829' };
  for (const b of BIOMES) {
    if (b.id.startsWith('grieta-')) {
      const w = ARENA_WALL[b.id.slice(7)];
      // (la misma receta que el juego para las arenas)
      b.wall = w ? [w, tone(w, .07), tone(w, -.07), tone(w, .32), tone(w, -.7), tone(w, -.3), tone(w, -.38), tone(w, -.55)] : [];
    } else b.wall = WALLS_BY_FLOOR[b.floor[0]] || [];
  }
  // niebla a ras de suelo, setas que brillan de noche, aurora (los que no salen aquí: nada)
  const EXTRA = { 'cementerio': { gfog: .6, glowK: .6 }, 'huerto': { gfog: .45, glowK: .4 }, 'bosque-tenebroso': { gfog: .5, glowK: .9 },
    'bosque-umbrio': { glowK: .3 }, 'grieta-ghost': { gfog: .5, glowK: .6 }, 'grieta-poison': { gfog: .4, glowK: .5 },
    'grieta-dark': { glowK: .5 }, 'grieta-ice': { aurora: .8 }, 'cueva-cristal': { aurora: .25 } };
  for (const b of BIOMES) Object.assign(b, EXTRA[b.id] || {});
  const NEUTRAL = { gfog: 0, glowK: 0, aurora: 0, clouds: .2, tint: [1, 1, 1], fogCol: [0, 0, 0], fogMul: 1, moonMul: 1, canopy: 0, lightning: 0, flicker: 0, emit: 1,
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
  // la composición final lee 14 texturas a la vez y usa unos 80 vectores de uniformes; WebGL sólo
  // garantiza 8 y 16 (móviles muy viejos): sin eso, el juego tal cual
  if (!gl || gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) < 14 || gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) < 96) { cv.remove(); return; }
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

  // 2) visibilidad: luna (r), antorcha del jugador (g) y sombra de contacto (b).
  // Las sombras ya no se adivinan desde la imagen: la capa de sprites pinta cada sprite
  // proyectado desde sus pies, con su forma exacta y, en verde, la altura de cada punto
  // (ver «capa de sprites» más abajo). Aquí sólo se les da la penumbra, como hacen las
  // sombras suaves de los motores (PCSS): primero se mira a qué altura está lo que tapa la
  // luz y, cuanto más alto, más ancha la penumbra. Nítida al pie, difusa en la copa.
  const FS_SHADOW = HEAD + `
    uniform sampler2D SM,ST,M,NB,WM; uniform vec2 res,cam,moonO; uniform float art,frame,jmode,time,canopy,clouds,sharp,wallH;
    // ¿tapa un muro la luz que llega a px desde la dirección d (en el canvas, y hacia abajo)? Se sube
    // hacia la luz: a la altura z, el muro se ve z más arriba en pantalla (su cara frontal)
    float wallShade(vec2 px,vec2 d,float rot){
      if(wallH<=0.)return 0.;
      float o=0.;
      for(int k=1;k<=8;k++){
        float z=(float(k)-.5+.5*fract(rot*1.7))/8.*wallH*art;
        vec2 q=px+vec2(-d.x*z,(d.y+1.)*z);
        o=max(o,texture2D(WM,q/res).r*(1.-.35*float(k)/8.)); // (lo más alto tapa algo menos: penumbra)
      }
      return o;
    }
    float soft(sampler2D T,vec2 px,float rot){
      float sr=art*3., hs=0., n=0.;
      for(int i=0;i<8;i++){
        float a=float(i)*2.39996+rot, r=sqrt((float(i)+.5)/8.)*sr;
        vec4 s=texture2D(T,(px+vec2(cos(a),sin(a))*r)/res);
        if(s.r>.5){hs+=s.g;n+=1.;}
      }
      vec4 c0=texture2D(T,px/res);
      if(c0.r>.5){hs+=c0.g;n+=1.;}
      if(n<.5)return 0.;
      float h=hs/n*127.5;            // altura media de lo que hace sombra, en píxeles de arte
      float r=(.6+h*art*.045)*(1.-.5*sharp); // radio de la penumbra (con sol abrasador, luz dura: más nítida)
      float o=0.;
      for(int i=0;i<12;i++){
        float a=float(i)*2.39996+rot*1.7, rr=sqrt((float(i)+.5)/12.)*r;
        o+=texture2D(T,(px+vec2(cos(a),sin(a))*rr)/res).r;
      }
      // lo muy alto (copas) tapa algo menos: la luz se cuela entre las hojas
      return o/12.*(1.-.35*smoothstep(30.,90.,h));
    }
    void main(){
      vec2 px=uv*res;
      // ruido anclado al mundo para girar las muestras (no titila al mover la cámara)
      vec2 wpx=vec2(px.x*2.-cam.x,(res.y-px.y)*2.-cam.y)*.5;
      float j=jmode<.5?hash(floor(px)):jmode<1.5?hash(floor(px)+fract(frame*.61803)*97.):hash(floor(wpx));
      float rot=j*6.2831853;
      // (qué píxeles son de un sprite y no reciben la sombra se decide en la composición, píxel a
      // píxel: aquí, a media resolución y con máscaras ensanchadas, la sombra se separaba del pie)
      float s=soft(SM,px,rot), t=soft(ST,px,rot+1.3);
      // muros y acantilados: sombra de la luna y de la antorcha (alejándose del jugador)
      if(texture2D(WM,uv).r<.5){
        s=max(s,wallShade(px,moonO,rot));
        vec2 tdv=px/res-vec2(.5,.48); tdv.y=-tdv.y; float tl=length(tdv);
        if(tl>.02) t=max(t,wallShade(px,tdv/tl*.6,rot+.7)*smoothstep(.02,.08,tl));
      }
      // el juego deja de pintar un árbol ~100 px antes de que su sombra salga por arriba (o por
      // la izquierda): sin este fundido, la punta de la sombra aparecería de golpe en el borde
      s*=smoothstep(0.,.09,1.-uv.y)*smoothstep(0.,.05,uv.x);
      float ct=texture2D(SM,uv).b;
      // los oclusores casi no reciben sombra proyectada (su cara iluminada la da la luz de contorno)
      // copas de los árboles (la luz de luna llega a manchas que se mecen con el viento) y nubes
      // (sombras enormes y lentas que cruzan el suelo): en alfa, aquí a media resolución porque
      // cambian muy despacio de un sitio a otro (eran 3 ruidos por píxel en la composición)
      vec2 wp=(vec2(px.x*2.,(res.y-px.y)*2.)-cam)/art;
      float mv=mix(1.,.55+.45*smoothstep(.3,.7,noise(wp*.012+vec2(time*.015,time*.01))),canopy);
      if(clouds>0.){
        float cs=noise(wp*.0016+vec2(time*.012,time*.005))*.7+noise(wp*.0041+vec2(time*.02,-time*.007))*.3;
        mv*=1.-clouds*smoothstep(.42,.72,cs);
      }
      gl_FragColor=vec4(1.-s,1.-t,ct,mv);
    }`;

  // 3) luz rebotada (iluminación global 2D) con Radiance Cascades (Sannikov, 2024).
  // Sondas repartidas por el mundo; cada sonda mira la luz que le llega desde todas las
  // direcciones, pero por tramos: la cascada 0 mira cerca, con pocas direcciones y muchas sondas;
  // cada cascada siguiente mira 4 veces más lejos, con 4 veces más direcciones y la mitad de sondas
  // por eje (la luz lejana cambia despacio de un sitio a otro pero necesita más resolución en
  // ángulo). Se calculan de la más lejana a la más cercana y cada una añade, por donde su tramo no
  // está tapado, lo que ve la siguiente. Sale sin ruido, sin acumular entre frames y con sombras
  // suaves de cada fuente. Antes: 16 rayos al azar por píxel y acumulación temporal (ruido, estelas).
  // Cada cascada ocupa una textura del mismo tamaño: bloques de direcciones (2^(i+1) por eje),
  // cada bloque con todas las sondas de esa dirección.
  // Los valores se guardan comprimidos (x/(x+2)): una dirección puede pasar mucho de 1.
  const FS_RC = HEAD + `
    uniform sampler2D SC,UP; uniform vec2 qres,p0,off; uniform float ci,last,L0,steps,texel;
    vec3 enc(vec3 x){return x/(x+2.);} vec3 dec(vec3 y){y=min(y,vec3(.996));return 2.*y/(1.-y);}
    void main(){
      vec2 tex=floor(gl_FragCoord.xy);
      float sc=exp2(ci), B=2.*sc;          // direcciones por eje (B×B en total)
      vec2 P=p0/sc;                        // sondas por eje en esta cascada
      vec2 blk=floor(tex/P), pr=tex-blk*P;
      float D=B*B, d=blk.x+blk.y*B;
      float sp=2.*sc;                      // separación entre sondas, en texels de 1/4
      vec2 c=(pr+.5)*sp+off;               // centro de la sonda
      float a0=L0*(exp2(2.*ci)-1.)/3., len=L0*exp2(2.*ci); // tramo [a0, a0+len]
      float ang=(d+.5)/D*6.2831853;
      vec2 dir=vec2(cos(ang),sin(ang));
      // (las sondas del margen, fuera de pantalla, lanzan sus rayos desde el borde: si no, valían 0
      // y al interpolar oscurecían una franja a lo largo de los bordes)
      vec2 cc=clamp(c,vec2(.5),qres-.5);
      float self=texture2D(SC,cc/qres).a;
      vec3 rad=vec3(0.); float T=1.;
      float stp=len/steps;
      for(int k=0;k<16;k++){
        if(float(k)>=steps)break;
        float t=a0+stp*(float(k)+.5);
        vec2 q=(cc+dir*t)/qres;
        if(q.x<0.||q.y<0.||q.x>1.||q.y>1.)continue; // fuera de pantalla no se sabe qué hay: no suma ni tapa
        vec4 e=texture2D(SC,q);
        // una sonda dentro de un sprite no se tapa a sí misma: así le llega luz a su cara iluminada
        float o=e.a*(t<3.?1.-self:1.);
        rad+=e.rgb*T*stp;
        T*=exp(-o*2.5*stp/texel); // (alfa = cuánto del texel tapa: se mide en texels atravesados)
      }
      if(last<.5&&T>.002){
        // lo que ve la cascada siguiente en las 4 direcciones en que se divide esta, en este sitio
        vec2 Pu=P*.5; float Bu=B*2.;
        vec2 g=clamp((c-off)/(sp*2.)-.5,vec2(0.),Pu-1.);
        vec3 up=vec3(0.);
        for(int k=0;k<4;k++){
          float du=d*4.+float(k);
          vec2 bu=vec2(mod(du,Bu),floor(du/Bu));
          up+=dec(texture2D(UP,(bu*Pu+g+.5)/(Pu*Bu)).rgb);
        }
        rad+=T*up*.25;
      }
      gl_FragColor=vec4(enc(rad),1.);
    }`;
  // luz que llega a cada sonda de la cascada 0 (media de sus 4 direcciones)
  // y, de paso, el parpadeo de vela de cada zona (cada una a su ritmo). Se funde entre campos de
  // ruido fijos: un ruido que se desplaza con el tiempo se ve como ráfagas de viento barriendo el suelo.
  // Y las luciérnagas (las partículas que parpadean) alumbran un poco de suelo a su alrededor: luz
  // suave, así que va aquí, en las sondas, y no en cada píxel (eran 9 celdas con ruido por píxel).
  const FS_RCOUT = HEAD + `uniform sampler2D C0; uniform vec2 p0,off,cam; uniform float k,art,hgt,time,flick,motes; uniform vec4 moteP; uniform vec3 moteCol;
    vec3 dec(vec3 y){y=min(y,vec3(.996));return 2.*y/(1.-y);}
    void main(){
      vec2 pr=floor(gl_FragCoord.xy); vec3 s=vec3(0.);
      for(int i=0;i<4;i++){ vec2 b=vec2(mod(float(i),2.),floor(float(i)/2.)); s+=dec(texture2D(C0,(b*p0+pr+.5)/(2.*p0)).rgb); }
      vec2 c=((pr+.5)*2.+off)*4.;                         // la sonda, en píxeles de pantalla (y de GL)
      vec2 wp=(vec2(c.x,hgt-c.y)-cam)/art;
      float ft=time*5., f0=floor(ft), fk=smoothstep(0.,1.,fract(ft));
      float fn=mix(noise(wp*.008+f0*17.31),noise(wp*.008+(f0+1.)*17.31),fk);
      vec3 ff=vec3(0.);
      if(moteP.z>.5&&motes>0.){
        vec2 mp=wp/(26.*moteP.w)+vec2(0.,time*moteP.y), cell=floor(mp);
        for(int yy=-1;yy<=1;yy++)for(int xx=-1;xx<=1;xx++){
          vec2 cl=cell+vec2(float(xx),float(yy)); float rr=hash(cl);
          if(rr<1.-moteP.x*.3)continue;
          vec2 cc=cl+vec2(hash(cl+1.7),hash(cl+4.3))*.7+.15+.1*vec2(sin(time*1.3+rr*40.),cos(time*1.1+rr*30.));
          float bl=pow(max(0.,sin(time*1.7+rr*60.)),4.);
          float dd=length(mp-cc);
          ff+=moteCol*bl*exp(-dd*dd*30.);
        }
      }
      gl_FragColor=vec4(s*.25*k*(1.+flick*(fn-.5)*.35)+ff*motes*.35,1.);
    }`;

  // 4) acumulación temporal con reproyección por el movimiento de la cámara
  const FS_TEMPORAL = HEAD + `
    uniform sampler2D C,H; uniform vec2 shift,texel; uniform float blend,clampK;
    void main(){
      vec4 c=texture2D(C,uv);
      vec2 p=uv+shift;
      vec4 h=texture2D(H,p);
      // recorte del historial al rango de los vecinos actuales: sin estelas detrás de lo que se mueve
      if(clampK>0.){
        vec4 a=texture2D(C,uv+vec2(texel.x,0)),b=texture2D(C,uv-vec2(texel.x,0));
        vec4 d=texture2D(C,uv+vec2(0,texel.y)),e=texture2D(C,uv-vec2(0,texel.y));
        vec4 lo=min(c,min(min(a,b),min(d,e)))-clampK, hi=max(c,max(max(a,b),max(d,e)))+clampK;
        h=clamp(h,lo,hi);
      }
      float k=(p.x<0.||p.y<0.||p.x>1.||p.y>1.)?1.:blend;
      gl_FragColor=mix(h,c,k);
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

  // 4d) escenario y verde de la hierba, contados en la GPU sobre la foto del suelo (48×27 muestras).
  // x < nº de escenarios: fracción de muestras con el suelo exacto de cada uno; después, histograma
  // del verde/rojo de lo verde (160 cubos de 0,01 desde 0,8). Antes se leían en la CPU los píxeles
  // de cada trozo de suelo nuevo, y cada lectura frenaba la GPU: tirones al andar por terreno nuevo.
  const NBIO = BIOMES.length;
  const FS_FLOOR = HEAD + `uniform sampler2D G,FC; uniform vec2 res;
    vec3 at(int i,int j){ vec2 q=(vec2(float(i),float(j))+.5)/vec2(48.,27.); return texture2D(G,(floor(q*res)+.5)/res).rgb; }
    // ¿es este color uno de los suelos del escenario k?
    float isFloor(vec3 g,float k){
      vec3 f0=texture2D(FC,vec2((k*3.+.5)/${NBIO * 3}.,.5)).rgb, f1=texture2D(FC,vec2((k*3.+1.5)/${NBIO * 3}.,.5)).rgb, f2=texture2D(FC,vec2((k*3.+2.5)/${NBIO * 3}.,.5)).rgb;
      return step(min(min(distance(g,f0),distance(g,f1)),distance(g,f2)),.003);
    }
    void main(){
      float x=floor(gl_FragCoord.x), c=0.;
      if(x<${NBIO}.){
        // Algunos escenarios comparten un tono de suelo (el bosque y la grieta de hierba): cada
        // muestra cuenta sólo para el primero de la lista que coincide. Contada para los dos, el
        // bosque parecía estar siempre cambiando de escenario y la decoración no llegaba a salir.
        for(int j=0;j<27;j++)for(int i=0;i<48;i++){
          vec3 g=at(i,j);
          float m=isFloor(g,x);
          if(m>.5) for(int k=0;k<${NBIO};k++){ if(float(k)>=x)break; if(isFloor(g,float(k))>.5){m=0.;break;} }
          c+=m;
        }
      } else {
        float bin=x-${NBIO}.;
        for(int j=0;j<27;j++)for(int i=0;i<48;i++){
          vec3 g=at(i,j);
          if(g.g>g.r&&g.g>g.b&&g.r>.032) c+=step(abs(floor((g.g/g.r-.8)*100.+.5)-bin),.1);
        }
      }
      float v=c/1296.;
      gl_FragColor=vec4(floor(v*255.)/255.,fract(v*255.),0.,1.);
    }`;

  const FS_DOWN = HEAD + `uniform sampler2D T;uniform vec2 px;
    void main(){gl_FragColor=(texture2D(T,uv+px*vec2(-1,-1))+texture2D(T,uv+px*vec2(1,-1))+texture2D(T,uv+px*vec2(-1,1))+texture2D(T,uv+px*vec2(1,1)))*.25;}`;
  const FS_BLUR = HEAD + `uniform sampler2D T;uniform vec2 dir;
    void main(){vec4 a=texture2D(T,uv)*.227;
      a+=(texture2D(T,uv+dir*1.385)+texture2D(T,uv-dir*1.385))*.316;
      a+=(texture2D(T,uv+dir*3.231)+texture2D(T,uv-dir*3.231))*.070;
      gl_FragColor=a;}`;

  // 5b) niebla volumétrica y haces de luz, a 1/4 de resolución: son suaves de por sí y, hechos
  // en cada píxel de la composición (ruido de 4 capas + 20 lecturas por píxel), eran lo más caro
  // de toda la luz. Sale la luz que dispersa la niebla (rgb, ya multiplicada) y su densidad (a).
  const FS_VOL = HEAD + `
    uniform sampler2D S,GI,EXPO; uniform vec2 res,cam,moonDir,center;
    uniform float art,aspect,time,quality,fog,shafts,gi,torchR; uniform vec4 giST;
    uniform vec4 lp[16]; uniform vec3 lc[16]; uniform float nLights;
    uniform vec3 fogCol,torch,moon;
    uniform vec4 wx; uniform float wfog,canopy; // clima (lluvia, nieve, sol, arena), niebla del clima, copas
    uniform sampler2D LQ; uniform float gfog,lavaK; uniform vec3 liqFx;
    float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.03+17.1;a*=.5;}return v;}
    float torchAtt(vec2 q){vec2 d=(q-center)*vec2(aspect,1.);float r=length(d)/torchR;return 1./(1.+r*r*4.)*(1.-smoothstep(.15,1.6,r));}
    void main(){
      vec2 wp=(vec2(uv.x,1.-uv.y)*res-cam)/art;
      float bk=smoothstep(.32,.62,texture2D(EXPO,vec2(.5)).r);
      vec3 g=texture2D(GI,uv*giST.xy+giST.zw).rgb*gi; g/=1.+lum(g)*1.4;
      // niebla anclada al mundo (se mueve con el viento, no con la cámara)
      float dens=fbm(wp*.014+vec2(time*.05,time*.018));
      dens=smoothstep(.3,1.,dens)*fog*.55*(1.-.65*bk); // rampa ancha: bordes difusos, sin manchas
      // clima: la niebla espesa de verdad; la arena, una calima que corre con el viento; la lluvia, algo de bruma
      float wd=fbm(wp*.02+vec2(time*.4,time*.05));
      // la niebla del clima se cierra con la distancia: cerca del jugador se ve, lejos no
      float far=smoothstep(.12,.55,length((uv-center)*vec2(aspect,1.)));
      dens=dens*(1.+wfog*1.2+wx.w+wx.x*.3)+wfog*(.1+.4*far)+wx.w*(.08+.25*smoothstep(.15,.85,wd))+wx.x*.05;
      // haces: de este punto hacia la antorcha y hacia la luna, mirando qué parte está a la sombra
      float sh=0.,sm=0.;
      vec2 vis=texture2D(S,uv).rg;
      if(quality>.5){
        float j=hash(uv*res+fract(time)*31.);
        for(int i=0;i<10;i++){float t=(float(i)+j)/10.;
          vec2 q=mix(uv,center,t*.9); sh+=texture2D(S,q).g*torchAtt(q);
          // (con las copas: el haz de luna sólo pasa por los huecos entre las hojas)
          vec4 sq=texture2D(S,uv+vec2(moonDir.x/aspect,moonDir.y)*t*.08); sm+=sq.r*sq.a;}
        sh/=10.; sm/=10.;
      }else{sh=vis.g*torchAtt(uv);sm=vis.r;}
      // cada luz puntual (fuegos, proyectiles) enciende la niebla a su alrededor: un halo
      vec3 halo=vec3(0.);
      for(int i=0;i<16;i++){
        if(float(i)>=nLights)break;
        vec2 dd=(lp[i].xy-uv)*vec2(aspect,1.); float r=lp[i].z*.7;
        halo+=lc[i]*lp[i].w/(1.+dot(dd,dd)/(r*r)*3.);
      }
      // en el bosque los haces de luna entre las copas se marcan más
      // niebla a ras de suelo: bancos bajos que se arremolinan despacio y se abren alrededor del jugador
      if(gfog>0.){
        vec2 gq=wp*.01+vec2(time*.03+sin(time*.11+wp.y*.004)*.4,time*.012);
        float gn=smoothstep(.35,.8,fbm(gq)*.75+noise(gq*3.1-vec2(time*.06,0.))*.25);
        float clear=smoothstep(.03,.13,length((uv-center)*vec2(aspect,1.)));
        dens+=gfog*gn*clear*.3;
      }
      // sobre la lava el aire brilla: una columna de calor que tiñe la niebla de su color
      float heat=0.;
      if(lavaK>0.){
        vec2 up=vec2(0.,.012);
        heat=(texture2D(LQ,uv).r+texture2D(LQ,uv-up).r+texture2D(LQ,uv-up*2.).r+texture2D(LQ,uv-up*3.5).r)*.25;
        dens+=heat*lavaK*.35;
      }
      // (con niebla del clima y niebla baja a la vez se tapaba todo: tope)
      dens=min(dens,.5-.2*bk);
      vec3 fc=mix(fogCol,vec3(.62,.48,.3),wx.w)+liqFx*heat*lavaK*2.2;
      vec3 scatter=fc+torch*sh*shafts*.8+moon*sm*.25*shafts*(1.+canopy*1.6)+g*.6+halo*1.4;
      gl_FragColor=vec4(scatter*dens,dens);
    }`;

  // 5c) decoración por celdas: el terreno de cada celda se comprueba aquí una sola vez (15 lecturas
  // del suelo); antes se hacía en cada píxel de la celda y era lo más caro de la composición.
  // Sale el color del suelo en la celda (rgb) y si lleva adorno: 1 hierba, .5 tierra, 0 nada.
  const FS_DECOCELL = HEAD + `
    uniform sampler2D G; uniform vec2 res,cam,cell0; uniform float art,grassRatio;
    float terrain(vec3 c){
      float grass=step(c.b*1.1,c.g)*step(c.r*1.02,c.g)*step(.08,c.g)*step(c.g,c.r*grassRatio*1.12);
      float dirt=step(c.g,c.r)*step(c.b,c.g)*step(.05,c.r-c.b)*step(.08,c.r)*step(c.r,.55)*step((c.r-c.b)/c.r,.55);
      return grass>.5?2.:dirt>.5?1.:0.;
    }
    void main(){
      vec2 cell=cell0+floor(gl_FragCoord.xy);
      float h1=hash(cell+.31),h2=hash(cell+7.7),h3=hash(cell+3.3);
      vec2 org=cell*14.+floor(vec2(h2,h3)*6.);
      // el terreno se mira en el centro y en 4 puntos alrededor: todos tienen que coincidir,
      // para que no salga nada en la orilla de un pantano o de una pared
      vec2 cs=(org+4.)*2.*art+cam;
      vec2 cuv=vec2(cs.x/res.x,1.-cs.y/res.y), o=vec2(5.*2.*art)/res;
      vec3 gr=texture2D(G,cuv).rgb;
      float t0=terrain(gr);
      float same=step(abs(terrain(texture2D(G,cuv+vec2(o.x,0)).rgb)-t0),.5)*step(abs(terrain(texture2D(G,cuv-vec2(o.x,0)).rgb)-t0),.5)
                *step(abs(terrain(texture2D(G,cuv+vec2(0,o.y)).rgb)-t0),.5)*step(abs(terrain(texture2D(G,cuv-vec2(0,o.y)).rgb)-t0),.5);
      // El pantano tiene píxeles sueltos casi iguales a la hierba, pero la mitad de sus píxeles
      // son de un verde más saturado. Si cualquiera de otras 9 muestras de la zona es de ese
      // verde, no se pone nada (simulado con los colores reales del Huerto: 0,005 % de fallos).
      for(int yy=-1;yy<=1;yy++)for(int xx=-1;xx<=1;xx++){
        vec3 c=texture2D(G,cuv+vec2(float(xx),float(yy))*o*.7).rgb;
        same*=1.-step(c.b*1.1,c.g)*step(c.r*grassRatio*1.12,c.g);
      }
      float grass=step(1.5,t0)*same, dirt=step(.5,t0)*step(t0,1.5)*same;
      // (fuera de pantalla no se sabe: nada)
      float inside=step(0.,cuv.x)*step(cuv.x,1.)*step(0.,cuv.y)*step(cuv.y,1.);
      float on=step(h1,grass*.5+dirt*.3)*inside*max(grass,dirt);
      gl_FragColor=vec4(gr,on*(grass>.5?1.:.5));
    }`;

  // 5e) huellas: por donde pisan el jugador y los Pokémon queda un rastro que se borra despacio
  // (~8 s). Va a 1/4 de resolución y se corre con la cámara, como la acumulación temporal.
  const FS_TRAIL = HEAD + `uniform sampler2D H; uniform vec2 shift; uniform vec4 rp[8]; uniform float nRp,decay,aspect;
    void main(){
      vec2 p=uv+shift;
      float h=(p.x<0.||p.y<0.||p.x>1.||p.y>1.)?0.:texture2D(H,p).r;
      float st=0.;
      for(int i=0;i<8;i++){
        if(float(i)>=nRp)break;
        vec2 d=(uv-rp[i].xy)*vec2(aspect,1.);
        vec2 e=d/vec2(rp[i].z*.32,rp[i].z*.16);
        st=max(st,exp(-dot(e,e)));
      }
      gl_FragColor=vec4(max(h*decay,st*.9),0.,0.,1.);
    }`;

  // 5f) muros: 1 donde el suelo es muro o acantilado del escenario actual (por color exacto)
  // (en g, si es cara frontal o borde: los colores 5.º en adelante de cada paleta lo son)
  const FS_WALLM = HEAD + `uniform sampler2D G; uniform vec2 full; uniform vec3 wc[8]; uniform float nwc;
    void main(){
      vec3 g=texture2D(G,(floor(uv*full)+.5)/full).rgb; float m=0., fc=0.;
      for(int i=0;i<8;i++){ if(float(i)>=nwc)break; float h=step(distance(g,wc[i]),.004); m=max(m,h); if(i>=4) fc=max(fc,h); }
      gl_FragColor=vec4(m,fc,0.,1.);
    }`;

  // 5d) agua y líquidos del escenario: máscara a media resolución (eran 5 lecturas por píxel)
  // Sólo coincidencias casi exactas (la hierba del Huerto está a 0,04 del pantano hondo) y
  // en al menos 2 de 5 muestras: el agua tiene espuma y motas de otros colores.
  const FS_LIQ = HEAD + `uniform sampler2D G,TRL,WM; uniform vec2 o,full; uniform vec3 liqA,liqB;
    void main(){
      vec2 c=(floor(uv*full)+.5)/full; // en el centro de un píxel: el color exacto, sin mezclar
      float nl=0.;
      for(int i=0;i<5;i++){
        vec2 off=i==0?vec2(0.):i==1?vec2(2.,0.):i==2?vec2(-2.,0.):i==3?vec2(0.,2.):vec2(0.,-2.);
        vec3 gs=texture2D(G,c+off*o).rgb;
        nl+=1.-smoothstep(.008,.02,min(distance(gs,liqA),distance(gs,liqB)));
      }
      // b: muro (.5 cara superior, 1 frontal); a: suelo al pie de una cara frontal (hasta 3 píxeles de arte)
      vec2 wm=texture2D(WM,uv).rg; float foot=0.;
      if(wm.r<.5) for(int k=1;k<=3;k++){ if(texture2D(WM,uv+vec2(0.,float(k)*2.*o.y)).g>.5){ foot=1.-float(k-1)/3.; break; } }
      gl_FragColor=vec4(smoothstep(1.5,2.5,nl),texture2D(TRL,uv).r,wm.r*(.5+.5*wm.g),foot);
    }`;

  // 7) efecto maqueta (opcional): desenfoque suave arriba y abajo de la pantalla, como una foto
  // con poca profundidad de campo de una maqueta. El centro, donde está el jugador, queda nítido.
  const FS_TILT = HEAD + `uniform sampler2D T; uniform vec2 px;
    void main(){
      // (más marcado: con 7 píxeles de desenfoque no se notaba; y un poco más de color, como las
      // fotos de maquetas, que suelen estar saturadas)
      float k=smoothstep(.08,.42,abs(uv.y-.5));
      vec4 c=texture2D(T,uv);
      vec3 cc=mix(vec3(dot(c.rgb,vec3(.299,.587,.114))),c.rgb,1.12);
      if(k<.01){ gl_FragColor=vec4(cc,1.); return; }
      vec4 a=vec4(0.); float r=k*18.;
      for(int i=0;i<16;i++){ float an=float(i)*2.39996; float rr=sqrt((float(i)+.5)/16.)*r; a+=texture2D(T,uv+vec2(cos(an),sin(an))*rr*px); }
      vec3 bl=a.rgb/16.;
      gl_FragColor=vec4(mix(cc,mix(vec3(dot(bl,vec3(.299,.587,.114))),bl,1.12),smoothstep(0.,.25,k)),1.);
    }`;

  // 6) composición final a resolución completa
  const FS_COMP = HEAD + `
    uniform sampler2D W,S,M,GI,B1,B2,B3,NB,EXPO,VOL,LQ;
    uniform vec2 res,cam,moonDir,center; uniform float art,aspect,time,dbg,quality; uniform vec4 giST; uniform float pixK,bandK,clouds;
    uniform vec3 ambient,moon,torch,fogCol,lowTint,highTint,shadowHue;
    uniform float torchR,gi,bloom,shadowK,relief,exposure,vignette,sat,fog,shafts,motes,ao,rim;
    // luces puntuales (capa de sprites): xy en pantalla, radio (en alturas de pantalla), fuerza; y su color
    uniform vec4 lp[16]; uniform vec3 lc[16]; uniform float nLights;
    // clima (lluvia, nieve, sol abrasador, arena), impactos (centro, edad 0-1, fuerza) y pies en el agua
    uniform float auroraK,nightK; uniform vec4 wx, wx2; uniform vec4 shk[4]; uniform vec4 rp[8]; uniform float nRp, tm;
    // toque de cada escenario (ver BIOMES en el JS)
    uniform vec3 liqA,liqB,liqFx,moteCol,flashCol; uniform vec4 bFx,bFx2,bLiq,moteP; uniform float flash;
    uniform vec4 rift; uniform float riftA; // grieta: centro y semiejes en píxeles (y de GL), opacidad
    vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
    // AgX (Troy Sobotka; ajuste polinómico de bwrensch). Sale ya en la misma escala que ACES.
    vec3 agx(vec3 c){
      mat3 i=mat3(.842479062253094,.0423282422610123,.0423756549057051,.0784335999999992,.878468636469772,.0784336,.0792237451477643,.0791661274605434,.879142973793104);
      mat3 o=mat3(1.19687900512017,-.0528968517574562,-.0529716355144438,-.0980208811401368,1.15190312990417,-.0980434501171241,-.0990297440797205,-.0989611768448433,1.15107367264116);
      c=i*max(c,vec3(1e-10));
      c=clamp(log2(c),-12.47393,4.026069); c=(c+12.47393)/16.500999;
      vec3 x2=c*c, x4=x2*x2;
      c=15.5*x4*x2-40.14*x4*c+31.96*x4-6.868*x2*c+.4298*x2+.1191*c-.00232;
      c=o*c;
      // un toque de contraste (look «punchy») y de vuelta a la escala lineal del resto del shader
      c=pow(max(c,vec3(0.)),vec3(1.12));
      return clamp(pow(c,vec3(2.2)),0.,1.);
    }
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
    // (qué adorno lleva cada celda y el color del suelo en ella lo decide FS_DECOCELL)
    uniform sampler2D DC; uniform vec2 cell0;
    float decoHalo=0.; // (lo escribe deco: el halo de una seta luminosa)
    uniform float glowK;
    vec4 deco(vec2 ap){
      if(decoOn<.002||quality<.5)return vec4(0.); // en la calidad más baja, sin adornos
      vec2 cell=floor(ap/14.);
      vec2 ci=cell-cell0;
      if(ci.x<0.||ci.y<0.||ci.x>127.||ci.y>127.)return vec4(0.);
      vec4 dcell=texture2D(DC,(ci+.5)/128.);
      if(dcell.a<.25)return vec4(0.);
      float h2=hash(cell+7.7),h3=hash(cell+3.3),h4=hash(cell+11.1),h5=hash(cell+5.9);
      vec2 org=cell*14.+floor(vec2(h2,h3)*6.);
      vec2 lp=floor(ap)-org;
      vec3 gr=dcell.rgb;
      float grass=step(.75,dcell.a);
      float s;
      if(grass>.5)s=h4<.3?0.:h4<.5?1.:h4<.64?2.:h4<.74?3.:h4<.84?6.:h4<.94?4.:7.;
      else s=h4<.35?4.:h4<.6?5.:h4<.8?6.:1.;
      // las setas, en los escenarios oscuros, brillan: un halo suave alrededor del sombrero
      if(s==7.&&glowK>0.){ vec2 dh=ap-(org+vec2(3.5,2.5)); decoHalo=exp(-dot(dh,dh)/14.)*(.75+.25*sin(time*1.3+h5*20.))*smoothstep(h5*.5,h5*.5+.5,decoOn); }
      if(lp.x<0.||lp.y<0.||lp.x>7.||lp.y>7.)return vec4(0.);
      if(h5<.5)lp.x=7.-lp.x; // espejo
      float t=floor(texture2D(DECO,(vec2(s*8.+lp.x,lp.y)+.5)/vec2(64.,8.)).r*255.+.5);
      if(t<.5)return vec4(0.);
      float gLum=lum(gr);
      vec3 base=(s==4.||s==5.)?mix(vec3(gLum),gr,.35)*vec3(1.05,1.,1.08):gr; // piedras: grisáceas
      vec3 c=t<1.5?base*.55:t<2.5?base*.95:t<3.5?base*1.45+.03:vec3(0.);
      vec3 petal=h5<.25?vec3(.95,.93,.85):h5<.5?vec3(.98,.82,.3):h5<.75?vec3(.95,.55,.7):vec3(.7,.6,.95);
      if(t>3.5&&t<4.5)c=petal;
      if(t>4.5&&t<5.5)c=vec3(.98,.78,.25);
      if(t>5.5&&t<6.5)c=mix(vec3(.72,.18,.14),vec3(.35,.85,1.)*1.3,min(1.,glowK*1.2));
      if(t>6.5)c=mix(vec3(.95,.9,.84),vec3(.8,1.,1.)*1.4,min(1.,glowK*1.2));
      // cada adorno aparece a su ritmo dentro del fundido general, no todos a la vez
      return vec4(c,smoothstep(h5*.5,h5*.5+.5,decoOn));
    }
    float torchAtt(vec2 q){vec2 d=(q-center)*vec2(aspect,1.);float r=length(d)/torchR;return 1./(1.+r*r*4.)*(1.-smoothstep(.15,1.6,r));}
    // capa de sprites: material (0 hierba/árbol, 1 Pokémon, 2 roca/objeto, 3 cristal) y altura
    float matOf(vec4 q){return floor(floor(q.b*255.+.5)/64.);}
    // Vegetación: cuánto se desplaza (en uv) el píxel de hierba o árbol que hay en p. Más cuanto
    // más alto está sobre su pie (la copa se mece, el tronco no) y, cerca del jugador, la hierba
    // se aparta hacia los lados.
    uniform float wind;
    vec2 swayAt(vec2 p){
      vec4 q=texture2D(NB,p);
      if(q.a<.5||q.b*255.>63.5)return vec2(0.);
      float h=floor(q.b*255.+.5)*2.;                 // píxeles de arte sobre el pie
      vec2 wq=(vec2(p.x,1.-p.y)*res-cam)/art;
      float w=(noise(wq*.003+vec2(time*.3,0.))-.5)*1.4+.3*sin(time*1.9+wq.x*.012+wq.y*.007);
      float k=min(h,40.)/40.;
      vec2 dp=(p-center+vec2(0.,.035))*vec2(aspect,1.);
      float push=(1.-smoothstep(.012,.065,length(dp)))*min(h,12.)/12.*2.5;
      return vec2((w*k*k*2.4*wind+sign(dp.x)*push)*2.*art/res.x,0.);
    }
    void main(){
      // aberración cromática leve en los bordes
      vec2 cuv=uv-.5; vec2 ca=cuv*dot(cuv,cuv)*.012;
      // aire que tiembla encima de lo que quema (lava, fuego): sólo donde hay emisión cerca
      vec2 wp0=(vec2(uv.x,1.-uv.y)*res-cam)/art;
      float hm=(smoothstep(.04,.25,lum(texture2D(B1,uv).rgb))*bFx2.x+wx.z*.35)*(1.-bFx2.w);
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
      // onda de los impactos: un anillo que se abre y deforma un poco la imagen
      vec2 sk=vec2(0.);
      for(int i=0;i<4;i++){
        vec4 k=shk[i]; if(k.w<=0.)continue;
        vec2 dv=(uv-k.xy)*vec2(aspect,1.); float dd=length(dv), R=k.z*.09;
        float ring=exp(-pow((dd-R)/.012,2.))*(1.-k.z)*k.w;
        sk+=dv/(dd+1e-4)*ring*.006*vec2(1./aspect,1.);
      }
      vec2 uvD=uv+hz+rz+sk;
      // la vegetación se mece: se lee la imagen desde donde viene la hoja; donde la hoja se ha ido
      // se ve el suelo (G). Un Pokémon u objeto delante no se mueve.
      vec2 sw=vec2(0.); float swG=0.;
      if(wind>0.&&quality>1.5){
        vec4 n0=texture2D(NB,uv);
        if(!(n0.a>.5&&n0.b*255.>63.5)){
          vec2 s0=swayAt(uv);
          if(s0.x==0.){ vec2 dx=vec2(3.*art/res.x,0.); s0=swayAt(uv-dx); if(s0.x==0.) s0=swayAt(uv+dx); }
          vec2 s1=swayAt(uv-s0); if(s1.x==0.) s1=s0;
          vec2 src=uv-s1;
          vec4 ns=texture2D(NB,src);
          if(s1.x!=0.&&ns.a>.5&&ns.b*255.<63.5) sw=-s1;
          else if(n0.a>.5) swG=1.;
        }
      }
      vec3 alb=texture2D(W,uvD+sw).rgb;
      if(swG>.5) alb=texture2D(G,uvD).rgb;
      if(dot(ca*res,ca*res)>.04) alb=vec3(texture2D(W,uvD+ca).r,alb.g,texture2D(W,uvD-ca).b);
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

      // líquido del escenario: se reconoce por sus colores exactos (los del propio juego; ver FS_LIQ)
      vec4 lqv=texture2D(LQ,uvD);
      float liq=lqv.r*(1.-above);
      float wallTop=step(.3,lqv.b)*step(lqv.b,.7), wallFace=step(.8,lqv.b);
      // agua poco profunda junto a la orilla: el fondo se ve deformado por las ondas (refracción)
      if(liq>.5&&quality>1.5){
        float sh=1.-min(min(texture2D(LQ,uvD+vec2(6.*o.x,0.)).r,texture2D(LQ,uvD-vec2(6.*o.x,0.)).r),min(texture2D(LQ,uvD+vec2(0.,6.*o.y)).r,texture2D(LQ,uvD-vec2(0.,6.*o.y)).r));
        if(sh>.01){ vec2 wq=(vec2(uvD.x,1.-uvD.y)*res-cam)/art; vec2 rf=vec2(sin(wq.y*.35+time*1.7),cos(wq.x*.3+time*1.3))*1.5*o*sh; alb=mix(alb,texture2D(W,uvD+rf).rgb,sh); }
      }
      // orilla mojada: la tierra junto al agua, más oscura y con algún brillo
      float shore=0.;
      if(liq<.5&&bLiq.w>.1){
        shore=max(max(texture2D(LQ,uvD+vec2(6.*o.x,0.)).r,texture2D(LQ,uvD-vec2(6.*o.x,0.)).r),max(texture2D(LQ,uvD+vec2(0.,6.*o.y)).r,texture2D(LQ,uvD-vec2(0.,6.*o.y)).r))*(1.-above)*(1.-step(.5,texture2D(NB,uv).a));
        alb*=1.-.28*shore;
      }
      // Reflejos: desde el agua se sube hasta la orilla (dos muestras seguidas que ya no son
      // agua, por la espuma) y se lee lo que hay a la misma distancia por encima de ella. Si es
      // un objeto (árbol, roca, Pokémon), se ve invertido y ondulado en el agua.
      // (pasos de 2 píxeles de arte, hasta 64: un árbol mide unos 40, y los estanques son grandes)
      vec2 mirUv=uv; float mirOn=0.;
      if(liq>.5&&bLiq.w>.1&&quality>1.5){ // reflejos: sólo en calidad alta
        float s=-1.; vec2 st=vec2(0.,4.*o.y);
        for(int i=1;i<=32;i++){
          vec2 q=uv+st*float(i);
          // (la orilla, en la máscara de agua: una lectura en vez de comparar colores en tres;
          // también para en un sprite que pisa el agua: se refleja bajo sus pies)
          if(texture2D(LQ,q).r<.5||texture2D(NB,q).a>.5){s=float(i);break;}
        }
        // ondas: el reflejo tiembla en horizontal, más lejos de la orilla
        float wob=sin(wp.y*.55+time*2.2)+.5*sin(wp.y*1.3-time*3.1+wp.x*.05);
        if(s>0.){
          mirUv=uv+st*(2.*s)+vec2(wob*o.x*(.6+s*.04),0.);
          mirOn=(1.-smoothstep(6.,32.,s));
          float ro=texture2D(M,mirUv).a;
          vec3 rc=texture2D(W,mirUv).rgb;
          // más oscuro y teñido del agua: claro sobre agua clara no se distinguía
          alb=mix(alb,rc*mix(vec3(1.),liqFx,.45)*.55,ro*.7*mirOn*min(1.,bLiq.w)*liq);
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
      // en los sprites manda su normal (capa de sprites): la luz les da volumen, no sólo brillo
      vec4 nb=texture2D(NB,uv+sw);
      float onSpr=step(.5,nb.a)*(1.-swG);
      // Luz por píxel de arte: en el suelo, toda la luz (sombras, antorcha, luces, luz rebotada,
      // oclusión) se mira en el centro del píxel de arte del mundo, así cada píxel del dibujo queda
      // de un solo tono en vez de cruzado por un degradado fino (que delataba un filtro encima).
      // En los sprites no: se mueven entre píxeles del mundo y la rejilla los cortaría.
      vec2 uvL=uv;
      if(pixK>.5){
        vec2 ac=(floor(wp*.5)+.5)*2.;                    // centro del píxel de arte, en el mundo
        vec2 sp=ac*art+cam;                              // en pantalla (y hacia abajo)
        uvL=mix(vec2(sp.x/res.x,1.-sp.y/res.y),uv,onSpr);
      }
      vec2 sxy=nb.rg*2.-1.;
      vec3 sn=vec3(sxy,sqrt(max(0.,1.-dot(sxy,sxy))));
      n=normalize(mix(n,sn,onSpr*.85));
      float ndl=max(dot(n,normalize(vec3(moonDir,.9))),0.);
      // ---- huellas ----
      // (lo que el clima pinta en el suelo —nieve, charcos, barro, huellas— sólo va sobre suelo de
      // verdad: un ataque o un efecto pintado encima no es suelo, y la nieve le pasaba por encima)
      float gnd=(1.-onSpr)*(1.-liq)*(1.-above);
      float trl=texture2D(LQ,uvD).g*gnd;
      // ---- vadeo ----
      // Un Pokémon con los pies en el agua: lo que queda por debajo de la superficie (unos 5 píxeles
      // de arte) se ve más oscuro, del color del agua y ondulado, con una línea clara donde corta.
      if(onSpr>.5&&matOf(nb)==1.){
        float hw=mod(floor(nb.b*255.+.5),64.)*2.;
        vec2 fu=uv-vec2(0.,hw*2.*art/res.y);
        if(texture2D(LQ,fu).r>.5&&hw<7.){
          float sub=1.-smoothstep(3.,5.,hw);
          vec3 und=texture2D(W,uvD+vec2(sin(time*4.+hw*1.7)*.4*2.*art/res.x,0.)).rgb;
          alb=mix(alb,und*.5+liqFx*.14,sub*.8);
          alb+=liqFx*.25*(smoothstep(4.,5.,hw)-smoothstep(5.,6.,hw));
        }
      }
      // ---- clima ----
      float wet=wx2.x, snw=wx2.y;
      // huellas en suelo blando: la arena (tormenta) y el barro (mojado) se oscurecen por donde se
      // pisa; la hierba queda un poco aplastada y más oscura
      alb*=1.-trl*(.05+.14*max(wet,wx.w));
      // Suelo mojado (crece con el tiempo que lleva lloviendo): más oscuro y algo más saturado, como
      // la tierra húmeda. Los charcos salen en los huecos (siempre los mismos sitios del mundo) y se
      // agrandan cuanto más llueve; al parar se encogen y se secan.
      float puddle=0.;
      if(wet>.01){
        float pn=noise(wp*.03)*.62+noise(wp*.085)*.28+noise(wp*.23)*.1;
        float th=mix(.8,.6,wet);
        puddle=smoothstep(th,th+.035,pn)*gnd;
        float gw=wet*gnd;
        alb=mix(vec3(lum(alb)),alb,1.+.3*gw)*(1.-.22*gw);
        // el charco: refleja el cielo (oscuro y azulado) y casi no deja ver el suelo del fondo
        alb=mix(alb,alb*.35+vec3(.025,.04,.07),puddle*.75);
        // y, como el agua, refleja lo que tiene encima (un árbol, un Pokémon), invertido y temblando
        if(puddle>.3&&quality>2.5){
          float sfound=-1.; vec2 st=vec2(0.,4.*art/res.y);
          for(int k=1;k<=14;k++){ if(texture2D(NB,uv+st*float(k)).a>.5){sfound=float(k);break;} }
          if(sfound>0.){
            vec2 mu=uv+st*(2.*sfound)+vec2(sin(wp.y*.6+time*2.5)*.6*art/res.x,0.);
            float ro=texture2D(NB,mu).a;
            alb=mix(alb,texture2D(W,mu).rgb*.42,ro*puddle*.6*(1.-smoothstep(4.,14.,sfound)));
          }
        }
      }
      // Nieve (cuaja con el tiempo): en los sprites, sobre lo que mira hacia arriba (copas, rocas,
      // lomos); en el suelo, más espesa en unas zonas que en otras y sin borrar el dibujo de debajo.
      if(snw>.01){
        // (los Pokémon se mueven: la nieve no se les queda encima; sí a árboles, rocas y cristales)
        float cover;
        // (en árboles y rocas, la nieve se queda en la parte alta: la copa entera, más en lo que mira
        // hacia arriba, y por píxel de arte con tramado; no sólo en el borde de arriba)
        if(onSpr>.5){
          float hs=mod(floor(nb.b*255.+.5),64.)*2.;
          float up=smoothstep(-.1,.45,sxy.y)*.65+smoothstep(.3,.6,sxy.y)*.35;
          float amt2=up*smoothstep(3.,12.,hs)*smoothstep(.0,.5,snw);
          cover=matOf(nb)==1.?0.:step(hash(floor(uv*res/(2.*art))*.73)*.6+.2,amt2)*.85;
        }
        else {
          // por píxel de arte y con tramado, como la pintaría un pixel artist: manchas nítidas que
          // se van cerrando según cuaja (con un degradado suave parecía niebla)
          float nz=noise(pa*.07)*.65+noise(pa*.19)*.35;
          float amt=snw*(.55+.6*nz);
          // (el umbral es un ruido a manchas, no por píxel: al fundirse quedaba un grano de sal)
          cover=step(.2+.5*(noise(pa*.11+.5)*.7+noise(pa*.37+3.1)*.3),amt)*gnd*.8;
          cover*=1.-smoothstep(.15,.6,trl)*.85; // por donde se ha pisado, se ve el suelo
          alb*=1.-trl*.12;
        }
        alb=mix(alb,vec3(.88,.92,.99)*(.78+.45*lum(alb)),cover);
      }

      // ¿este píxel es de un sprite? Exacto: la capa de sprites dice que hay uno y la imagen difiere
      // del suelo solo. Los sprites casi no reciben sombra proyectada (su cara iluminada la da la luz
      // de contorno). La sombra se lee en el píxel, no en el centro del píxel de arte: el pie de un
      // sprite no cae alineado con esa rejilla y la sombra quedaba a un píxel de él.
      float selfE=onSpr*step(.03,max(max(ddg.r,ddg.g),ddg.b));
      vec2 vis=mix(texture2D(S,uv).rg,vec2(1.),selfE*.8);
      // Un sprite se oscurece si sus pies están en una sombra (un Pokémon que pasa bajo un árbol):
      // cada píxel sabe a qué altura está sobre su pie. Se mira un poco hacia cada luz para no
      // tomar como propia la sombra que el sprite echa detrás de sí.
      vec2 ap=vec2(2.*art)/res;                           // un píxel de arte, en uv
      float hh=mod(floor(nb.b*255.+.5),64.)*2.;           // altura sobre el pie (píxeles de arte)
      vec2 footUv=uv-vec2(0.,hh*ap.y);
      if(selfE>.5){
        float vm=texture2D(S,footUv+moonDir*ap*3.).r;
        vec2 tp=center-footUv; float tl=length(tp*vec2(aspect,1.));
        float vt=texture2D(S,footUv+tp/max(tl,1e-3)*ap.y*3.).g;
        vis=mix(vec2(1.),vec2(vm,vt),.85);
      }
      vis=mix(vis,vec2(1.),liq*.8);
      float moonVis=mix(1.,vis.r,shadowK);
      moonVis*=texture2D(S,uvL).a; // copas y nubes (FS_SHADOW)
      float torchVis=mix(1.,vis.g,.88);
      vec2 dT=(uvL-center)*vec2(aspect,1.);
      // escena clara (hielo, cielo, arena): menos antorcha, menos niebla y menos exposición,
      // o el suelo casi blanco se quema en crema y pierde su color
      float bk=smoothstep(.32,.62,texture2D(EXPO,vec2(.5)).r);
      float att=torchAtt(uvL)*(1.-.55*bk);
      float tdl=.55+.45*max(dot(n,normalize(vec3(-dT,.35))),0.);
      vec3 g=texture2D(GI,uvL*giST.xy+giST.zw).rgb*gi; // (con su parpadeo: FS_RCOUT)
      g/=1.+lum(g)*1.4; // tope suave: un lago de lava ilumina su orilla, no tiñe toda la pantalla

      // oclusión ambiental: el suelo se oscurece al pie de lo que tiene encima
      float aoF=1.-ao*smoothstep(.05,.55,texture2D(B1,uvL).a)*(1.-occ);
      // sombra de contacto: el suelo se oscurece justo al pie de cada objeto
      aoF*=1.-.5*smoothstep(0.,.8,texture2D(S,uv).b)*(1.-selfE)*(1.-liq);
      // la base de cada sprite se oscurece donde toca el suelo (le da peso: no parece una pegatina)
      aoF*=1.-.32*selfE*(1.-smoothstep(0.,7.,hh));
      // al pie de los acantilados el suelo queda en penumbra
      aoF*=1.-.4*lqv.a*(1.-onSpr);

      // luz de contorno: borde del sprite que mira a la antorcha / a la luna
      float ex=0.,ey=0.;
      if(occ>.02&&onSpr<.5){ // (los sprites la sacan de su normal)
        ex=texture2D(M,uv+vec2(o.x,0)).a-texture2D(M,uv-vec2(o.x,0)).a;
        ey=texture2D(M,uv+vec2(0,o.y)).a-texture2D(M,uv-vec2(0,o.y)).a;
      }
      vec2 edge=-vec2(ex,ey);
      edge=mix(edge,sxy*1.4,onSpr); // con normal de sprite, el borde que mira a la luz sale de ella
      float el=length(edge);
      vec2 en=edge/(el+1e-4);
      float rimT=max(dot(en,normalize(-dT+1e-4)),0.)*att;
      float rimM=max(dot(en,moonDir),0.)*.35*moonVis;
      vec3 rimL=(torch*rimT+moon*rimM+g*.6)*smoothstep(.05,.5,el)*occ*rim;

      // Luces puntuales: cada fuego, proyectil encendido o cosa que brilla es una luz de verdad,
      // un poco por encima del suelo. Cae con la distancia como una luz real (cuadrado inverso,
      // suavizado) y a los sprites los ilumina por el lado que mira hacia ella (su normal).
      vec3 pl=vec3(0.), ps=vec3(0.), bl=vec3(0.);
      // brillo del material, más en lo claro que en lo oscuro del mismo sprite
      float mi=matOf(nb), mb=mi<.5?.1:mi<1.5?.14:mi<2.5?.38:.95;
      float matS=mb*(.35+.65*lum(alb))*onSpr, shin=10.+mb*60.;
      for(int i=0;i<16;i++){
        if(float(i)>=nLights)break;
        vec4 L=lp[i];
        vec2 d=(L.xy-uvL)*vec2(aspect,1.);
        float r=L.z, dist=length(d);
        vec3 Ld=normalize(vec3(d,r*.35));
        float fall=1./(1.+dist*dist/(r*r)*2.)*(1.-smoothstep(r*1.6,r*3.,dist));
        float fl=1.+bFx.w*.25*sin(time*(9.+float(i)*1.7)+float(i)*4.1)*sin(time*5.3+float(i));
        // las dos luces más fuertes proyectan sombra: del suelo hacia la luz, ¿se cruza algún sprite?
        float lsh=1.;
        if(i<2&&quality>2.5&&onSpr<.5&&fall>.03){
          vec2 to=L.xy-uvL; float oc=0.;
          for(int k=1;k<=8;k++){ float tt=float(k)/10.; oc=max(oc,texture2D(NB,uvL+to*tt).a*(1.-tt)); }
          lsh=1.-min(1.,oc*1.4)*.8;
        }
        pl+=lc[i]*L.w*fall*fl*lsh*mix(.4+.6*max(dot(n,Ld),0.),max(dot(n,Ld),0.)*1.2,onSpr);
        // hojas y hierba con la luz detrás: el borde que da la espalda a la luz se enciende (la luz
        // las atraviesa)
        if(onSpr>.5&&mi<.5) bl+=lc[i]*L.w*fall*max(-dot(normalize(n.xy+1e-4),normalize(Ld.xy+1e-4)),0.)*(1.-n.z);
        if(matS>.01) ps+=lc[i]*L.w*fall*pow(max(dot(n,normalize(Ld+vec3(0.,0.,1.))),0.),shin);
      }
      // (y la luz del jugador: las hojas al otro lado se iluminan a contraluz)
      if(onSpr>.5&&mi<.5) bl+=torch*att*max(dot(normalize(n.xy+1e-4),normalize(dT+1e-4)),0.)*(1.-n.z)*.8;
      vec3 light=ambient*aoF*(.7+.3*moonVis)+pl+bl*vec3(.75,1.,.45)*1.6
                +moon*ndl*moonVis*1.2
                +torch*att*tdl*torchVis
                +g*aoF+rimL
                +flashCol*flash*aoF // relámpago: un fogonazo...
                +flashCol*flash*moonVis*ndl*4. // ...que llega de lo alto, así que cada cosa echa su sombra
                +vec3(.6,.35,1.)*riftA*exp(-rd*rd*.12)*(1.+.25*sin(time*3.)); // luz violeta de la grieta, que palpita
      vec3 e=m.rgb;
      float em=clamp(max(max(e.r,e.g),e.b)*2.,0.,1.);
      vec3 b=texture2D(B1,uv).rgb*.5+texture2D(B2,uv).rgb*.32+texture2D(B3,uv).rgb*.18;
      // sombras con cambio de tono, como las pinta un pixel artist: no sólo más oscuras, más frías
      float shAmt=clamp((1.-moonVis)*1.3+(1.-torchVis)*smoothstep(.02,.3,att)+(1.-aoF)*1.5,0.,1.);
      // Suelo de luz: sombra de luna + sombra de antorcha + oclusión se multiplicaban y, donde
      // coincidían las tres, el suelo se quedaba casi negro. Nunca por debajo del 70 % del ambiente.
      light=max(light,ambient*.7);
      // acantilados con volumen: lo alto recibe la luna de lleno; la cara frontal, en penumbra
      light*=1.+wallTop*.25*moonVis-wallFace*.28;
      light+=moon*moonVis*wallTop*.18;
      // setas que brillan en la oscuridad y aurora reflejada en el suelo
      light+=vec3(.3,.85,1.)*decoHalo*glowK*.9;
      if(auroraK>0.){
        float ab=smoothstep(.5,.85,noise(vec2(wp.x*.0035+time*.025,wp.y*.0012-time*.008))*.7+noise(vec2(wp.x*.009-time*.03,wp.y*.004))*.3);
        vec3 ac=mix(vec3(.1,1.,.5),vec3(.45,.35,1.),smoothstep(.55,.9,noise(vec2(wp.x*.002,time*.02))));
        light+=ac*ab*auroraK*.12*(1.+liq*1.5);
      }
      // Escalones: la intensidad de la luz salta en pasos (cada uno ~19 % más claro que el
      // anterior), como sombrea un pixel artist, con el borde de cada paso suavizado. Mitad
      // escalonada y mitad continua: del todo escalonada se veían curvas de nivel.
      if(bandK>0.){
        float Ll=max(lum(light),.001), lg=log2(Ll)*4.;
        float fl=floor(lg), fr=lg-fl;
        float Lq=exp2((fl+smoothstep(.35,.65,fr))/4.);
        light*=mix(1.,Lq/Ll,bandK);
      }
      vec3 col=alb*light*mix(vec3(1.),shadowHue,shAmt*.8)+b*bloom*(1.-em*.8);
      // brillo especular (cámara mirando desde arriba): el punto del sprite que refleja la luna,
      // la antorcha o una luz cercana hacia nosotros. Cristales y gemas destellan; el pelo apenas.
      if(matS>.01){
        vec3 V=vec3(0.,0.,1.);
        vec3 Hm=normalize(normalize(vec3(moonDir,.9))+V), Ht=normalize(normalize(vec3(-dT,.35))+V);
        col+=matS*(moon*moonVis*pow(max(dot(n,Hm),0.),shin)*1.2+torch*att*torchVis*pow(max(dot(n,Ht),0.),shin)*1.8+ps*1.5);
      }
      // el líquido: brillo propio (veneno, pantano), que respira despacio, y destellos donde le da la luz
      col+=liq*liqFx*bLiq.x*(.3+.06*sin(time*.8+noise(pa*.05)*6.));
      float glint=step(.985,hash(pa+floor(time*3.)))*step(.5,noise(pa*.2+time*.5));
      col+=liq*glint*bLiq.w*(torch*att*1.5+moon*moonVis*.8);
      if(liq>.01&&quality>1.5){
        // toda la superficie refleja: brillo de luna y antorcha que corre con las ondas,
        // las luces cercanas (fuegos, calabazas, ataques) temblando, y un poco de cielo
        float sheen=smoothstep(.55,.95,noise(pa*vec2(.05,.16)+vec2(time*.15,time*.05)))*smoothstep(.3,.8,noise(pa*.03-time*.07));
        vec3 sky=moon*moonVis*.12+torch*att*.08; // poca antorcha: sumada al agua la volvía crema y tapaba los reflejos
        vec3 rl=(texture2D(B1,mirUv).rgb*.6+texture2D(B2,mirUv).rgb*.4)*mirOn;
        // cielo reflejado: nubes que pasan despacio y se rompen con las ondas, para que el centro
        // de un lago grande, lejos de toda orilla, también refleje algo (menos donde ya hay reflejo)
        vec2 cp=wp+vec2(sin(wp.y*.55+time*1.1)*.8,0.);
        float cl=noise(cp*.006+vec2(time*.008,time*.003))*.65+noise(cp*.017-vec2(time*.012,0.))*.35;
        float cloud=smoothstep(.42,.78,cl);
        sky+=(moon*moonVis*.13+ambient*.08)*cloud*(1.-mirOn*.6)-ambient*.03*(1.-cloud);
        col+=liq*bLiq.w*(sheen*(moon*moonVis*.35+torch*att*.6)+sky+rl*1.2);
      }
      // charcos: espejos de la luz que tienen cerca (antorcha, fuegos, luna) y anillos de las gotas
      if(puddle>.01){
        // gotas: anillos que se abren (con posición fina, no por píxel: salían cuadraditos); dos
        // capas desfasadas para que no se vea la rejilla, y más cuanto más fuerte llueve
        float pr=0.;
        for(int k=0;k<2;k++){
          vec2 o2=vec2(float(k)*7.,float(k)*3.);
          vec2 rc=floor((wp+o2)/11.); float rh=hash(rc+.3+float(k)), rt=fract(time*(1.4+float(k)*.3)+rh*9.);
          vec2 rpp=(rc+.2+.6*vec2(hash(rc+2.1),hash(rc+4.7)))*11.-o2;
          pr+=smoothstep(.8,0.,abs(length(wp-rpp)-rt*4.5))*(1.-rt)*step(1.-wx.x*.7,rh);
        }
        // reflejo: la luz cercana se ve en el charco como un brillo alargado que tiembla con las ondas
        float gl2=smoothstep(.55,.85,noise(vec2(wp.x*.12,wp.y*.04)+vec2(0.,time*.12)));
        col+=puddle*((torch*att*.4+pl*.5+moon*moonVis*.14)*(.5+.3*gl2)+pr*(moon*moonVis*.3+torch*att*.45+.03));
      }
      // salpicaduras: con lluvia fuerte, gotas que rebotan en cualquier sitio del suelo (un instante)
      if(wx.x>.05){
        vec2 sc=floor(wp*.5); float sp=step(1.-wx.x*.0012,hash(sc+floor(time*14.)*1.37));
        col+=sp*gnd*(moon*moonVis*.25+torch*att*.5+.04);
      }
      // suelo mojado: un brillo suave de la luz cercana (no sólo en los charcos)
      if(wet>.01) col+=wet*gnd*(torch*att*.12+pl*.15)*smoothstep(.5,.8,noise(wp*.2));
      // agua: la luna se refleja como un disco que tiembla con las olas, espuma en la orilla y
      // ondas a los pies de lo que se mete en el agua
      if(liq>.05&&bLiq.w>.1){
        vec2 mpos=vec2(.5,.5)-vec2(moonDir.x/aspect,moonDir.y)*.32;
        vec2 dm=(uv-mpos)*vec2(aspect,1.)+vec2(sin(wp.y*.5+time*2.)*.006,0.);
        float disc=exp(-dot(dm,dm)/.0035)*(.6+.4*noise(pa*.4+time*1.5));
        col+=liq*moon*moonVis*disc*1.1*bLiq.w;
        float e4=min(min(texture2D(LQ,uvD+vec2(o.x*3.,0.)).r,texture2D(LQ,uvD-vec2(o.x*3.,0.)).r),min(texture2D(LQ,uvD+vec2(0.,o.y*3.)).r,texture2D(LQ,uvD-vec2(0.,o.y*3.)).r));
        float foam=(1.-smoothstep(.3,.9,e4))*smoothstep(.45,.75,noise(pa*.35+vec2(time*.6,time*.2)));
        col=mix(col,vec3(.85,.92,1.)*(light*.9+.08),liq*foam*.45*min(1.,bLiq.w*1.5));
        for(int i=0;i<8;i++){
          if(float(i)>=nRp)break;
          vec2 dv=(uv-rp[i].xy)*vec2(aspect,1.); float dd=length(dv)/rp[i].z;
          float ring=max(0.,sin(dd*28.-time*7.))*exp(-dd*2.2)*step(.15,dd);
          col+=liq*ring*.10*(moon*moonVis+torch*att+.1)*step(.5,texture2D(LQ,rp[i].xy).r);
        }
      }
      // de noche, el agua refleja estrellas que titilan
      if(liq>.5&&nightK>0.){ float st=step(.9965,hash(pa*.913+.2))*(.4+.6*sin(time*(1.5+hash(pa)*3.)+hash(pa*1.7)*30.)); col+=st*nightK*bLiq.w*moon*moonVis*1.3*(1.-wx.x); }
      // ---- clima sobre la luz ----
      col*=mix(vec3(1.),vec3(.86,.92,1.04),wx.x*.7);   // lluvia: más frío y apagado
      col*=mix(vec3(1.),vec3(.95,.98,1.05),max(wx.y,snw)*.5); // nieve: luz fría y limpia
      col*=mix(vec3(1.),vec3(1.1,1.03,.88),wx.z*.55);  // sol abrasador: luz blanca y cálida
      col*=mix(vec3(1.),vec3(1.14,.98,.76),wx.w*.75);  // arena: amarillenta y con menos contraste
      col=mix(col,vec3(.72,.58,.38)*(lum(col)*.6+.25),wx.w*.1*(1.-.5*onSpr)); // (calima: el aire está lleno de polvo)
      // con nieve, las sombras se vuelven azules (el cielo se refleja en la nieve)
      col=mix(col,col*vec3(.82,.9,1.12),snw*shAmt*.6);
      // arena: nubes de polvo que pasan con el viento (bandas largas y deshilachadas, no rayas) y
      // granos que vuelan, cada uno una rayita fugaz
      if(wx.w>.01){
        vec2 wq=wp*vec2(.012,.03)+vec2(-time*.9,0.);
        float dust=smoothstep(.3,.8,noise(wq)*.6+noise(wq*2.7+vec2(time*.3,0.))*.4)*wx.w;
        // (sobre los sprites, algo menos: si no, árboles y Pokémon parecían fantasmas)
        // el polvo tapa la luz y tiñe: oscurece hacia el ocre, no lo blanquea todo
        col=mix(col,col*vec3(.92,.76,.54)+vec3(.06,.04,.02)*(light+.3),dust*.5*(1.-.35*onSpr));
        // granos: dos capas a distinta velocidad (los cercanos van más rápido)
        for(int k=0;k<2;k++){
          float sp=6.+float(k)*5.;
          vec2 gc=vec2(wp.x*.05+time*sp+float(k)*13.,floor(wp.y*.5)+float(k)*31.);
          float gr=step(.965,hash(vec2(floor(gc.x),gc.y)))*smoothstep(.0,.7,fract(gc.x))*(1.-fract(gc.x));
          col+=gr*wx.w*(vec3(.9,.75,.5)*.12+moon*.25+torch*att*.4);
        }
      }
      // escarcha / polvo de cristal / nieve: destellos sueltos que se encienden y apagan, sólo donde
      // les da la luz (en la sombra, la nieve no brilla)
      float frost=step(.997-snw*.0005,hash(pa*1.7+floor(time*2.5)))*(1.-liq)*(1.-above)*min(1.,bFx2.y+snw);
      col+=frost*(vec3(.35,.4,.45)*(.3+.7*moonVis)+torch*att+moon*moonVis*.6);

      // niebla y haces de luz (pasada aparte a 1/4 de resolución, ver FS_VOL)
      vec4 vol=texture2D(VOL,uv);
      float dens=vol.a; vec3 scatter=vol.rgb/max(dens,1e-3);
      col=col*(1.-dens*.6)+vol.rgb;

      // partículas del escenario (luciérnagas, destellos, brasas, fuegos fatuos, esporas),
      // iluminadas por lo que haya cerca y con su propio brillo
      vec2 mp=wp/(26.*moteP.w)+vec2(0.,time*moteP.y);
      vec2 cell=floor(mp); vec2 fp=fract(mp);
      float r1=hash(cell);
      vec2 c=vec2(hash(cell+1.7),hash(cell+4.3))*.7+.15+.1*vec2(sin(time*1.3+r1*40.),cos(time*1.1+r1*30.));
      float blink=mix(.6+.4*sin(time*3.+r1*60.),pow(max(0.,sin(time*1.7+r1*60.)),4.),moteP.z);
      float dot_=(1.-smoothstep(.0,.045,length(fp-c)))*step(1.-moteP.x*.3,r1)*blink;
      col+=dot_*motes*.55*(torch*att*1.2+g*1.5+moon*.25+moteCol*.6);
      // (la luz que echan las luciérnagas al suelo va con la luz rebotada: FS_RCOUT)

      // brasas: cada luz de fuego suelta chispitas que suben, se mecen y se apagan; y cada golpe
      // salta en chispas que salen disparadas y caen
      if(quality>2.5&&nLights>0.){
        vec2 apx=vec2(2.*art)/res;
        for(int i=0;i<4;i++){
          if(float(i)>=nLights)break;
          vec4 L=lp[i];
          if(lc[i].r<lc[i].b)continue; // (sólo luces cálidas: el agua no echa brasas)
          vec2 dl=(uv-L.xy)*vec2(aspect,1.);
          if(length(dl)>L.z*1.2)continue;
          for(int k=0;k<5;k++){
            float fk=float(k), fi=float(i);
            float ph=fract(time*.55+fk*.2+fi*.37+hash(vec2(fk,fi))*.5);
            if(ph<.12)continue; // (nacen ya fuera de la llama: encima la blanqueaban)
            vec2 pos=L.xy+vec2((hash(vec2(fk,fi+3.))-.5)*L.z*.5/aspect+sin(time*2.+fk*1.7)*apx.x*3.*ph,ph*L.z*.9);
            float dd=length((uv-pos)/apx);
            col+=lc[i]*L.w*(1.-smoothstep(.4,1.2,dd))*(1.-ph)*(1.-ph)*.9;
          }
        }
        for(int i=0;i<4;i++){
          vec4 K=shk[i]; if(K.w<=0.)continue;
          if(length((uv-K.xy)*vec2(aspect,1.))>.1)continue; // (sólo cerca del golpe)
          for(int k=0;k<8;k++){
            float an=float(k)*.785+float(i)*1.3+hash(vec2(float(k),float(i)))*.5;
            float sp=.035+.025*hash(vec2(float(k)+7.,float(i)));
            vec2 pos=K.xy+vec2(cos(an)/aspect,sin(an))*K.z*sp-vec2(0.,K.z*K.z*.03);
            float dd=length((uv-pos)/apx);
            col+=vec3(1.,.8,.5)*(1.-smoothstep(.3,1.,dd))*(1.-K.z)*(1.-K.z)*K.w*1.6;
          }
        }
      }
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
      // destellos de lente: una raya horizontal suave en las luces más fuertes
      if(quality>1.5) for(int i=0;i<4;i++){
        if(float(i)>=nLights)break;
        vec2 dd=(uv-lp[i].xy)*vec2(aspect,1.);
        col+=lc[i]*lp[i].w*exp(-abs(dd.y)*260.)*exp(-abs(dd.x)*9.)*.35;
      }
      col=tm>.5?agx(col*exposure*(1.-.3*bk)):aces(col*exposure*(1.-.3*bk));
      col=mix(col,alb*(.62+.25*light),bk*.42); // en escenas claras manda más el color del juego
      col=mix(col,alb,em*.85);
      // Los sprites conservan su color: con mucha luz cálida y la curva de tonos, un Gastly morado
      // junto al jugador se quedaba rosa pálido. Se mantiene su brillo y se le devuelve el tono.
      float lc=lum(col), la=max(lum(alb),.04);
      // (no en lo casi negro, como los contornos: si la niebla o el polvo los aclaraban, al devolverles
      // su color se multiplicaba muchísimo y salían verde chillón; y menos cuanto más cargado está el aire)
      col=mix(col,clamp(alb*min(lc/la,2.2),0.,1.),smoothstep(.3,.8,occ)*.55*smoothstep(.05,.18,lum(alb))*(1.-.75*max(wx.w,wx2.z)));
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
      if(dbg>5.5)col=nb.a>.5?vec3(nb.rg,matOf(nb)/3.):vec3(texture2D(S,uv).rgb*.5);
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
      prep: compile(FS_PREP), shadow: compile(FS_SHADOW), rc: compile(FS_RC), rcout: compile(FS_RCOUT), temporal: compile(FS_TEMPORAL), avg: compile(FS_AVG), pcol: compile(FS_PCOL),
      down: compile(FS_DOWN), blur: compile(FS_BLUR), comp: compile(FS_COMP), floor: compile(FS_FLOOR), vol: compile(FS_VOL), decocell: compile(FS_DECOCELL), liq: compile(FS_LIQ), trail: compile(FS_TRAIL), tilt: compile(FS_TILT), wallm: compile(FS_WALLM)
    };
  } catch (e) { console.warn('[luz] shaders:', e); cv.remove(); return; }
  for (const k in P) P[k].name = k;

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
  let tiltOn = /[?&]maqueta=1/.test(location.search); // efecto maqueta (opción del menú)
  let T = null, size = '', fresh = 2;
  function ensureTargets(w, h) {
    const k = w + 'x' + h;
    if (k === size) return;
    size = k;
    fresh = 2; // los historiales nuevos están en negro: los dos primeros frames no se mezclan con ellos
    if (T) for (const r of Object.values(T)) { gl.deleteTexture(r.t); gl.deleteFramebuffer(r.f); }
    const d = n => [Math.ceil(w / n), Math.ceil(h / n)];
    T = {
      prep: target(...d(2)), shadow: target(...d(2)), shadowb: target(...d(2)),
      sHistA: target(...d(2)), sHistB: target(...d(2)),
      q: target(...d(4)),
      // cascadas: sondas cada 2 texels de 1/4, con margen para correr la rejilla con la cámara
      ...(() => { const [qw, qh] = d(4), pw = Math.ceil((qw / 2 + 16) / 16) * 16, ph = Math.ceil((qh / 2 + 16) / 16) * 16;
        return { rcA: target(pw * 2, ph * 2), rcB: target(pw * 2, ph * 2), giOut: target(pw, ph), giTmp: target(pw, ph) }; })(), vol: target(...d(4)), volTmp: target(...d(4)), liq: target(...d(2)), wm: target(...d(2)), trA: target(...d(4)), trB: target(...d(4)), fin: target(w, h),
      e8: target(...d(8)), e8b: target(...d(8)),
      e16: target(...d(16)), e16b: target(...d(16)),
      e32: target(...d(32)), e32b: target(...d(32)),
      avg: target(1, 1), avgA: target(1, 1), avgB: target(1, 1), pcol: target(1, 1)
    };
  }

  // Perfilador (pruebas): tiempo de GPU de cada pasada con EXT_disjoint_timer_query. Las
  // consultas se recogen frames después, cuando la GPU ya las ha resuelto.
  const tq = gl.getExtension('EXT_disjoint_timer_query');
  const profQ = [], prof = {}; let profFrames = 0;
  function profBegin(name) {
    if (!tune.prof || !tq) return null;
    const q = tq.createQueryEXT(); tq.beginQueryEXT(tq.TIME_ELAPSED_EXT, q); return [name, q];
  }
  function profEnd(p) { if (p) { tq.endQueryEXT(tq.TIME_ELAPSED_EXT); profQ.push(p); } }
  function profPoll() {
    if (!tq) return;
    if (tune.prof) profFrames++;
    while (profQ.length && tq.getQueryObjectEXT(profQ[0][1], tq.QUERY_RESULT_AVAILABLE_EXT)) {
      const [name, q] = profQ.shift();
      if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) prof[name] = (prof[name] || 0) + tq.getQueryObjectEXT(q, tq.QUERY_RESULT_EXT) / 1e6;
      tq.deleteQueryEXT(q);
    }
  }
  function pass(prog, out, binds, set) {
    if (tune.skip && tune.skip[prog.name]) return; // (pruebas de rendimiento)
    const pq = profBegin(prog.name);
    try { pass1(prog, out, binds, set); } finally { profEnd(pq); }
  }
  function pass1(prog, out, binds, set) {
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
  // 3: luz rebotada fina · 2 y 1: más gruesa, y sin reflejos en el agua · 0: sin luz rebotada ni haces
  let quality = matchMedia('(pointer:coarse)').matches ? 2 : 3;
  const RC_STEPS = [0, 6, 10, 16]; // tope de pasos por tramo de cada cascada según la calidad
  // El objetivo es la frecuencia de la pantalla (60, 120, 144 Hz...), no un número fijo: antes sólo
  // bajaba de 47 fps y en una pantalla de 60 Hz se notaba lento sin que la calidad bajara nunca.
  // La frecuencia sale de los frames más rápidos (con sincronía vertical, aunque se vaya lento,
  // bastantes frames siguen llegando justo a tiempo). Si la media va un 15 % por encima durante 1,5 s,
  // un escalón menos; para subir hace falta ir sobrado 6 s y, si al subir vuelve a ir lento, se
  // espera cada vez más antes de intentarlo otra vez (sin eso oscilaba: sube, va lento, baja...).
  let slowSince = 0, fastSince = 0, lastT = 0, avgDt = 16, refreshMs = 16.7, raisedAt = -1e9, upBlock = 0, upWait = 8000;
  const dtRing = new Float32Array(120); let dtIdx = 0, dtN = 0, refreshKnown = false;
  function adapt(now) {
    const dt = lastT ? Math.min(100, now - lastT) : 16;
    lastT = now;
    avgDt = avgDt * .95 + dt * .05;
    dtRing[dtIdx] = dt; dtIdx = (dtIdx + 1) % dtRing.length; dtN = Math.min(dtN + 1, dtRing.length);
    if (dtN === dtRing.length && dtIdx === 0) {
      const sorted = Array.from(dtRing).sort((a, b) => a - b);
      // percentil 25, y como mucho 165 Hz: hay navegadores que entregan frames a ráfagas (dos
      // seguidos casi sin espera) y con el percentil 5 la pantalla "parecía" de 250 Hz
      refreshMs = Math.max(1000 / 165, Math.min(34, sorted[30]));
      refreshKnown = true;
    }
    if (!refreshKnown) return;
    // (a más de 75 fps no se baja nada aunque la pantalla dé más: ya va suelto; y por encima de
    // 110 se puede subir aunque no llegue a la frecuencia de una pantalla muy rápida)
    if (avgDt > refreshMs * 1.15 && avgDt > 1000 / 75) {
      fastSince = 0;
      if (!slowSince) slowSince = now;
      else if (now - slowSince > 1500 && quality > 0) {
        quality--; slowSince = 0;
        if (now - raisedAt < 10000) upWait = Math.min(120000, upWait * 2); // la subida no aguantó
        upBlock = now + upWait;
      }
    } else if (avgDt < refreshMs * 1.04 || avgDt < 1000 / 110) {
      slowSince = 0;
      if (!fastSince) fastSince = now;
      else if (now - fastSince > 6000 && quality < 3 && now > upBlock) { if (quality === 0) fresh = 2; quality++; fastSince = 0; raisedAt = now; }
    } else { slowSince = 0; fastSince = 0; }
  }

  // las 16 luces más fuertes del frame, en coordenadas del shader (y hacia arriba, radio en alturas de pantalla)
  const lpBuf = new Float32Array(64), lcBuf = new Float32Array(48), lIdx = [];
  function setLights(u, w, h) {
    const n = lights.length / 7;
    lIdx.length = 0; for (let i = 0; i < n; i++) lIdx.push(i);
    lIdx.sort((a, b) => lights[b * 7 + 3] - lights[a * 7 + 3]);
    const k = Math.min(16, n);
    stats.luces = n;
    for (let j = 0; j < k; j++) {
      const i = lIdx[j] * 7;
      lpBuf.set([lights[i] / w, 1 - lights[i + 1] / h, lights[i + 2] / h, lights[i + 3]], j * 4);
      lcBuf.set([lights[i + 4], lights[i + 5], lights[i + 6]], j * 3);
    }
    if (u['lp[0]']) { gl.uniform4fv(u['lp[0]'], lpBuf); gl.uniform3fv(u['lc[0]'], lcBuf); }
    gl.uniform1f(u.nLights, tune.lights ? k : 0);
  }
  // colores de suelo de cada escenario (3 por escenario; si tiene 2, el último se repite)
  const texFC = tex();
  {
    const px = new Uint8Array(NBIO * 3 * 4);
    BIOMES.forEach((b, i) => { for (let k = 0; k < 3; k++) { const c = hex(b.floor[Math.min(k, b.floor.length - 1)]); for (let ch = 0; ch < 3; ch++) px[(i * 3 + k) * 4 + ch] = Math.round(c[ch] * 255); px[(i * 3 + k) * 4 + 3] = 255; } });
    gl.bindTexture(gl.TEXTURE_2D, texFC);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, NBIO * 3, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }
  // celdas de decoración visibles (128×128: una pantalla 4K a la escala más pequeña necesita ~110)
  const TDC = target(128, 128);
  gl.bindTexture(gl.TEXTURE_2D, TDC.t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const TF = target(NBIO + 160, 1), floorPx = new Uint8Array((NBIO + 160) * 4);
  let floorAt = 0, floorPending = false, floorValid = false;
  // Se lee el resultado del cálculo del frame anterior (ya terminado: no hace esperar a la GPU)
  // y se lanza el siguiente. Dos veces por segundo basta: los escenarios se funden en 2,5 s.
  function floorStats(now) {
    if (now - floorAt < 450) return;
    floorAt = now;
    if (floorPending) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, TF.f);
      gl.readPixels(0, 0, NBIO + 160, 1, gl.RGBA, gl.UNSIGNED_BYTE, floorPx);
      const val = i => floorPx[i * 4] / 255 + floorPx[i * 4 + 1] / 65025;
      for (let k = 0; k < NBIO; k++) frameFloor[k] = val(k) * 65536; // (en la escala de antes: umbral 300 ≈ 0,5 %)
      let tot = 0;
      for (let k = 0; k < 160; k++) tot += (frameBins[k] = val(NBIO + k));
      if (tot > .01) { let acc = 0; for (let k = 0; k < 160; k++) { acc += frameBins[k]; if (acc >= tot / 2) { grassRatio = .8 + k / 100; break; } } }
      floorValid = true;
    }
    pass(P.floor, TF, [['G', texG], ['FC', texFC]], u => gl.uniform2f(u.res, game.width, game.height));
    floorPending = true;
  }
  // La rejilla de sondas va anclada al mundo (se corre con la cámara, en múltiplos de la
  // separación más grande): con la rejilla fija en pantalla, la luz rebotada temblaba al andar.
  const rpBuf = new Float32Array(32); let nRp = 0;
  function feetUniform(w, h) {
    const idx = [];
    for (let i = 0; i < feet.length; i += 3) idx.push(i);
    idx.sort((a, b) => Math.hypot(feet[a] - w * .5, feet[a + 1] - h * .48) - Math.hypot(feet[b] - w * .5, feet[b + 1] - h * .48));
    nRp = Math.min(8, idx.length); rpBuf.fill(0);
    for (let j = 0; j < nRp; j++) { const i = idx[j]; rpBuf.set([feet[i] / w, 1 - feet[i + 1] / h, Math.max(.02, feet[i + 2] / h * 1.2), 0], j * 4); }
  }
  let giST = [1, 1, 0, 0];
  function radianceCascades(now, flick, motesK, mp, mc) {
    const qw = T.q.w, qh = T.q.h, pw = T.giOut.w, ph = T.giOut.h, N = 5, per = 2 * 2 ** (N - 1);
    const md = (x, m) => ((x % m) + m) % m;
    const offX = md(camE / 4, per) - per, offY = md(-camF / 4, per) - per;
    // la escena que mira cada cascada: cerca, a 1/4; lejos, las versiones reducidas
    const scene = [T.q.t, T.q.t, T.e8.t, T.e16.t, T.e32.t];
    let src = null, dst = T.rcA;
    // pasos de cada tramo: uno por texel de la escena que mira (cerca no hacen falta tantos;
    // lejos, con pocos, se saltaba lo fino y la luz se colaba), con tope según la calidad
    const texel = [1, 1, 2, 4, 8], cap = RC_STEPS[quality];
    for (let i = N - 1; i >= 0; i--) {
      const steps = Math.max(2, Math.min(cap, 2 * 4 ** i / texel[i]));
      pass(P.rc, dst, [['SC', scene[i]], ['UP', src ? src.t : T.rcB.t]], u => {
        gl.uniform2f(u.qres, qw, qh); gl.uniform2f(u.p0, pw, ph); gl.uniform2f(u.off, offX, offY);
        gl.uniform1f(u.ci, i); gl.uniform1f(u.last, i === N - 1 ? 1 : 0);
        gl.uniform1f(u.L0, 2); gl.uniform1f(u.steps, steps); gl.uniform1f(u.texel, texel[i]);
      });
      src = dst; dst = dst === T.rcA ? T.rcB : T.rcA;
    }
    pass(P.rcout, T.giOut, [['C0', src.t]], u => {
      gl.uniform2f(u.p0, pw, ph); gl.uniform1f(u.k, tune.giK); gl.uniform2f(u.off, offX, offY);
      gl.uniform2f(u.cam, camE, camF); gl.uniform1f(u.art, artScale); gl.uniform1f(u.hgt, game.height);
      gl.uniform1f(u.time, (now / 1000) % 3600); gl.uniform1f(u.flick, flick);
      gl.uniform1f(u.motes, motesK); gl.uniform4f(u.moteP, mp[0], mp[1], mp[2], mp[3]); gl.uniform3fv(u.moteCol, mc);
    });
    blur(T.giOut, T.giTmp);
    giST = [qw / (2 * pw), qh / (2 * ph), -offX / (2 * pw), -offY / (2 * ph)];
  }
  let wallsOn = false;
  let artScale = 2.5, camE = 0, camF = 0, prevE = 0, prevF = 0, debug = 0, frame = 0, histFlip = false;
  function render(now) {
    const w = game.width, h = game.height;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    ensureTargets(w, h);
    adapt(now);
    shown = lerpPreset(shown, PRESETS[mode] || shown, .04);
    frame++;
    const center = [0.5, 0.52];
    floorStats(now);
    wxUpdate(Math.min(.1, (now - (render.lastWx || now)) / 1000)); render.lastWx = now;
    impactsUpdate(now); gemsUpdate(now);

    // escenario: el que más suelo hay en pantalla (última lectura); fundido entre uno y otro
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
    if (best >= 0) bioNow = best; else if (floorValid && frameChunks >= 2 && binsFrame === frameId) bioNow = -1;
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
    // (y con lluvia fuerte, tormenta: más a menudo, cada 10-22 s)
    const storm = wxCur[1] > .55 ? wxCur[1] : 0, lightK = Math.max(bio.lightning, storm);
    if (lightK > .01) {
      if (!render.nextFlash) render.nextFlash = now + 6000;
      if (now > render.nextFlash) { render.flashAt = now; render.nextFlash = now + (storm ? 10000 + Math.random() * 12000 : 20000 + Math.random() * 15000); }
    }
    const ft = (now - (render.flashAt || -1e9)) / 1000;
    const flash = (calm ? 0 : 1) * lightK * (Math.exp(-ft * 6) * (ft >= 0) + .6 * Math.exp(-Math.max(0, ft - .22) * 5) * (ft > .22)) * .35;
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
    spriteUpload();
    {
      const wl = dom && dom.wall && dom.wall.length ? dom.wall : null;
      if (wl) pass(P.wallm, T.wm, [['G', texG]], u => {
        gl.uniform2f(u.full, w, h); gl.uniform1f(u.nwc, Math.min(8, wl.length));
        if (u['wc[0]']) gl.uniform3fv(u['wc[0]'], wl.slice(0, 8).flatMap(hex).concat(Array(24).fill(0)).slice(0, 24));
      });
      if (!wl) { gl.bindFramebuffer(gl.FRAMEBUFFER, T.wm.f); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
      wallsOn = !!wl;
    }
    pass(P.shadow, T.shadow, [['M', T.prep.t], ['SM', texSM], ['ST', texST], ['NB', texNB], ['WM', T.wm.t]], u => {
      gl.uniform2f(u.moonO, moonOx, moonOy); gl.uniform1f(u.wallH, wallsOn && tune.walls ? 10 : 0);
      gl.uniform2f(u.res, T.prep.w, T.prep.h);
      gl.uniform1f(u.art, artScale); // píxeles de media resolución por píxel de arte
      gl.uniform1f(u.frame, frame % 1000);
      gl.uniform1f(u.jmode, tune.jmode);
      gl.uniform2f(u.cam, camE, camF);
      gl.uniform1f(u.time, (now / 1000) % 3600); gl.uniform1f(u.canopy, bio.canopy);
      gl.uniform1f(u.clouds, (calm ? bio.clouds * .5 : bio.clouds) * (1 - wxCur[0] * .8)); // (con sol abrasador, cielo despejado)
      gl.uniform1f(u.sharp, wxCur[0]);
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
    histFlip = !histFlip;
    prevE = camE; prevF = camF;

    // bloom en tres escalas (el alfa lleva los oclusores desenfocados → oclusión ambiental);
    // las cascadas lejanas miran la escena en estas versiones reducidas
    down(T.q, T.e8); blur(T.e8, T.e8b); blur(T.e8, T.e8b);
    down(T.e8, T.e16); blur(T.e16, T.e16b); blur(T.e16, T.e16b);
    down(T.e16, T.e32); blur(T.e32, T.e32b); blur(T.e32, T.e32b);

    if (quality > 0) radianceCascades(now, bio.flicker, S.motes, [bio.moteDen, bio.moteRise, bio.moteBlink, bio.moteSize], bio.moteCol); else { gl.bindFramebuffer(gl.FRAMEBUFFER, T.giOut.f); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }

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

    // decoración (por celdas) y máscara de líquidos, antes de la composición
    const cell0 = [Math.floor(-camE / (artScale * 28)) - 1, Math.floor(-camF / (artScale * 28)) - 1];
    if (decoOn && quality > 0) pass(P.decocell, TDC, [['G', texG]], u => {
      gl.uniform2f(u.res, w, h); gl.uniform2f(u.cam, camE, camF); gl.uniform2f(u.cell0, cell0[0], cell0[1]);
      gl.uniform1f(u.art, artScale); gl.uniform1f(u.grassRatio, grassRatio);
    });
    impactLights(now); feetUniform(w, h);
    const trIn = histFlip ? T.trA : T.trB, trOut = histFlip ? T.trB : T.trA;
    pass(P.trail, trOut, [['H', trIn.t]], u => {
      gl.uniform2f(u.shift, camShift[0], camShift[1]);
      if (u['rp[0]']) gl.uniform4fv(u['rp[0]'], rpBuf);
      gl.uniform1f(u.nRp, fresh ? 0 : nRp); gl.uniform1f(u.aspect, w / h);
      gl.uniform1f(u.decay, fresh ? 0 : Math.exp(-dt / 8));
    });
    {
      const liq = dom ? dom.liq.map(hex) : [[9, 9, 9], [9, 9, 9]];
      pass(P.liq, T.liq, [['G', texG], ['TRL', trOut.t], ['WM', T.wm.t]], u => {
        gl.uniform2f(u.o, artScale / w, artScale / h); gl.uniform2f(u.full, w, h);
        gl.uniform3fv(u.liqA, liq[0]); gl.uniform3fv(u.liqB, liq[1]);
      });
    }
    pass(P.vol, T.vol, [['S', T.shadow.t], ['GI', T.giOut.t], ['EXPO', aOut.t], ['LQ', T.liq.t]], u => {
      gl.uniform1f(u.gfog, (bio.gfog + wxCur[1] * .15) * (quality > 1.5 ? 1 : 0)); gl.uniform1f(u.lavaK, quality > 1.5 ? bio.liqGlow : 0);
      gl.uniform3fv(u.liqFx, dom ? dom.liqFx : [0, 0, 0]);
      gl.uniform2f(u.res, w, h); gl.uniform2f(u.cam, camE, camF);
      gl.uniform2f(u.moonDir, S.moonDir[0], S.moonDir[1]); gl.uniform2f(u.center, center[0], center[1]);
      gl.uniform1f(u.art, artScale); gl.uniform1f(u.aspect, w / h); gl.uniform1f(u.time, (now / 1000) % 3600);
      gl.uniform1f(u.quality, quality); gl.uniform1f(u.fog, S.fog); gl.uniform1f(u.shafts, S.shafts);
      gl.uniform1f(u.gi, S.gi); gl.uniform1f(u.torchR, S.torchR);
      for (const k of ['fogCol', 'torch', 'moon']) gl.uniform3fv(u[k], S[k]);
      gl.uniform4fv(u.giST, giST);
      setLights(u, w, h);
      gl.uniform4f(u.wx, wxCur[1], wxCur[3], wxCur[0], wxCur[2]); gl.uniform1f(u.wfog, wxCur[4]); gl.uniform1f(u.canopy, bio.canopy);
      gl.uniform2f(u.center, center[0], center[1]);
    });
    blur(T.vol, T.volTmp); // (el ruido de los haces, que antes quedaba por píxel)
    pass(P.comp, tiltOn ? T.fin : null, [['W', texW], ['S', T.shadow.t], ['M', T.prep.t], ['GI', T.giOut.t],
      ['B1', T.e8.t], ['B2', T.e16.t], ['B3', T.e32.t], ['NB', texNB], ['G', texG], ['DECO', texDeco], ['EXPO', aOut.t], ['VOL', T.vol.t], ['LQ', T.liq.t], ['DC', TDC.t]], u => {
      gl.uniform4fv(u.giST, giST);
      gl.uniform4f(u.wx, wxCur[1], wxCur[3], wxCur[0], wxCur[2]);
      gl.uniform4f(u.wx2, wet, snowAcc, wxCur[4], 0);
      if (u['shk[0]']) gl.uniform4fv(u['shk[0]'], shkBuf);
      if (u['rp[0]']) gl.uniform4fv(u['rp[0]'], rpBuf);
      gl.uniform1f(u.nRp, nRp); gl.uniform1f(u.tm, tune.tm);
      gl.uniform1f(u.glowK, mode === 'noche' ? bio.glowK : bio.glowK * .25);
      gl.uniform1f(u.auroraK, (bio.aurora + wxCur[3] * .3) * (mode === 'dia' ? .3 : 1));
      gl.uniform1f(u.nightK, mode === 'noche' ? 1 : 0);
      gl.uniform1f(u.wind, calm || !tune.sway ? 0 : .8 + wxCur[1] * .5 + wxCur[2] * .9);
      gl.uniform1f(u.pixK, tune.pix ? 1 : 0); gl.uniform1f(u.bandK, tune.bands); gl.uniform1f(u.clouds, calm ? bio.clouds * .5 : bio.clouds);
      gl.uniform2f(u.cell0, cell0[0], cell0[1]);
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
      setLights(u, w, h);
    });
    if (tiltOn) pass(P.tilt, null, [['T', T.fin.t]], u => gl.uniform2f(u.px, 1 / w, 1 / h));
    if (fresh) fresh--;
    profPoll();
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
  const tune = { jmode: 2, temporal: true, blend: .22, clampK: .2, fx: true, nb: true, blob: true, spr: true, lights: true, giK: .55, pix: true, bands: .35, tm: 1, wx: null, sway: true, noGameShadows: true, wxDim: .45, walls: true };

  function snap(t) {
    if (tune.skip && tune.skip.snap) return;
    const pq = profBegin('snap');
    try { snap1(t); } finally { profEnd(pq); }
  }
  function snap1(t) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, game);
  }

  // ---------- escucha del contexto 2D del juego ----------
  const ctx = game.getContext('2d');
  const C2 = CanvasRenderingContext2D.prototype;
  const _save = C2.save, _restore = C2.restore, _clear = C2.clearRect, _setT = C2.setTransform;
  let depth = 0, phase = 0; // 0 nada · 1 suelo · 2 entidades · 3 HUD
  const stats = { ok: 0, p1: 0, p2: 0, p3: 0, sprMs: 0, sprN: 0 }; // sprMs: ms por frame de la capa de sprites

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
        if (lit()) { try { snap(texG); fxBegin(); sprBegin(); } catch (e) { fail(e); } }
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
    if (fn === _fillText) noteNumber(c, args);
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
  C2.fillText = function () { if (this === ctx && phase === 3) try { noteHudText(String(arguments[0])); } catch (e) {} if (this === ctx && phase === 2 && lit()) { deferText(this, _fillText, [...arguments]); return; } return _fillText.apply(this, arguments); };
  C2.strokeText = function () { if (this === ctx && phase === 2 && lit()) { deferText(this, _strokeText, [...arguments]); return; } return _strokeText.apply(this, arguments); };

  // ---------- clima ----------
  // Cada clima del juego tiñe la pantalla con un velo de un color fijo (sol, lluvia, arena, nieve,
  // niebla): así se sabe cuál hay sin depender del idioma del texto. La intensidad sale de su alfa.
  const WX = [[255, 190, 90, .07], [50, 90, 170, .09], [200, 160, 90, .09], [210, 230, 255, .08], [190, 195, 210, .12]];
  const wxSeen = new Float32Array(5), wxCur = new Float32Array(5); let wxFrame = -1, wxDrawFrame = -1;
  function wxCheck(c, w, h) {
    const st = c.fillStyle;
    if (typeof st !== 'string' || !st.startsWith('rgba(')) return;
    const m = c.getTransform();
    if (Math.abs(w * h * m.a * m.d) < game.width * game.height * .5) return;
    const p = st.slice(5, -1).split(',').map(Number);
    for (let k = 0; k < WX.length; k++) {
      if (p[0] !== WX[k][0] || p[1] !== WX[k][1] || p[2] !== WX[k][2]) continue;
      if (wxFrame !== frameId) { wxSeen.fill(0); wxFrame = frameId; }
      wxSeen[k] = Math.min(1, p[3] * c.globalAlpha / WX[k][3]);
      wxDrawFrame = frameId;
    }
  }
  // Lo que cae (lluvia, nieve) entra y sale en ~1,5 s; lo que se queda en el suelo, no: el suelo se
  // moja poco a poco y los charcos crecen (~20 s), y al parar se seca despacio (~1 min); la nieve
  // cuaja en ~30 s y tarda más en irse. Con todo de golpe se notaba que era un filtro.
  let wet = 0, snowAcc = 0, wxBio = -2;
  function wxUpdate(dt) {
    const f = tune.wx;
    for (let k = 0; k < 5; k++) {
      const t = f ? f[k] || 0 : wxFrame === frameId ? wxSeen[k] : 0;
      wxCur[k] += (t - wxCur[k]) * Math.min(1, dt * 1.4);
    }
    wet = Math.max(0, Math.min(1, wet + (wxCur[1] > .05 ? wxCur[1] * dt / 20 : -dt / 60)));
    snowAcc = Math.max(0, Math.min(1, snowAcc + (wxCur[3] > .05 ? wxCur[3] * dt / 30 : -dt / 40)));
    // al cambiar de sitio (entrar o salir de una grieta, otro escenario) no se lleva el agua ni la nieve
    if (bioNow !== wxBio) { if (wxBio !== -2) { wet = 0; snowAcc = 0; } wxBio = bioNow; }
    if (f && f.fast) { wet = f[1] ? 1 : 0; snowAcc = f[3] ? 1 : 0; } // (pruebas: ya acumulado, o seco)
  }

  // ---------- impactos ----------
  // Cada número de daño nuevo es un golpe: un destello breve de luz en ese punto y una onda que
  // deforma un poco el aire. (Los números siguen pintándose unos frames mientras suben: se da por
  // nuevo el que no tenía uno igual cerca en el frame anterior.)
  let nums = [], prevNums = [];
  const impacts = [];
  function noteNumber(c, args) {
    const t = String(args[0]);
    if (!/^[-+]?\d{1,6}!?$/.test(t)) return;
    const m = c.getTransform(), x = +args[1] || 0, y = +args[2] || 0;
    nums.push(t, m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f + 14 * Math.abs(m.d), String(c.fillStyle));
  }
  function impactsUpdate(now) {
    for (let i = 0; i < nums.length; i += 4) {
      let seen = false;
      for (let j = 0; j < prevNums.length; j += 4)
        if (prevNums[j] === nums[i] && Math.abs(prevNums[j + 1] - nums[i + 1]) < 40 && Math.abs(prevNums[j + 2] - nums[i + 2]) < 60) { seen = true; break; }
      if (seen) continue;
      const col = /^#[0-9a-f]{6}$/i.test(nums[i + 3]) ? [1, 3, 5].map(k => parseInt(nums[i + 3].substr(k, 2), 16) / 255) : [1, .85, .6];
      const mx = Math.max(...col, .2);
      const v = Math.abs(parseInt(nums[i], 10)) || 1;
      impacts.push({ x: nums[i + 1], y: nums[i + 2], t: now, c: col.map(q => q / mx), k: Math.min(1, .35 + Math.log10(v) * .25) });
      if (impacts.length > 6) impacts.shift();
    }
    prevNums = nums; nums = [];
    for (let i = impacts.length - 1; i >= 0; i--) if (now - impacts[i].t > (impacts[i].dur || 450)) impacts.splice(i, 1);
  }
  const shkBuf = new Float32Array(16);
  function impactLights(now) {
    shkBuf.fill(0);
    let j = 0;
    for (let i = impacts.length - 1; i >= 0; i--) {
      const im = impacts[i], a = (now - im.t) / (im.dur || 450), e = Math.exp(-a * 5);
      if (a > 1) continue;
      lights.push(im.x, im.y, im.r || 110 + 60 * im.k, 1.1 * im.k * e, im.c[0], im.c[1], im.c[2]);
      if (im.ring !== false && j < 4 && !calm) { shkBuf.set([im.x / game.width, 1 - im.y / game.height, a, im.k], j * 4); j++; }
    }
  }
  // subir de nivel: el número de nivel del HUD («Nv. 3») cambia → un fogonazo dorado grande
  let lastLevel = 0;
  function noteHudText(t) {
    const m = /^Nv\.?\s*(\d+)/.exec(t); if (!m) return;
    const v = +m[1];
    if (lastLevel && v > lastLevel) impacts.push({ x: game.width * .5, y: game.height * .48, t: performance.now(), c: [1, .85, .45], k: 1, r: 420, dur: 900 });
    lastLevel = v;
  }
  // recoger: algo pequeño que brillaba junto al jugador (gema, moneda) desaparece → un destello suyo
  let gems = [], prevGems = [];
  function noteGem(x, y, c) { if (gems.length < 120) gems.push(x, y, c); }
  function gemsUpdate(now) {
    const px = game.width * .5, py = game.height * .48, near = artScale * 40;
    for (let i = 0; i < prevGems.length; i += 3) {
      if (Math.hypot(prevGems[i] - px, prevGems[i + 1] - py) > near) continue;
      let still = false;
      for (let j = 0; j < gems.length; j += 3) if (Math.abs(gems[j] - prevGems[i]) < 30 && Math.abs(gems[j + 1] - prevGems[i + 1]) < 30) { still = true; break; }
      if (!still) impacts.push({ x: prevGems[i], y: prevGems[i + 1], t: now, c: prevGems[i + 2], k: .6, r: 120, dur: 350, ring: false });
    }
    if (impacts.length > 10) impacts.splice(0, impacts.length - 10);
    prevGems = gems; gems = [];
  }

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
    if (tune.skip && tune.skip.fxup) return;
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
  // La sombrita del juego (una elipse negra semitransparente y aplanada bajo árboles, rocas, Pokémon
  // y objetos) era su forma de dar volumen sin luces. Con las sombras de verdad sobra: con la luz
  // encendida no se pinta. Los anillos de color (equipo, quemado, veneno) sí.
  function isGameShadow(c, a) {
    if (a || pathCmds.length !== 1 || pathCmds[0][0] !== 'ellipse') return false;
    const e = pathCmds[0][1], st = c.fillStyle;
    if (!(e[3] < e[2] * .7)) return false;
    let al;
    if (st === '#000000') al = 1;
    else if (typeof st === 'string' && st.startsWith('rgba(0, 0, 0, ')) al = parseFloat(st.slice(14));
    else return false;
    return al * c.globalAlpha <= .6;
  }
  C2.fill = (o => function (a) {
    if (recording(this) && tune.noGameShadows && isGameShadow(this, a)) return;
    if (recording(this) && isFx(this, this.fillStyle)) fxPath(this, 'fill', a);
    return o.apply(this, arguments);
  })(C2.fill);
  C2.stroke = (o => function (a) { if (recording(this) && isFx(this, this.strokeStyle)) fxPath(this, 'stroke', a); return o.apply(this, arguments); })(C2.stroke);
  C2.fillRect = (o => function (x, y, w, h) {
    if (this === ctx && phase === 3 && depth === 0 && typeof this.fillStyle !== 'string' && w * h * this.getTransform().a ** 2 > game.width * game.height * .5)
      gameVignetteSeen = performance.now();
    if (this === ctx && phase >= 2) wxCheck(this, w, h);
    // Las gotas y copos del juego se pintan justo después de su velo, encima de todo y sin luz: de
    // noche, a plena intensidad sobre una escena oscura, parecían demasiados. Con la luz, más tenues.
    if (this === ctx && phase === 3 && wxDrawFrame === frameId && tune.wxDim < 1 && lit()) {
      const m = this.getTransform();
      if (Math.abs(w * h * m.a * m.d) < 400) {
        const ga = this.globalAlpha; this.globalAlpha = ga * tune.wxDim;
        try { return o.apply(this, arguments); } finally { this.globalAlpha = ga; }
      }
    }
    if (recording(this) && isFx(this, this.fillStyle)) {
      fxT(this.getTransform()); fx.fillRect(x, y, w, h);
      atk.globalAlpha = this.globalAlpha; atk.fillStyle = this.fillStyle; atk.fillRect(x, y, w, h);
    }
    return o.apply(this, arguments);
  })(C2.fillRect);

  // ---------- capa de sprites: sombras con su forma real y normales (G-buffer) ----------
  // Cada sprite que el juego pinta sobre el suelo (Pokémon, árboles, rocas, hierba, objetos) se
  // repite aquí, con su misma transformación, en tres capas:
  //  · normales (rg: hacia dónde mira cada píxel; b: material ×64 + altura sobre el pie /2; a: hay sprite), a
  //    media resolución (a completa costaba subirla a la GPU cada frame y no se notaba). La normal sale de inflar la silueta (bordes redondeados) y de su
  //    propio sombreado pintado, como hacen SpriteIlluminator o Laigter con los sprites 2D.
  //  · sombra de la luna y sombra de la antorcha, a media resolución: la silueta del sprite
  //    aplastada e inclinada desde sus pies. Es una transformación afín (cada punto se desplaza
  //    en la dirección de la sombra tanto como alto está), así que la sombra tiene la forma
  //    exacta del sprite: las ramas del árbol seco, las orejas del Pokémon. En verde lleva la
  //    altura de cada punto (el shader ensancha la penumbra con ella) y, en azul, una mancha de
  //    contacto al pie.
  // Antes forma y altura se adivinaban comparando la imagen final con el suelo: salían manchas.
  const smCv = document.createElement('canvas'), sm = smCv.getContext('2d');
  const stCv = document.createElement('canvas'), st = stCv.getContext('2d');
  const nbCv = document.createElement('canvas'), nbx = nbCv.getContext('2d');
  const texSM = tex(), texST = tex(), texNB = tex();
  gl.bindTexture(gl.TEXTURE_2D, texNB); // normales sin interpolar: en el borde del sprite se mezclarían con la nada
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const blobGrad = sm.createRadialGradient(0, 0, 0, 0, 0, 1);
  blobGrad.addColorStop(0, 'rgb(0,0,170)'); blobGrad.addColorStop(.55, 'rgb(0,0,110)'); blobGrad.addColorStop(1, 'rgb(0,0,0)');
  const sprInfo = new WeakMap(); // imagen → Map(recorte → datos del sprite, o null si está vacío)
  let sprOn = false, moonOx = .5, moonOy = .75, sprT = 0, sprCount = 0, sprNew = 0;
  const blobs = []; // manchas de contacto del frame: escala x, escala y, centro x, centro y
  const feet = [];  // pies del frame (x, y en pantalla, ancho): para las ondas en el agua
  const lights = []; // luces puntuales del frame: [x, y, radio, fuerza, r, g, b] en píxeles de pantalla
  // Un sprite que brilla (llamas, brasas, gemas) se convierte en una luz puntual en el centro de
  // lo que brilla, de su color. El jugador no: ya lleva su propia luz.
  function sprLight(m, d, dx, dy, kx, ky, ga) {
    // (un Pokémon de fuego tiene poca llama en proporción a su cuerpo: basta menos para alumbrar)
    // los cristales: una luz suave de su color (la que se cuela a través de ellos y tiñe el suelo)
    if (d.isCrystal) {
      const cx = dx + (d.fl + d.fr + 1) * .5 * kx, cy = dy + (d.top + d.foot) * .5 * ky;
      const x = m.a * cx + m.c * cy + m.e, y = m.b * cx + m.d * cy + m.f;
      const c = d.ecol || [.45, .85, 1], mx = Math.max(...c, .01);
      lights.push(x, y, Math.max(70, (d.foot - d.top) * ky * m.d * 1.6), .4 * ga, c[0] / mx, c[1] / mx, c[2] / mx);
      return;
    }
    if (!d.ecol || d.emit < (d.isImg ? .025 : .1)) return;
    // (un Pokémon amarillo o naranja entero, como Pikachu, no es una llama: si lo que brilla ocupa más
    // de un cuarto del sprite, es el color de su cuerpo)
    if (d.isImg && d.emit > .25) return;
    const lx = dx + d.ecx * kx, ly = dy + d.ecy * ky;
    const x = m.a * lx + m.c * ly + m.e, y = m.b * lx + m.d * ly + m.f;
    if (Math.hypot(x - game.width * .5, y - game.height * .48) < artScale * 12) return;
    const size = Math.max(d.fr - d.fl + 1, d.foot - d.top + 1) * Math.max(kx, ky) * Math.hypot(m.a, m.b);
    const mx = Math.max(...d.ecol, .01);
    if (!sprLightOnlyNow && size < artScale * 20) noteGem(x, y, d.ecol.map(v => v / mx));
    lights.push(x, y, Math.max(50, Math.min(220, size * (d.isImg ? 1.5 : 2))), (d.isImg ? Math.min(.6, .18 + d.emit * 3) : Math.min(.9, d.emit * 2.5)) * ga, d.ecol[0] / mx, d.ecol[1] / mx, d.ecol[2] / mx);
  }
  // proyectiles y efectos centrados (girados): sólo su luz, ni sombra ni normales
  let sprLightOnlyNow = false;
  function sprLightOnly(c, img, dx, dy, dw, dh) {
    if (!(img instanceof HTMLCanvasElement || img instanceof HTMLImageElement) || dw <= 0 || dh <= 0) return;
    const d = spriteData(img, 0, 0, img.width, img.height); if (!d) return;
    sprLightOnlyNow = true;
    try { sprLight(c.getTransform(), d, dx, dy, dw / img.width, dh / img.height, Math.min(1, c.globalAlpha)); } finally { sprLightOnlyNow = false; }
  }

  // Lee el sprite una sola vez: pie (fila opaca más baja), ancho del pie, silueta y normales.
  // Leer píxeles obliga a la GPU a esperar: cada imagen (una hoja con todos los fotogramas de un
  // Pokémon, un árbol...) se lee entera una sola vez, y los fotogramas se recortan de esa copia.
  // Se guardan las últimas 12 (los fotogramas nuevos de un Pokémon van llegando poco a poco).
  const sheetPx = new Map();
  // Una imagen se decodifica antes en segundo plano (createImageBitmap): leerla directamente
  // obligaba al navegador a decodificar la hoja entera en el momento (10-70 ms seguidos).
  const decoded = new WeakMap(); // imagen → ImageBitmap (o 'esperando')
  function pixelsOf(img) {
    const isImg = img instanceof HTMLImageElement;
    if (isImg && !(img.complete && img.naturalWidth)) return undefined; // aún cargando: más tarde
    let p = isImg ? sheetPx.get(img) : undefined;
    if (p !== undefined) { sheetPx.delete(img); sheetPx.set(img, p); return p; } // (la más usada, la última en salir)
    let src = img;
    if (isImg && window.createImageBitmap) {
      const bm = decoded.get(img);
      if (bm === undefined) {
        decoded.set(img, 'esperando');
        createImageBitmap(img).then(b => decoded.set(img, b), () => decoded.set(img, null));
        return undefined;
      }
      if (bm === 'esperando') return undefined;
      if (bm) src = bm;
    }
    p = null;
    const w = img.width, h = img.height;
    if (w > 0 && h > 0 && w * h <= 2048 * 2048) {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d', { willReadFrequently: true });
      try { _draw.call(x, src, 0, 0); p = { d: x.getImageData(0, 0, w, h).data, w, h }; } catch (e) { p = null; }
      if (src !== img) { src.close(); decoded.delete(img); }
    }
    // los canvas no se guardan: el juego puede repintarlos
    if (isImg) { sheetPx.set(img, p); if (sheetPx.size > 12) sheetPx.delete(sheetPx.keys().next().value); }
    return p;
  }
  function analyzeSprite(img, sx, sy, sw, sh) {
    const src = pixelsOf(img);
    if (src === undefined) return undefined; // (imagen aún cargando: se vuelve a intentar)
    if (!src || sx < 0 || sy < 0 || sx + sw > src.w || sy + sh > src.h) return null;
    const px = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) px.set(src.d.subarray(((sy + y) * src.w + sx) * 4, ((sy + y) * src.w + sx + sw) * 4), y * sw * 4);
    return analyzePixels(img, px, sw, sh);
  }
  function analyzePixels(img, px, sw, sh) {
    const n = sw * sh, A = new Uint8Array(n);
    let top = sh, foot = -1;
    for (let i = 0; i < n; i++) if (px[i * 4 + 3] > 127) { A[i] = 1; const y = (i / sw) | 0; if (y < top) top = y; if (y > foot) foot = y; }
    if (foot < 0) return null;
    let fl = sw, fr = -1;
    for (let y = Math.max(top, foot - 2); y <= foot; y++) for (let k = 0; k < sw; k++) if (A[y * sw + k]) { fl = Math.min(fl, k); fr = Math.max(fr, k); }
    // distancia al borde (chaflán), contando como fuera lo que queda más allá de la imagen
    const D = new Float32Array(n);
    const at = (k, y) => (k < 0 || y < 0 || k >= sw || y >= sh) ? 0 : D[y * sw + k];
    for (let i = 0; i < n; i++) D[i] = A[i] ? 1e9 : 0;
    for (let y = 0; y < sh; y++) for (let k = 0; k < sw; k++) { const i = y * sw + k; if (!A[i]) continue;
      D[i] = Math.min(D[i], at(k - 1, y) + 1, at(k, y - 1) + 1, at(k - 1, y - 1) + 1.414, at(k + 1, y - 1) + 1.414); }
    for (let y = sh - 1; y >= 0; y--) for (let k = sw - 1; k >= 0; k--) { const i = y * sw + k; if (!A[i]) continue;
      D[i] = Math.min(D[i], at(k + 1, y) + 1, at(k, y + 1) + 1, at(k + 1, y + 1) + 1.414, at(k - 1, y + 1) + 1.414); }
    // relieve: un bisel redondo de 4 píxeles desde el borde + un poco del sombreado pintado
    const R = 4, Z = new Float32Array(n);
    for (let i = 0; i < n; i++) if (A[i]) {
      const t = Math.min(D[i], R) / R;
      Z[i] = R * Math.sqrt(1 - (1 - t) * (1 - t)) + (.299 * px[i * 4] + .587 * px[i * 4 + 1] + .114 * px[i * 4 + 2]) / 255 * 1.2;
    }
    // material (cuánto brilla al reflejar la luz): cristal mucho, gemas y objetos bastante, roca
    // algo, hojas y hierba poco, Pokémon poco (pelo, escamas mates)
    const dims = img.width + 'x' + img.height;
    // 0 hierba y árboles (se mecen) · 1 Pokémon · 2 roca y otros objetos · 3 cristal
    const matIdx = img instanceof HTMLImageElement ? 1 : dims === '26x40' ? 3 :
      (dims === '30x40' || dims === '28x40' || dims === '20x17') ? 0 : 2;
    // ¿brilla? (lo muy claro y saturado: llamas, brasas, gemas). Fracción, color y centro de lo que brilla
    const sst = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    let ew = 0, er = 0, eg = 0, eb = 0, ex = 0, ey = 0, opaque = 0;
    for (let i = 0; i < n; i++) if (A[i]) {
      opaque++;
      const r = px[i * 4] / 255, g = px[i * 4 + 1] / 255, b = px[i * 4 + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const w = sst(.8, .97, mx) * sst(.45, .7, mx - mn);
      if (w > 0) { ew += w; er += r * w; eg += g * w; eb += b * w; ex += (i % sw) * w; ey += ((i / sw) | 0) * w; }
    }
    const emit = ew / Math.max(1, opaque);
    const ecol = ew > 0 ? [er / ew, eg / ew, eb / ew] : null, ecx = ew > 0 ? ex / ew + .5 : 0, ecy = ew > 0 ? ey / ew + .5 : 0;
    const z = (k, y) => (k < 0 || y < 0 || k >= sw || y >= sh) ? 0 : Z[y * sw + k];
    const nrm = document.createElement('canvas'), sil = document.createElement('canvas');
    nrm.width = sil.width = sw; nrm.height = sil.height = sh;
    const ni = new ImageData(sw, sh), si = new ImageData(sw, sh), N = ni.data, Sd = si.data;
    for (let y = 0; y < sh; y++) for (let k = 0; k < sw; k++) {
      const i = y * sw + k; if (!A[i]) continue;
      // normal del relieve, con la y hacia arriba (la del shader)
      let nx = -(z(k + 1, y) - z(k - 1, y)) * .5, ny = (z(k, y + 1) - z(k, y - 1)) * .5;
      const l = Math.hypot(nx, ny, 1); nx /= l; ny /= l;
      const hgt = Math.min(255, (foot - y) * 2); // altura sobre el pie, en píxeles de arte ×2
      N[i * 4] = (nx * .5 + .5) * 255; N[i * 4 + 1] = (ny * .5 + .5) * 255; N[i * 4 + 2] = matIdx * 64 + Math.min(63, Math.round((foot - y) / 2)); N[i * 4 + 3] = 255;
      Sd[i * 4] = 255; Sd[i * 4 + 1] = hgt; Sd[i * 4 + 3] = 255;
    }
    // (éstos sí, en la GPU: se dibujan cientos de veces por frame)
    nrm.getContext('2d', { willReadFrequently: false }).putImageData(ni, 0, 0); sil.getContext('2d', { willReadFrequently: false }).putImageData(si, 0, 0);
    // color medio del sprite (lo saturado pesa más): el del aura de un jefe
    let ar = 0, ag = 0, ab = 0, aw = 0;
    for (let i = 0; i < n; i++) if (A[i]) { const r = px[i * 4] / 255, g = px[i * 4 + 1] / 255, b = px[i * 4 + 2] / 255, w = .05 + Math.max(r, g, b) - Math.min(r, g, b); ar += r * w; ag += g * w; ab += b * w; aw += w; }
    const acol = aw > 0 ? [ar / aw, ag / aw, ab / aw] : [1, 1, 1];
    return { acol, foot, top, fl, fr, nrm, sil, emit, ecol, ecx, ecy, isImg: img instanceof HTMLImageElement, isCrystal: matIdx === 3 };
  }
  function spriteData(img, sx, sy, sw, sh) {
    let byRect = sprInfo.get(img);
    if (!byRect) { byRect = new Map(); sprInfo.set(img, byRect); }
    const key = sx + ',' + sy + ',' + sw + ',' + sh;
    const d = byRect.get(key);
    if (d !== undefined) return d; // (false: en la cola, todavía sin analizar)
    // Nada se analiza dentro del frame: al moverse entraban decenas de sprites nuevos de golpe
    // y cada lectura de píxeles era un tirón. Va a una cola que se vacía en los ratos libres,
    // como mucho ~3 ms seguidos; hasta entonces ese sprite sale sin sombra (un instante).
    byRect.set(key, false);
    if (sw < 1 || sh < 1 || sw * sh > 200 * 200 || sx !== Math.floor(sx) || sy !== Math.floor(sy)) { byRect.set(key, null); return null; }
    sprQueue.push([img, sx, sy, sw, sh, byRect, key]);
    if (!sprQueued) { sprQueued = true; idle(runAnalysis); }
    return false;
  }
  const sprQueue = []; let sprQueued = false;
  const idle = fn => window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 150 }) : setTimeout(fn, 16);
  function runAnalysis() {
    sprQueued = false;
    const t0 = performance.now();
    while (sprQueue.length && performance.now() - t0 < 3) {
      const [img, sx, sy, sw, sh, byRect, key] = sprQueue.shift();
      let r = null;
      try { r = analyzeSprite(img, sx, sy, sw, sh); } catch (e) { r = null; } // sin sombra, pero la luz sigue
      if (r === undefined) byRect.delete(key); else byRect.set(key, r); sprNew++;
    }
    const dt = performance.now() - t0; stats.anaMs = (stats.anaMs || 0) + dt; stats.anaMax = Math.max(stats.anaMax || 0, dt);
    if (sprQueue.length) { sprQueued = true; idle(runAnalysis); }
  }
  function sprBegin() {
    const w = game.width, h = game.height, hw = w >> 1, hh = h >> 1;
    for (const [c2, x2, W, H] of [[smCv, sm, hw, hh], [stCv, st, hw, hh], [nbCv, nbx, hw, hh]]) {
      if (c2.width !== W || c2.height !== H) { c2.width = W; c2.height = H; }
      x2.setTransform(1, 0, 0, 1, 0, 0); x2.globalAlpha = 1; x2.globalCompositeOperation = 'source-over';
      x2.imageSmoothingEnabled = false;
    }
    sm.fillStyle = st.fillStyle = '#000'; sm.fillRect(0, 0, hw, hh); st.fillRect(0, 0, hw, hh);
    nbx.clearRect(0, 0, hw, hh);
    // Las siluetas se pintan una encima de otra (la última manda en la altura). Un modo de mezcla
    // como «lighten» obliga al canvas a leer lo ya pintado en cada dibujo y costaba un 25 % de fps.
    blobs.length = 0; lights.length = 0; feet.length = 0;
    // dirección de la sombra de la luna en el canvas (y hacia abajo), 0,9 veces la altura. Con
    // la luz casi de lado la silueta se aplastaría en una raya: los objetos tienen fondo.
    const md = shown.moonDir, ml = Math.hypot(md[0], md[1]) || 1;
    moonOx = -md[0] / ml * .9; moonOy = Math.max(.3, md[1] / ml * .9);
    sprOn = tune.spr;
  }
  function sprDraw(c, img, sx, sy, sw, sh, dx, dy, dw, dh) {
    const t0 = performance.now();
    try { sprDraw1(c, img, sx, sy, sw, sh, dx, dy, dw, dh); } finally { sprT += performance.now() - t0; sprCount++; }
  }
  function sprDraw1(c, img, sx, sy, sw, sh, dx, dy, dw, dh) {
    const m = c.getTransform();
    if (m.b || m.c || m.a <= 0 || m.d <= 0 || dw <= 0 || dh <= 0) return;
    const d = spriteData(img, sx, sy, sw, sh); if (!d) return;
    const ga = Math.min(1, c.globalAlpha), kx = dw / sw, ky = dh / sh;
    if (tune.nb && ga > .9) { nbx.setTransform(m.a * .5, 0, 0, m.d * .5, m.e * .5, m.f * .5); _draw.call(nbx, d.nrm, 0, 0, sw, sh, dx, dy, dw, dh); }
    sprLight(m, d, dx, dy, kx, ky, ga);
    // un Pokémon enorme (un jefe) ilumina a su alrededor con el color de su cuerpo
    const hpx = (d.foot - d.top + 1) * ky * m.d;
    if (d.isImg && hpx > 150 && ga > .5) {
      // (a sus pies: desde dentro de su cuerpo lo blanqueaba)
      const cx = m.a * (dx + (d.fl + d.fr + 1) * .5 * kx) + m.e, cy = m.d * (dy + (d.foot + 1) * ky) + m.f + hpx * .08;
      const mx = Math.max(...d.acol, .01);
      lights.push(cx, cy, Math.min(420, hpx * 1.1), .28 * (.85 + .15 * Math.sin(performance.now() / 400)), d.acol[0] / mx, d.acol[1] / mx, d.acol[2] / mx);
    }
    const Fy = dy + (d.foot + 1) * ky, Fx = dx + (d.fl + d.fr + 1) * .5 * kx; // pie, en unidades del juego
    if (d.isImg && feet.length < 240) feet.push(m.a * Fx + m.e, m.d * Fy + m.f, (d.fr - d.fl + 1) * kx * m.a);
    const a = m.a * .5, dd = m.d * .5, e = m.e * .5, f = m.f * .5;          // a media resolución
    // (x, y) → (x + ox·(Fy − y), Fy + oy·(Fy − y)): el pie se queda, lo alto se aleja
    const cast = (x2, ox, oy, al) => {
      x2.setTransform(a, 0, -a * ox, -dd * oy, a * ox * Fy + e, dd * (1 + oy) * Fy + f);
      x2.globalAlpha = al;
      _draw.call(x2, d.sil, 0, 0, sw, sh, dx, dy, dw, dh);
    };
    cast(sm, moonOx, moonOy, ga);
    // antorcha: la sombra se aleja del jugador, más larga cuanto más lejos está (como antes:
    // luz a 150 px de altura, con tope de 0,9 veces la altura). El jugador no se tapa a sí mismo.
    const vx = m.a * Fx + m.e - game.width * .5, vy = m.d * Fy + m.f - game.height * .48;
    const dP = Math.hypot(vx, vy), near = artScale * 14;
    if (dP > near) {
      const hmid = (d.foot - d.top) * ky * m.d * .25;
      const k = Math.min(.9, dP * .5 / (150 + hmid));
      cast(st, vx / dP * k, Math.max(Math.abs(vy / dP * k), .3 * k) * (vy < 0 ? -1 : 1), ga * Math.min(1, (dP - near) / (artScale * 6)));
    }
    // mancha de contacto al pie (lo que se apoya en el suelo lo oscurece justo debajo)
    // (se apuntan y se pintan todas al final, sumadas en el canal azul: una silueta pintada
    // después las borraría)
    if (tune.blob && sw >= 6 && ga > .5) {
      const rx = Math.max(1.5, (d.fr - d.fl + 1) * .5 * kx * 1.15), ry = rx * .38;
      blobs.push(a * rx, dd * ry, a * Fx + e, dd * (Fy - ry * .2) + f);
    }
  }
  function spriteUpload() {
    const pq = profBegin('capaSubir');
    try { spriteUpload1(); } finally { profEnd(pq); }
  }
  function spriteUpload1() {
    const t0 = performance.now();
    if (blobs.length) {
      sm.globalCompositeOperation = 'lighter'; sm.globalAlpha = 1; sm.fillStyle = blobGrad;
      for (let i = 0; i < blobs.length; i += 4) { sm.setTransform(blobs[i], 0, 0, blobs[i + 1], blobs[i + 2], blobs[i + 3]); sm.fillRect(-1, -1, 2, 2); }
      sm.globalCompositeOperation = 'source-over'; blobs.length = 0;
    }
    if (tune.up !== false) for (const [t, c2] of [[texSM, smCv], [texST, stCv], [texNB, nbCv]]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c2);
    }
    sprT += performance.now() - t0;
    stats.sprMs = stats.sprMs * .9 + sprT * .1; stats.sprN = sprCount; stats.sprNew = (stats.sprNew || 0) + sprNew; sprNew = 0; sprT = 0; sprCount = 0;
  }

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
  // ---------- suelo de este frame ----------
  // El suelo llega en trozos de 256×256 ya pintados. Aquí sólo se cuentan (un frame sin trozos
  // no es el mundo: un menú). Qué escenario es y el verde de la hierba los calcula la GPU
  // (floorStats), que antes se sacaban leyendo los píxeles de cada trozo nuevo.
  const frameBins = new Float64Array(160);         // verde/rojo de 0,8 a 2,4 en pasos de 0,01
  let binsFrame = -1, grassRatio = 1.25, frameChunks = 0;
  const frameFloor = new Float64Array(BIOMES.length); // suelo de cada escenario en pantalla (última lectura)
  function chunkRatio() {
    if (binsFrame !== frameId) { frameChunks = 0; binsFrame = frameId; }
    frameChunks++;
  }

  C2.drawImage = function (img, dx, dy, dw, dh) {
    if (this === ctx && phase === 1 && img instanceof HTMLCanvasElement && img.width === 256 && img.height === 256)
      chunkRatio(img);
    // Ataques y efectos no proyectan sombra y emiten un poco de luz de su color: los sprites
    // translúcidos o en modo de mezcla (destellos, auras, impactos) y los que el juego dibuja
    // centrados en su propio origen tras girarlos (proyectiles: dx ≈ −ancho/2, dy ≈ −alto/2).
    const centred = arguments.length === 5 && Math.abs(dx + dw / 2) < 1.5 && Math.abs(dy + dh / 2) < 1.5;
    if (recording(this) && (this.globalAlpha < .9 || this.globalCompositeOperation !== 'source-over' || centred)) {
      fxT(this.getTransform()); _draw.apply(fx, arguments);
      atk.globalAlpha = Math.min(1, this.globalAlpha); _draw.apply(atk, arguments);
    }
    if (sprOn && centred && this === ctx && phase === 2) try { sprLightOnly(this, img, dx, dy, dw, dh); } catch (e) { fail(e); }
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
        const vimg = PS_PROPS.variant(img, info, v);
        if (sprOn && this === ctx) sprDraw(this, vimg, 0, 0, vimg.width, vimg.height, dx, dy, dw, dh);
        return _draw.call(this, vimg, dx, dy, dw, dh);
      }
    }
    // capa de sprites: lo opaco que se apoya en el suelo (ni efectos, ni proyectiles, ni la grieta)
    if (sprOn && this === ctx && phase === 2 && !centred && this.globalAlpha >= .5 && this.globalCompositeOperation === 'source-over' &&
        (img instanceof HTMLCanvasElement || img instanceof HTMLImageElement) && !(img.width === 30 && img.height === 46)) {
      try {
        const n = arguments.length;
        if (n >= 9) sprDraw(this, img, arguments[1], arguments[2], arguments[3], arguments[4], arguments[5], arguments[6], arguments[7], arguments[8]);
        else if (n >= 5) sprDraw(this, img, 0, 0, img.width, img.height, dx, dy, dw, dh);
        else sprDraw(this, img, 0, 0, img.width, img.height, dx, dy, img.width, img.height);
      } catch (e) { fail(e); }
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
        phase = 0; depth = 0; sprOn = false;
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
    if (e.source !== window || !e.data || !e.data.psLuz || typeof e.data.psLuz !== 'object') return;
    const a = e.data.psLuz;
    if (MODES.includes(a.mode) && a.mode !== mode) { mode = a.mode; apply(); }
    if (typeof a.variantes === 'boolean') variantsOn = a.variantes;
    if (typeof a.deco === 'boolean') decoOn = a.deco;
    if (typeof a.maqueta === 'boolean') tiltOn = a.maqueta;
  });
  apply();
  window.postMessage({ psLuzListo: true }, location.origin); // la extensión responde con sus ajustes
  if (!window.PS_LUZ_DEBUG) return; // la herramienta de pruebas sólo existe en la copia local
  window.PS_LUZ = {
    get mode() { return mode; }, set mode(m) { if (MODES.includes(m)) { mode = m; apply(); } },
    get quality() { return quality; }, set quality(q) { quality = Math.max(0, Math.min(3, q | 0)); },
    get fps() { return Math.round(1000 / avgDt); }, get hz() { return Math.round(1000 / refreshMs); },
    set debug(d) { debug = d; }, set onFrame(f) { onFrame = f; }, tune, stats,
    get variantes() { return variantsOn; }, set variantes(v) { variantsOn = !!v; },
    get deco() { return decoOn; }, set deco(v) { decoOn = !!v; }, get maqueta() { return tiltOn; }, set maqueta(v) { tiltOn = !!v; }, get grassRatio() { return grassRatio; },
    get exposicion() { return +expoGain.toFixed(3); },
    get companero() { return partnerCol.map(v => Math.round(v * 255)); },
    get bioma() { return bioNow >= 0 ? BIOMES[bioNow].id : null; }, BIOMES, PRESETS,
    capas: { luna: smCv, antorcha: stCv, normales: nbCv },
    // tiempo de GPU por pasada, en ms por frame (PS_LUZ.tune.prof = true para medir)
    get perfil() { const o = {}; let tot = 0; for (const k in prof) { o[k] = +(prof[k] / Math.max(1, profFrames)).toFixed(3); tot += prof[k]; } o.total = +(tot / Math.max(1, profFrames)).toFixed(2); return o; },
    get clima() { return { sol: +wxCur[0].toFixed(2), lluvia: +wxCur[1].toFixed(2), arena: +wxCur[2].toFixed(2), nieve: +wxCur[3].toFixed(2), niebla: +wxCur[4].toFixed(2) }; },
    get suelo() { const o = {}; BIOMES.forEach((b, i) => { if (frameFloor[i] > 1) o[b.id] = Math.round(frameFloor[i]); }); return { escenarios: o, decoFade: +decoFade.toFixed(2), grassRatio }; },
    perfilReset() { for (const k in prof) delete prof[k]; profFrames = 0; }
  };
})();
