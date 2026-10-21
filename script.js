// ---------- Configuración de la fuente ----------
const UNITS_PER_EM = 1000;
const ASCENDER = 800;
const DESCENDER = -200;
const BASELINE_Y_SVG = 800; // en el viewBox 0..1000, la línea base está en y=800
const DEFAULT_ADVANCE = 650;
const SPACE_ADVANCE = 300;
const NODE_HIT_RADIUS = 16; // tolerancia en unidades de grilla para agarrar un nodo
const HANDLE_HIT_RADIUS = 20; // tolerancia para agarrar los manejadores laterales de ancho
const AUTO_WIDTH_PADDING = 80; // margen que se deja a cada lado al calcular un ancho automático
// Caja usada SOLO para sugerir un ajuste automático la primera vez que se pega algo
// (después, se reutiliza la escala/posición de referencia que haya quedado guardada).
const PASTE_BOX = { x0:100, x1:600, y0:100, y1:800 };
const PASTE_REF_KEY = 'fontmaker_paste_ref_v1';
const SHOW_REF_KEY = 'fontmaker_show_reference_v1';

// ---------- Set de caracteres ----------
function buildCharList(){
  const groups = [
    { label:'Mayúsculas', chars:'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    { label:'Minúsculas', chars:'abcdefghijklmnopqrstuvwxyz' },
    { label:'Números', chars:'0123456789' },
    { label:'Puntuación', chars:'.,;:!?\'"()-' },
    { label:'Acentos', chars:'áéíóúÁÉÍÓÚñÑüÜ' },
  ];
  const list = [{ char:' ', name:'space', isSpace:true }];
  groups.forEach(g=>{
    for(const c of g.chars){
      list.push({ char:c, name:'g'+c.codePointAt(0) });
    }
  });
  return list;
}
const CHAR_LIST = buildCharList();

// ---------- Estado ----------
const STORAGE_KEY = 'fontmaker_glyphs_v2';
let glyphData = loadState(); // { [char]: { contours: [{points:[{x,y}...], group:number|null}], advanceWidth } }
let currentIndex = 0;
let currentContour = []; // puntos en curso (coords SVG 0..1000)
let toolMode = 'pen'; // 'pen' | 'select' | 'node'
let selectedGroup = [];   // índices de contornos seleccionados juntos (modo selección)
let selectedNode = null;  // {contour, point} índice del nodo seleccionado (modo nodo)
let dragState = null;     // info durante un arrastre
let showReference = loadFlag(SHOW_REF_KEY, false);
let groupCounter = Date.now();
let pasteRef = loadJSON(PASTE_REF_KEY, null); // {scale, offsetX, offsetY} o null si todavía no hay referencia
let transformBase = null; // {center:{x,y}, points:[[{x,y}...],...]} — estado del grupo al seleccionarlo, para los sliders

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw) return JSON.parse(raw);
    // migración simple desde la versión anterior (contornos como array plano de puntos)
    const old = localStorage.getItem('fontmaker_glyphs_v1');
    if(old){
      const oldData = JSON.parse(old);
      const migrated = {};
      Object.keys(oldData).forEach(ch=>{
        migrated[ch] = {
          advanceWidth: oldData[ch].advanceWidth,
          contours: (oldData[ch].contours||[]).map(pts=>({ points: pts, group: null }))
        };
      });
      return migrated;
    }
  }catch(e){ console.warn('No se pudo leer localStorage', e); }
  return {};
}
function saveState(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(glyphData));
  }catch(e){ console.warn('No se pudo guardar en localStorage', e); }
}
function loadFlag(key, def){
  try{ const v = localStorage.getItem(key); return v===null? def : v==='1'; }catch(e){ return def; }
}
function saveFlag(key, val){
  try{ localStorage.setItem(key, val ? '1':'0'); }catch(e){}
}
function loadJSON(key, def){
  try{ const v = localStorage.getItem(key); return v? JSON.parse(v) : def; }catch(e){ return def; }
}
function saveJSON(key, val){
  try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){}
}
function getGlyph(char){
  if(!glyphData[char]){
    glyphData[char] = { contours: [], advanceWidth: char===' ' ? SPACE_ADVANCE : DEFAULT_ADVANCE, widthManual: false };
  }
  if(glyphData[char].widthManual === undefined) glyphData[char].widthManual = false; // datos guardados de una versión anterior
  return glyphData[char];
}

// ---------- Geometría: área con signo y test punto-en-polígono ----------
function signedArea(points){
  let s = 0;
  for(let i=0;i<points.length;i++){
    const p1 = points[i], p2 = points[(i+1)%points.length];
    s += p1.x*p2.y - p2.x*p1.y;
  }
  return s/2;
}
function pointInPolygon(pt, poly){
  let inside = false;
  for(let i=0, j=poly.length-1; i<poly.length; j=i++){
    const xi=poly[i].x, yi=poly[i].y, xj=poly[j].x, yj=poly[j].y;
    const intersect = ((yi>pt.y) !== (yj>pt.y)) && (pt.x < (xj-xi)*(pt.y-yi)/(yj-yi)+xi);
    if(intersect) inside = !inside;
  }
  return inside;
}
// Corrige automáticamente el sentido de giro de cada contorno según su anidamiento,
// para que los calados se vean huecos con la regla "nonzero" (la que usan TTF/OTF reales),
// sin importar en qué sentido los haya dibujado la persona. Recibe/devuelve arrays planos
// de puntos (sin la metadata de grupo, que no le importa a la fuente final).
function normalizeWindings(contours){
  if(contours.length===0) return { contours, fixedCount:0 };
  const depths = contours.map((c, idx)=>{
    let d = 0;
    contours.forEach((other, j)=>{
      if(j===idx) return;
      if(other.length>=3 && pointInPolygon(c[0], other)) d++;
    });
    return d;
  });
  let fixedCount = 0;
  const fixed = contours.map((c, idx)=>{
    const area = signedArea(c);
    const wantPositive = depths[idx] % 2 === 0;
    const needsFlip = (wantPositive && area < 0) || (!wantPositive && area > 0);
    if(needsFlip){ fixedCount++; return c.slice().reverse(); }
    return c;
  });
  return { contours: fixed, fixedCount };
}

// ---------- DOM refs ----------
const svg = document.getElementById('grid');
const glyphListEl = document.getElementById('glyphList');
const currentCharLabel = document.getElementById('currentCharLabel');
const progressLabel = document.getElementById('progressLabel');
const pasteBox = document.getElementById('pasteBox');
const pasteTextarea = document.getElementById('pasteTextarea');
const verifyPanel = document.getElementById('verifyPanel');
const verifyContent = document.getElementById('verifyContent');
const refToggleBtn = document.getElementById('toggleReference');
const transformPanel = document.getElementById('transformPanel');
const scaleSlider = document.getElementById('scaleSlider');
const scaleValueEl = document.getElementById('scaleValue');

