const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

// --- Helper Functions ---
function decodeConfig(configStr) {
    try {
        // Handle URL-safe base64 conversion
        let base64 = configStr.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) { base64 += '='; }
        const decoded = Buffer.from(base64, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch (e) {
        return null;
    }
}

function getUpstreamBase(manifestUrl) {
    return manifestUrl.replace('/manifest.json', '');
}

// --- Frontend Route ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Manifest Proxy ---
app.get('/:config/manifest.json', async (req, res) => {
    const config = decodeConfig(req.params.config);
    if (!config || !config.u || !config.p || !config.b || !config.l || !config.t) {
        return res.status(400).json({ error: "Invalid configuration - missing required URLs" });
    }

    try {
        const response = await fetch(config.u, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error("Failed to fetch upstream manifest");
        
        const manifest = await response.json();
        
        // Modify manifest to safely differentiate it inside Nuvio
        manifest.id = (manifest.id || "stremboxd") + ".btttr-wrapper";
        manifest.name = (manifest.name || "Stremboxd") + " (Enhanced with ExtendedRatings)";
        manifest.description = "Proxied with live dynamic updates and ExtendedRatings images. " + (manifest.description || "");
        
        // Caching manifest structure is safe (does not affect catalog updates)
        res.setHeader('Cache-Control', 'max-age=86400, stale-while-revalidate=86400'); 
        res.json(manifest);
    } catch (e) {
        console.error("Manifest error:", e);
        res.status(500).json({ error: "Manifest proxy failed" });
    }
});

// --- Catalog Proxy (Wildcard to strictly preserve Stremio path rules & parameters) ---
app.get('/:config/catalog/*', async (req, res) => {
    const config = decodeConfig(req.params.config);
    if (!config) return res.status(400).json({ metas: [] });
    
    const upstreamBase = getUpstreamBase(config.u);
    // Extrapolate exact path without modifying URL-encoded strings like 'genre=Action&skip=20'
    const proxyPath = req.originalUrl.replace(`/${req.params.config}`, '');
    const upstreamUrl = `${upstreamBase}${proxyPath}`;

    try {
        const response = await fetch(upstreamUrl, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error("Upstream returned HTTP " + response.status);
        const data = await response.json();

        const typeMatch = proxyPath.match(/\/catalog\/([^\/]+)/);
        const type = typeMatch ? typeMatch[1] : "movie";

        if (data.metas && Array.isArray(data.metas)) {
            data.metas = await Promise.all(data.metas.map(async (meta) => {
                let imdbId = null;
                
                // 1. Determine IMDb ID from the item natively
                if (meta.id && /^tt\d+$/.test(meta.id)) imdbId = meta.id;
                else if (meta.imdb_id && /^tt\d+$/.test(meta.imdb_id)) imdbId = meta.imdb_id;
                else {
                    // 2. Safely fallback to metadata if missing
                    try {
                        const metaRes = await fetch(`${upstreamBase}/meta/${type}/${meta.id}.json`, { signal: AbortSignal.timeout(3000) });
                        if (metaRes.ok) {
                            const metaData = await metaRes.json();
                            if (metaData?.meta?.id && /^tt\d+$/.test(metaData.meta.id)) imdbId = metaData.meta.id;
                            else if (metaData?.meta?.imdb_id && /^tt\d+$/.test(metaData.meta.imdb_id)) imdbId = metaData.meta.imdb_id;
                        }
                    } catch (e) {
                        // Keeps default Stremboxd poster dynamically on failure
                    }
                }

                // 3. Inject all image types from ExtendedRatings
                if (imdbId) {
                    // Poster from Stremboxd (using BetterPosters pattern)
                    meta.poster = config.p.replace('{imdb_id}', imdbId);
                    
                    // Backdrop from ExtendedRatings
                    meta.backdrop = config.b.replace('{imdb_id}', imdbId);
                    
                    // Logo from ExtendedRatings
                    meta.logo = config.l.replace('{imdb_id}', imdbId);
                    
                    // Thumbnail from ExtendedRatings  
                    meta.thumbnail = config.t.replace('{imdb_id}', imdbId);
                }
                
                return meta;
            }));
        }
        
        // Extremely short 60s cache forces immediate updates in Nuvio Watchlists
        res.setHeader('Cache-Control', 'max-age=60, stale-while-revalidate=60');
        res.json(data);
    } catch (e) {
        console.error("Catalog proxy error:", e.message);
        // Fail gracefully returning empty array so Nuvio doesn't crash on timeouts
        res.json({ metas: [] });
    }
});

// --- Meta Proxy (For fetching inside Movie Details view) ---
app.get('/:config/meta/*', async (req, res) => {
    const config = decodeConfig(req.params.config);
    if (!config) return res.status(400).json({ meta: null });

    const upstreamBase = getUpstreamBase(config.u);
    const proxyPath = req.originalUrl.replace(`/${req.params.config}`, '');
    const upstreamUrl = `${upstreamBase}${proxyPath}`;

    try {
        const response = await fetch(upstreamUrl, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error("Upstream error");
        const data = await response.json();

        if (data.meta) {
            let imdbId = null;
            if (data.meta.id && /^tt\d+$/.test(data.meta.id)) imdbId = data.meta.id;
            else if (data.meta.imdb_id && /^tt\d+$/.test(data.meta.imdb_id)) imdbId = data.meta.imdb_id;

            if (imdbId) {
                // Poster from Stremboxd (using BetterPosters pattern)
                data.meta.poster = config.p.replace('{imdb_id}', imdbId);
                
                // Backdrop from ExtendedRatings
                data.meta.backdrop = config.b.replace('{imdb_id}', imdbId);
                
                // Logo from ExtendedRatings
                data.meta.logo = config.l.replace('{imdb_id}', imdbId);
                
                // Thumbnail from ExtendedRatings  
                data.meta.thumbnail = config.t.replace('{imdb_id}', imdbId);
            }
        }

        res.setHeader('Cache-Control', 'max-age=86400, stale-while-revalidate=86400');
        res.json(data);
    } catch (e) {
        console.error("Meta proxy error:", e);
        res.json({ meta: null });
    }
});

// --- Server Init ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Enhanced Stremboxd Wrapper listening on port ${PORT} on 0.0.0.0`);
});
