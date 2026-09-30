export const BOARDS = [
  { slug: 'tecnologia', nombre: 'Tecnología', descripcion: 'Software, hardware, internet y ciencia.' },
  { slug: 'cultura', nombre: 'Cultura', descripcion: 'Libros, cine, arte, historia e ideas.' },
  { slug: 'musica', nombre: 'Música', descripcion: 'Discos, bandas, recitales, escenas y lo que estás escuchando.' },
  { slug: 'juegos', nombre: 'Juegos', descripcion: 'Videojuegos, juegos de mesa, rol y cartas.' },
  { slug: 'vida-real', nombre: 'Vida real', descripcion: 'Todo lo que NO sucede a través de una pantalla.' },
  // Sección de fotos: cada publicación abre con una foto y las respuestas son de texto. No se publica
  // desde el formulario de texto sino desde /fotos, que es también su página (ver src/fotos.js).
  { slug: 'fotos', nombre: 'Fotos', descripcion: 'Una foto por día por persona. Se comenta con texto.', fotos: true },
];

// Tablones donde se publica con el formulario de texto (todos menos el de fotos).
export const BOARDS_TEXTO = BOARDS.filter((b) => !b.fotos);
// Dirección de la página de un tablón: el de fotos tiene la suya.
export const rutaTablon = (b) => (b.fotos ? '/fotos' : `/b/${b.slug}`);

export const boardBySlug = (slug) => BOARDS.find((b) => b.slug === slug);

export const LIMITS = {
  asunto: 120,
  cuerpo: 8000,
  hilosPorPagina: 10,
  // El catálogo (vista por defecto) muestra fichas chicas: entran muchas más por página.
  hilosPorPaginaCatalogo: 60,
  // Últimas respuestas que se muestran debajo de cada hilo en la portada y en los tablones.
  respuestasEnResumen: 3,
  // Pasado este número, los hilos menos activos de un tablón van al archivo.
  hilosActivosPorTablon: 150,
  // Después de estas respuestas el hilo deja de subir.
  limiteBump: 300,
  // Y después de estas se cierra.
  limiteRespuestas: 500,
  segEntrePosts: 30,
  segEntreHilos: 600,
  rechazosPorHora: 10,
  // Reportes de personas distintas que sacan un post de la vista hasta que lo revise un mod.
  reportesParaOcultar: 3,
  // Fotos (src/fotos.js). Lo que se sube se re-codifica: estos son los tamaños de salida.
  fotoMaxBytes: 12 * 1024 * 1024,
  fotoMaxPixeles: 50_000_000,
  fotoMinLado: 200,
  fotoLado: 1600,
  fotoMiniatura: 480,
  // Lado de la copia que va al filtro de Claude (más chica = menos tokens).
  fotoLadoFiltro: 1024,
  fotoAsunto: 120,
  fotoTexto: 1000,
  fotosPorPagina: 60,
};