function svgPointFromEvent(e){
  const pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
  return { x: Math.round(loc.x), y: Math.round(loc.y) };
}

// ---------- Render de grilla / guías ----------
function drawGuides(){
  let svgns = 'http://www.w3.org/2000/svg';
  let guideGroup = document.getElementById('guideGroup');
  if(guideGroup) guideGroup.remove();
  guideGroup = document.createElementNS(svgns,'g');
  guideGroup.id = 'guideGroup';

  for(let i=0;i<=1000;i+=100){
    const v = document.createElementNS(svgns,'line');
    v.setAttribute('x1',i); v.setAttribute('y1',0);
    v.setAttribute('x2',i); v.setAttribute('y2',1000);
    v.setAttribute('stroke', i%500===0 ? '#c9bda6' : '#eee7da');
    v.setAttribute('stroke-width', i%500===0 ? 1 : 0.5);
    guideGroup.appendChild(v);

    const h = document.createElementNS(svgns,'line');
    h.setAttribute('x1',0); h.setAttribute('y1',i);
    h.setAttribute('x2',1000); h.setAttribute('y2',i);
    h.setAttribute('stroke', i%500===0 ? '#c9bda6' : '#eee7da');
    h.setAttribute('stroke-width', i%500===0 ? 1 : 0.5);
    guideGroup.appendChild(h);
  }
  const baseline = document.createElementNS(svgns,'line');
  baseline.setAttribute('x1',0); baseline.setAttribute('y1',BASELINE_Y_SVG);
  baseline.setAttribute('x2',1000); baseline.setAttribute('y2',BASELINE_Y_SVG);
  baseline.setAttribute('stroke','#b5432b');
  baseline.setAttribute('stroke-width',1.5);
  guideGroup.appendChild(baseline);

  svg.appendChild(guideGroup);
}

function renderReferenceLetter(){
  let svgns = 'http://www.w3.org/2000/svg';
  const old = document.getElementById('referenceLetter');
  if(old) old.remove();
  if(!showReference) return;
  const item = CHAR_LIST[currentIndex];
  if(item.isSpace) return;
  const text = document.createElementNS(svgns,'text');
  text.id = 'referenceLetter';
  text.setAttribute('x', (PASTE_BOX.x0+PASTE_BOX.x1)/2);
  text.setAttribute('y', BASELINE_Y_SVG);
  text.setAttribute('text-anchor','middle');
  text.setAttribute('font-family','Arial, Helvetica, sans-serif');
  text.setAttribute('font-size','700');
  text.setAttribute('fill','#000');
  text.setAttribute('fill-opacity','0.12');
  text.setAttribute('pointer-events','none');
  text.textContent = item.char;
  // insertarla justo después de las guías, para que quede DEBAJO del trazado que se dibuja
  const guideGroup = document.getElementById('guideGroup');
  if(guideGroup && guideGroup.nextSibling) svg.insertBefore(text, guideGroup.nextSibling);
  else svg.appendChild(text);
}

// Dos manejadores verticales: el izquierdo mueve TODO el glifo (para ajustar el espacio a la
// izquierda), el derecho define el ancho de avance (el espacio hasta el próximo carácter).
// Se pueden arrastrar en modo Selección. Funcionan también para el espacio, que no tiene tinta
// pero sí necesita un ancho.
function renderWidthHandles(glyph){
  const svgns = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(svgns,'g');
  g.id = 'widthHandles';
  const isDraggable = toolMode==='select';

  function makeHandle(x, color, label){
    const line = document.createElementNS(svgns,'line');
    line.setAttribute('x1',x); line.setAttribute('y1',0);
    line.setAttribute('x2',x); line.setAttribute('y2',1000);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', isDraggable ? 2 : 1);
    line.setAttribute('stroke-dasharray','6 4');
    g.appendChild(line);
    const knob = document.createElementNS(svgns,'circle');
    knob.setAttribute('cx',x); knob.setAttribute('cy',40);
    knob.setAttribute('r', isDraggable ? 9 : 6);
    knob.setAttribute('fill', color);
    g.appendChild(knob);
    const text = document.createElementNS(svgns,'text');
    text.setAttribute('x', x); text.setAttribute('y', 65);
    text.setAttribute('text-anchor','middle');
    text.setAttribute('font-size','22');
    text.setAttribute('fill', color);
    text.textContent = label;
    g.appendChild(text);
  }
  makeHandle(0, '#2b8a6b', '◄ 0');
  makeHandle(glyph.advanceWidth, '#2b6ab5', '► ' + glyph.advanceWidth);
  svg.appendChild(g);
}

function renderGlyphPath(){
  let svgns = 'http://www.w3.org/2000/svg';
  ['glyphPath','previewPath','ptsGroup','selectedContourOverlay','widthHandles'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.remove();
  });
  renderReferenceLetter();

  const char = CHAR_LIST[currentIndex].char;
  const glyph = getGlyph(char);
  renderWidthHandles(glyph);

  let d = '';
  glyph.contours.forEach(contour=>{
    const pts = contour.points;
    if(pts.length===0) return;
    d += `M ${pts[0].x} ${pts[0].y} `;
    for(let i=1;i<pts.length;i++){
      d += `L ${pts[i].x} ${pts[i].y} `;
    }
    d += 'Z ';
  });

  if(d){
    const path = document.createElementNS(svgns,'path');
    path.id = 'glyphPath';
    path.setAttribute('d', d);
    path.setAttribute('fill', '#1f1b16');
    path.setAttribute('fill-rule','evenodd');
    path.setAttribute('fill-opacity','0.85');
    svg.appendChild(path);
  }

  // resaltado del/los contorno(s) seleccionados (modo selección; un grupo pegado se resalta entero)
  if(toolMode==='select' && selectedGroup.length>0){
    let sd = '';
    selectedGroup.forEach(ci=>{
      const c = glyph.contours[ci];
      if(!c) return;
      const pts = c.points;
      sd += `M ${pts[0].x} ${pts[0].y} `;
      for(let i=1;i<pts.length;i++) sd += `L ${pts[i].x} ${pts[i].y} `;
      sd += 'Z ';
    });
    if(sd){
      const overlay = document.createElementNS(svgns,'path');
      overlay.id = 'selectedContourOverlay';
      overlay.setAttribute('d', sd);
      overlay.setAttribute('fill','none');
      overlay.setAttribute('stroke','#2b6ab5');
      overlay.setAttribute('stroke-width',3);
      svg.appendChild(overlay);
    }
  }

  // nodos visibles en modo "nodo" (para poder pinchar y arrastrar)
  if(toolMode==='node'){
    const ptsGroup = document.createElementNS(svgns,'g');
    ptsGroup.id = 'ptsGroup';
    glyph.contours.forEach((contour, ci)=>{
      contour.points.forEach((p, pi)=>{
        const isSel = selectedNode && selectedNode.contour===ci && selectedNode.point===pi;
        const c = document.createElementNS(svgns,'circle');
        c.setAttribute('cx',p.x); c.setAttribute('cy',p.y);
        c.setAttribute('r', isSel ? 9 : 6);
        c.setAttribute('fill', isSel ? '#2b6ab5' : '#b5432b');
        c.setAttribute('stroke','#fff');
        c.setAttribute('stroke-width', 1.5);
        ptsGroup.appendChild(c);
      });
    });
    svg.appendChild(ptsGroup);
  }

  // trazado en curso (preview, solo en modo pluma)
  if(currentContour.length>0){
    let pd = `M ${currentContour[0].x} ${currentContour[0].y} `;
    for(let i=1;i<currentContour.length;i++){
      pd += `L ${currentContour[i].x} ${currentContour[i].y} `;
    }
    const preview = document.createElementNS(svgns,'path');
    preview.id = 'previewPath';
    preview.setAttribute('d', pd);
    preview.setAttribute('fill','none');
    preview.setAttribute('stroke','#b5432b');
    preview.setAttribute('stroke-width',2);
    preview.setAttribute('stroke-dasharray','4 3');
    svg.appendChild(preview);

    const ptsGroup2 = document.createElementNS(svgns,'g');
    ptsGroup2.id = 'ptsGroup';
    currentContour.forEach((p,i)=>{
      const c = document.createElementNS(svgns,'circle');
      c.setAttribute('cx',p.x); c.setAttribute('cy',p.y);
      c.setAttribute('r', i===0 ? 7 : 4);
      c.setAttribute('fill', i===0 ? '#b5432b' : '#444');
      ptsGroup2.appendChild(c);
    });
    svg.appendChild(ptsGroup2);
  }
}

