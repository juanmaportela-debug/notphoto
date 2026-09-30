// Fotos: procesar lo que se sube y guardarlo en disco. Las rutas y las reglas (una por día, moderación,
// quién ve qué) están en app.js, en la sección "Fotos".
//
// Nada de lo que sube la gente se sirve tal cual: se decodifica y se vuelve a codificar con sharp.
// Eso descarta los metadatos (EXIF, con la ubicación GPS de donde se sacó la foto, el modelo del
// teléfono, la fecha), lo que haya pegado después de la imagen y cualquier archivo que se haga pasar
// por imagen. Sin este paso, el pseudoanonimato no sirve de nada.

import sharp from 'sharp';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS } from './config.js';

// Error con un mensaje que se le puede mostrar a quien sube la foto.
export class FotoInvalida extends Error {}

// Lo que se acepta de entrada (el formato real, no la extensión). 'heif' incluye AVIF; las HEIC del
// iPhone no se pueden leer, pero Safari las convierte a JPEG al subirlas desde el navegador.
const FORMATOS = new Set(['jpeg', 'png', 'webp', 'heif', 'gif']);

// Devuelve la foto grande (WebP, lado mayor ≤ fotoLado), la miniatura cuadrada (WebP) y una copia
// JPEG chica para el filtro. Las tres sin metadatos: sharp no los copia salvo que se le pida.
export async function procesarFoto(buf) {
  const opciones = { limitInputPixels: LIMITS.fotoMaxPixeles, failOn: 'error' };
  let meta;
  try {
    meta = await sharp(buf, opciones).metadata();
  } catch {
    throw new FotoInvalida('No se pudo leer la imagen. Probá con un JPG, PNG o WebP.');
  }
  if (!FORMATOS.has(meta.format)) throw new FotoInvalida('Ese formato no se acepta. Probá con un JPG, PNG o WebP.');
  if (Math.min(meta.width, meta.height) < LIMITS.fotoMinLado) {
    throw new FotoInvalida(`La foto tiene que medir al menos ${LIMITS.fotoMinLado} píxeles de cada lado.`);
  }
  // rotate() sin argumentos endereza según la orientación EXIF antes de que esa información se pierda.
  // De un GIF o WebP animado queda solo el primer cuadro (sharp lee una página por defecto).
  const base = () => sharp(buf, opciones).rotate();
  const L = LIMITS.fotoLado;
  const M = LIMITS.fotoMiniatura;
  const F = LIMITS.fotoLadoFiltro;
  try {
    const [grande, mini, filtro] = await Promise.all([
      base().resize({ width: L, height: L, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true }),
      base().resize({ width: M, height: M, fit: 'cover', position: 'attention' }).webp({ quality: 72 }).toBuffer(),
      base().resize({ width: F, height: F, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer(),
    ]);
    return { grande: grande.data, ancho: grande.info.width, alto: grande.info.height, mini, filtro };
  } catch {
    throw new FotoInvalida('No se pudo procesar la imagen. Probá con otra.');
  }
}

// Nombre público de una foto: 16 bytes al azar (22 caracteres). No lleva nada de la cuenta ni del día.
export const nombreNuevo = () => crypto.randomBytes(16).toString('base64url');
// /f/<nombre>.webp es la grande; /f/<nombre>-m.webp, la miniatura.
export const NOMBRE_ARCHIVO = /^([A-Za-z0-9_-]{22})(-m)?\.webp$/;
export const urlFoto = (archivo, mini = false) => `/f/${archivo}${mini ? '-m' : ''}.webp`;

export function crearAlmacen(carpeta) {
  const dir = path.resolve(carpeta);
  fs.mkdirSync(dir, { recursive: true });
  const ruta = (archivo, mini = false) => path.join(dir, `${archivo}${mini ? '-m' : ''}.webp`);
  return {
    dir,
    ruta,
    // 'wx': nunca pisa un archivo que ya existe.
    guardar(archivo, { grande, mini }) {
      fs.writeFileSync(ruta(archivo), grande, { flag: 'wx' });
      fs.writeFileSync(ruta(archivo, true), mini, { flag: 'wx' });
    },
    borrar(archivo) {
      if (!archivo) return;
      for (const mini of [false, true]) {
        try {
          fs.rmSync(ruta(archivo, mini), { force: true });
        } catch (err) {
          console.error('[fotos] No se pudo borrar', archivo, err.message);
        }
      }
    },
  };
}

// Días como 'AAAA-MM-DD' (la zona la pone app.js). Se calcula al mediodía UTC para no tropezar con
// cambios de hora.
export const diaValido = (s) =>
  typeof s === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) &&
  new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
export const moverDia = (dia, n) => new Date(Date.parse(`${dia}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
