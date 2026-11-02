"use strict";
// Recetario A5 (personal o de la institución) dibujado en el celular, sin servidor: cada hoja es un lienzo que se exporta
// como imagen (para pegar o compartir en WhatsApp) o como PDF (la hoja como imagen dentro del PDF).
// Mismo diseño que app/plantillas/recetario.html de la versión PC (portado de Quirón).

const Recetario = (() => {
  const MM = 8;                       // px por mm (≈ 200 ppp: nítido al imprimir y liviano para WhatsApp)
  const ANCHO = 148, ALTO = 210;      // A5 en mm
  const PT = 0.3528;                  // mm por punto tipográfico
  const SANS = 'Helvetica, Arial, "Liberation Sans", sans-serif', SERIF = 'Georgia, "Times New Roman", "DejaVu Serif", serif';
  const TINTA = "#1d2329", GRIS = "#5b6670";
  const u = 0.72;                     // escala de medidas del diseño (A5 = 0,72 de A4)
  const base = 9.5;                   // tamaño de letra del cuerpo (pt)

  const TITULOS = { estudios: "Pedido de estudios", materiales: "Pedido de materiales", autorizacion: "Solicitud de autorización", resumen: "Resumen de historia clínica", receta: "Receta" };

  const imagen = (src) => !src ? Promise.resolve(null) : new Promise((ok) => {
    const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src;
  });

  function edad(fnac) {
    const m = (fnac || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const hoy = new Date(), [d, mes, a] = [+m[1], +m[2], +m[3]];
    return hoy.getFullYear() - a - ((hoy.getMonth() + 1 < mes || (hoy.getMonth() + 1 === mes && hoy.getDate() < d)) ? 1 : 0);
  }
  const dniConPuntos = (dni) => { const d = (dni || "").replace(/\./g, "").trim(); return /^\d+$/.test(d) ? Number(d).toLocaleString("es-AR") : dni || ""; };
  const hoyTexto = () => new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });

  // ---------- Contenido de cada documento (bloques) ----------
  function bloques(tipo, d, proc) {
    const b = [], li = (t, c) => b.push({ li: t, codigo: c });
    const p = (...partes) => b.push({ p: partes }); // partes: [texto, negrita]
    if (tipo !== "resumen") b.push({ rp: true });
    if (tipo === "estudios") {
      d.estudios.forEach((e) => li(e.descripcion, d.mostrar_codigos ? e.codigo : ""));
      if (d.clinica.procedimiento) p(["Procedimiento propuesto: ", true], [proc]);
    } else if (tipo === "materiales") {
      p(["Solicito materiales para: ", true], [proc]);
      d.materiales.forEach((m) => li((m.cantidad ? m.cantidad + " × " : "") + m.descripcion));
      if (d.observaciones) p([d.observaciones]);
    } else if (tipo === "autorizacion") {
      p(["Solicito: ", true], ["Autorización para " + proc]);
      if (d.clinica.caracter) p(["Carácter: ", true], [d.clinica.caracter]);
      if (d.autorizacion.fecha_probable) p(["Fecha probable: ", true], [d.autorizacion.fecha_probable]);
      if (d.observaciones) p([d.observaciones]);
    } else if (tipo === "resumen") {
      b.push({ h3: "Resumen de historia clínica" });
      d.autorizacion.fundamento.split(/\n+/).forEach((t) => t.trim() && p([t.trim()]));
      if (d.autorizacion.resumen_estudios) { b.push({ h3: "Estudios" }); p([d.autorizacion.resumen_estudios]); }
      if (d.clinica.procedimiento) p(["Procedimiento propuesto: ", true], [proc]);
    } else if (tipo === "receta") {
      d.medicamentos.forEach((m) => li([m.nombre_generico, m.presentacion].filter(Boolean).join(" ") + (m.cantidad ? ` (x${m.cantidad})` : "") + (m.posologia ? " — " + m.posologia : "")));
      if (d.observaciones) p([d.observaciones]);
      b.push({ aviso: "Copia de referencia. La receta válida se emite en una plataforma de receta electrónica registrada (ReNaPDiS)." });
    }
    return b;
  }

  // ---------- Dibujo ----------
  const px = (mm) => mm * MM;
  const fuente = (pt, { negrita = false, serif = false } = {}) => `${negrita ? "bold " : ""}${px(pt * PT).toFixed(1)}px ${serif ? SERIF : SANS}`;

  // Renglones de un texto con partes (negrita o no) que no pasen de `ancho` mm
  function partir(ctx, partes, pt, ancho) {
    const palabras = [];
    for (const [t, negrita] of partes) for (const w of String(t ?? "").split(/(\s+)/)) if (w) palabras.push({ w, negrita: !!negrita });
    const lineas = [[]];
    let x = 0;
    for (const pal of palabras) {
      ctx.font = fuente(pt, { negrita: pal.negrita });
      const w = ctx.measureText(pal.w).width;
      if (/^\s+$/.test(pal.w)) { if (lineas.at(-1).length) { lineas.at(-1).push({ ...pal, w: " ", ancho: ctx.measureText(" ").width }); x += ctx.measureText(" ").width; } continue; }
      if (x + w > px(ancho) && lineas.at(-1).length) {
        while (lineas.at(-1).at(-1)?.w === " ") lineas.at(-1).pop();
        lineas.push([]); x = 0;
      }
      // Palabra más larga que el renglón: se corta
      if (w > px(ancho)) {
        let resto = pal.w;
        while (resto) {
          let n = resto.length;
          while (n > 1 && ctx.measureText(resto.slice(0, n)).width > px(ancho) - x) n--;
          lineas.at(-1).push({ ...pal, w: resto.slice(0, n), ancho: ctx.measureText(resto.slice(0, n)).width });
          resto = resto.slice(n);
          if (resto) { lineas.push([]); x = 0; } else x += ctx.measureText(lineas.at(-1).at(-1).w).width;
        }
        continue;
      }
      lineas.at(-1).push({ ...pal, ancho: w }); x += w;
    }
    return lineas.filter((l) => l.length);
  }
  function escribir(ctx, linea, x, y, pt, color = TINTA) {
    ctx.fillStyle = color;
    for (const s of linea) { ctx.font = fuente(pt, { negrita: s.negrita }); ctx.fillText(s.w, px(x), px(y)); x += s.ancho / MM; }
  }
  function texto(ctx, t, x, y, pt, { negrita = false, serif = false, color = TINTA, alinear = "left", espaciado = 0 } = {}) {
    ctx.font = fuente(pt, { negrita, serif });
    ctx.fillStyle = color;
    ctx.textAlign = alinear;
    if (espaciado && "letterSpacing" in ctx) ctx.letterSpacing = px(espaciado * PT) + "px";
    ctx.fillText(t, px(x), px(y));
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    ctx.textAlign = "left";
  }
  const ancho = (ctx, t, pt, op = {}) => { ctx.font = fuente(pt, op); return ctx.measureText(t).width / MM; };
  function linea(ctx, x1, y1, x2, y2, color, grosorPt, puntos = false) {
    ctx.strokeStyle = color; ctx.lineWidth = px(grosorPt * PT);
    ctx.setLineDash(puntos ? [px(0.4), px(0.6)] : []);
    ctx.beginPath(); ctx.moveTo(px(x1), px(y1)); ctx.lineTo(px(x2), px(y2)); ctx.stroke();
    ctx.setLineDash([]);
  }
  function rect(ctx, x, y, w, h, color, grosorPt) { ctx.strokeStyle = color; ctx.lineWidth = px(grosorPt * PT); ctx.strokeRect(px(x), px(y), px(w), px(h)); }
  function rombo(ctx, cx, cy, lado, color) {
    ctx.save(); ctx.translate(px(cx), px(cy)); ctx.rotate(Math.PI / 4); ctx.fillStyle = color;
    ctx.fillRect(-px(lado) / 2, -px(lado) / 2, px(lado), px(lado)); ctx.restore();
  }
  // Imagen dentro de una caja (sin deformar); devuelve el tamaño usado
  function encajar(ctx, img, x, y, maxW, maxH, alinear = "left", vertical = "top") {
    const e = Math.min(maxW / img.width, maxH / img.height), w = img.width * e, h = img.height * e;
    const dx = alinear === "right" ? x + maxW - w : alinear === "center" ? x + (maxW - w) / 2 : x;
    const dy = vertical === "bottom" ? y + maxH - h : vertical === "middle" ? y + (maxH - h) / 2 : y;
    ctx.drawImage(img, px(dx), px(dy), px(w), px(h));
    return { w, h };
  }

  function nuevaHoja() {
    const c = document.createElement("canvas");
    c.width = px(ANCHO); c.height = px(ALTO);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.textBaseline = "alphabetic";
    return { c, ctx };
  }

  // Encabezado + datos del paciente; devuelve dónde empieza el cuerpo y dónde termina el área útil
  function personal(ctx, x) {
    const { acento, segundo } = x.colores, mT = 19 * u, mL = 18 * u, mB = 27 * u, W = ANCHO - 2 * mL;
    // Marco doble con rombos dorados en las esquinas
    rect(ctx, mL - 12 * u, mT - 13 * u, W + 24 * u, ALTO - mT - mB + 32 * u, acento, 1.6);
    rect(ctx, mL - 10.4 * u, mT - 11.4 * u, W + 20.8 * u, ALTO - mT - mB + 28.8 * u, segundo, 0.5);
    for (const [cx, cy] of [[mL - 12 * u, mT - 13 * u], [ANCHO - mL + 12 * u, mT - 13 * u], [mL - 12 * u, ALTO - mB + 19 * u], [ANCHO - mL + 12 * u, ALTO - mB + 19 * u]]) rombo(ctx, cx, cy, 2.6 * u, segundo);
    // Logo o monograma + nombre, subtítulo y matrículas
    let y = mT, xId = mL;
    const altoCab = 22 * u;
    if (x.logo) xId = mL + encajar(ctx, x.logo, mL, y, 40 * u, altoCab, "left", "middle").w + 6 * u;
    else {
      const r = 10 * u, cx = mL + r + 1 * u, cy = y + altoCab / 2;
      ctx.lineWidth = px(0.6 * PT); ctx.strokeStyle = segundo; ctx.beginPath(); ctx.arc(px(cx), px(cy), px(r + 1 * u), 0, 7); ctx.stroke();
      ctx.lineWidth = px(1.3 * PT); ctx.strokeStyle = acento; ctx.beginPath(); ctx.arc(px(cx), px(cy), px(r), 0, 7); ctx.stroke();
      texto(ctx, x.iniciales, cx, cy + 19 * u * PT * 0.35, 19 * u, { serif: true, color: acento, alinear: "center", espaciado: 1 });
      xId = mL + 2 * r + 2 * u + 6 * u;
    }
    const sub = (x.medico.subtitulo || x.medico.especialidad || "").toUpperCase();
    const lineasId = [[x.nombreMedico, 21 * u, { serif: true, color: acento }], sub && [sub, 8.6 * u + 0.6, { negrita: true, color: segundo, espaciado: 1.1 }],
      x.matriculas && [x.matriculas, 8.6 * u + 0.6, { color: GRIS }]].filter(Boolean);
    const altoId = lineasId.reduce((s, [, pt]) => s + pt * PT * 1.35, 0);
    let yi = y + (altoCab - altoId) / 2;
    for (const [t, pt, op] of lineasId) {
      yi += pt * PT * 1.1;
      let tam = pt;
      while (tam > 6 && ancho(ctx, t, tam, op) > ANCHO - mL - xId) tam -= 0.5;
      texto(ctx, t, xId, yi, tam, op);
      yi += pt * PT * 0.25;
    }
    y += altoCab + 3.5 * u;
    // Divisor dorado con rombo azul
    linea(ctx, mL, y, ANCHO - mL, y, segundo, 0.6);
    rombo(ctx, ANCHO / 2, y, 2.6 * u, acento);
    y += 4.5 * u;
    // Datos del paciente
    y = cajaPaciente(ctx, x, mL, y, W);
    // Pie: dirección, teléfono, mail, web
    const partes = [x.medico.direccion, x.medico.telefono, x.medico.email, x.medico.web].filter(Boolean);
    if (partes.length) {
      const pt = 8 * u + 0.8, sep = "  ◆  ";
      const renglones = [""];
      for (const pte of partes) {
        const prueba = renglones.at(-1) ? renglones.at(-1) + sep + pte : pte;
        if (ancho(ctx, prueba, pt) > W && renglones.at(-1)) renglones.push(pte); else renglones[renglones.length - 1] = prueba;
      }
      let yp = ALTO - mB + 14 * u - (renglones.length - 1) * pt * PT * 1.3;
      for (const r of renglones) {
        // separadores en dorado
        const trozos = r.split(sep), total = ancho(ctx, r, pt);
        let xp = ANCHO / 2 - total / 2;
        trozos.forEach((t, i) => {
          texto(ctx, t, xp, yp, pt, { color: GRIS }); xp += ancho(ctx, t, pt);
          if (i < trozos.length - 1) { const s = "  ◆  "; texto(ctx, s, xp, yp, pt * 0.7, { color: segundo }); xp += ancho(ctx, s, pt); }
        });
        yp += pt * PT * 1.3;
      }
    }
    return { y, xMin: mL, ancho: W, fin: ALTO - mB };
  }

  function cajaPaciente(ctx, x, izq, y, W) {
    const { acento, segundo } = x.colores, pt = base - 1, alto = pt * PT * 1.45, pad = 3 * u;
    const celdas = [];
    if (x.paciente.dni) celdas.push([["DNI: ", false, GRIS], [x.paciente.dni]]);
    if (x.paciente.edad !== null) celdas.push([["Edad: ", false, GRIS], [x.paciente.edad + " años"]]);
    celdas.push([["Obra social: ", false, GRIS], [(x.paciente.os || "Particular") + (x.paciente.afiliado ? " — N° " + x.paciente.afiliado : "")]]);
    celdas.push([["Fecha: ", false, GRIS], [x.fecha]]);
    // Renglones: nombre entero, celdas que entren una al lado de la otra, diagnóstico entero
    const filas = [[[["Paciente: ", false, GRIS], [x.paciente.nombre, true]]]];
    const anchoCelda = (c) => c.reduce((s, [t, n]) => s + ancho(ctx, t, pt, { negrita: n }), 0);
    let fila = [], usado = 0;
    for (const c of celdas) {
      const w = anchoCelda(c) + 6 * u;
      if (fila.length && usado + w > W - 2 * pad - 4 * u) { filas.push(fila); fila = []; usado = 0; }
      fila.push(c); usado += w;
    }
    if (fila.length) filas.push(fila);
    const diag = x.diagnostico ? partir(ctx, [["Diagnóstico: ", false], [x.diagnostico]], pt, W - 2 * pad - 2) : [];
    const h = pad * 2 + (filas.length + diag.length) * alto;
    ctx.fillStyle = acento + "0b"; ctx.fillRect(px(izq), px(y), px(W), px(h));
    linea(ctx, izq, y, izq, y + h, segundo, 1.6);
    let yy = y + pad + pt * PT * 1.05;
    for (const f of filas) {
      let xx = izq + pad + 1;
      for (const c of f) {
        for (const [t, n, color] of c) { texto(ctx, t, xx, yy, pt + (f === filas[0] ? 0.5 : 0), { negrita: n, color: color || TINTA }); xx += ancho(ctx, t, pt + (f === filas[0] ? 0.5 : 0), { negrita: n }); }
        xx += 6 * u;
      }
      yy += alto;
    }
    for (const l of diag) {
      let xx = izq + pad + 1;
      for (const s of l) { texto(ctx, s.w, xx, yy, pt, { color: s.w === "Diagnóstico:" ? GRIS : TINTA }); xx += s.ancho / MM; }
      yy += alto;
    }
    return y + h + 5 * u;
  }

  function institucional(ctx, x) {
    const { acento, segundo } = x.colores, mT = 12 * u, mL = 13 * u, mB = 30 * u, W = ANCHO - 2 * mL;
    // Línea negra fina en el borde: marca dónde termina la hoja cuando se ve como imagen sobre fondo blanco
    rect(ctx, 0.8, 0.8, ANCHO - 1.6, ALTO - 1.6, "#000", 0.6);
    let y = mT;
    const altoCab = 30 * u;
    if (x.logo) encajar(ctx, x.logo, ANCHO - mL - 62 * u, y, 62 * u, altoCab, "right", "middle");
    else texto(ctx, x.institucion.nombre, mL, y + altoCab / 2 + 2, 17 * u, { negrita: true, color: segundo, espaciado: 1 });
    y += altoCab + 4 * u;
    // Campos con línea de puntos
    const pt = base + 0.5, paso = 2.6 * u + pt * PT * 1.5;
    const campo = (etq, valor, desde, hasta, yy) => {
      texto(ctx, etq, desde, yy, pt, { color: "#3a3f44" });
      const x0 = desde + ancho(ctx, etq, pt) + 2 * u;
      linea(ctx, x0, yy + 0.6, hasta, yy + 0.6, "#6b7279", 0.7, true);
      let v = valor || "", tam = pt;
      while (tam > 7 && ancho(ctx, v, tam, { negrita: true }) > hasta - x0 - 1) tam -= 0.5;
      if (ancho(ctx, v, tam, { negrita: true }) > hasta - x0 - 1) {
        while (v.length > 1 && ancho(ctx, v + "…", tam, { negrita: true }) > hasta - x0 - 1) v = v.slice(0, -1);
        v = v.trimEnd() + "…";
      }
      texto(ctx, v, x0 + 1, yy - 0.3, tam, { negrita: true, color: "#111" });
    };
    const casilla = (etq, xx, yy) => { rect(ctx, xx, yy - 3.6 * u, 3.6 * u, 3.6 * u, "#3a3f44", 0.9); texto(ctx, etq, xx + 3.6 * u + 1.5, yy, pt, { color: "#3a3f44" }); };
    const fin = ANCHO - mL, colCheck = fin - 18 * u, mitad = mL + W / 2;
    y += pt * PT;
    campo("Fecha:", x.fecha, mL, mL + 46 * u, y); y += paso;
    campo("Paciente:", x.paciente.nombre, mL, fin, y); y += paso;
    campo("DNI:", x.paciente.dni, mL, mitad - 2 * u, y); campo("Obra Social:", x.paciente.os || "Particular", mitad + 1 * u, fin, y); y += paso;
    campo("N° de Afiliado:", x.paciente.afiliado, mL, colCheck - 3 * u, y); casilla("Vol.", colCheck, y); y += paso;
    campo("Diagnóstico:", x.diagnostico, mL, colCheck - 3 * u, y); casilla("Obl.", colCheck, y);
    y += 3 * u + 1;
    linea(ctx, mL - 6 * u, y, fin + 6 * u, y, segundo, 1.2);
    y += 4 * u + 1;
    // Pie: franja fina dorada, banda azul con el texto y la insignia en un círculo blanco
    const top = ALTO - 2.9 - 20 * u;
    ctx.fillStyle = segundo; ctx.fillRect(0, px(top + 3 * u), px(ANCHO), px(1.6 * u));
    ctx.fillStyle = acento; ctx.fillRect(0, px(top + 6 * u), px(ANCHO), px(ALTO - 2.9 - top - 6 * u));
    if (x.institucion.pie) {
      const lineas = partir(ctx, [[x.institucion.pie]], 10 * u + 0.6, ANCHO - 30 * u - 8 * u);
      const h = lineas.length * (10 * u + 0.6) * PT * 1.25;
      let yy = top + 6 * u + (ALTO - 2.9 - top - 6 * u - h) / 2 + (10 * u + 0.6) * PT;
      for (const l of lineas) { escribir(ctx, l, 30 * u, yy, 10 * u + 0.6, "#fff"); yy += (10 * u + 0.6) * PT * 1.25; }
    }
    if (x.insignia) {
      const r = 19 * u / 2, cx = 12 * u + r, cy = top + r;
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(px(cx), px(cy), px(r), 0, 7); ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.arc(px(cx), px(cy), px(r), 0, 7); ctx.clip();
      encajar(ctx, x.insignia, cx - r, cy - r, 2 * r, 2 * r, "center", "middle");
      ctx.restore();
    }
    return { y, xMin: mL, ancho: W, fin: top - 1 };
  }

  // Firma y sello (o, sin imagen, el nombre con la línea): abajo a la derecha del cuerpo
  const ALTO_FIRMA = 36;
  function firma(ctx, x, area, y) {
    const w = 70 * u, x0 = area.xMin + area.ancho - w;
    if (x.firma) { encajar(ctx, x.firma, x0, y, w, ALTO_FIRMA, "center", "bottom"); return; }
    const yl = y + ALTO_FIRMA - 12;
    linea(ctx, x0, yl, x0 + w, yl, TINTA, 0.5);
    const pt = base - 1.5;
    [[x.nombreMedico, true], [x.medico.especialidad, false], [x.matriculas, false]].filter(([t]) => t).forEach(([t, n], i) =>
      texto(ctx, t, x0 + w / 2, yl + 1 + (i + 1) * pt * PT * 1.3, pt, { negrita: n, alinear: "center" }));
  }

  // ---------- Armar el documento ----------
  async function hojas(tipo, d, perfil) {
    const { medico, institucion } = perfil;
    const inst = esInstitucional(d, institucion);
    const col = (c, def) => (/^#[0-9a-f]{6}$/i.test(c || "") ? c : def);
    const colores = inst ? { acento: col(institucion.color_acento, "#092b50"), segundo: col(institucion.color_secundario, "#519bb4") }
      : { acento: col(medico.color_acento, "#1f3a5f"), segundo: col(medico.color_secundario, "#b08d57") };
    const nombreMedico = [medico.titulo, medico.apellido, medico.nombre].filter(Boolean).join(" ");
    const matriculas = [medico.mp && "M.P. " + medico.mp, medico.me && "M.E. " + medico.me].filter(Boolean).join(" · ");
    const proc = procedimientoTexto(d);
    const img = perfil.imagenes || {};
    const [logo, insignia, firmaImg] = await Promise.all([imagen(inst ? img.logo_institucion : img.logo_personal), imagen(inst ? img.insignia_institucion : null), imagen(img.firma)]);
    const x = {
      colores, medico, institucion, nombreMedico, matriculas, logo, insignia, firma: firmaImg,
      iniciales: (((medico.nombre || "")[0] || "") + ((medico.apellido || "")[0] || "")).toUpperCase(),
      fecha: hoyTexto(),
      diagnostico: d.clinica.diagnostico || Catalogos.descripcionCie10(d.clinica.cie10),
      paciente: { nombre: [d.paciente.nombre, d.paciente.apellido].filter(Boolean).join(" "), dni: dniConPuntos(d.paciente.dni), edad: edad(d.paciente.fecha_nacimiento),
        os: d.cobertura.obra_social, afiliado: d.cobertura.nro_afiliado },
    };
    const hojas = [];
    const empezar = () => { const h = nuevaHoja(); hojas.push(h.c); return { ctx: h.ctx, area: (inst ? institucional : personal)(h.ctx, x) }; };
    let { ctx, area } = empezar();
    let y = area.y;
    const lh = (pt) => pt * PT * 1.38;
    for (const b of bloques(tipo, d, proc)) {
      let alto, dibujar;
      if (b.rp) { alto = lh(base + 8); dibujar = () => texto(ctx, "Rp/", area.xMin, y + (base + 8) * PT, base + 8, { negrita: true, color: "#3a3f44" }); }
      else if (b.h3) {
        alto = lh(base) + 3.8 * u;
        dibujar = () => texto(ctx, b.h3.toUpperCase(), area.xMin, y + 3 * u + base * PT, base, { negrita: true, color: x.colores.acento, espaciado: 0.7 });
      } else {
        const pt = b.aviso ? base - 2 : base, sangria = b.li !== undefined ? 5 : 0, color = b.aviso ? "#8a1c1c" : TINTA;
        const partes = b.li !== undefined ? [[b.li], ...(b.codigo ? [[` (${b.codigo})`]] : [])] : b.aviso ? [[b.aviso]] : b.p;
        const ls = partir(ctx, partes, pt, area.ancho - sangria);
        // Un ítem corto no se parte entre dos hojas; un párrafo largo sigue en la hoja siguiente
        if (ls.length <= 3 && y + (b.aviso ? 3 : 0) + ls.length * lh(pt) > area.fin) ({ ctx, area } = empezar(), y = area.y);
        y += b.aviso ? 3 : 0;
        ls.forEach((l, i) => {
          if (y + lh(pt) > area.fin) ({ ctx, area } = empezar(), y = area.y);
          if (i === 0 && b.li !== undefined) texto(ctx, "•", area.xMin + 1.5, y + pt * PT, pt);
          escribir(ctx, l, area.xMin + sangria, y + pt * PT, pt, color);
          y += lh(pt);
        });
        y += b.li !== undefined ? 0.5 : 1.5;
        continue;
      }
      if (y + alto > area.fin) ({ ctx, area } = empezar(), y = area.y);
      dibujar();
      y += alto;
    }
    if (y + 3 + ALTO_FIRMA > area.fin) ({ ctx, area } = empezar(), y = area.y);
    firma(ctx, x, area, y + 3);
    return hojas;
  }

  // PAMI va siempre en el recetario de la institución (si está cargada); el resto, el que elija el médico
  function esInstitucional(d, institucion) {
    if (!institucion?.nombre) return false;
    return Catalogos.obraSocialCanonica(d.cobertura.obra_social) === "PAMI" || d.membrete === "institucional";
  }
  function procedimientoTexto(d) {
    const k = d.clinica;
    return k.procedimiento + (k.lateralidad && !k.procedimiento.toLowerCase().includes(k.lateralidad.toLowerCase()) ? " " + k.lateralidad.toLowerCase() : "");
  }

  const aBlob = (c, tipo, calidad) => new Promise((ok) => c.toBlob(ok, tipo, calidad));
  async function pdf(lienzos) {
    const imgs = [];
    for (const c of lienzos) imgs.push({ ancho: c.width, alto: c.height, datos: new Uint8Array(await (await aBlob(c, "image/jpeg", 0.92)).arrayBuffer()) });
    return pdfDeImagenes(imgs);
  }
  // Todas las hojas una debajo de la otra (para WhatsApp)
  async function png(lienzos) {
    if (lienzos.length === 1) return aBlob(lienzos[0], "image/png");
    const c = document.createElement("canvas");
    c.width = lienzos[0].width; c.height = lienzos.reduce((s, l) => s + l.height, 0);
    let y = 0;
    for (const l of lienzos) { c.getContext("2d").drawImage(l, 0, y); y += l.height; }
    return aBlob(c, "image/png");
  }

  // PDF con una imagen JPEG por hoja A5 (419,5 × 595,3 pt). (Igual que en la app Liquidaciones.)
  function pdfDeImagenes(imagenes) {
    const enc = new TextEncoder(), partes = [], desde = [];
    let largo = 0;
    const poner = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; partes.push(b); largo += b.length; };
    const objeto = (n, ...cuerpo) => { desde[n] = largo; poner(`${n} 0 obj\n`); cuerpo.forEach(poner); poner("\nendobj\n"); };
    const total = 2 + 3 * imagenes.length;
    poner("%PDF-1.4\n");
    objeto(1, "<< /Type /Catalog /Pages 2 0 R >>");
    objeto(2, `<< /Type /Pages /Count ${imagenes.length} /Kids [${imagenes.map((_, i) => `${3 + 3 * i} 0 R`).join(" ")}] >>`);
    imagenes.forEach((im, i) => {
      const pag = 3 + 3 * i, ancho = 419.53, alto = +(ancho * im.alto / im.ancho).toFixed(2), dibujo = `q ${ancho} 0 0 ${alto} 0 0 cm /Im0 Do Q`;
      objeto(pag, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ancho} ${alto}] /Resources << /XObject << /Im0 ${pag + 2} 0 R >> >> /Contents ${pag + 1} 0 R >>`);
      objeto(pag + 1, `<< /Length ${dibujo.length} >>\nstream\n${dibujo}\nendstream`);
      objeto(pag + 2, `<< /Type /XObject /Subtype /Image /Width ${im.ancho} /Height ${im.alto} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.datos.length} >>\nstream\n`,
        im.datos, "\nendstream");
    });
    const xref = largo;
    poner(`xref\n0 ${total + 1}\n0000000000 65535 f \n` + desde.slice(1).map((d) => String(d).padStart(10, "0") + " 00000 n \n").join(""));
    poner(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(partes, { type: "application/pdf" });
  }

  return { hojas, pdf, png, esInstitucional, procedimientoTexto, TITULOS };
})();