// ---------- Modo PLUMA: click para agregar puntos ----------
svg.addEventListener('click', (e)=>{
  if(toolMode!=='pen') return;
  const {x,y} = svgPointFromEvent(e);

  if(currentContour.length>=3){
    const first = currentContour[0];
    const dist = Math.hypot(first.x-x, first.y-y);
    if(dist < 18){
      closeCurrentContour();
      return;
    }
  }
  currentContour.push({x,y});
  renderGlyphPath();
});

// Al cerrar un trazado dibujado a mano queda LIBRE (sin grupo): así podés, por ejemplo,
// seguir haciendo clic para dibujar el agujero de al lado y ajustarlo por separado con
// la herramienta de selección. Si más adelante preferís que también queden pegados
// entre sí, se puede agregar una opción para eso.
function closeCurrentContour(){
  if(currentContour.length<3) return;
  const char = CHAR_LIST[currentIndex].char;
  const glyph = getGlyph(char);
  glyph.contours.push({ points: currentContour, group: null });
  currentContour = [];
  saveState();
  renderGlyphPath();
  refreshGlyphList();
  refreshProgress();
}

// ---------- Modos SELECCIÓN (mover contorno o grupo pegado completo) y NODO (mover un punto) ----------
svg.addEventListener('mousedown', (e)=>{
  if(toolMode==='pen') return;
  const {x,y} = svgPointFromEvent(e);
  const char = CHAR_LIST[currentIndex].char;
  const glyph = getGlyph(char);

  if(toolMode==='node'){
    let found = null;
    glyph.contours.forEach((contour, ci)=>{
      contour.points.forEach((p, pi)=>{
        if(Math.hypot(p.x-x, p.y-y) <= NODE_HIT_RADIUS) found = {contour:ci, point:pi};
      });
    });
    selectedNode = found;
    if(found) dragState = { type:'node' };
    renderGlyphPath();
  } else if(toolMode==='select'){
    // los manejadores de ancho tienen prioridad si el clic cae cerca de alguno de los dos
    if(Math.abs(x-0) <= HANDLE_HIT_RADIUS){
      dragState = { type:'leftHandle', lastX:x };
      renderGlyphPath();
      return;
    }
    if(Math.abs(x-glyph.advanceWidth) <= HANDLE_HIT_RADIUS){
      dragState = { type:'rightHandle' };
      renderGlyphPath();
      return;
    }
    let foundIdx = -1;
    for(let ci=glyph.contours.length-1; ci>=0; ci--){
      if(glyph.contours[ci].points.length>=3 && pointInPolygon({x,y}, glyph.contours[ci].points)) { foundIdx = ci; break; }
    }
    if(foundIdx>=0){
      const g = glyph.contours[foundIdx].group;
      // si el contorno pertenece a un grupo (por ej. viene de un mismo pegado con su calado),
      // seleccionamos TODOS los contornos de ese grupo para que se muevan juntos.
      selectedGroup = (g===null) ? [foundIdx] : glyph.contours
        .map((c,idx)=> c.group===g ? idx : -1)
        .filter(idx=> idx>=0);
    } else {
      selectedGroup = [];
    }
    if(foundIdx>=0) dragState = { type:'contour', lastX:x, lastY:y };
    rebaseTransform();
    renderGlyphPath();
  }
});
svg.addEventListener('mousemove', (e)=>{
  if(!dragState) return;
  const {x,y} = svgPointFromEvent(e);
  const char = CHAR_LIST[currentIndex].char;
  const glyph = getGlyph(char);

  if(dragState.type==='node' && selectedNode){
    glyph.contours[selectedNode.contour].points[selectedNode.point] = {x,y};
    renderGlyphPath();
  } else if(dragState.type==='contour' && selectedGroup.length>0){
    const dx = x - dragState.lastX, dy = y - dragState.lastY;
    selectedGroup.forEach(ci=>{
      glyph.contours[ci].points = glyph.contours[ci].points.map(p=>({x:p.x+dx, y:p.y+dy}));
    });
    dragState.lastX = x; dragState.lastY = y;
    renderGlyphPath();
  } else if(dragState.type==='leftHandle'){
    const dx = x - dragState.lastX;
    glyph.contours.forEach(c=>{ c.points = c.points.map(p=>({x:p.x+dx, y:p.y})); });
    dragState.lastX = x;
    renderGlyphPath();
  } else if(dragState.type==='rightHandle'){
    glyph.advanceWidth = Math.max(50, Math.round(x));
    glyph.widthManual = true;
    renderGlyphPath();
  }
});
window.addEventListener('mouseup', ()=>{
  if(dragState){
    dragState = null;
    saveState();
    refreshGlyphList();
    refreshProgress();
    rebaseTransform(); // el arrastre manual mueve los puntos: los sliders vuelven a 0/100% desde acá
  }
});

