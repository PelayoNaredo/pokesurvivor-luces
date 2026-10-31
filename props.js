/*
 * PokéSurvivor · variantes de árboles, árboles secos, cristales, rocas y hierba alta
 *
 * El juego no tiene estos objetos en imágenes: los pinta por código con un "pintor" por tipo
 * (tree 30×40, deadtree 28×40, crystal 26×40, rock 22×17, grass 20×17), cada uno con la paleta
 * de su escenario (leaf, trunk, rock, grass, speck) y contornos fijos. Aquí están portados
 * esos pintores tal cual —mismo ruido (U.hash), mismos umbrales de luz, mismo contorno— y lo
 * único nuevo son las formas: la variante 0 de cada uno es exactamente el sprite del juego.
 *
 * La paleta se lee del propio sprite original en las coordenadas donde el pintor del juego
 * pone cada color, y antes de usar nada se comprueba que la variante 0 reconstruida es
 * píxel a píxel igual al original. Si no lo es (un escenario raro, un cambio del juego), ese
 * objeto se queda como está.
 *
 *   PS_PROPS.analyze(canvas) → info | null      (tipo, fotograma/grieta, paleta; cacheado)
 *   PS_PROPS.variant(info, v) → canvas          (v = 0..N-1; 0 = el original)
 */
