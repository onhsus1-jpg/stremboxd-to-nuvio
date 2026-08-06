const express = require('express');
const cors = require('cors');
const path = require('path');

// 🔽 YOUR EXTENDED RATINGS CONFIGURATION 🔽
const HARDCODED_XRDB_CONFIG = "config=onhsusss&v=f8e5147f"; 

const app = express();
app.use(cors());

// --- Helper Functions ---
function decodeConfig(configStr) {
    try {
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

// Helper to inject Extended Ratings artwork (Logo, Backdrop/Background, Thumbnail)
function applyXrdbArtwork(meta, imdbId, xrdbConfig) {
    if (!xrdbConfig || !imdbId) return;

    let configQuery = xrdbConfig.trim();
    
    // Parse if user passed a full URL or plain alias
    if (configQuery.includes('http')) {
        try {
            const urlObj = new URL(configQuery);
            configQuery = urlObj.search.replace(/^\?/, '');
        } catch (e) {
            configQuery = HARDCODED_XRDB_CONFIG;
        }
    } else if (!configQuery.startsWith('config=')) {
        configQuery = `config=${configQuery}`;
    }

    meta.logo = `https://extendedratings.com/logo/${imdbId}?${configQuery}`;
    meta.background = `https://extendedratings.com/backdrop/${imdbId}?${configQuery}`;
    meta.thumbnail = `https://extendedratings.com/thumbnail/${imdbId}?${configQuery}`;
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
    if (!config || !config.u || !config.p) {
        return res.status(400).json({ error: "Invalid configuration" });
    }

    try {
        const response = await fetch(config.u, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error("Failed to fetch upstream manifest");
        
        const manifest = await response.json();
        
        // Modify manifest to safely differentiate it inside Nuvio
        manifest.id = (manifest.id || "stremboxd") + ".btttr-xrdb-wrapper";
        manifest.name = (manifest.name || "Stremboxd") + " (BTTTR + XRDB Wrapped)";
        manifest.description = "Proxied with live dynamic updates. " + (manifest.description || "");
        
        res.setHeader('Cache-Control', 'max-age=86400, stale-while-revalidate=86400'); 
        res.json(manifest);
    } catch (e) {
        console.error("Manifest error:", e);
        res.status(500).json({ error: "Manifest proxy failed" });
    }
});

// --- Catalog Proxy ---
app.get('/:config/catalog/*', async (req, res) => {
    const config = decodeConfig(req.params.config);
    if (!config) return res.status(400).json({ metas: [] });
    
    const upstreamBase = getUpstreamBase(config.u);
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
                
                // 1. Determine IMDb ID natively
                if (meta.id && /^tt\d+$/.test(meta.id)) imdbId = meta.id;
                else if (meta.imdb_id && /^tt\d+$/.test(meta.imdb_id)) imdbId = meta.imdb_id;
                else {
                    // 2. Fallback check metadata
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

                if (imdbId) {
                    // 3. BetterPosters for POSTERS ONLY
                    if (config.p) {
                        meta.poster = config.p.replace('{imdb_id}', imdbId);
                    }
                    // 4. Extended Ratings for LOGO, BACKDROP, and THUMBNAIL
                    const xrdbConfigToUse = config.xrdb || HARDCODED_XRDB_CONFIG;
                    applyXrdbArtwork(meta, imdbId, xrdbConfigToUse);
                }
                
                return meta;
            }));
        }
        
        res.setHeader('Cache-Control', 'max-age=60, stale-while-revalidate=60');
        res.json(data);
    } catch (e) {
        console.error("Catalog proxy error:", e.message);
        res.json({ metas: [] });
    }
});

// --- Meta Proxy (For Details View inside Nuvio) ---
app.get('/:config/meta/*', async (req, res) => {
    const config = decodeConfig(req.params.config);
    if (!config) return res.status(400).json({ meta: null });

    const upstreamBase = getUpstreamBase(config.u);
    const proxyPath = req.originalUrl.replace(`/${req.params.config}`, '');
    const upstreamUrl = `${upstreamBase}${proxyPath}`;

    try {
        const response = await fetch(upstre