document.querySelectorAll('.tool-mode').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    toolMode = btn.dataset.mode;
    selectedGroup = [];
    selectedNode = null;
    document.querySelectorAll('.tool-mode').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    rebaseTransform();
    renderGlyphPath();
  });
});

// ---------- Slider de escala para el contorno/grupo seleccionado (modo Selección) ----------
// Al elegir un contorno o grupo pegado, "congelamos" sus puntos originales como referencia
// (transformBase); mover el slider aplica la escala en vivo a partir de esa referencia
// (con centro en el propio conjunto seleccionado), sin ir acumulando error. Un arrastre manual
// con el mouse (para reposicionarlo) vuelve a congelar la referencia en la nueva posición.
function rebaseTransform(){
  if(selectedGroup.length===0){
    transformBase = null;
    updateTransformPanelVisibility();
    return;
  }
  const glyph = getGlyph(CHAR_LIST[currentIndex].char);
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  const points = selectedGroup.map(ci=>{
    const pts = glyph.contours[ci].points.map(p=>({...p}));
    pts.forEach(p=>{ minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y); });
    return pts;
  });
  transformBase = { center: { x:(minX+maxX)/2, y:(minY+maxY)/2 }, points };
  scaleSlider.value = 100;
  scaleValueEl.textContent = '100%';
  updateTransformPanelVisibility();
}
function updateTransformPanelVisibility(){
  transformPanel.classList.toggle('hidden', !(toolMode==='select' && selectedGroup.length>0));
}
function applySliders(){
  if(!transformBase) return;
  const glyph = getGlyph(CHAR_LIST[currentIndex].char);
  const scale = parseFloat(scaleSlider.value)/100;
  selectedGroup.forEach((ci, idx)=>{
    glyph.contours[ci].points = transformBase.points[idx].map(p=>({
      x: Math.round(transformBase.center.x + (p.x - transformBase.center.x)*scale),
      y: Math.round(transformBase.center.y + (p.y - transformBase.center.y)*scale)
    }));
  });
  scaleValueEl.textContent = Math.round(scale*100) + '%';
  renderGlyphPath();
}
scaleSlider.addEventListener('input', applySliders);
scaleSlider.addEventListener('change', ()=>{ saveState(); refreshGlyphList(); refreshProgress(); });

document.getElementById('closeContour').addEventListener('click', closeCurrentContour);

document.getElementById('undoPoint').addEventListener('click', ()=>{
  currentContour.pop();
  renderGlyphPath();
});

document.getElementById('deleteSelected').addEventListener('click', ()=>{
  const char = CHAR_LIST[currentIndex].char;
  const glyph = getGlyph(char);
  if(toolMode==='node' && selectedNode){
    glyph.contours[selectedNode.contour].points.splice(selectedNode.point,1);
    if(glyph.contours[selectedNode.contour].points.length<3) glyph.contours.splice(selectedNode.contour,1);
    selectedNode = null;
  } else if(toolMode==='select' && selectedGroup.length>0){
    // borramos de mayor a menor índice para no desordenar el resto al hacer splice
    [...selectedGroup].sort((a,b)=>b-a).forEach(idx=> glyph.contours.splice(idx,1));
    selectedGroup = [];
  } else {
    return;
  }
  rebaseTransform();
  saveState();
  renderGlyphPath();
  refreshGlyphList();
  refreshProgress();
});

document.getElementById('clearGlyph').addEventListener('click', ()=>{
  const char = CHAR_LIST[currentIndex].char;
  if(!confirm(`¿Borrar todo el trazado de "${char}"?`)) return;
  glyphData[char] = { contours: [], advanceWidth: char===' ' ? SPACE_ADVANCE : DEFAULT_ADVANCE };
  currentContour = [];
  selectedGroup = [];
  selectedNode = null;
  saveState();
  renderGlyphPath();
  refreshGlyphList();
  refreshProgress();
});

// ---------- Letra de referencia (guía gris para centrar/comparar proporciones) ----------
function updateReferenceButton(){
  refToggleBtn.classList.toggle('active', showReference);
}
refToggleBtn.addEventListener('click', ()=>{
  showReference = !showReference;
  saveFlag(SHOW_REF_KEY, showReference);
  updateReferenceButton();
  renderGlyphPath();
});
updateReferenceButton();

// ---------- Pegar vector ----------
document.getElementById('pasteVector').addEventListener('click', async ()=>{
  pasteBox.classList.remove('hidden');
  try{
    const text = await navigator.clipboard.readText();
    if(text) pasteTextarea.value = text;
  }catch(e){
    // El portapapeles automático no siempre funciona (permisos del navegador,
    // o al abrir el archivo directamente sin servidor). No pasa nada:
    // se puede pegar a mano con Ctrl+V / Cmd+V en el cuadro de abajo.
  }
  pasteTextarea.focus();
});
document.getElementById('cancelPaste').addEventListener('click', ()=>{
  pasteBox.classList.add('hidden');
  pasteTextarea.value = '';
});
// Recalcula la referencia de escala/posición a partir de lo que haya en el cuadro ahora mismo
// (por si cambiaste de dibujo/fuente de origen y la escala guardada ya no corresponde).
// No hace falta tocarla para el uso normal: se usa sola y se guarda sola en el primer pegado.
document.getElementById('recalcPasteRef').addEventListener('click', ()=>{
  const text = pasteTextarea.value.trim();
  if(!text){ alert('Pegá primero el vector en el cuadro de texto.'); return; }
  const contours = parseVectorText(text);
  if(!contours || contours.every(c=>c.length<3)){
    alert('No pude interpretar ese vector todavía para calcular el ajuste.');
    return;
  }
  pasteRef = computeFitTransform(contours.filter(c=>c.length>=3));
  saveJSON(PASTE_REF_KEY, pasteRef);
  alert('Listo, se recalculó la escala/posición de referencia para los próximos pegados.');
});
document.getElementById('applyPaste').addEventListener('click', ()=>{
  const text = pasteTextarea.value.trim();
  if(!text){
    alert('El cuadro de texto está vacío. Si "Pegar vector" no lo completó solo, pegá manualmente el contenido con Ctrl+V (o Cmd+V en Mac) dentro del recuadro y volvé a apretar "Aplicar".');
    return;
  }
  let contours = parseVectorText(text);
  if(!contours || contours.length===0 || contours.every(c=>c.length<3)){
    alert('No pude interpretar ese vector. Probá con un path SVG (M.. L.. Z, incluyendo curvas C/Q/S), el <svg>/<path> completo, o una lista de puntos "x,y x,y ...".');
    return;
  }
  contours = contours.filter(c=>c.length>=3);

  // Usamos la referencia guardada (escala/posición) para que todo lo pegado mantenga el
  // mismo tamaño relativo entre sí. Si es el primer pegado, la calculamos y la guardamos.
  if(!pasteRef){
    pasteRef = computeFitTransform(contours);
    saveJSON(PASTE_REF_KEY, pasteRef);
  }
  const { scale, offsetX, offsetY } = pasteRef;
  const transformed = contours.map(c=> c.map(p=>({
    x: Math.round(offsetX + p.x*scale),
    y: Math.round(offsetY + p.y*scale)
  })));

  const char = CHAR_LIST[currentIndex].char;
  const glyph = getGlyph(char);
  const groupId = ++groupCounter;
  transformed.forEach(pts=> glyph.contours.push({ points: pts, group: groupId }));
  saveState();
  pasteBox.classList.add('hidden');
  pasteTextarea.value = '';
  renderGlyphPath();
  refreshGlyphList();
  refreshProgress();
});

