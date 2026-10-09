"use strict";

/**
 * hfs-directory
 *
 * Reads Nautilus custom icons (GIO metadata) and `.directory` files from
 * folders and customizes folder icons in HFS list.
 * Hierarchy (first hit wins): Nautilus -> .directory -> default.
 * Supported .directory syntax:
 * [Desktop Entry]
 * Icon=/absolute/path/to/icon.ico
 * Icon=folder-green
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const child_process = require("child_process");

const ICON_ROUTE = "/__hfs_directory_icon";
const DIRECTORY_FILE_NAME = ".directory";
const CACHE_TTL_MS = 30 * 1000;
const GIO_TIMEOUT_MS = 2000;
const GIO_ATTRIBUTES = "metadata::custom-icon,metadata::custom-icon-name";
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

/**
 * Cache for `gio` binary availability. `null` = unknown yet,
 * `true` = usable, `false` = missing (skip future spawns).
 * @type {boolean | null}
 */
let gioAvailable = null;

/** @type {Map<string, { expiresAt: number, result: { icon: string | null, color: string | null, iconPath: string | null } }>} */
const folderCache = new Map();

/** @type {Map<string, { iconPath: string, expiresAt: number }>} */
const iconTokenCache = new Map();

exports.description = "Use Nautilus custom icons and .directory to customize folder icons";
exports.version = 2;
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
 * Customize folder entry icon with hierarchy: Nautilus -> `.directory` -> default.
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
    gioAvailable = null;
}

/**
 * Read (or cache-hit) folder icon with hierarchy: Nautilus -> .directory -> default.
 * @param {string} folderPath
 * @returns {{ icon: string | null, color: string | null, iconPath: string | null }}
 */
function getFolderIconDescriptor(folderPath) {
    const now = Date.now();
    const cached = folderCache.get(folderPath);
    if (cached && cached.expiresAt > now) return cached.result;

    const result = getNautilusIconDescriptor(folderPath) || parseDirectoryFile(path.join(folderPath, DIRECTORY_FILE_NAME));
    folderCache.set(folderPath, { result, expiresAt: now + CACHE_TTL_MS });
    return result;
}

/**
 * Read Nautilus custom icon from GIO metadata (`gio info`).
 * Returns a descriptor on hit, or null to fall through to `.directory`.
 * @param {string} folderPath
 * @returns {{ icon: string | null, color: string | null, iconPath: string | null } | null}
 */
function getNautilusIconDescriptor(folderPath) {
    if (gioAvailable === false) return null;

    let stdout = "";
    try {
        const res = child_process.spawnSync(
            "gio",
            ["info", "-a", GIO_ATTRIBUTES, "--", folderPath],
            { encoding: "utf8", timeout: GIO_TIMEOUT_MS },
        );
        if (res.error) {
            if (res.error.code === "ENOENT") gioAvailable = false;
            return null;
        }
        if (res.status !== 0 || typeof res.stdout !== "string") return null;
        gioAvailable = true;
        stdout = res.stdout;
    } catch {
        return null;
    }

    const { customIcon, customIconName } = parseGioInfoMetadata(stdout);

    if (customIcon) {
        const localPath = fileUriToPath(customIcon);
        if (localPath && isSafeAbsoluteImagePath(localPath)) {
            try {
                if (fs.statSync(localPath).isFile()) {
                    return { icon: null, color: null, iconPath: localPath };
                }
            } catch {
                // Referenced file gone/unreadable -> fall through to .directory.
            }
        }
        // metadata::custom-icon set but unusable -> still allow custom-icon-name?
        // Nautilus gives precedence to custom-icon, but an invalid file should
        // not block the themed-name fallback below.
    }

    if (customIconName) {
        return resolveIconValue(customIconName);
    }

    return null;
}

/**
 * Extract `metadata::custom-icon` and `metadata::custom-icon-name` from `gio info` output.
 * @param {string} output
 * @returns {{ customIcon: string | null, customIconName: string | null }}
 */
function parseGioInfoMetadata(output) {
    let customIcon = null;
    let customIconName = null;

    for (const rawLine of String(output || "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const match = line.match(/^metadata::(custom-icon(?:-name)?):\s*(.+?)\s*$/);
        if (!match) continue;
        const value = match[2].trim();
        if (!value) continue;
        if (match[1] === "custom-icon") customIcon = value;
        else customIconName = value;
    }

    return { customIcon, customIconName };
}

/**
 * Convert `file://` URI (as stored by Nautilus) to a local absolute path.
 * @param {string} uri
 * @returns {string | null}
 */
function fileUriToPath(uri) {
    const value = String(uri || "").trim();
    if (!value.startsWith("file://")) return null;
    try {
        if (typeof URL !== "undefined" && URL.canParse && URL.canParse(value)) {
            const url = new URL(value);
            if (url.protocol !== "file:") return null;
            return decodeURIComponent(url.pathname);
        }
        let rest = value.slice("file://".length);
        if (rest.startsWith("localhost/")) rest = rest.slice("localhost".length);
        if (!rest.startsWith("/")) rest = `/${rest}`;
        return decodeURIComponent(rest.split("?")[0].split("#")[0]);
    } catch {
        return null;
    }
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

        return resolveIconValue(iconValue) || emptyDescriptor();
    } catch (error) {
        if (pluginApi?.log) pluginApi.log("Failed to parse .directory", filePath, error?.message || error);
        return emptyDescriptor();
    }
}

/**
 * Resolve a `.directory` Icon value or Nautilus `custom-icon-name` to a descriptor.
 * Returns null when the value is empty/invalid.
 * @param {string} iconValue
 * @returns {{ icon: string | null, color: string | null, iconPath: string | null } | null}
 */
function resolveIconValue(iconValue) {
    const value = String(iconValue || "").trim();
    if (!value) return null;

    if (path.isAbsolute(value)) {
        if (!isSafeAbsoluteImagePath(value)) return null;
        return { icon: null, color: null, iconPath: value };
    }

    if (value.startsWith("folder-")) {
        return {
            icon: "folder",
            color: sanitizeColorName(value.slice("folder-".length)),
            iconPath: null,
        };
    }

    return { icon: value, color: null, iconPath: null };
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
