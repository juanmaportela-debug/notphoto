import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { crearModeradorFoto } from '../src/moderation.js';
import { procesarFoto, diaValido, moverDia } from '../src/fotos.js';

// Una foto de prueba con metadatos que no tienen que llegar al sitio (autor en EXIF).
const fotoDePrueba = (color = '#3366cc', ancho = 800, alto = 600) =>
  sharp({ create: { width: ancho, height: alto, channels: 3, background: color } })
    .jpeg()
    .withExif({ IFD0: { Artist: 'Juan Perez', Copyright: 'privado' } })
    .toBuffer();

async function montar() {
  const db = openDb(':memory:');
  const reloj = { t: Date.parse('2026-09-29T15:00:00-03:00') };
  const filtro = { decision: 'approve', grave: 'ninguna' };
  const recibidas = [];
  const moderarFoto = async (datos) => {
    recibidas.push(datos);
    if (filtro.esperar) await filtro.esperar;
    return {
      decision: filtro.decision,
      rule: filtro.decision === 'reject' ? 'sexual' : 'ninguna',
      reason: filtro.decision === 'reject' ? 'Desnudez.' : '',
      grave: filtro.grave,
      model: 'falso',
    };
  };
  const fotosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fotos-test-'));
  const app = createApp({
    db,
    moderar: async () => ({ decision: 'approve', rule: 'ninguna', reason: '', model: 'falso' }),
    moderarFoto,
    fotosDir,
    loginDePrueba: true,
    secret: 'secreto-de-prueba',
    baseUrl: 'http://prueba',
    siteName: 'prueba',
    now: () => reloj.t,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const pedir = (ruta, { sesion, datos, cuerpo } = {}) =>
    fetch(base + ruta, {
      method: datos || cuerpo ? 'POST' : 'GET',
      headers: sesion ? { cookie: sesion.cookie } : {},
      body: cuerpo ?? (datos ? new URLSearchParams({ ...(sesion ? { _csrf: sesion.csrf } : {}), ...datos }) : undefined),
      redirect: 'manual',
    });

  async function entrar(nombre, { admin = false } = {}) {
    const r = await pedir('/entrar/prueba', { datos: { nombre, ...(admin ? { admin: '1' } : {}) } });
    assert.equal(r.status, 303);
    const cookie = r.headers.getSetCookie().find((c) => c.startsWith('sid=')).split(';')[0];
    const home = await (await fetch(base + '/', { headers: { cookie } })).text();
    return { cookie, csrf: home.match(/name="_csrf" value="([^"]+)"/)[1] };
  }

  async function subir(sesion, imagen, { asunto = '', cuerpo = '', csrf = sesion.csrf, tipo = 'image/jpeg' } = {}) {
    const form = new FormData();
    form.set('_csrf', csrf);
    form.set('asunto', asunto);
    form.set('cuerpo', cuerpo);
    if (imagen) form.set('foto', new Blob([imagen], { type: tipo }), 'foto.jpg');
    return pedir('/fotos', { sesion, cuerpo: form });
  }

  const archivos = () => fs.readdirSync(fotosDir).sort();
  return { db, reloj, filtro, recibidas, pedir, entrar, subir, archivos, cerrar: () => server.close() };
}

const urlDeFoto = (html) => html.match(/<img src="(\/f\/[A-Za-z0-9_-]{22}\.webp)"/)?.[1];

test('sube la foto del día: se re-codifica sin metadatos, se publica y aparece en /fotos', async (t) => {
  const s = await montar();
  t.after(s.cerrar);
  const ana = await s.entrar('ana');

  const r = await s.subir(ana, await fotoDePrueba(), { asunto: 'Atardecer', cuerpo: 'Desde el balcón.' });
  assert.equal(r.status, 303);
  const destino = r.headers.get('location');
  assert.match(destino, /^\/h\/\d+$/);

  // Al disco van la grande y la miniatura, con nombre al azar.
  const guardados = s.archivos();
  assert.equal(guardados.length, 2);
  assert.ok(guardados.every((f) => /^[A-Za-z0-9_-]{22}(-m)?\.webp$/.test(f)));

  // La publicación muestra la foto; la imagen se sirve a cualquiera y sin EXIF.
  const hilo = await (await s.pedir(destino)).text();
  assert.match(hilo, /Atardecer/);
  assert.match(hilo, /Desde el balcón\./);
  const url = urlDeFoto(hilo);
  assert.ok(url, 'la publicación tiene la foto');
  const img = await s.pedir(url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/webp');
  const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.exif, undefined, 'no quedan datos EXIF');
  assert.equal(meta.width, 800);

  // Al filtro le llega una copia JPEG sin metadatos, con el título y el texto.
  assert.equal(s.recibidas.length, 1);
  assert.equal(s.recibidas[0].asunto, 'Atardecer');
  const alFiltro = await sharp(s.recibidas[0].imagen).metadata();
  assert.equal(alFiltro.format, 'jpeg');
  assert.equal(alFiltro.exif, undefined);

  // En la galería del día y en la portada (con miniatura).
  const galeria = await (await s.pedir('/fotos')).text();
  assert.match(galeria, /class="galeria-foto" href="\/h\/\d+"/);
  assert.match(galeria, /1 foto/);
  assert.match(await (await s.pedir('/')).text(), /class="ficha-foto"/);
  // El tablón de fotos no tiene página de texto: /b/fotos lleva a /fotos.
  assert.equal((await s.pedir('/b/fotos')).headers.get('location'), '/fotos');
});

test('una foto por día: la segunda vuelve a la primera; al día siguiente se puede otra', async (t) => {
  const s = await montar();
  t.after(s.cerrar);
  const ana = await s.entrar('ana');
  const primera = (await s.subir(ana, await fotoDePrueba())).headers.get('location');

  const otra = await s.subir(ana, await fotoDePrueba('#ff0000'));
  assert.equal(otra.status, 303);
  assert.equal(otra.headers.get('location'), `${primera}?aviso=foto-hoy`);
  assert.equal(s.recibidas.length, 1, 'la segunda ni se manda al filtro');
  assert.equal(s.archivos().length, 2);

  // El formulario ya no aparece.
  const pagina = await (await s.pedir('/fotos', { sesion: ana })).text();
  assert.doesNotMatch(pagina, /action="\/fotos"/);
  assert.match(pagina, /Ya subiste tu foto de hoy/);

  // Medianoche en Buenos Aires: otro día.
  s.reloj.t = Date.parse('2026-09-30T00:05:00-03:00');
  const manana = await s.subir(ana, await fotoDePrueba('#00ff00'));
  assert.equal(manana.status, 303);
  assert.notEqual(manana.headers.get('location'), primera);
  // La de ayer sigue en su día.
  assert.match(await (await s.pedir('/fotos?dia=2026-09-29')).text(), /1 foto/);
});

test('dos fotos distintas enviadas a la vez: entra una sola', async (t) => {
  const s = await montar();
  t.after(s.cerrar);
  const ana = await s.entrar('ana');
  let soltar;
  s.filtro.esperar = new Promise((r) => (soltar = r));
  const a = s.subir(ana, await fotoDePrueba('#111111'));
  const b = s.subir(ana, await fotoDePrueba('#222222'));
  setTimeout(soltar, 50);
  const estados = (await Promise.all([a, b])).map((r) => r.status).sort();
  assert.equal(estados[0], 303);
  assert.notEqual(estados[1], 303);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM fotos').get().n, 1);
  assert.equal(s.archivos().length, 2);
});

test('una foto rechazada no se guarda y también ocupa el día', async (t) => {
  const s = await montar();
  t.after(s.cerrar);
  const ana = await s.entrar('ana');
  s.filtro.decision = 'reject';
  const r = await s.subir(ana, await fotoDePrueba(), { cuerpo: 'hola' });
  assert.equal(r.status, 422);
  assert.match(await r.text(), /no cumple las normas/);
  assert.deepEqual(s.archivos(), []);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM rechazos WHERE board = 'fotos' AND body = '[foto] hola'").get().n, 1);

  s.filtro.decision = 'approve';
  const otra = await s.subir(ana, await fotoDePrueba('#ff0000'));
  assert.equal(otra.status, 409);
  assert.match(await otra.text(), /no pasó el filtro/);
});

test('caso grave: se rechaza y la cuenta queda suspendida en el acto', async (t) => {
  const s = await montar();
  t.after(s.cerrar);
  const ana = await s.entrar('ana');
  s.filtro.decision = 'reject';
  s.filtro.grave = 'menores';
  assert.equal((await s.subir(ana, await fotoDePrueba())).status, 422);
  const u = s.db.prepare("SELECT banned_until, ban_reason FROM users WHERE identidad = 'prueba:ana'").get();
  assert.ok(u.banned_until > s.reloj.t + 365 * 86_400_000);
  assert.equal(u.ban_reason, 'Automática: menores');
  assert.deepEqual(s.archivos(), []);
});

test('en revisión: la ven solo su autor y los mods; aprobada, todos', async (t) => {
  const s = await montar();
  t.after(s.cerrar);
  const ana = await s.entrar('ana');
  const beto = await s.entrar('beto');
  const mod = await s.entrar('mod', { admin: true });
  s.filtro.decision = 'queue';
  const r = await s.subir(ana, await fotoDePrueba());
  assert.match(r.headers.get('location'), /\?aviso=foto-cola$/);
  const url = urlDeFoto(await (await s.pedir(r.headers.get('location'), { sesion: ana })).text());
  assert.ok(url);

  assert.equal((await s.pedir(url)).status, 404);
  assert.equal((await s.pedir(url, { sesion: beto })).status, 404);
  assert.equal((await s.pedir(url, { sesion: ana })).status, 200);
  assert.equal((await s.pedir(url, { sesion: mod })).status, 200);
  assert.doesNotMatch(await (await s.pedir('/fotos')).text(), /galeria-foto/);

  // /mod muestra la foto para decidir.
  const panel = await (await s.pedir('/mod', { sesion: mod })).text();
  assert.ok(panel.includes(url));
  const postId = s.db.prepare('SELECT post_id FROM fotos').get().post_id;
  assert.equal((await s.pedir(`/mod/p/${postId}/aprobar`, { sesion: mod, datos: {} })).status, 303);
  assert.equal((await s.pedir(url)).status, 200);
  assert.match(await (await s.pedir('/fotos')).text(), /galeria-foto/);
});

test('si un mod la elimina o su autor la borra, el archivo se va del servidor', async (t) => {
  const s = await montar();
  t.after(s.cerrar);
  const ana = await s.entrar('ana');
  const beto = await s.entrar('beto');
  const mod = await s.entrar('mod', { admin: true });

  const hiloAna = (await s.subir(ana, await fotoDePrueba())).headers.get('location');
  const urlAna = urlDeFoto(await (await s.pedir(hiloAna)).text());
  const postAna = s.db.prepare('SELECT op_post_id FROM threads WHERE id = ?').get(Number(hiloAna.split('/').pop())).op_post_id;
  assert.equal((await s.pedir(`/mod/p/${postAna}/eliminar`, { sesion: mod, datos: {} })).status, 303);
  assert.equal((await s.pedir(urlAna, { sesion: mod })).status, 404);

  const hiloBeto = (await s.subir(beto, await fotoDePrueba('#ff0000'))).headers.get('location');
  const postBeto = s.db.prepare('SELECT op_post_id FROM threads WHERE id = ?').get(Number(hiloBeto.split('/').pop())).op_post_id;
  assert.equal((await s.pedir(`/p/${postBeto}/borrar`, { sesion: beto, datos: {} })).status, 303);
  assert.deepEqual(s.archivos(), []);
  // Borrada o no, la foto de hoy ya se usó.
  assert.equal((await s.subir(beto, await fotoDePrueba())).status, 303);
  assert.deepEqual(s.archivos(), []);
});

test('borrar la cuenta borra sus fotos', async (t) => {
  const s = await montar();
  t.after(s.cerrar);
  const ana = await s.entrar('ana');
  await s.subir(ana, await fotoDePrueba());
  assert.equal(s.archivos().length, 2);
  assert.equal((await s.pedir('/cuenta/borrar', { sesion: ana, datos: { confirmar: '1' } })).status, 303);
  assert.deepEqual(s.archivos(), []);
});

test('lo que no es una imagen, o es muy chica, no se acepta y no gasta el día', async (t) => {
  const s = await montar();
  t.after(s.cerrar);
  const ana = await s.entrar('ana');
  const trucho = await s.subir(ana, Buffer.from('<?php echo "hola"; ?>'));
  assert.equal(trucho.status, 422);
  assert.match(await trucho.text(), /No se pudo leer la imagen/);
  const chica = await s.subir(ana, await fotoDePrueba('#000', 50, 50));
  assert.equal(chica.status, 422);
  assert.equal((await s.subir(ana, null)).status, 422);
  assert.equal(s.recibidas.length, 0);
  assert.equal((await s.subir(ana, await fotoDePrueba())).status, 303);
});

test('sin sesión o sin token no se sube; en Fotos no se publica texto', async (t) => {
  const s = await montar();
  t.after(s.cerrar);
  const form = new FormData();
  form.set('foto', new Blob([await fotoDePrueba()], { type: 'image/jpeg' }), 'x.jpg');
  const anonimo = await s.pedir('/fotos', { cuerpo: form });
  assert.equal(anonimo.status, 303);
  assert.equal(anonimo.headers.get('location'), '/entrar');

  const ana = await s.entrar('ana');
  assert.equal((await s.subir(ana, await fotoDePrueba(), { csrf: 'otro' })).status, 403);
  const texto = await s.pedir('/b/fotos/hilo', { sesion: ana, datos: { asunto: 'Hola', cuerpo: 'texto' } });
  assert.equal(texto.status, 422);
  assert.match(await texto.text(), /se publica subiendo una foto/);
  assert.doesNotMatch(await (await s.pedir('/', { sesion: ana })).text(), /<option value="fotos"/);
});

test('procesarFoto endereza según EXIF, achica y no agranda', async () => {
  const vertical = await sharp({ create: { width: 600, height: 300, channels: 3, background: '#abc' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const r = await procesarFoto(vertical);
  assert.equal(r.ancho, 300);
  assert.equal(r.alto, 600);
  const enorme = await procesarFoto(await fotoDePrueba('#123456', 4000, 3000));
  assert.equal(enorme.ancho, 1600);
  assert.equal(enorme.alto, 1200);
  assert.equal((await sharp(enorme.mini).metadata()).width, 480);
});

test('días', () => {
  assert.ok(diaValido('2026-09-29'));
  assert.ok(!diaValido('2026-02-30'));
  assert.ok(!diaValido('ayer'));
  assert.equal(moverDia('2026-03-01', -1), '2026-02-28');
  assert.equal(moverDia('2026-12-31', 1), '2027-01-01');
});

test('crearModeradorFoto: manda la imagen y, si la API falla, va a revisión', async () => {
  let pedido;
  const client = {
    messages: {
      parse: async (p) => {
        pedido = p;
        return { model: 'm', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, parsed_output: { decision: 'reject', rule: 'sexual', reason: 'x', grave: 'menores' } };
      },
    },
  };
  const v = await crearModeradorFoto({ siteName: 'prueba', client })({ imagen: Buffer.from('jpeg'), asunto: '<hola>', cuerpo: '' });
  assert.equal(v.decision, 'reject');
  assert.equal(v.grave, 'menores');
  const [imagen, texto] = pedido.messages[0].content;
  assert.equal(imagen.type, 'image');
  assert.equal(imagen.source.media_type, 'image/jpeg');
  assert.equal(imagen.source.data, Buffer.from('jpeg').toString('base64'));
  assert.match(texto.text, /<asunto>‹hola>/);

  const roto = { messages: { parse: async () => { throw new Error('sin red'); } } };
  const e = await crearModeradorFoto({ siteName: 'prueba', client: roto })({ imagen: Buffer.from('x') });
  assert.equal(e.decision, 'queue');
});