// Detecta y parsea: markup <svg>/<path> completo (uno o VARIOS <path>), path "d" suelto
// (M/L/H/V/C/Q/S/Z), o lista de puntos "x,y x,y ...". Devuelve un ARRAY DE CONTORNOS
// (cada M...Z, de cualquiera de los "d" encontrados, es un contorno independiente).
function parseVectorText(text){
  const dValues = extractAllPathD(text);
  if(dValues.length>0){
    let all = [];
    dValues.forEach(d=>{
      const c = parseSvgPathToContours(d);
      if(c) all = all.concat(c);
    });
    return all;
  }
  if(/[MLHVZCQSTAmlhvzcqsta]/.test(text) && /[MLmlZz]/.test(text)){
    return parseSvgPathToContours(text);
  }
  const points = parsePointList(text);
  return points ? [points] : null;
}
// Si pegaron el <svg>...</svg> completo (con uno o varios <path>), <!-- comentarios -->,
// <?xml ...?>, etc., extraemos TODOS los atributos d="..." (o d='...') y descartamos el
// resto del markup, así no hace falta borrar nada a mano antes de pegar.
function extractAllPathD(text){
  const out = [];
  const re = /\bd\s*=\s*"([^"]+)"|\bd\s*=\s*'([^']+)'/gi;
  let m;
  while((m = re.exec(text)) !== null){
    out.push(m[1] || m[2]);
  }
  return out;
}

function parseSvgPathToContours(d){
  const tokens = d.match(/[MLHVZCQSTAmlhvzcqsta]|-?\d*\.?\d+(?:e-?\d+)?/g);
  if(!tokens) return null;
  const CURVE_STEPS = 10; // segmentos rectos con los que se aproxima cada curva pegada

  const contours = [];
  let current = [];
  let i=0, cur = {x:0,y:0}, start = {x:0,y:0}, cmd = 'M'; // si el "d" viene sin M inicial (pasa según de dónde se copie), lo asumimos igual
  const num = ()=> parseFloat(tokens[i++]);

  function pushPoint(p){ current.push(p); }
  function sampleQuad(p0,p1,p2){
    for(let s=1;s<=CURVE_STEPS;s++){
      const t=s/CURVE_STEPS, mt=1-t;
      pushPoint({ x: mt*mt*p0.x+2*mt*t*p1.x+t*t*p2.x, y: mt*mt*p0.y+2*mt*t*p1.y+t*t*p2.y });
    }
  }
  function sampleCubic(p0,p1,p2,p3){
    for(let s=1;s<=CURVE_STEPS;s++){
      const t=s/CURVE_STEPS, mt=1-t;
      pushPoint({
        x: mt*mt*mt*p0.x + 3*mt*mt*t*p1.x + 3*mt*t*t*p2.x + t*t*t*p3.x,
        y: mt*mt*mt*p0.y + 3*mt*mt*t*p1.y + 3*mt*t*t*p2.y + t*t*t*p3.y
      });
    }
  }
  let lastCubicCtrl = null, lastQuadCtrl = null;

  function sampleArc(p0, rx, ry, phiDeg, largeArcFlag, sweepFlag, p1){
    if(rx===0 || ry===0){ pushPoint({x:p1.x,y:p1.y}); return; }
    rx = Math.abs(rx); ry = Math.abs(ry);
    const phi = phiDeg * Math.PI/180;
    const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
    const dx2 = (p0.x-p1.x)/2, dy2=(p0.y-p1.y)/2;
    const x1p = cosPhi*dx2 + sinPhi*dy2;
    const y1p = -sinPhi*dx2 + cosPhi*dy2;
    let rxSq=rx*rx, rySq=ry*ry;
    const x1pSq=x1p*x1p, y1pSq=y1p*y1p;
    const radCheck = x1pSq/rxSq + y1pSq/rySq;
    if(radCheck>1){ const s=Math.sqrt(radCheck); rx*=s; ry*=s; rxSq=rx*rx; rySq=ry*ry; }
    const sign = (largeArcFlag!==sweepFlag)?1:-1;
    let numr = rxSq*rySq - rxSq*y1pSq - rySq*x1pSq;
    if(numr<0) numr=0;
    const denom = (rxSq*y1pSq+rySq*x1pSq) || 1;
    const co = sign*Math.sqrt(numr/denom);
    const cxp = co*(rx*y1p/ry);
    const cyp = co*(-ry*x1p/rx);
    const cx = cosPhi*cxp - sinPhi*cyp + (p0.x+p1.x)/2;
    const cy = sinPhi*cxp + cosPhi*cyp + (p0.y+p1.y)/2;
    function ang(ux,uy,vx,vy){
      const dot = ux*vx+uy*vy;
      const len = Math.sqrt((ux*ux+uy*uy)*(vx*vx+vy*vy)) || 1;
      let a = Math.acos(Math.max(-1,Math.min(1,dot/len)));
      if(ux*vy - uy*vx < 0) a = -a;
      return a;
    }
    const theta1 = ang(1,0,(x1p-cxp)/rx,(y1p-cyp)/ry);
    let dtheta = ang((x1p-cxp)/rx,(y1p-cyp)/ry, (-x1p-cxp)/rx, (-y1p-cyp)/ry);
    if(!sweepFlag && dtheta>0) dtheta -= 2*Math.PI;
    if(sweepFlag && dtheta<0) dtheta += 2*Math.PI;
    for(let s=1;s<=CURVE_STEPS;s++){
      const t = theta1 + dtheta*(s/CURVE_STEPS);
      pushPoint({
        x: cx + rx*Math.cos(t)*cosPhi - ry*Math.sin(t)*sinPhi,
        y: cy + rx*Math.cos(t)*sinPhi + ry*Math.sin(t)*cosPhi
      });
    }
  }

  while(i<tokens.length){
    if(/^[a-zA-Z]$/.test(tokens[i])){ cmd = tokens[i]; i++; }
    if(!cmd) break;
    const isNewMove = (cmd==='M' || cmd==='m');
    if(isNewMove){
      if(current.length>=3) contours.push(current);
      current = [];
    }
    switch(cmd){
      case 'M': cur={x:num(),y:num()}; start=cur; pushPoint({...cur}); cmd='L'; break;
      case 'm': cur={x:cur.x+num(),y:cur.y+num()}; start=cur; pushPoint({...cur}); cmd='l'; break;
      case 'L': cur={x:num(),y:num()}; pushPoint({...cur}); break;
      case 'l': cur={x:cur.x+num(),y:cur.y+num()}; pushPoint({...cur}); break;
      case 'H': cur={x:num(),y:cur.y}; pushPoint({...cur}); break;
      case 'h': cur={x:cur.x+num(),y:cur.y}; pushPoint({...cur}); break;
      case 'V': cur={x:cur.x,y:num()}; pushPoint({...cur}); break;
      case 'v': cur={x:cur.x,y:cur.y+num()}; pushPoint({...cur}); break;
      case 'C': { const p0=cur, p1={x:num(),y:num()}, p2={x:num(),y:num()}, p3={x:num(),y:num()};
        sampleCubic(p0,p1,p2,p3); cur=p3; lastCubicCtrl=p2; break; }
      case 'c': { const p0=cur, p1={x:cur.x+num(),y:cur.y+num()}, p2={x:cur.x+num(),y:cur.y+num()}, p3={x:cur.x+num(),y:cur.y+num()};
        sampleCubic(p0,p1,p2,p3); cur=p3; lastCubicCtrl=p2; break; }
      case 'S': { const p0=cur, p1= lastCubicCtrl? {x:2*cur.x-lastCubicCtrl.x,y:2*cur.y-lastCubicCtrl.y}: cur, p2={x:num(),y:num()}, p3={x:num(),y:num()};
        sampleCubic(p0,p1,p2,p3); cur=p3; lastCubicCtrl=p2; break; }
      case 's': { const p0=cur, p1= lastCubicCtrl? {x:2*cur.x-lastCubicCtrl.x,y:2*cur.y-lastCubicCtrl.y}: cur, p2={x:cur.x+num(),y:cur.y+num()}, p3={x:cur.x+num(),y:cur.y+num()};
        sampleCubic(p0,p1,p2,p3); cur=p3; lastCubicCtrl=p2; break; }
      case 'Q': { const p0=cur, p1={x:num(),y:num()}, p2={x:num(),y:num()};
        sampleQuad(p0,p1,p2); cur=p2; lastQuadCtrl=p1; break; }
      case 'q': { const p0=cur, p1={x:cur.x+num(),y:cur.y+num()}, p2={x:cur.x+num(),y:cur.y+num()};
        sampleQuad(p0,p1,p2); cur=p2; lastQuadCtrl=p1; break; }
      case 'T': { const p0=cur, p1= lastQuadCtrl? {x:2*cur.x-lastQuadCtrl.x,y:2*cur.y-lastQuadCtrl.y}: cur, p2={x:num(),y:num()};
        sampleQuad(p0,p1,p2); cur=p2; lastQuadCtrl=p1; break; }
      case 't': { const p0=cur, p1= lastQuadCtrl? {x:2*cur.x-lastQuadCtrl.x,y:2*cur.y-lastQuadCtrl.y}: cur, p2={x:cur.x+num(),y:cur.y+num()};
        sampleQuad(p0,p1,p2); cur=p2; lastQuadCtrl=p1; break; }
      case 'A': { const rx=num(), ry=num(), rot=num(), laf=num(), sf=num(), ex=num(), ey=num();
        const p0=cur, p1={x:ex,y:ey}; sampleArc(p0,rx,ry,rot,laf,sf,p1); cur=p1; break; }
      case 'a': { const rx=num(), ry=num(), rot=num(), laf=num(), sf=num(), dx=num(), dy=num();
        const p0=cur, p1={x:cur.x+dx,y:cur.y+dy}; sampleArc(p0,rx,ry,rot,laf,sf,p1); cur=p1; break; }
      case 'Z': case 'z': cur = start; break;
      default: i++;
    }
    if(cmd!=='C' && cmd!=='c' && cmd!=='S' && cmd!=='s') lastCubicCtrl=null;
    if(cmd!=='Q' && cmd!=='q' && cmd!=='T' && cmd!=='t') lastQuadCtrl=null;
  }
  if(current.length>=3) contours.push(current);
  return contours;
}
function parsePointList(text){
  const nums = text.match(/-?\d*\.?\d+/g);
  if(!nums || nums.length<6) return null;
  const points = [];
  for(let i=0;i+1<nums.length;i+=2){
    points.push({ x: parseFloat(nums[i]), y: parseFloat(nums[i+1]) });
  }
  return points;
}