(function () {
  'use strict';

  // ---------- utilidades idénticas a las del juego ----------
  function hash(x, y, s = 0) { // U.hash
    let h = Math.imul(x | 0, 0x165667b1) ^ Math.imul(y | 0, 0x27d4eb2f) ^ Math.imul(s | 0, 0x85ebca77);
    h = Math.imul(h ^ (h >>> 13), 0x4bf19f61); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  const rgba = (r, g, b) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  const hex = h => rgba(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16));
  function grid(w, h) {
    const px = new Uint32Array(w * h);
    return {
      w, h, px,
      set(x, y, c) { if (x >= 0 && y >= 0 && x < w && y < h) px[y * w + x] = c; },
      get(x, y) { return px[y * w + x]; },
      canvas() {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const x = c.getContext('2d'), im = x.createImageData(w, h);
        new Uint32Array(im.data.buffer).set(px); x.putImageData(im, 0, 0);
        return c;
      }
    };
  }
  function disc(g, cx, cy, r, fn) { // _0x43e0dd
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= r) { const c = fn(x, y, d / r); if (c != null) g.set(x, y, c); }
      }
  }
  function outline(g, c) { // _0x50fd64
    const add = [];
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      if (g.get(x, y) >>> 24) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return nx >= 0 && ny >= 0 && nx < g.w && ny < g.h && g.get(nx, ny) >>> 24;
      })) add.push([x, y]);
    }
    for (const [x, y] of add) g.set(x, y, c);
  }

  // ---------- árbol frondoso (tree) ----------
  // Copas: el juego usa la forma 0. Las demás son nuevas, dentro del mismo lienzo y con el
  // mismo tronco (así el pie y el choque no cambian).
  const TREE_FORMS = [
    { blobs: [[15, 20, 10], [9, 16, 7], [21, 16, 7], [15, 10, 8], [10, 23, 6], [20, 23, 6]] },          // original
    { blobs: [[15, 9, 6], [15, 15, 7], [15, 21, 8], [11, 24, 5], [19, 24, 5]] },                         // esbelto
    { blobs: [[15, 18, 9], [7, 19, 6], [23, 19, 6], [10, 12, 6], [20, 12, 6], [15, 9, 6]] },             // copa ancha
    { blobs: [[10, 15, 7], [20, 11, 7], [15, 21, 8], [9, 22, 5], [21, 19, 6]] },                         // dos copas
    { blobs: [[15, 18, 7], [11, 22, 5], [19, 22, 5], [15, 13, 6]], thin: true },                         // joven
    { blobs: [[15, 21, 9], [7, 22, 6], [23, 22, 6], [11, 14, 7], [19, 14, 7], [15, 26, 6]] }             // frondoso y bajo
  ];
  function paintTree(p, form) {
    const g = grid(30, 40), L = p.leaf, T = p.trunk;
    const x0 = form.thin ? 14 : 13, x1 = form.thin ? 16 : 17;
    for (let y = 26; y < 38; y++) for (let x = x0; x <= x1; x++) g.set(x, y, T[x === x0 || x === x1 ? 0 : 1]);
    if (!form.thin) { g.set(12, 37, T[0]); g.set(18, 37, T[0]); g.set(11, 38, T[0]); g.set(19, 38, T[0]); }
    else { g.set(13, 37, T[0]); g.set(17, 37, T[0]); }
    for (const [bx, by, br] of form.blobs) disc(g, bx, by, br, (x, y) => {
      const s = (-.6 * (x - bx) + -.8 * (y - by)) / br;
      const i = s > .45 ? 3 : s > .05 ? 2 : s > -.45 ? 1 : 0;
      return hash(x, y, 41) < .12 && i > 0 ? L[i - 1] : L[i];
    });
    outline(g, hex('#14200f'));
    return g;
  }

  // ---------- árbol seco (deadtree) ----------
  // ramas: [x, y, dirección, largo] como las del juego (diagonales de 45°, dos tonos)
  const DEAD_FORMS = [
    { top: 12, br: [[12, 20, -1, 9], [15, 17, 1, 10], [13, 13, -1, 7], [14, 12, 1, 6]] },                 // original
    { top: 16, br: [[12, 24, -1, 8], [15, 21, 1, 9], [13, 17, -1, 5], [14, 16, 1, 7], [12, 31, -1, 3]] }, // ramas bajas
    { top: 20, br: [[12, 27, -1, 6], [15, 24, 1, 5]], broken: true },                                      // tronchado
    { top: 22, br: [[13, 22, -1, 11], [12, 22, -1, 10], [14, 22, 1, 11], [15, 22, 1, 10], [9, 16, 1, 3], [18, 16, -1, 3]] }, // horquilla
    { top: 6, br: [[12, 22, -1, 7], [15, 18, 1, 8], [12, 12, -1, 6], [15, 10, 1, 5], [13, 7, -1, 3]] },    // alto
    { top: 10, br: [[15, 20, 1, 11], [15, 14, 1, 8], [12, 16, -1, 4], [14, 10, 1, 4]] }                     // vencido hacia un lado
  ];
  function paintDead(p, form) {
    const g = grid(28, 40), T = p.trunk, L = p.leaf;
    for (let y = form.top; y < 38; y++) for (let x = 12; x < 16; x++) g.set(x, y, T[x < 14 ? 0 : 1]);
    if (form.broken) { g.set(12, form.top - 1, T[0]); g.set(14, form.top - 1, T[1]); g.set(14, form.top - 2, T[1]); }
    for (const [x, y, d, n] of form.br) for (let i = 0; i < n; i++) { g.set(x + d * i, y - i, L[1]); g.set(x + d * i, y - i + 1, L[0]); }
    outline(g, hex('#0f0b09'));
    return g;
  }

  // ---------- cristal (crystal) ----------
  // prismas: [centro, arriba, media anchura, abajo]; se pintan en orden (los de delante, después)
  const CRYSTAL_FORMS = [
    [[13, 2, 5, 38], [7, 14, 4, 38], [19, 12, 4, 38]],                       // original
    [[13, 6, 6, 38], [6, 18, 3, 38], [20, 16, 3, 38]],                       // uno grande
    [[9, 4, 4, 38], [17, 10, 5, 38]],                                        // pareja
    [[7, 4, 3, 38], [19, 8, 4, 38], [13, 14, 5, 38]],                        // abanico
    [[5, 20, 3, 38], [11, 12, 3, 38], [17, 16, 3, 38], [22, 22, 2, 38]],     // racimo bajo
    [[13, 1, 7, 38]]                                                         // monolito
  ];
  function paintCrystal(p, form) {
    const g = grid(26, 40), L = p.leaf, T = p.trunk;
    for (const [cx, top, half, bot] of form) for (let y = top; y <= bot; y++) {
      const w = Math.round(half * Math.min(1, (y - top) / 8));
      for (let x = cx - w; x <= cx + w; x++) {
        const i = x < cx ? (x === cx - w ? 3 : 2) : x === cx ? 1 : 0;
        g.set(x, y, i >= 2 ? L[i] : y > bot - 4 ? T[1] : L[i]);
      }
    }
    outline(g, T[0]);
    return g;
  }

  // ---------- roca (rock) ----------
  // piedras: [centro x, centro y, radio x, radio y]; brillos arriba a la izquierda de cada una
  const ROCK_FORMS = [
    [[10.5, 9.5, 9.5, 7]],                                                   // original
    [[7.5, 10.5, 6.5, 5], [15.5, 11.5, 5, 4]],                               // pareja
    [[10.5, 11, 9.5, 4.5]],                                                  // losa
    [[10.5, 8.5, 6.5, 7.5]],                                                 // alta
    [[6, 12, 4.5, 3.5], [13, 10, 6, 5.5], [18, 13, 3, 2.5]],                 // trío
    [[10.5, 9.5, 8.5, 6.5], [4, 13.5, 2.5, 2]]                               // con canto suelto
  ];
  const CRACK = [[9, 4], [10, 5], [10, 6], [11, 7], [10, 8], [12, 8], [13, 9], [8, 9], [7, 10]];
  function paintRock(p, form, v, cracked) {
    const g = grid(22, 17), R = p.rock, W = hex('#ffffff');
    const orig = v === 0;
    for (const [cx, cy, rx, ry] of form) {
      for (let y = 0; y < 17; y++) for (let x = 0; x < 22; x++) {
        const nx = (x - cx) / rx, ny = (y - cy) / ry;
        if (orig && (y < 2 || y > 15 || x < 1 || x > 20)) continue; // límites del bucle original
        if (nx * nx + ny * ny + .08 * (hash(x, y, 61) - .5) > 1) continue;
        const s = .55 * -nx - .85 * ny + .25 * (hash(x, y, 62) - .5);
        let c = R[s > .4 ? 2 : s > -.15 ? 1 : 0];
        if (orig ? y >= 14 : y >= Math.min(14, cy + ry - 1.5)) c = R[0];
        g.set(x, y, c);
      }
    }
    if (orig) {
      [[6, 5], [7, 5], [6, 6], [8, 4]].forEach(([x, y]) => g.set(x, y, W));
      [[13, 8], [14, 9], [9, 11], [16, 11], [11, 7]].forEach(([x, y]) => g.set(x, y, R[0]));
    } else {
      for (const [cx, cy, rx, ry] of form) {
        const hx = Math.round(cx - rx * .45), hy = Math.round(cy - ry * .6);
        [[0, 0], [1, 0], [0, 1]].forEach(([dx, dy], i) => { if ((i === 0 || rx > 5) && g.get(hx + dx, hy + dy) >>> 24) g.set(hx + dx, hy + dy, W); });
        for (let k = 0; k < 3; k++) {
          const sx = Math.round(cx + (hash(v, k, 71) - .3) * rx), sy = Math.round(cy + (hash(v, k, 72) - .2) * ry * .8);
          if (g.get(sx, sy) >>> 24 && g.get(sx, sy) !== W) g.set(sx, sy, R[0]);
        }
      }
    }
    if (cracked) {
      const C = hex('#1b1d22'), [cx, cy] = form[0], ox = Math.round(cx - 10.5), oy = Math.round(cy - 9.5);
      CRACK.forEach(([x, y]) => { if (g.get(x + ox, y + oy) >>> 24) g.set(x + ox, y + oy, C); });
    }
    outline(g, hex('#17191d'));
    return g;
  }

  // ---------- hierba alta (grass), dos fotogramas de vaivén ----------
  // Variantes: otra semilla de ruido para las briznas y otra disposición, con el algoritmo del juego.
  const GRASS_FORMS = [
    { seed: 0, step: 2, n: 11, x0: 3, span: 13, h: 8, hr: 6, mid: 3, lean: 7 },   // original
    { seed: 101, step: 3, n: 11, x0: 3, span: 13, h: 9, hr: 6, mid: 3, lean: 7 },  // rala
    { seed: 202, step: 2, n: 11, x0: 4, span: 11, h: 10, hr: 5, mid: 2, lean: 5 }, // alta y recta
    { seed: 303, step: 2, n: 13, x0: 2, span: 15, h: 5, hr: 4, mid: 2, lean: 9 },  // baja y abierta
    { seed: 404, step: 2, n: 9, x0: 6, span: 8, h: 8, hr: 6, mid: 3, lean: 5 },    // mata
    { seed: 505, step: 2, n: 11, x0: 3, span: 13, h: 7, hr: 7, mid: 4, lean: 11 }  // revuelta
  ];
  function paintGrass(p, form, frame) {
    const g = grid(20, 17), G = p.grass, sp = p.speck, sway = frame === 1 ? 1.2 : 0, S = form.seed;
    const last = form.n - 1;
    for (let pass = 0; pass < 2; pass++) for (let i = pass; i < form.n; i += form.step) {
      const t = i / last;
      const x0 = form.x0 + form.span * t + 2 * (hash(i, 7, 52 + S) - .5);
      const h = form.h + Math.floor(form.hr * hash(i, 3, 51 + S)) + (Math.abs(t - .5) < .25 ? form.mid : 0);
      const lean = form.lean * (t - .5) + sway * (.6 + hash(i, 1, 53 + S));
      for (let k = 0; k <= h; k++) {
        const u = k / h, x = Math.round(x0 + lean * u * u), y = 16 - k;
        let c = u > .78 ? G[2] : u > .25 ? G[1] : G[0];
        if (pass === 0 && u <= .78) c = G[0];
        g.set(x, y, c);
        if (k < .45 * h) g.set(x + 1, y, u < .15 ? sp : G[0]);
      }
    }
    outline(g, p.outline);
    return g;
  }

  // ---------- lectura de la paleta del sprite original ----------
  function pixels(c) {
    try { return new Uint32Array(c.getContext('2d').getImageData(0, 0, c.width, c.height).data.buffer); } catch (e) { return null; }
  }
  const at = (px, w, x, y) => px[y * w + x];
  const lumOf = c => .299 * (c & 255) + .587 * ((c >>> 8) & 255) + .114 * ((c >>> 16) & 255);
  function colorsBy(px, exclude) {
    const m = new Map();
    for (const c of px) if (c >>> 24 && !exclude.includes(c)) m.set(c, (m.get(c) || 0) + 1);
    return [...m.keys()].sort((a, b) => lumOf(a) - lumOf(b));
  }
  function same(g, px) { if (g.px.length !== px.length) return false; for (let i = 0; i < px.length; i++) if (g.px[i] !== px[i]) return false; return true; }

  const READERS = {
    '30x40'(px) { // tree
      const trunk = [at(px, 30, 13, 35), at(px, 30, 15, 35)];
      const leaf = colorsBy(px, [...trunk, hex('#14200f')]);
      if (leaf.length < 3) return null;
      while (leaf.length < 4) leaf.push(leaf[leaf.length - 1]);
      const p = { trunk, leaf: leaf.slice(0, 4) };
      return same(paintTree(p, TREE_FORMS[0]), px) ? { tipo: 'arbol', p } : null;
    },
    '28x40'(px) { // deadtree
      const p = { trunk: [at(px, 28, 12, 30), at(px, 28, 14, 30)], leaf: [at(px, 28, 10, 19), at(px, 28, 10, 18)] };
      return same(paintDead(p, DEAD_FORMS[0]), px) ? { tipo: 'seco', p } : null;
    },
    '26x40'(px) { // crystal
      // a y=10 sólo está el prisma grande; abajo a la derecha manda el tercero (el último en pintarse)
      const p = { leaf: [at(px, 26, 16, 10), at(px, 26, 13, 10), at(px, 26, 10, 10), at(px, 26, 8, 10)], trunk: [at(px, 26, 13, 1), at(px, 26, 20, 37)] };
      return same(paintCrystal(p, CRYSTAL_FORMS[0]), px) ? { tipo: 'cristal', p } : null;
    },
    '22x17'(px) { // rock (normal o agrietada)
      const R = colorsBy(px, [hex('#ffffff'), hex('#17191d'), hex('#1b1d22')]);
      if (R.length !== 3) return null;
      const p = { rock: R };
      for (const cracked of [false, true]) if (same(paintRock(p, ROCK_FORMS[0], 0, cracked), px)) return { tipo: 'roca', p, cracked };
      return null;
    },
    '20x17'(px) { // grass (fotograma 0 o 1)
      const cs = colorsBy(px, []);
      if (cs.length < 4) return null;
      const outlineC = cs[0], rest = cs.slice(1);
      // [mota, verde 0, verde 1, verde 2] de oscuro a claro; si la mota coincide con un verde, hay 3
      const tries = rest.length >= 4 ? [{ speck: rest[0], grass: rest.slice(1, 4) }] : [{ speck: rest[0], grass: rest.slice(0, 3) }];
      for (const t of tries) {
        const p = { grass: t.grass, speck: t.speck, outline: outlineC };
        for (const frame of [0, 1]) if (same(paintGrass(p, GRASS_FORMS[0], frame), px)) return { tipo: 'hierba', p, frame };
      }
      return null;
    }
  };

  const infoCache = new WeakMap(), variantCache = new WeakMap();
  const N = { arbol: TREE_FORMS.length, seco: DEAD_FORMS.length, cristal: CRYSTAL_FORMS.length, roca: ROCK_FORMS.length, hierba: GRASS_FORMS.length };

  window.PS_PROPS = {
    analyze(c) {
      if (infoCache.has(c)) return infoCache.get(c);
      let info = null;
      const read = READERS[c.width + 'x' + c.height];
      if (read) { const px = pixels(c); if (px) try { info = read(px); } catch (e) { info = null; } }
      if (info) info.n = N[info.tipo];
      infoCache.set(c, info);
      return info;
    },
    variant(src, info, v) {
      if (!v) return src;
      let list = variantCache.get(src);
      if (!list) variantCache.set(src, list = []);
      if (list[v]) return list[v];
      const p = info.p;
      const g = info.tipo === 'arbol' ? paintTree(p, TREE_FORMS[v]) :
        info.tipo === 'seco' ? paintDead(p, DEAD_FORMS[v]) :
        info.tipo === 'cristal' ? paintCrystal(p, CRYSTAL_FORMS[v]) :
        info.tipo === 'roca' ? paintRock(p, ROCK_FORMS[v], v, info.cracked) :
        paintGrass(p, GRASS_FORMS[v], info.frame);
      return (list[v] = g.canvas());
    },
    // para revisar las variantes a mano: PS_PROPS.sheet(canvasOriginal)
    sheet(src) {
      const info = this.analyze(src); if (!info) return null;
      const c = document.createElement('canvas'); c.width = src.width * info.n + 4 * info.n; c.height = src.height;
      const x = c.getContext('2d');
      for (let v = 0; v < info.n; v++) x.drawImage(this.variant(src, info, v), v * (src.width + 4), 0);
      return c;
    }
  };
})();
