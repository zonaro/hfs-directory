"use strict";

/**
 * hfs-directory
 *
 * Reads `.directory` files from folders and customizes folder icons in HFS list.
 * Supported syntax:
 * [Desktop Entry]
 * Icon=/absolute/path/to/icon.ico
 * Icon=folder-green
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ICON_ROUTE = "/__hfs_directory_icon";
const DIRECTORY_FILE_NAME = ".directory";
const CACHE_TTL_MS = 30 * 1000;
const ALLOWED_IMAGE_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".ico",
    ".bmp",
    ".avif",
]);

let pluginApi;
const pathTokenSecret = crypto.randomBytes(16).toString("hex");

/** @type {Map<string, { expiresAt: number, result: { icon: string | null, color: string | null, iconPath: string | null } }>} */
const folderCache = new Map();

/** @type {Map<string, { iconPath: string, expiresAt: number }>} */
const iconTokenCache = new Map();

exports.description = "Use .directory to customize folder icons";
exports.version = 1;
exports.apiRequired = 12.97;
exports.frontend_js = "main.js";
exports.frontend_css = "style.css";

/**
 * Initialize plugin and bind middleware + entry hook.
 * @param {object} api
 */
exports.init = function init(api) {
    pluginApi = api;
    return {
        middleware,
        onDirEntry,
        unload,
    };
};

/**
 * Serve local icon files through a controlled route.
 * @param {import('koa').Context & { stop?: () => void }} ctx
 */
function middleware(ctx) {
    if (ctx.path !== ICON_ROUTE) return;

    const token = typeof ctx.query?.t === "string" ? ctx.query.t : "";
    const record = iconTokenCache.get(token);
    if (!record || record.expiresAt < Date.now()) {
        ctx.status = 404;
        ctx.body = "Icon not found";
        return;
    }

    if (!isSafeAbsoluteImagePath(record.iconPath)) {
        ctx.status = 400;
        ctx.body = "Invalid icon path";
        return;
    }

    try {
        const stat = fs.statSync(record.iconPath);
        if (!stat.isFile()) {
            ctx.status = 404;
            ctx.body = "Icon not found";
            return;
        }

        ctx.type = path.extname(record.iconPath);
        ctx.body = fs.createReadStream(record.iconPath);
        if (typeof ctx.stop === "function") ctx.stop();
    } catch {
        ctx.status = 404;
        ctx.body = "Icon not found";
    }
}

/**
 * Customize folder entry icon by reading child-folder `.directory`.
 * @param {{ entry: any, node?: { source?: string } }} args
 */
function onDirEntry({ entry, node }) {
    if (!isFolderEntry(entry) || !node?.source) return;

    const folderPath = node.source;
    const { icon, color, iconPath } = getFolderIconDescriptor(folderPath);

    if (iconPath) {
        const token = tokenFromPath(iconPath);
        iconTokenCache.set(token, { iconPath, expiresAt: Date.now() + CACHE_TTL_MS });
        entry.icon = `${ICON_ROUTE}?t=${encodeURIComponent(token)}`;
        delete entry.hfsDirectoryColor;
        return;
    }

    if (icon) {
        entry.icon = icon;
    }

    if (color) {
        entry.hfsDirectoryColor = color;
    } else {
        delete entry.hfsDirectoryColor;
    }
}

/**
 * Cleanup runtime caches.
 */
function unload() {
    folderCache.clear();
    iconTokenCache.clear();
}

/**
 * Read (or cache-hit) `.directory` for a folder.
 * @param {string} folderPath
 * @returns {{ icon: string | null, color: string | null, iconPath: string | null }}
 */
function getFolderIconDescriptor(folderPath) {
    const now = Date.now();
    const cached = folderCache.get(folderPath);
    if (cached && cached.expiresAt > now) return cached.result;

    const result = parseDirectoryFile(path.join(folderPath, DIRECTORY_FILE_NAME));
    folderCache.set(folderPath, { result, expiresAt: now + CACHE_TTL_MS });
    return result;
}

/**
 * Parse INI-like .directory file and resolve Icon.
 * @param {string} filePath
 * @returns {{ icon: string | null, color: string | null, iconPath: string | null }}
 */
function parseDirectoryFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return emptyDescriptor();
        const text = fs.readFileSync(filePath, "utf8");
        const iconValue = extractDesktopEntryIcon(text);
        if (!iconValue) return emptyDescriptor();

        if (path.isAbsolute(iconValue)) {
            if (!isSafeAbsoluteImagePath(iconValue)) return emptyDescriptor();
            return { icon: null, color: null, iconPath: iconValue };
        }

        if (iconValue.startsWith("folder-")) {
            return {
                icon: "folder",
                color: sanitizeColorName(iconValue.slice("folder-".length)),
                iconPath: null,
            };
        }

        return { icon: iconValue, color: null, iconPath: null };
    } catch (error) {
        if (pluginApi?.log) pluginApi.log("Failed to parse .directory", filePath, error?.message || error);
        return emptyDescriptor();
    }
}

/**
 * Extract Icon value from [Desktop Entry] block.
 * @param {string} iniText
 * @returns {string | null}
 */
function extractDesktopEntryIcon(iniText) {
    const lines = iniText.split(/\r?\n/);
    let inDesktopEntry = false;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || line.startsWith(";")) continue;

        if (line.startsWith("[") && line.endsWith("]")) {
            const sectionName = line.slice(1, -1).trim().toLowerCase();
            inDesktopEntry = sectionName === "desktop entry";
            continue;
        }

        if (!inDesktopEntry) continue;

        const separatorIndex = line.indexOf("=");
        if (separatorIndex < 1) continue;

        const key = line.slice(0, separatorIndex).trim().toLowerCase();
        const value = line.slice(separatorIndex + 1).trim();
        if (key === "icon" && value) return value;
    }

    return null;
}

/**
 * Validate accepted local image path for icon serving.
 * @param {string} iconPath
 * @returns {boolean}
 */
function isSafeAbsoluteImagePath(iconPath) {
    if (!path.isAbsolute(iconPath)) return false;
    const ext = path.extname(iconPath).toLowerCase();
    return ALLOWED_IMAGE_EXTENSIONS.has(ext);
}

/**
 * Determine if backend entry represents a folder row.
 * @param {any} entry
 * @returns {boolean}
 */
function isFolderEntry(entry) {
    return Boolean(entry && typeof entry.n === "string" && entry.n.endsWith("/"));
}

/**
 * Build a stable token for local icon route.
 * @param {string} iconPath
 * @returns {string}
 */
function tokenFromPath(iconPath) {
    return crypto
        .createHash("sha1")
        .update(pathTokenSecret)
        .update("\0")
        .update(iconPath)
        .digest("hex");
}

/**
 * Restrict custom color names to css-class-safe characters.
 * @param {string} value
 * @returns {string | null}
 */
function sanitizeColorName(value) {
    const sanitized = String(value || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    return sanitized || null;
}

/**
 * @returns {{ icon: null, color: null, iconPath: null }}
 */
function emptyDescriptor() {
    return { icon: null, color: null, iconPath: null };
}