// Calcula una escala + offset que centran el grupo de contornos dentro de la caja de
// referencia (PASTE_BOX), apoyado en la línea base. Es solo la SUGERENCIA inicial:
// una vez aplicada, esa misma escala/offset puede guardarse como referencia fija para
// que los próximos pegados (por ejemplo el resto de las letras del mismo dibujo/fuente
// de origen) mantengan el mismo tamaño y posición relativa entre sí, en vez de que cada
// uno se reajuste de forma independiente según su propio contorno.
function computeFitTransform(contours){
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  contours.forEach(c=> c.forEach(p=>{
    minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x);
    minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y);
  }));
  const w = maxX-minX || 1, h = maxY-minY || 1;
  const boxW = PASTE_BOX.x1-PASTE_BOX.x0, boxH = PASTE_BOX.y1-PASTE_BOX.y0;
  const scale = Math.min(boxW/w, boxH/h);
  const cx = (minX+maxX)/2, cy = (minY+maxY)/2;
  const targetCx = (PASTE_BOX.x0+PASTE_BOX.x1)/2, targetCy = (PASTE_BOX.y0+PASTE_BOX.y1)/2;
  return { scale, offsetX: targetCx - cx*scale, offsetY: targetCy - cy*scale };
}

// ---------- Navegación de caracteres ----------
document.getElementById('prevChar').addEventListener('click', ()=> goTo(currentIndex-1));
document.getElementById('nextChar').addEventListener('click', ()=> goTo(currentIndex+1));
function goTo(idx){
  if(idx<0 || idx>=CHAR_LIST.length) return;
  if(currentContour.length>0 && currentContour.length<3){
    if(!confirm('Hay un trazado sin terminar (menos de 3 puntos) en este carácter y se perderá si cambiás de glifo. ¿Continuar de todos modos?')) return;
  }
  currentContour = [];
  selectedGroup = [];
  selectedNode = null;
  currentIndex = idx;
  updateCurrentCharUI();
}
function updateCurrentCharUI(){
  const item = CHAR_LIST[currentIndex];
  currentCharLabel.textContent = item.isSpace ? '(espacio)' : item.char;
  renderGlyphPath();
  document.querySelectorAll('.glyph-btn').forEach(b=>b.classList.remove('selected'));
  const btn = document.getElementById('glyphbtn-'+currentIndex);
  if(btn) btn.classList.add('selected');
}

