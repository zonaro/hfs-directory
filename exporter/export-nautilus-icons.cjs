#!/usr/bin/env node
"use strict";

/**
 * Mirror Nautilus/GIO custom folder icons into a world-readable cache dir
 * so the HFS plugin (often running as another user, e.g. `hfs`) can serve
 * exactly the same icon files. Run as the desktop user via the bundled
 * systemd user timer (see install.sh).
 *
 * Env:
 *   HFS_EXPORT_ROOTS       colon-separated scan roots (default: /mnt/GIT)
 *   HFS_EXPORT_DEPTH       max descend depth below each root (default: 4)
 *   HFS_EXPORT_CACHE       cache dir (default: /var/tmp/hfs-directory)
 *   HFS_EXPORT_GIO_TIMEOUT per-folder `gio info` timeout ms (default: 5000)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const child_process = require("child_process");
const { fileURLToPath } = require("url");

const ROOTS = (process.env.HFS_EXPORT_ROOTS || "/mnt/GIT")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
const MAX_DEPTH = Number.parseInt(process.env.HFS_EXPORT_DEPTH || "4", 10) || 4;
const CACHE_DIR = (process.env.HFS_EXPORT_CACHE || "/var/tmp/hfs-directory").trim();
const ICONS_SUBDIR = "icons";
const MANIFEST = "manifest.json";
const GIO_TIMEOUT_MS = Number.parseInt(process.env.HFS_EXPORT_GIO_TIMEOUT || "5000", 10) || 5000;
const GIO_ATTRIBUTES = "metadata::custom-icon,metadata::custom-icon-name";
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif"]);

function main() {
    const iconsDir = path.join(CACHE_DIR, ICONS_SUBDIR);
    fs.mkdirSync(iconsDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(CACHE_DIR, 0o755);
    fs.chmodSync(iconsDir, 0o755);

    const entries = {};
    const referenced = new Set();
    let scanned = 0;
    let withFile = 0;
    let withName = 0;

    for (const root of ROOTS) {
        for (const dir of walkDirs(root, MAX_DEPTH)) {
            scanned += 1;
            const meta = readGioMetadata(dir);
            if (!meta) continue;
            if (meta.customIcon) {
                const rel = mirrorIconFile(meta.customIcon, iconsDir, referenced);
                if (rel) {
                    entries[dir] = { icon: `${ICONS_SUBDIR}/${rel}` };
                    withFile += 1;
                    continue;
                }
            }
            if (meta.customIconName) {
                entries[dir] = { name: meta.customIconName };
                withName += 1;
            }
        }
    }

    pruneIcons(iconsDir, referenced);

    const manifest = {
        version: 1,
        generatedAt: new Date().toISOString(),
        roots: ROOTS,
        entries,
    };
    const tmp = path.join(CACHE_DIR, `${MANIFEST}.tmp.${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(manifest), { mode: 0o644 });
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, path.join(CACHE_DIR, MANIFEST));
    fs.chmodSync(path.join(CACHE_DIR, MANIFEST), 0o644);

    console.log(`scanned=${scanned} fileIcons=${withFile} namedIcons=${withName} cache=${CACHE_DIR}`);
}

function* walkDirs(root, maxDepth) {
    let rootStat;
    try {
        rootStat = fs.statSync(root);
    } catch {
        return;
    }
    if (!rootStat.isDirectory()) return;
    yield root;
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length > 0) {
        const { dir, depth } = stack.pop();
        if (depth >= maxDepth) continue;
        let children;
        try {
            children = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const child of children) {
            let full;
            try {
                full = path.join(dir, child.name);
                if (child.isDirectory()) {
                    yield full;
                    stack.push({ dir: full, depth: depth + 1 });
                } else if (child.isSymbolicLink()) {
                    try {
                        if (fs.statSync(full).isDirectory()) yield full;
                    } catch {
                        // Dangling link: ignore.
                    }
                }
            } catch {
                // Unreadable entry: ignore.
            }
        }
    }
}

function readGioMetadata(dir) {
    let stdout = "";
    try {
        const res = child_process.spawnSync("gio", ["info", "-a", GIO_ATTRIBUTES, "--", dir], {
            encoding: "utf8",
            timeout: GIO_TIMEOUT_MS,
        });
        if (res.error || res.status !== 0 || typeof res.stdout !== "string") return null;
        stdout = res.stdout;
    } catch {
        return null;
    }
    let customIcon = null;
    let customIconName = null;
    for (const rawLine of stdout.split(/\r?\n/)) {
        const match = rawLine.trim().match(/^metadata::(custom-icon(?:-name)?):\s*(.+?)\s*$/);
        if (!match || !match[2].trim()) continue;
        if (match[1] === "custom-icon") customIcon = match[2].trim();
        else customIconName = match[2].trim();
    }
    if (!customIcon && !customIconName) return null;
    return { customIcon, customIconName };
}

function mirrorIconFile(uri, iconsDir, referenced) {
    if (!uri.startsWith("file://")) return null;
    let localPath;
    try {
        localPath = fileURLToPath(uri);
    } catch {
        return null;
    }
    if (!path.isAbsolute(localPath)) return null;
    const ext = path.extname(localPath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) return null;
    let bytes;
    try {
        const stat = fs.statSync(localPath);
        if (!stat.isFile()) return null;
        bytes = fs.readFileSync(localPath);
    } catch {
        return null;
    }
    const name = `${crypto.createHash("sha1").update(bytes).digest("hex")}${ext}`;
    referenced.add(name);
    const dest = path.join(iconsDir, name);
    try {
        if (!fs.existsSync(dest)) {
            fs.writeFileSync(dest, bytes, { mode: 0o644 });
        }
        fs.chmodSync(dest, 0o644);
    } catch {
        return null;
    }
    return name;
}

function pruneIcons(iconsDir, referenced) {
    let files;
    try {
        files = fs.readdirSync(iconsDir);
    } catch {
        return;
    }
    for (const file of files) {
        if (!referenced.has(file)) {
            try {
                fs.unlinkSync(path.join(iconsDir, file));
            } catch {
                // Best effort.
            }
        }
    }
}

main();
