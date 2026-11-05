# Cine Web

Lista personal de **películas y series** (España). HTML/CSS/JS sin build. Datos en `localStorage`.

## Cómo usarla

```bash
cd cine-web
python3 -m http.server 8080
```

Abre `http://localhost:8080`.

- **+ Añadir** / **Editar** / **Borrar**, ficha detalle, **→ Vista** / **→ Pendiente**, ★ favorita en la tarjeta.
- Filtros: estado, tipo, plataforma, género, **Solo favoritas**, búsqueda y orden.
- **Exportar / Importar JSON** (`{ fichas, lista }`). Si un import trae estado `viendo`, se guarda como `pendiente`.
- **Restablecer seed** vuelve a cargar el catálogo de `data/seed.json` (con fallback `seed.js` si abres por `file://`).

### Plataformas (ES)

En filtro y formulario, en este orden: Netflix, Max, Apple TV+, Prime Video, Disney+, Movistar Plus+, Filmin, SkyShowtime y **Otra** (texto libre).

En la tarjeta solo aparecen plataformas de **suscripción**. Alquiler/compra (Amazon Video, Apple TV Store, Rakuten TV, etc.) se ven agrupados en la ficha. El filtro **Max** incluye también «Max Amazon Channel»; variantes de Movistar se normalizan a **Movistar Plus+**. Amazon Video ≠ Prime Video; Apple TV Store ≠ Apple TV+.

### Modelo

- **fichas**: catálogo (título, sinopsis, `streaming_es`, póster, `titulo_original`, …).
- **lista**: `estado` (`pendiente`|`vista`), `favorita`, `puntuacion` (1–10), `notas`, `anadido_en`, `visto_en`, `plataformas[]` (snapshot suscripción), `temporada?`.

La capa `Storage` en `app.js` aísla la persistencia para poder cambiar a un backend después.

## Despliegue

Hosting estático: GitHub Pages, Netlify, Cloudflare Pages, Vercel o `npx surge ./cine-web`. Sin build. Cada visitante tiene su propio `localStorage`; comparte la lista con export/import JSON.