// ---------- Lista lateral de glifos ----------
function refreshGlyphList(){
  glyphListEl.innerHTML = '';
  CHAR_LIST.forEach((item, idx)=>{
    const btn = document.createElement('button');
    btn.className = 'glyph-btn';
    btn.id = 'glyphbtn-'+idx;
    btn.textContent = item.isSpace ? '␣' : item.char;
    const g = glyphData[item.char];
    if(g && g.contours.length>0) btn.classList.add('done');
    if(idx===currentIndex) btn.classList.add('selected');
    const dot = document.createElement('span');
    dot.className = 'dot';
    btn.appendChild(dot);
    btn.addEventListener('click', ()=> goTo(idx));
    glyphListEl.appendChild(btn);
  });
}
function refreshProgress(){
  const done = CHAR_LIST.filter(it=>{
    const g = glyphData[it.char];
    return g && g.contours.length>0;
  }).length;
  progressLabel.textContent = `${done} / ${CHAR_LIST.length} glifos`;
}

// ---------- Verificación previa a exportar ----------
function runDiagnostics(){
  const missing = CHAR_LIST.filter(it=>{
    const g = glyphData[it.char];
    return (!g || g.contours.length===0) && !it.isSpace;
  }).map(it=> it.char);

  let windingFixes = 0;
  CHAR_LIST.forEach(it=>{
    const g = glyphData[it.char];
    if(g && g.contours.length>0){
      windingFixes += normalizeWindings(g.contours.map(c=>c.points)).fixedCount;
    }
  });

  const openIncomplete = (currentContour.length>0 && currentContour.length<3)
    ? { char: CHAR_LIST[currentIndex].char, points: currentContour.length }
    : null;
  const openReadyToClose = (currentContour.length>=3)
    ? { char: CHAR_LIST[currentIndex].char, points: currentContour.length }
    : null;

  // Glifos con dibujo pero cuyo ancho nunca se ajustó a mano (manejador derecho intacto):
  // les sugerimos un ancho proporcional al propio dibujo/pegado, en vez del ancho parejo por defecto.
  const autoWidthCandidates = CHAR_LIST.filter(it=>{
    const g = glyphData[it.char];
    return g && g.contours.length>0 && !g.widthManual;
  });

  return { missing, windingFixes, openIncomplete, openReadyToClose, autoWidthCandidates };
}

function suggestedWidthFor(glyph){
  let minX=Infinity, maxX=-Infinity;
  glyph.contours.forEach(c=> c.points.forEach(p=>{ minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); }));
  if(!isFinite(minX)) return null;
  return Math.max(80, Math.round((maxX-minX) + AUTO_WIDTH_PADDING*2));
}

function showVerifyPanel(){
  let diag = runDiagnostics();
  let autoWidthApplied = 0;

  if(diag.autoWidthCandidates.length>0){
    const ok = confirm(
      `Hay ${diag.autoWidthCandidates.length} glifo(s) dibujado(s) cuyo ancho nunca ajustaste a mano (con el manejador derecho). ` +
      `¿Querés que les asigne automáticamente un ancho proporcional a lo dibujado o pegado en cada uno, en vez del ancho parejo por defecto?`
    );
    if(ok){
      autoWidthApplied = diag.autoWidthCandidates.length;
      diag.autoWidthCandidates.forEach(it=>{
        const g = glyphData[it.char];
        const w = suggestedWidthFor(g);
        if(w) g.advanceWidth = w;
      });
      saveState();
      diag = runDiagnostics(); // autoWidthCandidates sigue igual a propósito: no se marcan como "manual"
    }
  }

  let html = '';
  if(diag.openIncomplete){
    html += `<p class="diag-error">⚠️ Hay un trazado sin cerrar en "${diag.openIncomplete.char}" con solo ${diag.openIncomplete.points} punto(s) (hacen falta al menos 3). No se puede autocorregir: agregá más puntos y cerralo, o descartalo, antes de exportar.</p>`;
  }
  if(diag.openReadyToClose){
    html += `<p class="diag-info">ℹ️ Hay un trazado en curso en "${diag.openReadyToClose.char}" con ${diag.openReadyToClose.points} puntos. Se cerrará automáticamente al exportar.</p>`;
  }
  if(diag.missing.length>0){
    html += `<p class="diag-warn">📝 Glifos sin dibujar (${diag.missing.length}): <span class="mono">${diag.missing.map(c=>c===' '?'␣':c).join(' ')}</span></p>`;
  } else {
    html += `<p class="diag-ok">✅ Todos los caracteres tienen al menos un trazado.</p>`;
  }
  if(diag.windingFixes>0){
    html += `<p class="diag-info">🔧 Se corregirá automáticamente el sentido de giro de ${diag.windingFixes} contorno(s) para que los calados se vean huecos en la fuente exportada. No hace falta que hagas nada.</p>`;
  } else {
    html += `<p class="diag-ok">✅ El sentido de giro de todos los contornos ya es correcto.</p>`;
  }
  if(autoWidthApplied>0){
    html += `<p class="diag-ok">✅ Se asignó automáticamente un ancho proporcional al dibujo/pegado en ${autoWidthApplied} glifo(s). Si volvés a abrir esta verificación seguirán apareciendo como "sin ajustar a mano" — es solo para saber que podés recalcularlos de nuevo cuando quieras, no significa que estén mal.</p>`;
  } else if(diag.autoWidthCandidates.length>0){
    html += `<p class="diag-warn">📐 ${diag.autoWidthCandidates.length} glifo(s) siguen con el ancho parejo por defecto (nunca tocaste el manejador derecho): <span class="mono">${diag.autoWidthCandidates.map(it=>it.char===' '?'␣':it.char).join(' ')}</span>. Podés arrastrar el manejador de cada uno, o volver a abrir "Verificar fuente" para que te ofrezca asignarlo automáticamente.</p>`;
  } else {
    html += `<p class="diag-ok">✅ Todos los anchos están definidos (a mano o por el ajuste automático).</p>`;
  }
  verifyContent.innerHTML = html;
  verifyPanel.classList.remove('hidden');
}
document.getElementById('verifyFont').addEventListener('click', showVerifyPanel);
document.getElementById('closeVerify').addEventListener('click', ()=> verifyPanel.classList.add('hidden'));

