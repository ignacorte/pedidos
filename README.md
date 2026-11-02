# Pedidos — versión celular y computadora

Pedidos de estudios, materiales, autorización, resumen de HC y receta en el recetario del médico (personal o de la institución),
listos para compartir por WhatsApp. Sin servidor: se publica en GitHub Pages (https://ignacorte.github.io/pedidos/).

- **Datos:** en el dispositivo (IndexedDB, cifrado con el PIN) y en el Google Drive de cada profesional, carpeta «Pedidos»
  (`pedidos-datos.json`, respaldo diario en «Respaldos», PDF de cada pedido en «Pacientes/<año>/<paciente>»). Misma base que Liquidaciones (`almacen.js`).
- **Lectura de fotos:** `lector.js` + `vendor/` (PaddleOCR y pdf.js, copiados de Liquidaciones) dentro del dispositivo; las reglas de `catalogos.js`
  arman paciente, cobertura, diagnóstico (CIE-10), procedimiento, estudios con código PAMI, kit y documentos sugeridos.
- **Recetario:** `recetario.js` lo dibuja en un lienzo (mismo diseño que la versión PC) → PNG y PDF A5.
- **Google:** usa el cliente OAuth de Liquidaciones (`config.js`); en Google Cloud tiene que estar `https://ignacorte.github.io/pedidos/` como URI de redireccionamiento.
- **Configuración de la PC:** `../scripts/exportar_para_celular.py` → Configuración › Mi cuenta › «Importar configuración de la PC».
- **Versión:** `VERSION_APP` en `app.js` y `VERSION` en `sw.js` siempre iguales.
- **Pruebas:** `../tests/test_movil.py` (Chrome + playwright, datos ficticios).

Nunca subir acá datos de pacientes, la firma ni los logos: cada profesional los carga en su app y quedan en su Drive.