// ---------- Generación de la fuente con opentype.js ----------
function buildFont(){
  const familyName = document.getElementById('familyName').value.trim() || 'MiFuente';

  const notdefPath = new opentype.Path();
  notdefPath.moveTo(50,0); notdefPath.lineTo(450,0);
  notdefPath.lineTo(450,700); notdefPath.lineTo(50,700); notdefPath.close();
  const notdefGlyph = new opentype.Glyph({
    name:'.notdef', unicode:0, advanceWidth: DEFAULT_ADVANCE, path: notdefPath
  });

  const glyphs = [notdefGlyph];
  CHAR_LIST.forEach(item=>{
    const data = glyphData[item.char];
    const path = new opentype.Path();
    if(data && data.contours.length>0){
      const toFont = p => ({ x: p.x, y: BASELINE_Y_SVG - p.y });
      // pasamos a espacio de fuente ANTES de corregir el sentido de giro,
      // porque el eje Y se invierte y eso también invierte el signo del área.
      const fontSpaceContours = data.contours
        .map(c=>c.points)
        .filter(pts=>pts.length>=3)
        .map(pts=> pts.map(toFont));
      const { contours: fixedContours } = normalizeWindings(fontSpaceContours);
      fixedContours.forEach(contour=>{
        path.moveTo(contour[0].x, contour[0].y);
        for(let i=1;i<contour.length;i++) path.lineTo(contour[i].x, contour[i].y);
        path.close();
      });
    }
    const advanceWidth = (data && data.advanceWidth) || (item.isSpace ? SPACE_ADVANCE : DEFAULT_ADVANCE);
    glyphs.push(new opentype.Glyph({
      name: item.name,
      unicode: item.char.codePointAt(0),
      advanceWidth,
      path
    }));
  });

  return new opentype.Font({
    familyName,
    styleName: 'Regular',
    unitsPerEm: UNITS_PER_EM,
    ascender: ASCENDER,
    descender: DESCENDER,
    glyphs
  });
}

function download(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function familyFileName(){
  return (document.getElementById('familyName').value.trim() || 'MiFuente');
}

// NOTA TÉCNICA (ver explicación completa en el chat): la librería opentype.js que
// usamos para generar la fuente escribe siempre un sfnt con tabla "CFF " (formato
// OpenType/PostScript), nunca "glyf" (TrueType puro). Eso es, técnicamente, un .otf.
// Igual lo ofrecemos también como .ttf porque el sistema operativo identifica el
// formato real por el contenido del archivo, no por la extensión, y en la práctica
// se instala y funciona igual en Windows/macOS y en la mayoría de los programas.
document.getElementById('exportOtf').addEventListener('click', ()=>{
  if(currentContour.length>=3) closeCurrentContour();
  try{
    const font = buildFont();
    const buffer = font.toArrayBuffer();
    download(new Blob([buffer], {type:'font/otf'}), familyFileName() + '.otf');
  }catch(err){
    console.error(err);
    alert('Error generando el OTF: ' + err.message);
  }
});
document.getElementById('exportTtf').addEventListener('click', ()=>{
  if(currentContour.length>=3) closeCurrentContour();
  try{
    const font = buildFont();
    const buffer = font.toArrayBuffer();
    download(new Blob([buffer], {type:'font/ttf'}), familyFileName() + '.ttf');
  }catch(err){
    console.error(err);
    alert('Error generando el TTF: ' + err.message);
  }
});
document.getElementById('exportWoff').addEventListener('click', ()=>{
  if(currentContour.length>=3) closeCurrentContour();
  try{
    const font = buildFont();
    const sfntBuffer = font.toArrayBuffer();
    const woffBuffer = sfntToWoff(sfntBuffer);
    download(new Blob([woffBuffer], {type:'font/woff'}), familyFileName() + '.woff');
  }catch(err){
    console.error(err);
    alert('Error generando el WOFF: ' + err.message);
  }
});

// ---------- Empaquetador WOFF1 (a partir de un SFNT ya generado) ----------
function sfntToWoff(sfntArrayBuffer){
  const dv = new DataView(sfntArrayBuffer);
  const flavor = dv.getUint32(0);
  const numTables = dv.getUint16(4);

  const tables = [];
  let offset = 12;
  for(let i=0;i<numTables;i++){
    const tag = String.fromCharCode(
      dv.getUint8(offset), dv.getUint8(offset+1), dv.getUint8(offset+2), dv.getUint8(offset+3)
    );
    const checksum = dv.getUint32(offset+4);
    const tOffset = dv.getUint32(offset+8);
    const length = dv.getUint32(offset+12);
    tables.push({ tag, checksum, offset: tOffset, length });
    offset += 16;
  }

  const compressedTables = tables.map(t=>{
    const origData = new Uint8Array(sfntArrayBuffer, t.offset, t.length);
    let comp = pako.deflate(origData);
    if(comp.length >= origData.length) comp = origData;
    return { ...t, compData: comp };
  });

  const HEADER_SIZE = 44;
  const DIR_ENTRY_SIZE = 20;
  let dataOffset = HEADER_SIZE + DIR_ENTRY_SIZE*numTables;
  const dirEntries = [];
  let totalDataSize = 0;
  compressedTables.forEach(t=>{
    const padded = Math.ceil(t.compData.length/4)*4;
    dirEntries.push({
      tag: t.tag, offset: dataOffset, compLength: t.compData.length,
      origLength: t.length, origChecksum: t.checksum
    });
    dataOffset += padded;
    totalDataSize += padded;
  });
  const totalLength = HEADER_SIZE + DIR_ENTRY_SIZE*numTables + totalDataSize;

  const out = new Uint8Array(totalLength);
  const outDv = new DataView(out.buffer);

  out[0]=0x77; out[1]=0x4F; out[2]=0x46; out[3]=0x46; // 'wOFF'
  outDv.setUint32(4, flavor);
  outDv.setUint32(8, totalLength);
  outDv.setUint16(12, numTables);
  outDv.setUint16(14, 0);
  outDv.setUint32(16, sfntArrayBuffer.byteLength);
  outDv.setUint16(20, 1);
  outDv.setUint16(22, 0);
  outDv.setUint32(24, 0);
  outDv.setUint32(28, 0);
  outDv.setUint32(32, 0);
  outDv.setUint32(36, 0);
  outDv.setUint32(40, 0);

  let p = HEADER_SIZE;
  dirEntries.forEach(e=>{
    out[p]=e.tag.charCodeAt(0); out[p+1]=e.tag.charCodeAt(1);
    out[p+2]=e.tag.charCodeAt(2); out[p+3]=e.tag.charCodeAt(3);
    outDv.setUint32(p+4, e.offset);
    outDv.setUint32(p+8, e.compLength);
    outDv.setUint32(p+12, e.origLength);
    outDv.setUint32(p+16, e.origChecksum);
    p += DIR_ENTRY_SIZE;
  });

  compressedTables.forEach((t, idx)=>{
    out.set(t.compData, dirEntries[idx].offset);
  });

  return out.buffer;
}

// ---------- Inicialización ----------
drawGuides();
refreshGlyphList();
refreshProgress();
updateCurrentCharUI();
